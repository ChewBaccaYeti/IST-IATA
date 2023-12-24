const async = require('async');
const request = require('request');
const colors = require('colors').default;
const express = require('express');
const moment = require('moment-timezone');

const port = 3000;
const base_url = 'https://www.istairport.com/umbraco/api/FlightInfo/GetFlightStatusBoard';
const headers = {
    "Accept": "application/json, text/javascript, */*; q=0.01",
    "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
    "Origin": "https://www.istairport.com",
    "Referer":
        "https://www.istairport.com/en/flights/flight-info/departure-flights/?locale=en",
    "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
};
const proxy = 'http://speej9xhkw:KbdCbB22xmdmxpG28k@dc.smartproxy.com:10000';
const FMT = 'YYYY-MM-DD HH:mm';
const TMZN = 'Europe/Istanbul';
const day = moment().tz(TMZN);
const dates = [day.format(FMT), day.clone().add(1, 'd').format(FMT)];

const redis_url = 'redis://127.0.0.1:6379';
const redis_key = 'airports:istanbul';

const redis = require('redis')
    .createClient({
        url: redis_url,
    })
    .on('connect', () => {
        console.log(`[${day}][redis] connected`.magenta.bold);
        dataFlights(); // Вызов основной функции во время подкючения Редиса
    })
    .on('reconnecting', (p) =>
        console.log(`[${day}][redis] reconnecting: %j`.magenta.bold, p)
    )
    .on('error', (e) => console.error(`[${day}][redis] error: %j`.red.bold, e));

const app = express();

app.get('/schedules', (req, res) => {
    // http://localhost:3000/schedules - endpoint для получения расписания рейсов
    redis.get(redis_key, (e, reply) => {
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

// Функция для работы с расписанием, записывает данные в Редис
const setRedisData = (redis_key, newFlightsArray, callback) => {
    redis.set(redis_key, JSON.stringify(newFlightsArray), (err) => {
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

function dataFlights() {
    const min_page_size = 11;
    const max_page_size = 45;
    const max_retries = 3;
    let newFlightsArray = [];
    let finished = false;

    async.eachLimit(
        Array.from({ length: max_page_size }, (_, i) => i + 1),
        20,
        (pageNumber, next_page) => {
            async.eachSeries(
                dates,
                (date, next_date) => {
                    async.eachSeries(
                        [0, 1], 
                        (type, next_type) => {
                        async.each(
                            [0, 1],
                            (status, next_status) => {

                                let newFieldsFlights;
                                let tries = 0;
                                
                                async.retry(max_retries, (done) => { if (tries)
                                console.log(
                                            `[retrying#${tries}] ${base_url}`
                                                .yellow.bold
                                            );
                                        tries++;

                                        request.post(
                                            {
                                                url: base_url,
                                                proxy,
                                                headers,
                                                formData: {
                                                    pageSize: max_page_size,
                                                    pageNumber,
                                                    '': [
                                                        `date=${date}`,
                                                        `endDate=${date}`,
                                                    ],
                                                    flightNature: status,
                                                    nature: type,
                                                    isInternational: status,
                                                    searchTerm: 'changeflight',
                                                    culture: 'en',
                                                    prevFlightPage: '0',
                                                    clickedButton: 'moreFlight',
                                                },
                                            },
                                            (error, response, body) => {
                                                // В случае ошибки, отсутствия данных или слишком мало данных, то пробуем ещё раз
                                                if (
                                                    error ||
                                                    !body ||
                                                    body.length < min_page_size
                                                )
                                                    return done(true);

                                                const obj = JSON.parse(body);

                                                // В случае если данные не парсятся или не приходит ответ
                                                if (
                                                    !obj.result ||
                                                    !obj.result.data
                                                ) {
                                                    return done(true);
                                                }

                                                //  Массив-родитель
                                                const flightsArray =
                                                    obj.result.data.flights;

                                                newFieldsFlights =
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
                                                // Конечный результат, массив данных после прогонки и парсинга с мапингом
                                                newFlightsArray.push(
                                                    ...newFieldsFlights
                                                );

                                                // Вывожу в консоль результаты для наглядности
                                                console.log(
                                                    `Page ${pageNumber}, Date ${date}, Type ${type}, isInternational ${status}`
                                                        .blue.bold,
                                                    newFlightsArray
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

                                                // Сохраняю данные в Redis
                                                setRedisData(
                                                    redis_key,
                                                    newFlightsArray,
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
                                next_status();
                            },
                            next_type
                        );
                    });
                    next_date();
                },
                next_page
            );
        }
    );
}
