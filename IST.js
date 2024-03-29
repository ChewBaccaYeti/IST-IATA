const async = require('async');
const colors = require('colors').default;
const express = require('express');
const fs = require('fs/promises');
const moment = require('moment-timezone');
const morgan = require('morgan');
const request = require('request');

const port = 11288;
const base_url = 'https://www.istairport.com/umbraco/api/FlightInfo/GetFlightStatusBoard';
const headers = {
    'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
    'Referer': 'https://www.istairport.com/en/flights/flight-info/departure-flights/?locale=en',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
};
const proxy = 'http://speej9xhkw:KbdCbB22xmdmxpG28k@dc.smartproxy.com:10000';
const frmt = 'YYYY-MM-DD HH:mm:ss';
const tmzn = 'Europe/Istanbul';
const day = moment().tz(tmzn);
const dates = [day.format(frmt), day.clone().add(1, 'd').format(frmt)];

const redis_url = 'redis://127.0.0.1:6379';
const redis_key = 'airports:istanbul';

const redis = require('redis')
    .createClient({ url: redis_url, })
    .on('connect', () => {
        console.log(`[${day}][redis] connected`.magenta);
        dataFlights(); // Вызов основной функции во время подкючения Редиса
    })
    .on('reconnecting', (p) => console.log(`[${day}][redis] reconnecting: %j`.magenta, p))
    .on('error', (e) => console.error(`[${day}][redis] error: %j`.bgRed.bold, e));

redis.del(redis_key, (err, reply) => {
    if (err) {
        console.error(`[${day}][redis] delete error: %j`.bgRed.bold, err);
    } else {
        console.log(`[${day}][redis] data deleted successfully.`.magenta);
    }
})

const app = express();
// http://localhost:3000/schedules - endpoint для получения расписания рейсов
app.get('/schedules', (req, res) => {
    redis.get(redis_key, (error, reply) => {
        // Вывод в консоль новых данных после каждого обновления хоста в браузере
        console.log('Reply from Redis:', JSON.parse(reply));
        if (!reply) {
            return res.status(404).json({ error: 'Data not found.' });
        };
        try {
            res.json({
                status: 'success',
                code: 200,
                data: {
                    result: JSON.parse(reply)
                }
            });
        } catch (error) {
            res.status(500).json({ error: 'Internal Server Error.' });
        }
    });
}).use((req, res, next) => {
    const { method, url } = req;
    const date = moment().format(frmt);
    try {
        fs.appendFile('./public/server.log', `\n${method} ${url} ${date}`);
    } catch (error) {
        console.error(`Error writing to log file: ${error}`.bgRed.bold);
    }
    next();
}).use(morgan('dev')).listen(port, () => {
    console.log(`Server started on port ${port}`.yellow);
});

// Функция для работы с расписанием, записывает данные в Редис
const setRedisData = (redis_key, newFlightsArray, callback) => {
    redis.set(redis_key, JSON.stringify(newFlightsArray), (err) => {
        if (err) {
            console.error(`[${day}][redis] set error: %j`.bgRed.bold, err);
            return callback && callback(err);
        } else {
            console.log(`[${day}][redis] data set successfully.`.magenta);
        }
        callback && callback();
    });
};

const shutdownSignal = () => {
    // Сигнал о завершении работы приложения
    console.log('\nReceived kill signal, shutting down gracefully.');

    redis && redis.end && redis.end(true);

    setTimeout(() => {
        console.error('Could not close connections in time, forcefully shutting down.'.red.bold);
        return process.exit(1);
    }, 5000);
};
process.once('SIGTERM', shutdownSignal); // listen for TERM signal .e.g. kill
process.once('SIGINT', shutdownSignal); // listen for INT signal .e.g. Ctrl-C

