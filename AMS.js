const express = require('express');
const request = require('request');
const moment = require('moment-timezone');
const async = require('async');
const cheerio = require('cheerio');
const _ = require('lodash');

const port = 3000;
const redis_url = 'redis://localhost:6379';
const redis_key = 'airports:schiphol';

const redis = require('redis')
    .createClient({ url: redis_url })
    .on('connect', () =>
        console.log(`[${moment().format('HH:mm')}][redis] connected`)
    )
    .on('reconnecting', (p) =>
        console.log(`[${moment().format('HH:mm')}][redis] reconnecting: %j`, p)
    )
    .on('error', (e) =>
        console.error(`[${moment().format('HH:mm')}][redis] error: %j`, e)
    );

const app = express();
// http://localhost:3000/schedules
app.get('/schedules', (req, res) => {
    redis.get(redis_key, (e, reply) => {
        if (!reply) return res.status(404).json({ error: 'Data not found' });

        try {
            res.json(JSON.parse(reply));
        } catch (e) {
            res.status(500).json({ error: 'Internal Server Error' });
        }
    });
});

app.listen(port, () => console.log(`Server is running on port ${port}`));

const gracefulShutdown = () => {
    console.log('\nReceived kill signal, shutting down gracefully.');

    redis && redis.end && redis.end(true);

    setTimeout(() => {
        console.error(
            'Could not close connections in time, forcefully shutting down'
        );
        return process.exit(1);
    }, 9000);
};
process.once('SIGTERM', gracefulShutdown); // listen for TERM signal .e.g. kill
process.once('SIGINT', gracefulShutdown); // listen for INT signal e.g. Ctrl-C

const proxy = 'http://speej9xhkw:KbdCbB22xmdmxpG28k@dc.smartproxy.com:10000';
const base = 'https://www.schiphol.nl';
const headers = { 'Content-Encoding': 'gzip' };
const timezone = 'Europe/Amsterdam';
const fmt = 'YYYY-MM-DD HH:mm';
const refresh_delay = 20 * 60 * 1000;
const max_retries = 3;
const max_limit = 10;

const status_format = (raw_status, type) => {
    /*
        > landed
        Arrives early: 25
        Baggage handled: 455
        Baggage on belt: 63
        Landed: 23

        > cancelled
        Cancelled: 13

        > schedule
        Now boarding:
        On schedule: 2463
        Wait in lounge: 26
        Gate change: 124
        Gate closed: 14
        Gate closing: 10
        Gate open: 17
        Delayed: 56 ??? if depart

        > active
        Departed: 519
        On its way: 12
        Preparing for landing: 12
        Delayed: 56 ??? if arrival
    */

    if (/Cancelled/im.test(raw_status)) return 'cancelled';

    if (/Arrives|Baggage|Landed/im.test(raw_status)) return 'landed';

    if (/Departed|On its way|Preparing for landing/im.test(raw_status))
        return 'active';

    if (/boarding|schedule|lounge|Gate/im.test(raw_status)) return 'scheduled';

    if (/Delayed/im.test(raw_status)) {
        if (type === 'departure') return 'scheduled';
        else if (type === 'arrival') return 'active';
    }

    return 'scheduled';
};

const parse_list = (html) => {
    if (!html) return {};

    const items = {};
    const $ = cheerio.load(html);

    $('[class="card-flight"]').each(function () {
        const $this = $(this);
        const id = $this.attr('id');
        const obj = {
            source: 'schiphol.nl',
            source_id: id,
            type: /^D/.test(id) ? 'departure' : 'arrival',
        };

        try {
            const j = JSON.parse($this.find('script').text());

            obj.flight_iata =
                _.get(j, 'flightNumber', '').replace(/\s+/g, '') || undefined;
            obj.airline_iata = _.get(j, 'provider.iataCode', undefined);
            obj.aircraft_type = _.get(j, 'aircraft', undefined);

            obj.arr_iata = _.get(j, 'arrivalAirport.iataCode');
            obj.dep_iata = _.get(j, 'departureAirport.iataCode');

            obj.arr_gate = _.get(j, 'arrivalGate', undefined);
            obj.arr_terminal = _.get(j, 'arrivalTerminal', undefined);
            obj.arr_time = _.get(j, 'arrivalTime')
                ? moment(j.arrivalTime).format(fmt)
                : undefined;

            obj.dep_gate = _.get(j, 'departureGate', undefined);
            obj.dep_terminal = _.get(j, 'departureTerminal', undefined);
            obj.dep_time = _.get(j, 'departureTime')
                ? moment(j.departureTime).format(fmt)
                : undefined;
        } catch (e) {
            console.log(e);
        }

        const $delayed = $this.find('ins.time-delayed>[dateTime]');
        if ($delayed.length) {
            const dt = moment($delayed.attr('dateTime')).format(fmt);
            if (obj.dep_time) {
                obj.dep_estimated = dt;
                obj.dep_delayed = Math.abs(
                    moment(obj.dep_time, fmt).diff(moment(dt, fmt), 'minutes')
                );
            } else if (obj.arr_time) {
                obj.arr_estimated = dt;
                obj.arr_delayed = Math.abs(
                    moment(obj.arr_time, fmt).diff(moment(dt, fmt), 'minutes')
                );
            }
        }

        // в общем ответе кодшары представленны в виде отдельных рейсов, но можно и выдать и так - тоже ценная инфа
        $this.find('.card-flight__code-share').each(function () {
            obj.codeshares = obj.codeshares || [];

            obj.codeshares.push(
                $(this)
                    .text()
                    .replace(/[^\d\s\w]/gi, '')
                    .trim()
            );
        });

        // полезные данные, можно использовать в будущем для повышения качества и детализации
        obj.status_raw = $this.find('.flight-status').text().trim();
        obj.status = status_format(obj.status_raw, obj.type);
        obj.link = $this.find('a[href].card-flight__link').attr('href');

        items[id] = obj;
    });

    return items;
};

