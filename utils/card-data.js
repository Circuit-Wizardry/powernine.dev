const axios = require('axios');

cardNamesCache = [];

async function initializeCardNameCache() {
    try {
        console.log('Fetching Scryfall card name catalog...');
        const response = await axios.get('https://api.scryfall.com/catalog/card-names');
        cardNamesCache = response.data.data;
        console.log(`Cached ${cardNamesCache.length} card names for autocomplete.`);
    } catch (error) {
        console.error('Failed to fetch Scryfall card names:', error.message);
    }
}

function getCardNames() {
    return cardNamesCache;
}

module.exports = { initializeCardNameCache, getCardNames };