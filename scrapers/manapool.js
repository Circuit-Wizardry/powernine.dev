// witherflare/mtg-deal-finder/scrapers/manapool.js

const SELF_SELLER_NAME = (process.env.MANAPOOL_SELLER_NAME || 'Fells Forge TCG').trim().toLowerCase();

/**
 * UPDATED: Now accepts a foilType and a targetCondition.
 * It finds the cheapest listing (assumed to be the first match) for the target condition OR BETTER.
 * If no initial match is found, it will click "Show More" up to 5 times to find one.
 * It will also avoid any listings from the seller "Fells Forge TCG".
 * @param {object} page - The Playwright page object.
 * @param {string} manaPoolUrl - The direct URL to the card's page.
 * @param {string} foilType - 'normal', 'foil', or 'etched'.
 * @param {string} targetCondition - The minimum acceptable condition (e.g., 'LP').
 */
async function scrapeManaPoolListings(page, manaPoolUrl, foilType, targetCondition) {
    console.log(`  -> Scraping ManaPool for ${foilType} listings at ${targetCondition} or better...`);
    await page.goto(manaPoolUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForSelector('li .font-bold.text-green-700, li .font-bold.text-green-600', { timeout: 20000 });

    const conditionHierarchy = ['NM', 'LP', 'MP', 'HP', 'DMG'];
    const targetConditionIndex = conditionHierarchy.indexOf(targetCondition);
    if (targetConditionIndex === -1) {
        throw new Error(`Invalid target condition provided: ${targetCondition}`);
    }

    /**
     * Scans the currently visible listings on the page.
     * Since the lowest price is always first, it returns the first valid match it finds.
     * @returns {Promise<number|null>} The price if found, otherwise null.
     */
    const findFirstValidListing = async () => {
        const listingElements = await page.locator('.flow-root li').all();
        if (listingElements.length === 0) throw new Error("No ManaPool listings found on page load.");

        for (const item of listingElements) {
            try {
                // --- FIXED: Updated the selector for the seller name ---
                // The site changed from a <p> tag to nested <div>s for the seller name.
                const sellerNameElement = item.locator('a.text-sm.truncate.font-medium, div.text-sm.truncate.font-medium').first();
                const sellerName = await sellerNameElement.textContent({ timeout: 1000 });
                if (sellerName && SELF_SELLER_NAME && sellerName.trim().toLowerCase() === SELF_SELLER_NAME) {
                    continue; // Skip this seller
                }

                const badges = (await item.locator('span[class*="rounded"]').allTextContents()).map(b => b.trim()).filter(Boolean);
                const normalizedBadges = badges.map(b => b.toLowerCase());

                const listingIsEtched = normalizedBadges.some(b => b.includes('etched'));
                const listingHasFoilTrait = normalizedBadges.some(b => b.includes('foil')) && !normalizedBadges.some(b => b.includes('non-foil'));

                if (foilType === 'foil' && !listingHasFoilTrait) continue;
                if (foilType === 'etched' && !listingIsEtched) continue;
                if (foilType === 'normal' && (listingHasFoilTrait || listingIsEtched)) continue;

                let listingCondition = 'NM'; // Default condition on ManaPool
                badges.forEach(badgeText => {
                    const text = badgeText.toUpperCase();
                    if (conditionHierarchy.includes(text)) listingCondition = text;
                });
                
                const listingConditionIndex = conditionHierarchy.indexOf(listingCondition);

                // If the listing's condition meets the criteria
                if (listingConditionIndex <= targetConditionIndex) {
                    const priceElement = item.locator('.font-bold.text-green-700, .font-bold.text-green-600').first();
                    const priceText = await priceElement.textContent();
                    // Found the first valid listing, return its price
                    if (!priceText) continue;
                    const numeric = parseFloat(priceText.replace(/[^0-9.]/g, ''));
                    if (Number.isFinite(numeric)) {
                        return numeric;
                    }
                }
            } catch { continue; }
        }
        // If the loop completes without finding a match
        return null;
    };

    // 1. First attempt on the initially loaded listings.
    let cheapestPrice = await findFirstValidListing();

    // 2. If no price was found, then try clicking "Show More".
    if (cheapestPrice === null) {
        console.log('     -> No match found on initial load. Attempting to "Show More".');
        for (let i = 0; i < 5; i++) {
            try {
                const showMoreButton = page.getByRole('button', { name: /show more/i });
                await showMoreButton.click({ timeout: 2000 });
                console.log('     -> Clicked "Show More" button.');
                await page.waitForLoadState('networkidle', { timeout: 5000 });

                // Re-run the scan on the newly loaded content
                cheapestPrice = await findFirstValidListing();

                // If a price is found after clicking, we're done.
                if (cheapestPrice !== null) {
                    console.log('     -> Found a match after expanding listings.');
                    break;
                }
            } catch (error) {
                console.log('     -> No more "Show More" buttons found. Proceeding.');
                break; // Exit loop if button is no longer available
            }
        }
    }
    
    return {
        cheapestPrice: cheapestPrice // This will be the price or null
    };
}

export { scrapeManaPoolListings };
