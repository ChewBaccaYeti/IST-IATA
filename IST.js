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
    "Referer": "https://www.istairport.com/en/flights/flight-info/departure-flights/?locale=en",
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
};
const proxy = 'http://speej9xhkw:KbdCbB22xmdmxpG28k@dc.smartproxy.com:10000';
const FMT = 'YYYY-MM-DD HH:mm';
const TMZN = 'Europe/Istanbul';
const day = moment().tz(TMZN);
const dates = [day.format(FMT), day.clone().add(1, 'd').format(FMT)];

const redis_url = 'redis://127.0.0.1:6379';
const redis_key = 'airports:istanbul';

const redis = require('redis')
    .createClient({url: redis_url,})
    .on('connect', () => {
        console.log(`[${day}][redis] connected`.magenta.bold);
        dataFlights(); // Вызов основной функции во время подкючения Редиса
    })
    .on('reconnecting', (p) => console.log(`[${day}][redis] reconnecting: %j`.magenta.bold, p))
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
        console.error('Could not close connections in time, forcefully shutting down.');
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
    let finished = false; // Флаг для остановки цикла async.until

    async.eachLimit(
        Array.from({ length: max_page_size }, (_, i) => i + 1), 20, (pageNumber, next_page) => {
            async.eachSeries(dates,(date, next_date) => {
                    async.eachSeries([0, 1], (type, next_type) => {
                        async.each([0, 1],(status, next_status) => {

                                let newFieldsFlights;
                                let tries = 0;

                                async.until(function test(cb) {
                                        cb(null, finished)
                                    }, function iter(done) {
                                        async.retry(max_retries, (retryDone) => {
                                                if (tries) console.log(`[retrying#${tries}] ${base_url}`.yellow.bold);
                                                tries++;

                                                request.post(
                                                    {
                                                        url: base_url,
                                                        proxy,
                                                        headers,
                                                        formData: {
                                                            pageSize:max_page_size,
                                                            pageNumber,
                                                            '': [
                                                                `date=${date}`,
                                                                `endDate=${date}`,
                                                            ],
                                                            nature: type,
                                                            flightNature: type, // 0 - departure, 1 - arrival
                                                            isInternational: status, // 0 - domestic, 1 - international
                                                            searchTerm: 'changeflight',
                                                            culture: 'en',
                                                            prevFlightPage: '0',
                                                            clickedButton: 'moreFlight',
                                                        },
                                                    },
                                                    (error, response, body) => {
                                                        if (
                                                            error ||
                                                            !body ||
                                                            body.length < min_page_size
                                                        ) {
                                                            // В случае ошибки, отсутствия данных или слишком мало данных, то пробуем ещё раз
                                                            return retryDone(true);
                                                        }

                                                        const obj = JSON.parse(body);

                                                        if (
                                                            !obj.result ||
                                                            !obj.result.data
                                                        ) {
                                                            // В случае, если данные не парсятся или не приходит ответ
                                                            return retryDone(true);
                                                        }

                                                        const flightsArray = obj.result.data.flights;

                                                        newFieldsFlights =
                                                            flightsArray.map(
                                                                (flight) => ({
                                                                    // ...flight, // Оригинальный массив данных
                                                                    // Нужный формат данных, для сравнения оставил массив выше. Значение самих ключей брал из оригинального массива.
                                                                    airline_iata: flight.airlineCode,
                                                                    airline_icao: flight.airlineName,
                                                                    flight_iata: flight.airlineCode,
                                                                    flight_icao: flight.airlineName,
                                                                    flight_number: flight.flightNumber,
                                                                    cs_airline_iata: flight.airlineCodeList,
                                                                    cs_flight_number: flight.codeshare,
                                                                    cs_flight_iata: '',
                                                                    dep_iata: flight.fromCityCode,
                                                                    dep_icao: flight.fromCityName,
                                                                    dep_terminal: flight.carousel,
                                                                    dep_gate: flight.gate,

                                                                    dep_time: flight.scheduledDatetime,
                                                                    dep_time_ts: new Date(flight.scheduledDatetime ).getTime() / 1000,
                                                                    dep_time_utc: flight.scheduledDatetime,
                                                                    dep_estimated: flight.estimatedDatetime,
                                                                    dep_estimated_ts: new Date(flight.estimatedDatetime ).getTime() / 1000,
                                                                    dep_estimated_utc: flight.estimatedDatetime,
                                                                    dep_actual: flight.estimatedDatetime,
                                                                    dep_actual_ts: new Date(flight.estimatedDatetime ).getTime() / 1000,
                                                                    dep_actual_utc: flight.estimatedDatetime,

                                                                    arr_iata: flight.toCityCode,
                                                                    arr_icao: flight.toCityName,
                                                                    arr_terminal: '',
                                                                    arr_gate: '',
                                                                    arr_baggage: '',

                                                                    arr_time: flight.scheduledDatetime,
                                                                    arr_time_ts: new Date(flight.scheduledDatetime ).getTime() / 1000,
                                                                    arr_time_utc: flight.scheduledDatetime,
                                                                    arr_estimated: flight.estimatedDatetime,
                                                                    arr_estimated_ts: new Date(flight.estimatedDatetime ).getTime() / 1000,
                                                                    arr_estimated_utc: flight.estimatedDatetime,
                                                                    arr_actual: flight.estimatedDatetime,
                                                                    arr_actual_ts: new Date(flight.estimatedDatetime ).getTime() / 1000,
                                                                    arr_actual_utc: flight.estimatedDatetime,

                                                                    status: flight.remark,
                                                                    duration: '',
                                                                    delayed: flight.remarkCode,
                                                                    dep_delayed: flight.remarkColorCode,
                                                                    arr_delayed: '',

                                                                    // Новые ключи, значений нет, прописал null
                                                                    dep_checkin: null,
                                                                    aircraft_type: null,
                                                                    reg_number: flight.flightNumber,

                                                                    // Ключи для проверки фильтрации по методам async, позже сотру
                                                                    page_number: pageNumber,
                                                                    flightNature: flight.flightNature,
                                                                    isInternational: flight.isInternational,
                                                                })
                                                            );

                                                        newFlightsArray.push(...newFieldsFlights); // Добавляем новые данные в массив, в данном случае новые данные добавляются в конец массива, однако больше имеет смысл когда приходит оригинальный массив

                                                        console.log(`Page ${pageNumber}, Date ${date}`.blue.bold,
                                                            newFlightsArray);
                                                        console.log('Request completed successfully.'.green.bold);
                                                        console.log(`Proxy is configured and request were made via proxy: ${proxy}`.cyan.bold);

                                                        finished = true;
                                                        retryDone();
                                                    }
                                                );
                                            },
                                            function iterCallback() {
                                                done();
                                            }
                                        );
                                    },
                                    function testCallback() {
                                        next_status();
                                    }
                                );
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