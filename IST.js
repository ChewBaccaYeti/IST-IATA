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
    'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
    Origin: 'https://www.istairport.com',
    Referer:
        'https://www.istairport.com/en/flights/flight-info/departure-flights/?locale=en',
    'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
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
        console.log(`[${day}][redis] connected`.magenta.bold);
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

const setRedisData = (redis_KEY, new_FlightsArray, callback) => {
    const internationalFlights = new_FlightsArray.filter(
        (flight) => flight.isInternational === 1
    );

    const domesticFlights = new_FlightsArray.filter(
        (flight) => flight.isInternational === 0
    );

    redis.set(
        `${redis_KEY}:international`,
        JSON.stringify(internationalFlights),
        (err) => {
            if (err) {
                console.error(
                    `[${day}][redis] set error for international flights: %j`
                        .red.bold,
                    err
                );
            } else {
                console.log(
                    `[${day}][redis] International flights data set successfully`
                        .magenta.bold
                );
            }
        }
    );

    redis.set(
        `${redis_KEY}:domestic`,
        JSON.stringify(domesticFlights),
        (err) => {
            if (err) {
                console.error(
                    `[${day}][redis] set error for domestic flights: %j`.red
                        .bold,
                    err
                );
            } else {
                console.log(
                    `[${day}][redis] Domestic flights data set successfully`
                        .magenta.bold
                );
            }

            callback && callback();
        }
    );
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

function run() {
    const min_pageSize = 11;
    const max_pageSize = 45;
    const max_retries = 3;
    const retry_interval = 3000;
    let new_FlightsArray = [];
    let finished = false;

    async.eachLimit(
        Array.from({ length: max_pageSize }, (_, i) => i + 1),
        20,
        function (pageNumber, next_page) {
            async.eachSeries(
                [0, 1],
                function (status, next_status) {
                    async.eachSeries([0, 1], function (type, next_type) {
                        // заменил async.each на async.eachSeries
                        async.each(
                            dates,
                            function (date, next_date) {
                                let new_fieldsFlights;

                                let tries = 0;
                                async.retry(
                                    {
                                        times: max_retries,
                                        interval: retry_interval,
                                    },
                                    function (done) {
                                        if (tries)
                                            console.log(
                                                `[retrying#${tries}] ${base_URL}`
                                                    .yellow.bold
                                            );
                                        tries++;

                                        request.post(
                                            {
                                                url: base_URL,
                                                proxy,
                                                headers,
                                                formData: {
                                                    pageSize: max_pageSize,
                                                    pageNumber,
                                                    flightNature: status,
                                                    nature: type,
                                                    isInternational: status,
                                                    '': [
                                                        `date=${date}`,
                                                        `endDate=${date}`,
                                                    ],
                                                    searchTerm: 'changeflight',
                                                    culture: 'en',
                                                    prevFlightPage: '0',
                                                    clickedButton: 'moreFlight',
                                                },
                                            },
                                            function (error, response, body) {
                                                if (
                                                    error ||
                                                    !body ||
                                                    body.length < min_pageSize
                                                )
                                                    return done(true);

                                                const obj = JSON.parse(body);

                                                if (
                                                    !obj.result ||
                                                    !obj.result.data
                                                ) {
                                                    return done(true);
                                                }

                                                const flightsArray =
                                                    obj.result.data.flights;

                                                new_fieldsFlights =
                                                    flightsArray.map(
                                                        (flight) => ({
                                                            ...flight,
                                                            dep_checkin: null,
                                                            aircraft_type: null,
                                                            reg_number: null,
                                                            page_number:
                                                                pageNumber,
                                                        })
                                                    );

                                                new_FlightsArray.push(
                                                    ...new_fieldsFlights
                                                );

                                                console.log(
                                                    `Page ${pageNumber}, Date ${date}, Type ${type}, isInternational ${status}`
                                                        .blue.bold,
                                                    new_FlightsArray
                                                );
                                                console.log(
                                                    'Request completed successfully.'
                                                        .green.bold
                                                );
                                                console.log(
                                                    `Proxy is configured and request were made via proxy: ${proxy}`
                                                        .cyan.bold
                                                );
                                                done();

                                                setRedisData(
                                                    redis_KEY,
                                                    new_FlightsArray,
                                                    () => {
                                                        console.log(
                                                            `[${day}][redis] data saved in Redis successfully.`
                                                                .magenta.bold
                                                        );
                                                    }
                                                );
                                            }
                                        );
                                    }
                                );
                                next_date();
                            },
                            next_type
                        );
                    });
                    next_status();
                },
                next_page
            );
        }
    );
}
