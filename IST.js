const async = require("async");
const request = require("request");
const colors = require("colors").default;
const express = require("express");
const moment = require("moment-timezone");

const port = 3000;
const base_url = "https://www.istairport.com/umbraco/api/FlightInfo/GetFlightStatusBoard";
const headers = {
    "Accept": "application/json, text/javascript, */*; q=0.01",
    "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
    "Origin": "https://www.istairport.com",
    "Referer": "https://www.istairport.com/en/flights/flight-info/departure-flights/?locale=en",
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
};
const proxy = "http://speej9xhkw:KbdCbB22xmdmxpG28k@dc.smartproxy.com:10000";
const FMT = "YYYY-MM-DD HH:mm";
const TMZN = "Europe/Istanbul";
const day = moment().tz(TMZN);
const dates = [day.format(FMT), day.clone().add(1, "d").format(FMT)];

const redis_url = "redis://127.0.0.1:6379";
const redis_key = "airports:istanbul";

const redis = require("redis")
    .createClient({url: redis_url,})
    .on("connect", () => {
        console.log(`[${day}][redis] connected`.magenta.bold);
        dataFlights(); // Вызов основной функции во время подкючения Редиса
    })
    .on("reconnecting", (p) => console.log(`[${day}][redis] reconnecting: %j`.magenta.bold, p))
    .on("error", (e) => console.error(`[${day}][redis] error: %j`.red.bold, e));

redis.del(redis_key, (err, reply) => {
    if (err) {
        console.error(`[${day}][redis] delete error: %j`.red.bold, err);
    } else {
        console.log(`[${day}][redis] data deleted successfully`.magenta.bold);
    }
})

const app = express();

