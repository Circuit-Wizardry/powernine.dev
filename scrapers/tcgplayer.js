// witherflare/mtg-deal-finder/scrapers/tcgplayer.js

const conditionMap = {
    'Near Mint': 'NM', 'Lightly Played': 'LP', 'Moderately Played': 'MP',
    'Heavily Played': 'HP', 'Damaged': 'DMG'
};

/**
 * UPDATED: Now accepts a foilType and a targetCondition.
 * It finds the cheapest listing for the target condition OR BETTER,
 * plus other market data.
 * @param {object} page - The Playwright page object.
 * @param {string} tcgplayer_id - The TCGplayer product ID.
 * @param {string} foilType - 'normal', 'foil', or 'etched'.
 * @param {string} targetCondition - The minimum acceptable condition (e.g., 'LP').
 */
async function scrapeTcgplayerData(page, tcgplayer_id, foilType, targetCondition) {
    console.log(`  -> Scraping TCGplayer for ${foilType} listings at ${targetCondition} or better...`);
    const productUrl = `https://www.tcgplayer.com/product/${tcgplayer_id}?Language=English`;
    await page.goto(productUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForSelector('.listing-item', { timeout: 20000 });

    const listingElements = await page.locator('.listing-item').all();
    if (listingElements.length === 0) throw new Error("No TCGplayer listings found.");

    // --- NEW: Condition hierarchy from best to worst ---
    const conditionHierarchy = ['NM', 'LP', 'MP', 'HP', 'DMG'];
    const targetConditionIndex = conditionHierarchy.indexOf(targetCondition);
    if (targetConditionIndex === -1) {
        throw new Error(`Invalid target condition provided: ${targetCondition}`);
    }

    const data = {};
    let cheapestPrice = Infinity;

    for (const item of listingElements) {
        try {
            const listingIsFoil = await item.locator('span:text("Foil")').count() > 0;

            if (foilType === 'foil' && !listingIsFoil) continue;
            if (foilType === 'normal' && listingIsFoil) continue;
            // Note: TCGPlayer often groups 'etched' with 'foil', so we treat them the same here.
            if (foilType === 'etched' && !listingIsFoil) continue;

            const conditionText = await item.locator('.listing-item__listing-data__info__condition').textContent();
            const priceText = await item.locator('.listing-item__listing-data__info__price').textContent();
            const price = parseFloat(priceText.replace('$', ''));
            const conditionCode = conditionMap[conditionText.trim()];

            // --- NEW: Check if the listing's condition meets the criteria ---
            if (conditionCode) {
                const listingConditionIndex = conditionHierarchy.indexOf(conditionCode);
                // If the listing's condition is at or better than the target (lower or equal index)
                if (listingConditionIndex !== -1 && listingConditionIndex <= targetConditionIndex) {
                    if (price < cheapestPrice) {
                        cheapestPrice = price;
                    }
                }
            }
        } catch { continue; }
    }
    
    // Assign the found price, or null if no listings met the criteria
    data.cheapestPrice = cheapestPrice === Infinity ? null : cheapestPrice;
    
    // Scrape additional market data (this logic is unchanged)
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