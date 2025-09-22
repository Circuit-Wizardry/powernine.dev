// const fs = require('fs');
// const axios = require('axios');
// const cron = require('node-cron');

// const PRICES_JSON_PATH = './AllPricesToday.json';
// const MTGJSON_PRICES_URL = 'https://mtgjson.com/api/v5/AllPricesToday.json'; // Direct URL to the prices file
// let mtgPricesData = {};

// function loadPriceDataFromFile() {
//     try {
//         console.log(`Loading price data from ${PRICES_JSON_PATH}...`);
//         const fileContents = fs.readFileSync(PRICES_JSON_PATH, 'utf8');
//         mtgPricesData = JSON.parse(fileContents).data;
//         console.log('✅ Price data loaded successfully.');
//     } catch (error) {
//         console.error('❌ Could not load price data from file. The API might not work until the file is downloaded.', error.message);
//     }
// }


// // This function downloads the latest prices file from MTGJSON.
// async function downloadLatestPrices() {
//     console.log('🕒 Starting daily download of AllPrices.json...');
//     try {
//         const response = await axios({
//             method: 'get',
//             url: MTGJSON_PRICES_URL,
//             responseType: 'stream',
//         });

//         const writer = fs.createWriteStream(PRICES_JSON_PATH);
//         response.data.pipe(writer);

//         return new Promise((resolve, reject) => {
//             writer.on('finish', resolve);
//             writer.on('error', reject);
//         });

//     } catch (error) {
//         console.error('❌ Failed to download latest prices:', error.message);
//         throw error; // Propagate error to the cron handler
//     }
// }

// cron.schedule('0 3 * * *', async () => {
//     try {
//         await downloadLatestPrices();
//         console.log('✅ New price file downloaded. Reloading data into memory...');
//         // After downloading, reload the data into our variable.
//         loadPriceDataFromFile();
//     } catch (error) {
//         console.error('❌ An error occurred during the scheduled daily update.');
//     }
// }, {
//     scheduled: true,
//     timezone: "America/New_York"
// });

// if (!fs.existsSync(PRICES_JSON_PATH)) {
//     console.log('No existing price file found. Downloading for the first time...');
//     downloadLatestPrices()
//         .then(() => {
//             console.log('✅ Initial price file downloaded. Loading data into memory...');
//             loadPriceDataFromFile();
//         })
//         .catch(() => {
//             console.error('❌ Failed to download the initial price file. The API might not work until the file is downloaded.');
//         });
//     } else {
//     loadPriceDataFromFile();
// }


// module.exports = { mtgPricesData };