app.get("/schedules", (req, res) => {
    // http://localhost:3000/schedules - endpoint для получения расписания рейсов
    redis.get(redis_key, (e, reply) => {
        if (!reply) return res.status(404).json({ error: "Data not found" });

        try {
            res.json(JSON.parse(reply));
        } catch (e) {
            res.status(500).json({ error: "Internal Server Error" });
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
    console.log("\nReceived kill signal, shutting down gracefully.");

    redis && redis.end && redis.end(true);

    setTimeout(() => {
        console.error("Could not close connections in time, forcefully shutting down.");
        return process.exit(1);
    }, 9000);
};
process.once("SIGTERM", shutdownSignal); // listen for TERM signal .e.g. kill
process.once("SIGINT", shutdownSignal); // listen for INT signal .e.g. Ctrl-C

function dataFlights() {
    const min_body_length = 11;
    const max_page_size = 50;
    const max_retries = 3;

    let newFlightsArray = [];
    let finished = false; // Флаг для остановки цикла async.until

    pageNumber = 0;
    async.eachSeries(dates, (date, next_date) => {
        async.eachSeries([0, 1], (status, next_status) => {
            async.each([0, 1], (type, next_type) => {

                    let newFieldsFlights;
                    let tries = 0;

                    async.until(
                        (cb) => { // test 
                            cb(null, finished);
                        },
                        (done) => { // iter 
                            async.retry(max_retries, (retry_done) => {
                                    if (tries) console.log(`[retrying#${tries}] ${base_url}`.yellow.bold);
                                    tries++;

                                    request.post(
                                        {
                                            url: base_url,
                                            proxy,
                                            headers,
                                            formData: {
                                                pageNumber,
                                                pageSize: max_page_size,
                                                "": [
                                                    `date=${date}`,
                                                    `endDate=${date}`,
                                                ],
                                                nature: status,
                                                flightNature: status, // 0 - departure, 1 - arrival
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
                                                    return retry_done(true);
                                                }

                                                const flightsArray = obj.result.data.flights;

                                                newFieldsFlights = flightsArray.map((flight) => ({
                                                            // ...flight, // Оригинальный массив данных
                                                            // Нужный формат данных, для сравнения оставил массив выше. Значение самих ключей брал из оригинального массива.
                                                            aircraft_icao: "" || null,
                                                            airline_iata: flight.airlineCode, //✅
                                                            airline_icao: "" || null, //❌
                                                            arr_baggage: flight.carousel, //✅
                                                            arr_delayed:  "" || null,
                                                            arr_estimated: status === 1 ? moment(flight.estimatedDatetime).format(FMT) : null,
                                                            arr_estimated_ts: status === 1 ? moment(flight.estimatedDatetime).unix() : null,
                                                            arr_estimated_utc: status === 1 ? moment.utc(flight.estimatedDatetime).format(FMT) : null,
                                                            arr_gate: status === 1 ? flight.gate : null, //✅
                                                            arr_iata: flight.toCityCode || null, //✅
                                                            arr_icao: flight.toCityName || null, //✅
                                                            arr_terminal: status === 1 ? "" : null, //?✅
                                                            arr_time: status === 1 ? moment(flight.scheduledDatetime).format(FMT) : null,
                                                            arr_time_ts: status === 1 ? moment(flight.scheduledDatetime).unix() : null,
                                                            arr_time_utc: status === 1 ? moment.utc(flight.scheduledDatetime).format(FMT) : null,
                                                            arr_actual: status === 1 ? moment(flight.estimatedDatetime).format(FMT) : null,
                                                            arr_actual_ts: status === 1 ? moment(flight.estimatedDatetime).unix() : null,
                                                            arr_actual_utc: status === 1 ? moment.utc(flight.estimatedDatetime).format(FMT) : null,
                                                            cs_airline_iata: "" || null, //❌
                                                            cs_flight_number: "" || null, //❌
                                                            cs_flight_iata: "" || null, //❌
                                                            delayed: flight.remarkCode || null,
                                                            dep_actual: status === 0 ? moment(flight.estimatedDatetime).format(FMT) : null,
                                                            dep_actual_ts: status === 0 ? moment(flight.estimatedDatetime).unix() : null,
                                                            dep_actual_utc: status === 0 ? moment.utc(flight.estimatedDatetime).format(FMT) : null,
                                                            dep_delayed: flight.remarkColorCode || null,
                                                            dep_estimated: status === 0 ? moment(flight.estimatedDatetime).format(FMT) : null,
                                                            dep_estimated_ts: status === 0 ? moment(flight.estimatedDatetime).unix() : null,
                                                            dep_estimated_utc: status === 0 ? moment.utc(flight.estimatedDatetime).format(FMT) : null,
                                                            dep_gate: status === 0 ? flight.gate : null, //✅
                                                            dep_iata: flight.fromCityCode || null, //✅
                                                            dep_icao: "" || null, //❌
                                                            dep_terminal: status === 0 ? "" : null, //?✅
                                                            dep_time: status === 0 ? moment(flight.scheduledDatetime).format(FMT) : null,
                                                            dep_time_ts: status === 0 ? moment(flight.scheduledDatetime).unix() : null,
                                                            dep_time_utc: status === 0 ? moment.utc(flight.scheduledDatetime).format(FMT) : null,
                                                            duration:  "" || null,
                                                            flight_iata: flight.flightNumber || null, //✅
                                                            flight_icao: "" || null, //❌
                                                            flight_number: "" || null, //❌
                                                            status:  flight.remark || null,

                                                            // Новые ключи
                                                            dep_checkin:  flight.counter || null, //✅
                                                            aircraft_type:  "" || null,
                                                            reg_number: flight.flightNumber || null,

                                                            // Ключи для проверки фильтрации по методам async
                                                            id: flight.id || null,
                                                            page_number: pageNumber || null,
                                                            flight_nature: status || null,
                                                            is_international: type || null,
                                                        })
                                                    );

                                                newFlightsArray.push(...newFieldsFlights); // Добавляем новые данные в массив, в данном случае новые данные добавляются в конец массива, однако больше имеет смысл когда приходит оригинальный массив

                                                console.log(`Page ${pageNumber}, Date ${date}`.blue.bold,
                                                        newFlightsArray);
                                                console.log('Request completed successfully.'.green.bold);
                                                console.log(`Proxy is configured and request were made via proxy: ${proxy}`.cyan.bold);

                                                if (newFlightsArray.length >= max_page_size) {
                                                    finished = false;
                                                } else {
                                                    finished = true;
                                                }

                                                retry_done();

                                            } catch (error) {
                                                console.log(`[error] ${error}`.red.bold);
                                                return retry_done(true);
                                            }
                                        }
                                    );
                                },
                                function iter_callback() {
                                    done();
                                }
                            );
                        },
                        function test_callback() {
                            next_type();
                        }
                    );
                },
                next_status()
            );
        });
        next_date();
    }, () => {
        setRedisData(redis_key, newFlightsArray, () => {
            console.log(`[${day}][redis] Flight data saved to Redis successfully.`.bgMagenta.bold);
        });
    });
}