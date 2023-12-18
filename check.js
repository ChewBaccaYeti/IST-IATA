const express = require('express');
const request = require('request');
const moment = require('moment-timezone');
const async = require('async');
const colors = require('colors');
const cheerio = require('cheerio');
const _ = require('lodash');

const port = 3000;
const redis_url = 'redis://localhost:6379';
const redis_key = 'airports:istanbul';

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

const proxy = 'http://iydv9uop:7rSHfY6iR6dBQRnX@proxy.proxy-cheap.com:31112';
const base =
    'https://www.istairport.com/umbraco/api/FlightInfo/GetFlightStatusBoard';
const headers = {
    Accept: 'application/json, text/javascript, */*; q=0.01',
    'Accept-Language': 'ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7',
    Connection: 'keep-alive',
    'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
    Cookie: '_gid=GA1.2.71353474.1702211813; _tt_enable_cookie=1; _ttp=xHAyXcBhbyteIoU2ncI_HxvtGOk; _gcl_au=1.1.1202715006.1702211813; _fbp=fb.1.1702377723947.286767234; iga_bid=MDMAAAEA9GgnCQAAAACVPtCkU194ZQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABgnK4NbB2b11gnu4AkaqHloFvxp; _ga_2KDDX4ZQVX=GS1.1.1702387577.9.1.1702387581.0.0.0; _gat_gtag_UA_129306132_1=1; _ga=GA1.1.1547759267.1702211813; _ga_V39SG6FNFF=GS1.1.1702387577.8.1.1702387581.56.0.0',
    DNT: '1',
    Origin: 'https://www.istairport.com',
    Referer:
        'https://www.istairport.com/en/flights/flight-info/departure-flights/?locale=en',
    'Sec-Fetch-Dest': 'empty',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Site': 'same-origin',
    'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'X-Requested-With': 'XMLHttpRequest',
    'sec-ch-ua': '^^Not_A',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '^^Windows^^',
    'Content-Encoding': 'gzip',
};
const tmzn = 'Europe/Istanbul';
const fmt = 'YYYY-MM-DD HH:mm';
const now = moment().tz(tmzn);

const refresh_delay = 20 * 60 * 1000;
const max_retries = 3;
const max_limit = 10;

const list = () => {
    const offset = 20;

    const n = now;
    const f = fmt;
    const dates = [n.format(f), n.clone().add(1, 'd').format(f)];

    let result = {};
    console.time('total time for all listings');
    // запускаем параллельно что бы ускорить, не привысив общее кол-во одновременных запросов
    async.each(
        ['international', 'domestic'],
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

const details = (result, done) => {
    const now = moment().tz(tmzn).format(fmt);

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
