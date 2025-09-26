// witherflare/mtg-deal-finder/scrapers/manapool.js

/**
 * UPDATED: Now accepts a foilType to target specific listings.
 * @param {object} page - The Playwright page object.
 * @param {string} manaPoolUrl - The direct URL to the card's page.
 * @param {string} foilType - 'normal', 'foil', or 'etched'.
 */
async function scrapeManaPoolListings(page, manaPoolUrl, foilType) {
    console.log(`  -> Scraping ManaPool for ${foilType} listings...`);
    await page.goto(manaPoolUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForSelector('li .font-bold.text-green-700', { timeout: 20000 });

    const listingElements = await page.locator('.flow-root li').all();
    if (listingElements.length === 0) throw new Error("No ManaPool listings found.");

    const data = { lowestPrices: {} };
    const validConditions = ['NM', 'LP', 'MP', 'HP', 'DMG'];

    for (const item of listingElements) {
        try {
            const badges = await item.locator('span[class*="rounded-"]').allTextContents();
            
            // --- THIS IS THE NEW LOGIC ---
            const listingIsFoil = badges.some(b => b.trim() === 'Foil');
            const listingIsEtched = badges.some(b => b.trim() === 'Etched');

            if (foilType === 'foil' && !listingIsFoil) continue;
            if (foilType === 'etched' && !listingIsEtched) continue;
            if (foilType === 'normal' && (listingIsFoil || listingIsEtched)) continue;

            const priceText = await item.locator('.font-bold.text-green-700').textContent();
            const price = parseFloat(priceText.replace('$', ''));
            
            let conditionCode = 'NM'; // Default condition on ManaPool
            badges.forEach(badgeText => {
                const text = badgeText.trim();
                if (validConditions.includes(text)) conditionCode = text;
            });
            
            if (!data.lowestPrices[conditionCode] || price < data.lowestPrices[conditionCode]) {
                data.lowestPrices[conditionCode] = price;
            }
        } catch { continue; }
    }
    return data;
}

export { scrapeManaPoolListings };
