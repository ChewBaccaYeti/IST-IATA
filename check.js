const axios = require('axios').default;

const options = {
    method: 'POST',
    url: 'https://www.istairport.com/umbraco/api/FlightInfo/GetFlightStatusBoard',
    headers: {
        cookie: 'iga_bid=MDMAAAIA5cqTFwAAAACVPtHKGH53ZQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAJZ6GTJ63Qak-OtAgPoD_yOfNCjH',
        Accept: 'application/json, text/javascript, */*; q=0.01',
        'Accept-Language': 'ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        Cookie: '_gid=GA1.2.71353474.1702211813; _tt_enable_cookie=1; _ttp=xHAyXcBhbyteIoU2ncI_HxvtGOk; _gcl_au=1.1.1202715006.1702211813; iga_bid=MDMAAAEAFlnSCAAAAACVPtHKeXp3ZQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAPzPoJDIyWp4Jiq8diA-En1Z905u; _ga=GA1.1.1547759267.1702211813; _ga_V39SG6FNFF=GS1.1.1702328988.5.1.1702328992.56.0.0; _ga_2KDDX4ZQVX=GS1.1.1702328988.6.1.1702329806.0.0.0',
        DNT: '1',
        Origin: 'https://www.istairport.com',
        Pragma: 'no-cache',
        Referer:
            'https://www.istairport.com/en/flights/flight-info/departure-flights/?locale=en',
        'Sec-Fetch-Dest': 'empty',
        'Sec-Fetch-Mode': 'cors',
        'Sec-Fetch-Site': 'same-origin',
        'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
        'X-Requested-With': 'XMLHttpRequest',
        'sec-ch-ua': '^^Google',
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-platform': '^^Windows^^',
    },
    data: {
        nature: '1',
        searchTerm: 'changeflight',
        pageNumber: '1',
        pageSize: '20',
        isInternational: '1',
        '': ['date=', 'endDate='],
        culture: 'en',
        prevFlightPage: '0',
        clickedButton: 'moreFlight',
    },
};

axios
    .request(options)
    .then(function (response) {
        console.log(response.data);
    })
    .catch(function (error) {
        console.error(error);
    });
