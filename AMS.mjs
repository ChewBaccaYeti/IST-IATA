// I decided to use ECMAScript modules and their imports for convenience.
// I am using the axios module for executing HTTP requests, express for creating an HTTP server.
import axios from 'axios';
import { createClient } from 'redis';
import express from 'express';
import moment from 'moment-timezone';
import { eachLimit } from 'async';
import { get as _get } from 'lodash';

const redisClient = createClient({
    host: 'your-redis-host',
    port: 6379,
    password: 'your-redis-password',
});

const app = express();

const apiEndpoint =
    'https://www.istairport.com/umbraco/api/FlightInfo/GetFlightStatusBoard';

const fetchData = async () => {
    try {
        const response = await axios.post(apiEndpoint);
        return response.data;
    } catch (error) {
        throw new Error(`Error fetching data from API: ${error.message}`);
    }
};

const mainTask = async () => {
    try {
        const flightData = await fetchData();
        redisClient.set('flight-data', JSON.stringify(flightData));
        console.log('Flight data saved to Redis.');
    } catch (error) {
        console.error('Error:', error);
    }
};

setInterval(mainTask, 60000);

app.get('/api/flights', (req, res) => {
    redisClient.get('flight-data', (err, reply) => {
        if (err) {
            console.error('Redis Error:', err);
            res.status(500).send('Internal Server Error');
        } else {
            const flightData = JSON.parse(reply);
            res.json(flightData);
        }
    });
});

const PORT = 3000;
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
