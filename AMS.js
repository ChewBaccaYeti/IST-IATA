const _ = require('lodash');
const async = require('async');
const axios = require('axios');
const chalk = require('chalk');
const cheerio = require('cheerio');
const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();
const PORT = 3000;

const proxy = 'http://iydv9uop:7rSHfY6iR6dBQRnX@proxy.proxy-cheap.com:31112';

app.use(cors());

app.use((req, res, next) => {
    res.setHeader(
        'Content-Security-Policy',
        "font-src 'self' data:; img-src 'self' data:; default-src 'self' http://localhost:3000/"
    );
    next();
});

app.get('/getFlightData', async (req, res) => {
    try {
        const response = await axios.get(
            'https://www.istairport.com/umbraco/api/FlightInfo/GetFlightStatusBoard',
            {
                proxy: {
                    host: proxy,
                    port: 31112,
                },
            }
        );

        const flightData = response.data;
        res.json(flightData);
    } catch (error) {
        console.error('Error fetching flight data:', error);
        res.status(500).send('Server error');
    }
});

app.listen(PORT, () => {
    console.log(`Server started on port ${PORT}`);
});
