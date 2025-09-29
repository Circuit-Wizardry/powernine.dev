// witherflare/mtg-deal-finder/scrapers/manapool.js

/**
 * UPDATED: Now accepts a foilType and a targetCondition.
 * It finds the cheapest listing for the target condition OR BETTER.
 * @param {object} page - The Playwright page object.
 * @param {string} manaPoolUrl - The direct URL to the card's page.
 * @param {string} foilType - 'normal', 'foil', or 'etched'.
 * @param {string} targetCondition - The minimum acceptable condition (e.g., 'LP').
 */
async function scrapeManaPoolListings(page, manaPoolUrl, foilType, targetCondition) {
    console.log(`  -> Scraping ManaPool for ${foilType} listings at ${targetCondition} or better...`);
    await page.goto(manaPoolUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForSelector('li .font-bold.text-green-700', { timeout: 20000 });

    const listingElements = await page.locator('.flow-root li').all();
    if (listingElements.length === 0) throw new Error("No ManaPool listings found.");

    // --- NEW: Condition hierarchy from best to worst ---
    const conditionHierarchy = ['NM', 'LP', 'MP', 'HP', 'DMG'];
    const targetConditionIndex = conditionHierarchy.indexOf(targetCondition);
    if (targetConditionIndex === -1) {
        throw new Error(`Invalid target condition provided: ${targetCondition}`);
    }

    let cheapestPrice = Infinity;

    for (const item of listingElements) {
        try {
            const badges = await item.locator('span[class*="rounded-"]').allTextContents();
            
            const listingIsFoil = badges.some(b => b.trim() === 'Foil');
            const listingIsEtched = badges.some(b => b.trim() === 'Etched');

            if (foilType === 'foil' && !listingIsFoil) continue;
            if (foilType === 'etched' && !listingIsEtched) continue;
            if (foilType === 'normal' && (listingIsFoil || listingIsEtched)) continue;

            const priceText = await item.locator('.font-bold.text-green-700').textContent();
            const price = parseFloat(priceText.replace('$', ''));
            
            let listingCondition = 'NM'; // Default condition on ManaPool
            badges.forEach(badgeText => {
                const text = badgeText.trim();
                if (conditionHierarchy.includes(text)) listingCondition = text;
            });
            
            // --- NEW: Check if the listing's condition meets the criteria ---
            const listingConditionIndex = conditionHierarchy.indexOf(listingCondition);

            // If the listing's condition is at or better than the target (lower or equal index)
            if (listingConditionIndex <= targetConditionIndex) {
                if (price < cheapestPrice) {
                    cheapestPrice = price;
                }
            }
        } catch { continue; }
    }
    
    return {
        cheapestPrice: cheapestPrice === Infinity ? null : cheapestPrice
    };
}

export { scrapeManaPoolListings };