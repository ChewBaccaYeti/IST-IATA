const async = require('async');
const request = require('request');
const colors = require('colors').default;
const express = require('express');
const moment = require('moment-timezone');

const port = 3000;
const base_URL =
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
};
const proxy = 'http://speej9xhkw:KbdCbB22xmdmxpG28k@dc.smartproxy.com:10000';
const FMT = 'YYYY-MM-DD HH:mm';
const TMZN = 'Europe/Istanbul';
const day = moment().tz(TMZN);
const dates = [day.format(FMT), day.clone().add(1, 'd').format(FMT)];

const redis_URL = 'redis://127.0.0.1:6379';
const redis_KEY = 'airports:istanbul';

const redis = require('redis')
    .createClient({
        url: redis_URL,
    })
    .on('connect', () => {
        console.log(`[${day}][redis] connected`.bgMagenta.bold);
        run();
    })
    .on('reconnecting', (p) =>
        console.log(`[${day}][redis] reconnecting: %j`.magenta.bold, p)
    )
    .on('error', (e) => console.error(`[${day}][redis] error: %j`.red.bold, e));

const app = express();

app.get('/schedules', (req, res) => {
    // http://localhost:3000/schedules - endpoint для получения расписания рейсов
    redis.get(redis_KEY, (e, reply) => {
        if (!reply) return res.status(404).json({ error: 'Data not found' });

        try {
            res.json(JSON.parse(reply));
        } catch (e) {
            res.status(500).json({ error: 'Internal Server Error' });
        }
    });
}).listen(port, () => {
    console.log(`Server started on port ${port}`.bgYellow.bold);
});

const setRedisData = (redis_KEY, data, callback) => {
    redis.set(redis_KEY, JSON.stringify(data), (err) => {
        if (err) {
            console.error(`[${day}][redis] set error: %j`.red.bold, err);
        } else {
            console.log(`[${day}][redis] data set successfully`.magenta.bold);
        }
        callback && callback();
    });
};

const shutdownSignal = () => {
    // Сигнал о завершении работы приложения
    console.log('\nReceived kill signal, shutting down gracefully.');

    redis && redis.end && redis.end(true);

    setTimeout(() => {
        console.error(
            'Could not close connections in time, forcefully shutting down.'
        );
        return process.exit(1);
    }, 9000);
};
process.once('SIGTERM', shutdownSignal); // listen for TERM signal .e.g. kill
process.once('SIGINT', shutdownSignal); // listen for INT signal .e.g. Ctrl-C

const min_pageSize = 11;
const max_pageSize = 45;
const max_retries = 3;
let new_FlightsArray = [];
let json_FlightsArray = [];

function run() {
    async.eachLimit(
        Array.from({ length: max_pageSize }, (_, i) => i + 1),
        20,
        (pageNumber, next_page) => {
            async.each(dates, (date, next_date) => {
                let new_fieldsFlights;
                let page = 0;
                let tries = 0;

                async.retry(
                    {
                        times: max_retries,
                        interval: 3000,
                        errorFilter: (err) => err.code === 'ETIMEDOUT',
                    },
                    (done) => {
                        const url = `${base_URL}/en/flights/flight-info/departure-flights/?date=${date}&offset=${
                            page * max_pageSize
                        }`;
                        if (tries) console.log(`[retrying#${tries}] ${url}`);
                        tries++;

                        request.post(
                            base_URL,
                            {
                                proxy,
                                headers,
                                formData: {
                                    nature: '1',
                                    searchTerm: 'changeflight',
                                    pageNumber,
                                    pageSize: max_pageSize,
                                    isInternational: '1',
                                    '': [`date=${date}`, `endDate=${date}`],
                                    culture: 'en',
                                    prevFlightPage: '0',
                                    clickedButton: 'moreFlight',
                                },
                            },
                            (error, response, body) => {
                                if (
                                    error ||
                                    !body ||
                                    body.length < min_pageSize
                                ) {
                                    console.error('Error:'.red.bold, error);
                                    done(error); // Прекращаем повторы при ошибке
                                } else {
                                    const obj = JSON.parse(body);
                                    const flightsArray =
                                        obj.result.data.flights;
                                    new_fieldsFlights = flightsArray.map(
                                        (flight) => ({
                                            ...flight,
                                            dep_checkin: null,
                                            aircraft_type: null,
                                            reg_number: null,
                                            page_number: pageNumber,
                                        })
                                    );
                                    new_FlightsArray.push(...new_fieldsFlights);
                                    json_FlightsArray =
                                        JSON.stringify(new_FlightsArray);

                                    console.log(
                                        `Page ${pageNumber}, Date ${date}`.blue
                                            .bold,
                                        new_FlightsArray
                                    );
                                    console.log(
                                        'Request completed successfully.'.green
                                            .bold
                                    );
                                    console.log(
                                        `Proxy is configured and request were made via proxy: ${proxy}`
                                            .cyan.bold
                                    );
                                    done(null, new_fieldsFlights); // Завершаем повторы при успешном выполнении
                                }
                            }
                        );
                    },
                    (err, result) => {
                        // Логика после успешного выполнения
                        next_date();
                    }
                );
            });
            next_page();
        }
    );
}

setRedisData(redis_KEY, json_FlightsArray, () => {
    console.log(
        `[${day}][redis] data saved in Redis successfully.`.magenta.bold
    );
});
