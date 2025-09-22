import axios from 'axios';

let cardNamesCache = [];

// Use 'export' to make this function available to other files
export async function initializeCardNameCache() {
    try {
        console.log('Fetching Scryfall card name catalog...');
        const response = await axios.get('https://api.scryfall.com/catalog/card-names');
        cardNamesCache = response.data.data;
        console.log(`Cached ${cardNamesCache.length} card names for autocomplete.`);
    } catch (error) {
        console.error('Failed to fetch Scryfall card names:', error.message);
    }
}

// Use 'export' here as well
export function getCardNames() {
    return cardNamesCache;
}