const list = () => {
    const offset = 50;

    const d = moment().tz(timezone);
    const f = 'YYYY-MM-DD';
    const dates = [
        d.format(f),
        d.clone().add(1, 'd').format(f),
        d.clone().add(2, 'd').format(f),
    ];

    let result = {};
    console.time('total time for all listings');
    // запускаем параллельно что бы ускорить, не привысив общее кол-во одновременных запросов
    async.each(
        ['departures', 'arrivals'],
        (type, next_type) => {
            // так же запускаем параллельно что бы ускорить
            async.each(
                dates,
                (date, next_date) => {
                    let ended = false;
                    let page = 0;
                    // листаем страницы поочереди, так как уже все даты и типы и так одновременно
                    async.until(
                        () => !!ended,
                        (next_page) => {
                            const url = `${base}/en/${type}/?date=${date}&offset=${
                                page * offset
                            }`;

                            let tries = 0;
                            async.retry(
                                max_retries,
                                (done) => {
                                    if (tries)
                                        console.log(
                                            `[retrying#${tries}] ${url}`
                                        );
                                    tries++;
                                    request.get(
                                        url,
                                        { proxy, headers, gzip: 1 },
                                        (e, r, html) => {
                                            // если ошибка, нет ответа или подозрительно короткий ответ - страница ошибки или защита CF
                                            if (
                                                e ||
                                                !html ||
                                                html.length < 5555
                                            )
                                                return done(true);

                                            const items = parse_list(html);
                                            if (
                                                Object.keys(items).length !== 50
                                            )
                                                ended = true;

                                            result = Object.assign(
                                                result,
                                                items
                                            );

                                            done();
                                        }
                                    );
                                },
                                () => {
                                    page++;
                                    next_page();
                                }
                            );
                        },
                        () => {
                            next_date();
                        }
                    );
                },
                () => {
                    next_type();
                }
            );
        },
        () => {
            console.timeEnd('total time for all listings');

            console.log(
                'total flights from listings: %s\n%j',
                Object.keys(result).length,
                Object.values(result).slice(0, 5)
            );

            details(result, () => {
                setTimeout(list, refresh_delay);
            });
        }
    );
};
list();

const parse_details = (html) => {
    if (!html) return {};
    const $ = cheerio.load(html);

    const obj = {};

    const dep_checkin =
        $('.flight-information__description--check-in').text().trim() ||
        undefined;
    if (dep_checkin && dep_checkin !== '-') obj.dep_checkin = dep_checkin;

    const reg_number =
        $('.aircraft-details__description:last-child').text().trim() ||
        undefined;
    if (reg_number && reg_number !== '-') obj.reg_number = reg_number;

    $('.flight-information__item').each(function () {
        const $this = $(this);
        if (
            /Baggage belt/im.test($this.find('.flight-information__h').text())
        ) {
            const arr_baggage =
                String(
                    $this.find('.flight-information__description').text() || ''
                ).trim() || undefined;
            if (arr_baggage && arr_baggage !== '-')
                obj.arr_baggage = arr_baggage;
        }
    });

    return obj;
};
const details = (result, done) => {
    const now = moment().tz(timezone).format(fmt);

    let requested = 0;
    let withresults = 0;
    // let debug = {};

    console.time('details');
    // берем детали не от всех рейсов а только где есть смысл
    async.eachLimit(
        Object.keys(result),
        max_limit,
        (id, next_flight) => {
            const flight = result[id];

            // так как checkin и reg_number появляеться примерно за 5 часов до вылета
            if (flight.type === 'departure') {
                // используем свежее время, если задерживается
                const diff = Math.abs(
                    moment(now, fmt).diff(
                        moment(flight.dep_estimated || flight.dep_time, fmt),
                        'hours'
                    )
                );
                if (diff > 5) return next_flight();
            }

            // baggage_belt так же появляеться только по прибытию
            if (flight.type === 'arrival') {
                if (flight.status !== 'landed') {
                    return next_flight();
                }
            }

            const url = `${base}${flight.link}`;

            let tries = 0;
            async.retry(
                max_retries,
                (done) => {
                    if (tries) console.log(`[retrying#${tries}] ${url}`);
                    tries++;
                    request.get(
                        url,
                        { proxy, headers, gzip: 1 },
                        (e, r, html) => {
                            // если ошибка, нет ответа или подозрительно короткий ответ - страница ошибки или защита CF
                            if (e || !html || html.length < 5555)
                                return done(true);

                            const detailed = parse_details(html);
                            requested++;

                            if (Object.keys(detailed).length) withresults++;

                            result[id] = Object.assign(result[id], detailed);
                            // debug[id] = Object.assign({}, result[id]);

                            done();
                        }
                    );
                },
                () => {
                    next_flight();
                }
            );
        },
        () => {
            console.log('total detailed requested: %s', requested);
            console.log(
                'total detailed requested with results: %s',
                withresults
            );
            console.timeEnd('details');

            // console.log('total detailed requested: %s\n%j', Object.keys(debug).length, Object.values(debug).slice(0, 5));

            redis.set(redis_key, JSON.stringify(Object.values(result)), done);
        }
    );
};
