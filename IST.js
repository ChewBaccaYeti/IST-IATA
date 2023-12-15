const async = require('async');
const axios = require('axios').default;
const { HttpsProxyAgent } = require('https-proxy-agent');
const colors = require('colors').default;
const express = require('express');
const moment = require('moment-timezone');

const PORT = 3000;
const BASE_URL =
    'https://www.istairport.com/umbraco/api/FlightInfo/GetFlightStatusBoard';
const PROXY_USERNAME = 'iydv9uop';
const PROXY_PASSWORD = '7rSHfY6iR6dBQRnX';
const PROXY = `http://${PROXY_USERNAME}:${PROXY_PASSWORD}@proxy.proxy-cheap.com:31112`;
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

const redis = require('redis')
    .createClient({
        url: redis_URL,
        legacyMode: true,
    })
    .on('connect', () => {
        console.log(
            `Key: ${redis_KEY}, [${today}][redis] connected`.bgMagenta.bold
        );
        console.log('Saving flights data to Redis...'.bgMagenta.bold);
    })
    .on('reconnecting', (p) =>
        console.log(`[${today}][redis] reconnecting: %j`.magenta.bold, p)
    )
    .on('error', (e) =>
        console.error(`[${today}][redis] error: %j`.red.bold, e)
    );

const TIMEZONE = 'Europe/Istanbul';

const app = express();

app.use((req, res, next) => {
    res.setHeader(
        'Content-Security-Policy',
        `font-src 'self' data:; img-src 'self' data:; default-src 'self' http://localhost:${PORT}/`
    );
    next();
});

app.listen(PORT, () => {
    console.log(`Server started on port ${PORT}`.bgYellow.bold);
});

const agent = new HttpsProxyAgent(PROXY);
const pageCount = 10;
let flightsWithNewFields = [];

axios.interceptors.request.use(
    (config) => {
        console.log(`Making request to ${config.url} via proxy.`.bgCyan.bold);
        return config;
    },
    (error) => {
        console.error(
            `Error in request interceptor: ${error.message}`.red.bold
        );
        return Promise.reject(error);
    }
);

const generateRequestOptions = (pageNumber) => {
    return {
        method: 'POST',
        url: BASE_URL,
        headers: {
            ...HEADERS,
            'Proxy-Authorization': `Basic ${Buffer.from(
                `${PROXY_USERNAME}:${PROXY_PASSWORD}`
            ).toString('base64')}`,
        },
        httpAgent: agent,
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
            });
    },
    (err) => {
        if (err) {
            console.error('Error:'.red.bold, err);
        } else {
            console.log('All requests completed successfully.'.green.bold);

            console.log(
                `Proxy is configured and requests were made via proxy: ${PROXY}`
                    .cyan.bold
            );
        }
    }
);
