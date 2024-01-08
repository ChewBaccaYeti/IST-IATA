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
        console.log(`[${day}][redis] connected`.magenta);
        dataFlights(); // Вызов основной функции во время подкючения Редиса
    })
    .on("reconnecting", (p) => console.log(`[${day}][redis] reconnecting: %j`.magenta, p))
    .on("error", (e) => console.error(`[${day}][redis] error: %j`.bgRed.bold, e));

redis.del(redis_key, (err, reply) => {
    if (err) {
        console.error(`[${day}][redis] delete error: %j`.bgRed.bold, err);
    } else {
        console.log(`[${day}][redis] data deleted successfully.`.bgMagenta);
    }
})

const app = express();

app.get("/schedules", (req, res) => {
    // http://localhost:3000/schedules - endpoint для получения расписания рейсов
    redis.get(redis_key, (e, reply) => {
        console.log("Reply from Redis:", reply); // Вывод в консоль новых данных после каждого обновления хоста в браузере
        if (!reply) return res.status(404).json({ error: "Data not found." });
        try {
            res.json(JSON.parse(reply));
        } catch (e) {
            res.status(500).json({ error: "Internal Server Error." });
        }
    });
}).listen(port, () => {
    console.log(`Server started on port ${port}`.bgYellow);
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
    console.log("\nReceived kill signal, shutting down gracefully.");

    redis && redis.end && redis.end(true);

    setTimeout(() => {
        console.error("Could not close connections in time, forcefully shutting down.".red.bold);
        return process.exit(1);
    }, 5000);
};
process.once("SIGTERM", shutdownSignal); // listen for TERM signal .e.g. kill
process.once("SIGINT", shutdownSignal); // listen for INT signal .e.g. Ctrl-C

function dataFlights() {
    const min_body_length = 10;
    const max_page_size = 50;
    const max_retries = 3;

    let newFlightsArray = [];
    let finished = false; // Флаг для остановки цикла async.until

    pageNumber = 1;
    async.eachSeries(dates, (date, next_date) => {
        async.eachSeries([0, 1], (status, next_status) => {
            async.each([0, 1], (type, next_type) => {

                    let tries = 0;

                    async.until(
                        (cb) => { // test 
                            cb(null, finished);
                        },
                        (done) => { // iter 
                            async.retry(max_retries, (retry_done) => {
                                    if (tries) console.log(`[retrying#${tries}] ${base_url}`.yellow);
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
                                                    console.log("body:".bgBlue, body);
                                                    return retry_done(true);
                                                }

                                                const flightsArray = obj.result.data.flights;

                                                const newFieldsFlights = flightsArray.flatMap((flight) => {
                                                    const flight_clones = flight.codeshare.map((code) => {
                                                        const arrival_fields = {
                                                            "arr_baggage": flight.carousel,
                                                            "arr_delayed": status === 1 ? Math.abs(moment(flight.scheduledDatetime, FMT).diff(moment(flight.estimatedDatetime, FMT), "minutes")) : null,
                                                            "arr_estimated": status === 1 ? moment(flight.estimatedDatetime).format(FMT) : null,
                                                            "arr_estimated_ts": status === 1 ? moment(flight.estimatedDatetime).tz(TMZN).unix() : null,
                                                            "arr_estimated_utc": status === 1 ? moment.tz(TMZN).utc(flight.estimatedDatetime).format(FMT) : null,
                                                            "arr_gate": status === 1 ? flight.gate : null,
                                                            "arr_iata": flight.toCityCode,
                                                            "arr_icao": flight.toCityName,
                                                            "arr_terminal": status === 1 ? flight.gate.charAt(0) : null,
                                                            "arr_time": status === 1 ? moment(flight.scheduledDatetime).format(FMT) : null,
                                                            "arr_time_ts": status === 1 ? moment(flight.scheduledDatetime).tz(TMZN).unix() : null,
                                                            "arr_time_utc": status === 1 ? moment.tz(TMZN).utc(flight.scheduledDatetime).format(FMT) : null,
                                                            "arr_actual": status === 1 ? moment(flight.estimatedDatetime).format(FMT) : null,
                                                            "arr_actual_ts": status === 1 ? moment(flight.estimatedDatetime).tz(TMZN).unix() : null,
                                                            "arr_actual_utc": status === 1 ? moment.tz(TMZN).utc(flight.estimatedDatetime).format(FMT) : null,
                                                        };
                                                        const cs_fields = {
                                                            "cs_airline_iata": code.slice(0, 2),
                                                            "cs_flight_number": code.slice(2, 6),
                                                            "cs_flight_iata": code,
                                                        };
                                                        const departure_fields = {
                                                            "dep_actual": status === 0 ? moment(flight.estimatedDatetime).format(FMT) : null,
                                                            "dep_actual_ts": status === 0 ? moment(flight.estimatedDatetime).tz(TMZN).unix() : null,
                                                            "dep_actual_utc": status === 0 ? moment.tz(TMZN).utc(flight.estimatedDatetime).format(FMT) : null,
                                                            "dep_delayed": status === 0 ? Math.abs(moment(flight.scheduledDatetime, FMT).diff(moment(flight.estimatedDatetime, FMT), "minutes")) : null,
                                                            "dep_estimated": status === 0 ? moment(flight.estimatedDatetime).format(FMT) : null,
                                                            "dep_estimated_ts": status === 0 ? moment(flight.estimatedDatetime).tz(TMZN).unix() : null,
                                                            "dep_estimated_utc": status === 0 ? moment.tz(TMZN).utc(flight.estimatedDatetime).format(FMT) : null,
                                                            "dep_gate": status === 0 ? flight.gate : null,
                                                            "dep_iata": flight.fromCityCode,
                                                            "dep_terminal": status === 0 ? flight.gate.charAt(0) : null,
                                                            "dep_time": status === 0 ? moment(flight.scheduledDatetime).format(FMT) : null,
                                                            "dep_time_ts": status === 0 ? moment(flight.scheduledDatetime).tz(TMZN).unix() : null,
                                                            "dep_time_utc": status === 0 ? moment.tz(TMZN).utc(flight.scheduledDatetime).format(FMT) : null,
                                                            "dep_checkin":  flight.counter,
                                                        };
                                                        const status_fields = {
                                                        "airline_iata": flight.airlineCode,
                                                        "delayed":
                                                            status === 1 ? Math.abs(moment(flight.scheduledDatetime, FMT).diff(moment(flight.estimatedDatetime, FMT), "minutes")) : null ||
                                                            status === 0 ? Math.abs(moment(flight.scheduledDatetime, FMT).diff(moment(flight.estimatedDatetime, FMT), "minutes")) : null,
                                                        "flight_iata": flight.flightNumber,
                                                        "flight_number": flight.flightNumber.slice(2),
                                                        "status": flight.remark ? flight.remark.toLowerCase() : null,
                                                        "reg_number": "",
                                                        // Ключи для проверки фильтрации по методам async
                                                        "id": flight.id,
                                                        "page_number": pageNumber,
                                                        "flight_nature": status,
                                                        "is_international": type,
                                                        };
                                                        const clonedFlight = {
                                                            ...arrival_fields,
                                                            ...cs_fields,
                                                            ...departure_fields,
                                                            ...status_fields,
                                                        };

                                                        return clonedFlight;
                                                    });
                                                    return flight_clones;
                                                });

                                                newFlightsArray.push(...newFieldsFlights); // Добавляем новые данные в массив
                                                console.log(`Page ${pageNumber}, Date ${date}`.blue, newFieldsFlights);
                                                console.log('Request completed successfully.'.green);
                                                console.log(`Proxy is configured and request were made via proxy: ${proxy}`.cyan);
                                                
                                                if (newFieldsFlights.length >= max_page_size) {
                                                    finished = false;
                                                    console.log("Loop is still running...".bgYellow);
                                                } else {
                                                    finished = true;
                                                    console.log("Loop is over.".bgCyan);
                                                }
                                                
                                                retry_done();

                                            } catch (error) {
                                                console.log(`[error] ${error}`.red.bold);
                                                return retry_done(true);
                                            }
                                        });
                                    }, done);
                                },
                                () => {
                                    setRedisData(redis_key, newFlightsArray, (err) => {
                                        if (err) {
                                            console.error("Error while saving data to Redis:".bgRed.bold, err);
                                        } else {
                                            console.log(`[${day}][redis] data saved successfully.`.bgMagenta);
                                        }
                                        next_type();  // Добавил вызов next_type здесь
                                    });
                                }
                            );
            }, next_status);
        }, next_date);
    });
}
// const newFieldsFlights = flightsArray.flatMap((flight) => {
//     // Проверяю, есть ли у текущего рейса codeshare
//     if (flight.codeshare && flight.codeshare.length > 0) {
//         const parent_flight = {
//                 "arr_baggage": flight.carousel,
//                 "arr_delayed": status === 1 ? Math.abs(moment(flight.scheduledDatetime, FMT).diff(moment(flight.estimatedDatetime, FMT), "minutes")) : null,
//                 "arr_estimated": status === 1 ? moment(flight.estimatedDatetime).format(FMT) : null,
//                 "arr_estimated_ts": status === 1 ? moment(flight.estimatedDatetime).tz(TMZN).unix() : null,
//                 "arr_estimated_utc": status === 1 ? moment.tz(TMZN).utc(flight.estimatedDatetime).format(FMT) : null,
//                 "arr_gate": status === 1 ? flight.gate : null,
//                 "arr_iata": flight.toCityCode,
//                 "arr_icao": flight.toCityName,
//                 "arr_terminal": status === 1 ? flight.gate.charAt(0) : null,
//                 "arr_time": status === 1 ? moment(flight.scheduledDatetime).format(FMT) : null,
//                 "arr_time_ts": status === 1 ? moment(flight.scheduledDatetime).tz(TMZN).unix() : null,
//                 "arr_time_utc": status === 1 ? moment.tz(TMZN).utc(flight.scheduledDatetime).format(FMT) : null,
//                 "arr_actual": status === 1 ? moment(flight.estimatedDatetime).format(FMT) : null,
//                 "arr_actual_ts": status === 1 ? moment(flight.estimatedDatetime).tz(TMZN).unix() : null,
//                 "arr_actual_utc": status === 1 ? moment.tz(TMZN).utc(flight.estimatedDatetime).format(FMT) : null,
//                 "dep_actual": status === 0 ? moment(flight.estimatedDatetime).format(FMT) : null,
//                 "dep_actual_ts": status === 0 ? moment(flight.estimatedDatetime).tz(TMZN).unix() : null,
//                 "dep_actual_utc": status === 0 ? moment.tz(TMZN).utc(flight.estimatedDatetime).format(FMT) : null,
//                 "dep_delayed": status === 0 ? Math.abs(moment(flight.scheduledDatetime, FMT).diff(moment(flight.estimatedDatetime, FMT), "minutes")) : null,
//                 "dep_estimated": status === 0 ? moment(flight.estimatedDatetime).format(FMT) : null,
//                 "dep_estimated_ts": status === 0 ? moment(flight.estimatedDatetime).tz(TMZN).unix() : null,
//                 "dep_estimated_utc": status === 0 ? moment.tz(TMZN).utc(flight.estimatedDatetime).format(FMT) : null,
//                 "dep_gate": status === 0 ? flight.gate : null,
//                 "dep_iata": flight.fromCityCode,
//                 "dep_terminal": status === 0 ? flight.gate.charAt(0) : null,
//                 "dep_time": status === 0 ? moment(flight.scheduledDatetime).format(FMT) : null,
//                 "dep_time_ts": status === 0 ? moment(flight.scheduledDatetime).tz(TMZN).unix() : null,
//                 "dep_time_utc": status === 0 ? moment.tz(TMZN).utc(flight.scheduledDatetime).format(FMT) : null,
//                 "dep_checkin":  flight.counter,
//                 "airline_iata": flight.airlineCode,
//                 "delayed":
//                     status === 1 ? Math.abs(moment(flight.scheduledDatetime, FMT).diff(moment(flight.estimatedDatetime, FMT), "minutes")) : null ||
//                     status === 0 ? Math.abs(moment(flight.scheduledDatetime, FMT).diff(moment(flight.estimatedDatetime, FMT), "minutes")) : null,
//                 "flight_iata": flight.flightNumber,
//                 "flight_number": flight.flightNumber.slice(2),
//                 "status": flight.remark ? flight.remark.toLowerCase() : null,
//                 "reg_number": "",
//                 // Ключи для проверки фильтрации по методам async
//                 "id": flight.id,
//                 "page_number": pageNumber,
//                 "flight_nature": status,
//                 "is_international": type,
//         }

//         const flight_clones = flight.codeshare.map((code) => {
//             const cs_fields = {
//             "cs_airline_iata": code.slice(0, 2),
//             "cs_flight_number": code.slice(2, 6),
//             "cs_flight_iata": code,
//         };
//         const clonedFlight = {
//             ...parent_flight,
//             ...cs_fields,
//         };

//         return clonedFlight;
//     });
//     return flight_clones;
// }});