// I am using the axios module for executing HTTP requests, express for creating an HTTP server.
const express = require('express');
const axios = require('request');
const redis = require('redis');
const moment = require('moment-timezone');
const async = require('async');
const cheerio = require('cheerio');
const _ = require('lodash');

const PORT = 3000;
const redis_URL = 'redis://localhost:6379';
const redis_KEY = 'airports:istanbul';

const redisClient = redis
    .createClient({
        url: redis_URL,
        password: redis_KEY,
    })
    .on('connect', () =>
        console.log(`[${moment().format('HH:mm')}][redis] connected`)
    )
    .on('reconnecting', (p) =>
        console.log(`[${moment().format('HH:mm')}][redis] reconnecting: %j`, p)
    )
    .on('error', (e) =>
        console.error(`[${moment().format('HH:mm')}][redis] error: %j`, e)
    );

const app = express();

app.get('/api/flights/:flightNumber', (req, res) => {
    const { flightNumber } = req.params;
    redisClient.hGet('flights-data', flightNumber, (err, reply) => {
        if (err) {
            console.error('Redis Error:', err);
            res.status(500).send('Internal Server Error');
        } else if (reply) {
            const flightInfo = JSON.parse(reply);
            res.json(flightInfo);
        } else {
            res.status(404).send('Flight not found');
        }
    });
});

app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});

const apiEndpoint =
    'https://www.istairport.com/umbraco/api/FlightInfo/GetFlightStatusBoard';

const fetchData = (callback) => {
    axios
        .post(apiEndpoint)
        .then((response) => {
            callback(null, response.data);
        })
        .catch((error) => {
            callback(
                new Error(`Error fetching data from API: ${error.message}`),
                null
            );
        });
};

const extractFlightInfo = (flight) => {
    return {
        name: flight.airline,
        flightNumber: flight.flightNumber,
        scheduledDeparture: flight.scheduledDeparture,
        scheduledArrival: flight.scheduledArrival,
        dep_checkin: flight.checkinDesk,
        aircraft_type: flight.aircraft.type,
        reg_number: flight.aircraft.registration,
    };
};

const mainTask = () => {
    fetchData((error, flightsData) => {
        if (error) {
            console.error('Error:', error);
        } else {
            console.log('Response from API:', flightsData); // Добавим это
            redisClient.del('flights-data');

            // Проверим, является ли flightsData массивом
            if (Array.isArray(flightsData)) {
                flightsData.forEach((flight) => {
                    const flightInfo = extractFlightInfo(flight);
                    redisClient.hSet(
                        'flights-data',
                        flight.flightNumber,
                        JSON.stringify(flightInfo)
                    );
                });
                console.log('Flight data saved to Redis.');
            } else {
                console.error('Unexpected format of response from API.');
            }
        }
    });
};

setInterval(mainTask, 60000);