function dataFlights() {
    const min_body_length = 10;
    const max_page_size = 50;
    const max_retries = 3;

    let newFlightsArray = [];
    let finished = false; // Флаг для остановки цикла async.until
    let pageNumber = 1;

    async.eachLimit(dates, 20, (date, next_date) => {
        async.each([1, 0], (status, next_status) => {
            async.each([0, 1], (type, next_type) => {

                let tries = 0;
                async.until((cb) => { // test 
                    cb(null, finished) // iter
                }, (until_done) => {
                    async.retry(max_retries, (retry_done) => {
                        if (tries) console.log(`[retrying#${tries}] ${base_url}`.yellow);
                        tries++;

                        request.post(
                            {
                                url: base_url,
                                proxy: proxy,
                                headers: headers,
                                formData: {
                                    pageNumber: pageNumber,
                                    pageSize: max_page_size,
                                    '': [
                                        `date=${date}`,
                                        `endDate=${date}`,
                                    ],
                                    flightNature: status, // 1 - departure, 0 - arrival
                                    isInternational: type, // 0 - domestic, 1 - international
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
                                    body.length < min_body_length
                                ) {
                                    // В случае ошибки, отсутствия данных или слишком мало данных, то пробуем ещё раз
                                    return retry_done(true);
                                }
                                pageNumber++;

                                try {
                                    const obj = JSON.parse(body);
                                    if (
                                        !obj.result ||
                                        !obj.result.data
                                    ) {
                                        // В случае, если данные не парсятся или не приходит ответ
                                        console.log('body:'.bgRed, body);
                                        console.dir(obj);
                                        return retry_done(true);
                                    }

                                    const flightsArray = obj.result.data.flights;
                                    // Разглаживаю массив для получения всех рейсов, если они есть внутри 
                                    const newFlightsFields = flightsArray.flatMap((flight) => {
                                        const general_fields = {
                                            // 'aircraft_icao': '' || null,
                                            'airline_iata': status === 0 ? flight.airlineCode : status === 1 ? flight.airlineCode : null,
                                            // 'airline_icao': '' || null,
                                            'flight_iata': status === 0 ? flight.flightNumber : status === 1 ? flight.flightNumber : null,
                                            // 'flight_icao': '' || null,
                                            'flight_number': status === 0 ? flight.flightNumber.slice(2) : status === 1 ? flight.flightNumber.slice(2) : null,
                                            'status': flight.remark ? flight.remark.toLowerCase() : null,
                                            'duration':
                                                moment(status === 0 ? moment.tz(tmzn).utc(flight.scheduledDatetime).format(frmt) : null,)
                                                    .diff(moment(status === 1 ? moment.tz(tmzn).utc(flight.estimatedDatetime).format(frmt) : null,)) || null,
                                            'delayed':
                                                status === 0 ? (Math.abs(moment(flight.scheduledDatetime, frmt).diff(moment(flight.estimatedDatetime, frmt), 'minutes')) || null) : null ||
                                                    status === 1 ? (Math.abs(moment(flight.scheduledDatetime, frmt).diff(moment(flight.estimatedDatetime, frmt), 'minutes')) || null) : null,
                                        };
                                        const cs_fields = {
                                            'cs_airline_iata': null,
                                            'cs_flight_iata': null,
                                            'cs_flight_number': null,
                                        };
                                        const arr_fields = {
                                            'arr_baggage': flight.carousel || null,
                                            'arr_delayed': status === 0 ? (Math.abs(moment(flight.scheduledDatetime, frmt).diff(moment(flight.estimatedDatetime, frmt), 'minutes')) || null) : null,
                                            'arr_gate': status === 0 ? flight.gate : null,
                                            'arr_iata': flight.toCityCode || null,
                                            // 'arr_icao': flight.toCityName || null,
                                            'arr_terminal': status === 0 ? flight.gate.charAt(0) : null,
                                            'arr_time': status === 0 ? moment(flight.scheduledDatetime).format(frmt) : null,
                                            'arr_time_ts': status === 0 ? moment(flight.scheduledDatetime).tz(tmzn).unix() : null,
                                            'arr_time_utc': status === 0 ? moment.tz(tmzn).utc(flight.scheduledDatetime).format(frmt) : null,
                                            // 'arr_estimated': status === 0 ? moment(flight.estimatedDatetime).format(frmt) : null,
                                            // 'arr_estimated_ts': status === 0 ? moment(flight.estimatedDatetime).tz(tmzn).unix() : null,
                                            // 'arr_estimated_utc': status === 0 ? moment.tz(tmzn).utc(flight.estimatedDatetime).format(frmt) : null,
                                            // 'arr_actual': status === 0 ? moment(flight.estimatedDatetime).format(frmt) : null,
                                            // 'arr_actual_ts': status === 0 ? moment(flight.estimatedDatetime).tz(tmzn).unix() : null,
                                            // 'arr_actual_utc': status === 0 ? moment.tz(tmzn).utc(flight.estimatedDatetime).format(frmt) : null,
                                        };
                                        const dep_fields = {
                                            'dep_checkin': status === 1 ? flight.counter : null,
                                            'dep_delayed': status === 1 ? (Math.abs(moment(flight.scheduledDatetime, frmt).diff(moment(flight.estimatedDatetime, frmt), 'minutes')) || null) : null,
                                            'dep_gate': status === 1 ? flight.gate : null,
                                            'dep_iata': flight.fromCityCode || null,
                                            // 'dep_icao': flight.fromCityName || null,
                                            'dep_terminal': status === 1 ? flight.gate.charAt(0) : null,
                                            'dep_time': status === 1 ? moment(flight.scheduledDatetime).format(frmt) : null,
                                            'dep_time_ts': status === 1 ? moment(flight.scheduledDatetime).tz(tmzn).unix() : null,
                                            'dep_time_utc': status === 1 ? moment.tz(tmzn).utc(flight.scheduledDatetime).format(frmt) : null,
                                            // 'dep_estimated': status === 1 ? moment(flight.estimatedDatetime).format(frmt) : null,
                                            // 'dep_estimated_ts': status === 1 ? moment(flight.estimatedDatetime).tz(tmzn).unix() : null,
                                            // 'dep_estimated_utc': status === 1 ? moment.tz(tmzn).utc(flight.estimatedDatetime).format(frmt) : null,
                                            // 'dep_actual': status === 1 ? moment(flight.estimatedDatetime).format(frmt) : null,
                                            // 'dep_actual_ts': status === 1 ? moment(flight.estimatedDatetime).tz(tmzn).unix() : null,
                                            // 'dep_actual_utc': status === 1 ? moment.tz(tmzn).utc(flight.estimatedDatetime).format(frmt) : null,
                                        };
                                        const original_flight = {
                                            ...general_fields,
                                            ...cs_fields,
                                            ...arr_fields,
                                            ...dep_fields,
                                        };
                                        const flights_bucket = {
                                            ...original_flight,
                                        };
                                        // Фильтруем по статусу и добавляем родителя в массив
                                        if (status === 1 ? flight : status === 0 ? flight : null) {
                                            console.log('Adding parent:', flights_bucket);
                                            newFlightsArray.push(flights_bucket);
                                            // Добавляем детей в массив, если они есть
                                            if (flight.codeshare && flight.codeshare.length > 0) {
                                                console.log('Adding children:', flight.codeshare);
                                                newFlightsArray.push(...flight.codeshare.map((code) => ({
                                                    ...flights_bucket,
                                                    'cs_airline_iata': flights_bucket.airline_iata || null,
                                                    'cs_flight_number': flights_bucket.flight_number || null,
                                                    'cs_flight_iata': flights_bucket.flight_iata || null,
                                                    'airline_iata': status === 0 ? code.slice(0, 2) : status === 1 ? code.slice(0, 2) : null,
                                                    'flight_iata': status === 0 ? code : status === 1 ? code : null,
                                                    'flight_number': status === 0 ? code.slice(2, 6) : status === 1 ? code.slice(2, 6) : null,
                                                })));
                                            }
                                            return flights_bucket;
                                        }
                                    });

                                    function findAndRemoveDuplicatesByKey(arr, key) {
                                        const duplicates = [];
                                        const uniqueItems = [];
                                        for (let i = 0; i < arr.length; i++) {
                                            let isDuplicate = false;
                                            for (let j = i + 1; j < arr.length; j++) {
                                                if (arr[i][key] === arr[j][key]) {
                                                    duplicates.push({ duplicate1: arr[i], duplicate2: arr[j] });
                                                    isDuplicate = true;
                                                    break;
                                                }
                                            }
                                            if (!isDuplicate) {
                                                uniqueItems.push(arr[i]);
                                            }
                                        }
                                        return { duplicates, uniqueItems };
                                    }

                                    const { duplicates, uniqueItems } = findAndRemoveDuplicatesByKey(newFlightsArray, 'flight_iata');
                                    if (duplicates.length > 0) {
                                        console.log('Duplicates found:', duplicates);
                                        console.log('Unique items:', uniqueItems);
                                        //Удаляю дубликаты из исходного массива, заменив его уникальными рейсами
                                        newFlightsArray = uniqueItems;
                                    } else {
                                        console.log('No duplicates found.');
                                    }

                                    if (newFlightsFields.length >= max_page_size) {
                                        finished = false;
                                        console.log('Loop is still running...'.bgYellow);
                                    } else {
                                        finished = true;
                                        console.log('Loop is over.'.bgBlue);
                                    }
                                    retry_done();

                                    if (newFlightsFields.length > 0) {
                                        console.log(`Page ${pageNumber}, Date ${date}`.blue, newFlightsFields);
                                        console.log('Request completed successfully.'.green);
                                        console.log(`Proxy is configured and request were made via proxy: ${proxy}`.cyan);
                                    }
                                    return newFlightsArray;

                                } catch (error) {
                                    console.error(`[error] ${error}`.red.bold);
                                    return retry_done(true);
                                }
                            }, retry_done);
                    }, until_done);
                }, () => {
                    setRedisData(redis_key, newFlightsArray, (err) => {
                        if (err) {
                            console.error('Error while saving data to Redis:'.bgRed.bold, err);
                        } else {
                            console.log(`[${day}][redis] data saved successfully.`.magenta);
                        }
                    });
                }, next_type());
            }, next_status());
        }, next_date());
    });
}