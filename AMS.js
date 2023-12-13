const async = require('async');
const axios = require('axios').default;
const cheerio = require('cheerio');
const colors = require('colors').default;
const express = require('express');
const proxy = require('express-http-proxy');
const moment = require('moment-timezone');
const _ = require('lodash');

const BASE_URL =
    'https://www.istairport.com/umbraco/api/FlightInfo/GetFlightStatusBoard';
const FMT = 'YYYY-MM-DD HH:mm';
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
const PORT = 3000;
const PROXY = 'http://iydv9uop:7rSHfY6iR6dBQRnX@proxy.proxy-cheap.com:31112';
const REDIS_KEY = 'airports:Istanbul';
const REDIS_URL = 'redis://localhost:8080';
const TIMEZONE = 'Europe/Istanbul';

const today = moment().format('YYYY-MM-DD');
const tomorrow = moment().add(1, 'days').format('YYYY-MM-DD');

const app = express();

const proxyMiddleware = proxy(BASE_URL, {
    parseReqBody: false, // Disable body parsing to keep original request body
    reqAsBuffer: true, // Keep the request body as a buffer
    timeout: 2000, // Timeout for the proxy request in milliseconds
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
    console.log(`Proxy started`.bgMagenta.bold);
    console.log(
        `[${moment().format('HH:mm')}]${PROXY} connected`.bgMagenta.bold
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

async.eachLimit(
    Array.from({ length: pageCount }, (_, i) => i + 1),
    20,
    (pageNumber, callback) => {
        const options = generateRequestOptions(pageNumber);
        axios
            .request(options)
            .then((response) => {
                const flightsArray = response.data.result.data.flights;
                const flightsWithNewFields = flightsArray.map((flight) => {
                    return {
                        ...flight,
                        dep_checkin: null,
                        aircraft_type: null,
                        reg_number: null,
                        page_number: pageNumber,
                    };
                });
                console.log(
                    `Page ${pageNumber}:`.blue.bold,
                    flightsWithNewFields
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
        }
    }
);
