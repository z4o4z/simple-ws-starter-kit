require('../helpers/env');

const moment = require('moment');
const Promise = require('bluebird');

moment.locale('ru');

const { EVENTS_ENDPOINTS } = require('../constants');

const logger = require('../helpers/get-logger')(__filename);

const MongoDB = require('../libs/mongo-db');

const Page = require('../models/page');
const Event = require('../models/event');

const Crawler = require('./crawler');

class DevByCrawler extends Crawler {
  static getCompanyInfoFromNode(node) {
    const strongNodes = [...node.querySelectorAll('strong')];

    return strongNodes.reduce((res, strongNode) => {
      const text = Crawler.getTextFromNode(strongNode);

      switch (text) {
        case 'Эл. почта:':
          return Object.assign(res, {
            email: Crawler.getTextFromNode(strongNode.nextElementSibling)
          });
        case 'Сайт:':
          return Object.assign(res, {
            site: strongNode.nextElementSibling.getAttribute('href')
          });
        case 'Телефон:':
          return Object.assign(res, { phoneNumber: Crawler.getNextSiblingText(strongNode) });
        default:
          return res;
      }
    }, {});
  }

  static getEventPriceAndAddressFromNode(node) {
    const h4sNodes = [...node.querySelectorAll('.bl > h4')];

    return h4sNodes.reduce((res, h4Node) => {
      const text = Crawler.getTextFromNode(h4Node);

      switch (text) {
        case 'Стоимость участия':
          return Object.assign(res, { price: Crawler.getTextFromNode(h4Node.nextElementSibling) });
        case 'Место проведения':
          return Object.assign(res, {
            geo: {
              latitude: h4Node.nextElementSibling.getAttribute('data-longitude'),
              longitude: h4Node.nextElementSibling.getAttribute('data-latitude')
            },
            address: h4Node.nextElementSibling.getAttribute('data-address')
          });
        default:
          return res;
      }
    }, {});
  }

  constructor(options) {
    super(options);

    logger.debug('constructor - eventsPerPage=%s', options.eventsPerPage);

    this.pages = [];
    this.eventsPerPage = options.eventsPerPage;
  }

  async processAllPages() {
    logger.debug('processAllPages');
    logger.info('processing pages');

    let page = 1;
    let eventsNodes = [];

    do {
      const dom = await this.getDomFromURL(`/?page=${page}`);
      const { document } = dom.window;

      const pageModel = new Page({
        uri: `/?page=${page}`,
        html: dom.serialize()
      });

      await pageModel.save();

      eventsNodes = [...document.querySelectorAll('.list-item-events .item')];

      const eventsPreviews = await Promise.mapSeries(eventsNodes, event => {
        try {
          return this.transformEventNodeToData(event);
        } catch (e) {
          logger.warn("can't process event", e);

          return null;
        }
      });

      await Promise.each(eventsPreviews, async event => {
        try {
          await this.fetchAllEventInfoAndSave(event);
        } catch (e) {
          logger.warn("can't save event", e);
        }
      });

      page += 1;
    } while (eventsNodes.length);

    logger.info('processing pages done');
  }

  transformEventNodeToData(event) {
    logger.debug('transformEvents - event=%j', event);

    if (!event) {
      return null;
    }

    const titleNode = event.querySelector('a.title');
    const titleLink = titleNode.getAttribute('href');
    const titleText = Crawler.getTextFromNode(titleNode);

    logger.info('transforming event "%s" preview html to data', titleText);

    const dateTimeNode = event.querySelector('a.title + p time');

    dateTimeNode.remove();

    const localeAndOrganizerNode = event.querySelector('a.title + p');
    const localeAndOrganizerRow = Crawler.getTextFromNode(localeAndOrganizerNode);
    const [, , organizer] =
      localeAndOrganizerRow.match(/^([а-яА-Я]+)\.(?:(?:\s+)[а-яА-Я]+:\s+(.+))?/) || [];

    const tagsNodes = [...event.querySelectorAll('.list-style-tags li span')];
    const tags = tagsNodes.map((span = '') => Crawler.getTextFromNode(span).toLowerCase());

    logger.info('transforming event "%s" preview html to data done', titleText);

    return {
      uri: titleLink,
      tags,
      link: `${this.endpoint}${titleLink}`,
      title: titleText,
      organizer
    };
  }

  async fetchAllEventInfoAndSave(event) {
    if (!event) {
      return;
    }

    logger.debug('fetchAllEventInfoAndSave - event=%j', event);
    logger.info('fetching event by uri %s', event.uri);

    const dom = await this.getDomFromURL(event.uri);
    const { document } = dom.window;

    const pageModel = new Page({
      uri: event.uri,
      html: dom.serialize()
    });

    await pageModel.save();

    const contentNode = document.querySelector('.body-events__overview .input');
    const content = Crawler.getHTMLFromNode(contentNode);

    const bodyEventsNode = document.querySelector('.data-desc-events .body-events');
    const dataCompanyNode = document.querySelector('.sidebar-show-events .data-company .info');

    const dateTimeNode = document.querySelector('.data-topic-events .time');

    const dateTimeRow = Crawler.getTextFromNode(dateTimeNode);

    const [
      ,
      startDate,
      startMonth,
      finishDate = startDate,
      finishMonth,
      startTime = '00:00',
      finishTime = '00:00'
    ] =
      dateTimeRow.match(
        /^(?:[а-яА-Я]+,\s+)?([0-9]+)(?:\s+([а-яА-Я]+))?(?:\s+—\s+([0-9]+)\s+([а-яА-Я]+))?(?:\s+([0-9:]+))?(?:\s+-\s+([0-9:]+))?/
      ) || [];

    const { email, site, phoneNumber } = DevByCrawler.getCompanyInfoFromNode(dataCompanyNode);
    const { geo, price, address } = DevByCrawler.getEventPriceAndAddressFromNode(bodyEventsNode);

    logger.info('fetching event by uri %s done', event.uri);

    logger.info('saving event %s', event.title);

    const momentStartDate = moment(
      `+03:00 ${startTime} ${startDate} ${startMonth || finishMonth}`,
      'ZZ HH:mm D MMMM YYYY'
    );
    const momentFinishDate = moment(
      `+03:00 ${finishTime} ${finishDate} ${finishMonth || startMonth}`,
      'ZZ HH:mm D MMMM YYYY'
    );

    if (!momentStartDate.isValid() || !momentFinishDate.isValid()) {
      return;
    }

    const eventModel = new Event({
      uri: event.uri,
      geo,
      site,
      tags: event.tags,
      link: event.link,
      email,
      price,
      title: event.title,
      content,
      address,
      organizer: event.organizer,
      start_date: momentStartDate,
      finish_date: momentFinishDate,
      phone_number: phoneNumber,
      hero_image_url: `https://picsum.photos/600/400?uri=${event.uri}`
    });

    await eventModel.save();

    logger.info('saving event %s done', event.title);
  }
}

async function main() {
  const db = new MongoDB({
    port: process.env.MONGO_DB_PORT,
    host: process.env.MONGO_DB_HOST,
    name: process.env.MONGO_DB_NAME
  });

  const devByCrawler = new DevByCrawler({
    endpoint: EVENTS_ENDPOINTS.DEV_BY,
    eventsPerPage: 8
  });

  try {
    await db.connect();

    await Page.remove({});
    await Event.remove({});

    await devByCrawler.processAllPages();
  } catch (err) {
    logger.error('fata error %s', err.message);
  } finally {
    await db.disconnect();
  }
}

main();
