// witherflare/mtg-deal-finder/scrapers/tcgplayer.js

const conditionMap = {
    'Near Mint': 'NM', 'Lightly Played': 'LP', 'Moderately Played': 'MP',
    'Heavily Played': 'HP', 'Damaged': 'DMG'
};

async function scrapeTcgplayerData(page, tcgplayer_id, foilType) {
    console.log(`  -> Scraping TCGplayer for ${foilType} listings...`);
    const productUrl = `https://www.tcgplayer.com/product/${tcgplayer_id}?Language=English`;
    await page.goto(productUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForSelector('.listing-item', { timeout: 20000 });

    const listingElements = await page.locator('.listing-item').all();
    if (listingElements.length === 0) throw new Error("No TCGplayer listings found.");

    const data = { lowestPrices: {} };
    for (const item of listingElements) {
        try {
            // Determine if the listing is for a foil card
            const listingIsFoil = await item.locator('span:text("Foil")').count() > 0;

            // --- THIS IS THE NEW LOGIC ---
            // If we want 'foil' but this listing isn't, skip it.
            if (foilType === 'foil' && !listingIsFoil) continue;
            // If we want 'normal' (non-foil) but this listing IS foil, skip it.
            if (foilType === 'normal' && listingIsFoil) continue;
            // Note: TCGPlayer often groups 'etched' with 'foil', so we treat them the same here.
            if (foilType === 'etched' && !listingIsFoil) continue;

            const conditionText = await item.locator('.listing-item__listing-data__info__condition').textContent();
            const priceText = await item.locator('.listing-item__listing-data__info__price').textContent();
            const price = parseFloat(priceText.replace('$', ''));
            const conditionCode = conditionMap[conditionText.trim()];

            // Store the lowest price found for each condition
            if (conditionCode && (!data.lowestPrices[conditionCode] || price < data.lowestPrices[conditionCode])) {
                data.lowestPrices[conditionCode] = price;
            }
        } catch { continue; }
    }
    
    
    try {
        const lastSoldPriceText = await page.locator('tr:has-text("Most Recent Sale") .price-points__upper__price').textContent({ timeout: 3000 });
        data.lastSoldPrice = parseFloat(lastSoldPriceText.replace('$', ''));
    } catch (e) { data.lastSoldPrice = null; }

    try {
        const totalSoldText = await page.locator('tr:has-text("Total Sold") .sales-data__price').textContent({ timeout: 3000 });
        data.totalSold = parseInt(totalSoldText.trim(), 10);
    } catch (e) { data.totalSold = 0; }
    
    try {
        const currentQuantityText = await page.locator('tr:has-text("Current Quantity:") .price-points__lower__price').textContent({ timeout: 3000 });
        data.currentQuantity = parseInt(currentQuantityText.trim(), 10);
    } catch (e) { data.currentQuantity = 0; }

    try {
        data.volatility = await page.locator('.volatility__label').textContent({ timeout: 5000 });
    } catch (e) { data.volatility = 'N/A'; }

    return data;
}

export { scrapeTcgplayerData };
