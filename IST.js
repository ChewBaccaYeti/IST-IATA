const async = require('async');
const axios = require('axios').default;
const colors = require('colors').default;
const express = require('express');
const proxy = require('express-http-proxy');
const moment = require('moment-timezone');
const redis = require('redis');

const PORT = 3000;
const BASE_URL =
    'https://www.istairport.com/umbraco/api/FlightInfo/GetFlightStatusBoard';
const PROXY = 'http://iydv9uop:7rSHfY6iR6dBQRnX@proxy.proxy-cheap.com:31112';
const FMT = 'YYYY-MM-DD HH:mm';
const today = moment().format(FMT);
const tomorrow = moment().add(1, 'days').format(FMT);
const HEADERS = {
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

const redis_URL = 'redis://localhost:6379';
const redis_KEY = 'airport:Istanbul';

const TIMEZONE = 'Europe/Istanbul';

const app = express();

const proxyMiddleware = proxy(BASE_URL, {
    parseReqBody: false, // Disable body parsing to keep the original request body
    reqAsBuffer: true, // Keep the request body as a buffer
    timeout: 5000, // Timeout for the proxy request in milliseconds
    preserveHostHdr: true, // Preserve the host header of the original request
    limit: '10mb', // Limit the size of the response body
    userResDecorator: (proxyRes, proxyResData, userReq, userRes) => {
        return proxyResData;
    },
});

app.use(PROXY, proxyMiddleware);

app.use((req, res, next) => {
    res.setHeader(
        'Content-Security-Policy',
        `font-src 'self' data:; img-src 'self' data:; default-src 'self' http://localhost:${PORT}/`
    );
    next();
});

app.listen(proxyMiddleware, () => {
    console.log(
        `Proxy started [${moment().format('HH:mm')}]${PROXY} connected`.bgCyan
            .bold
    );
});

app.listen(PORT, () => {
    console.log(`Server started on port ${PORT}`.bgYellow.bold);
});

const pageCount = 10;

const generateRequestOptions = (pageNumber) => {
    return {
        method: 'POST',
        url: BASE_URL,
        headers: HEADERS,
        data: {
            nature: '1',
            searchTerm: 'changeflight',
            pageNumber: pageNumber,
            pageSize: pageCount,
            isInternational: '1',
            '': [`date=${today}`, `endDate=${tomorrow}`],
            culture: 'en',
            prevFlightPage: '0',
            clickedButton: 'moreFlight',
        },
    };
};

let flightsWithNewFields = [];

async.eachLimit(
    Array.from({ length: pageCount }, (_, i) => i + 1),
    20,
    (pageNumber, callback) => {
        const options = generateRequestOptions(pageNumber);
        let flightsWithNewFieldsPage;

        axios
            .request(options)
            .then((response) => {
                const flightsArray = response.data.result.data.flights;
                flightsWithNewFieldsPage = flightsArray.map((flight) => ({
                    ...flight,
                    dep_checkin: null,
                    aircraft_type: null,
                    reg_number: null,
                    page_number: pageNumber,
                }));
                flightsWithNewFields = flightsWithNewFields.concat(
                    flightsWithNewFieldsPage
                );
                console.log(
                    `Page ${pageNumber}:`.blue.bold,
                    flightsWithNewFieldsPage
                );
                callback();
            })
            .catch((error) => {
                console.error(
                    `Error on page ${pageNumber}:`.red.bold,
                    error.message
                );
                callback(error);
            })
            .finally(() => {
                try {
                    const client = redis.createClient({
                        url: redis_URL,
                        legacyMode: true,
                    });

                    client.on('connect', () => {
                        console.log(
                            `[${moment().format(
                                'HH:mm'
                            )}][redis] Redis connected`.bgMagenta.bold
                        );
                        console.log(
                            'Saving flights data to Redis...'.yellow.bold
                        );
                        console.log(
                            `Key: ${redis_KEY}, Value: ${flightsWithNewFields}`
                                .cyan.bold
                        );

                        const redis_flightsJSON =
                            JSON.stringify(flightsWithNewFields);
                        console.log(redis_flightsJSON);

                        client.set(
                            redis_KEY,
                            redis_flightsJSON,
                            (err, reply) => {
                                if (err) {
                                    console.error(
                                        `Error storing flights data in Redis: ${err}`
                                            .red.bold
                                    );
                                } else {
                                    console.log(
                                        `Flights data stored in Redis: ${reply}`
                                            .magenta.bold
                                    );
                                }
                            }
                        );
                    });
                } catch (error) {
                    console.error(
                        `[${moment().format('HH:mm')}][redis] Redis error: %j`
                            .bgRed.bold,
                        error
                    );
                }
            });
    },
    (err) => {
        if (err) {
            console.error('Error:'.red.bold, err);
        } else {
            console.log('All requests completed successfully.'.green.bold);
        }
    }
);
