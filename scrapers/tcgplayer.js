const conditionMap = {
    'Near Mint': 'NM', 'Lightly Played': 'LP', 'Moderately Played': 'MP',
    'Heavily Played': 'HP', 'Damaged': 'DMG'
};

/**
 * Scrapes TCGplayer for the cheapest listing of a specific card version
 * by applying a filter and finding the first valid listing on the first page of results.
 *
 * @param {object} page - The Playwright page object.
 * @param {string} tcgplayer_id - The TCGplayer product ID.
 * @param {string} foilType - The desired printing: 'normal', 'foil', or 'etched'.
 * @param {string} targetCondition - The minimum acceptable condition (e.g., 'LP').
 * @returns {Promise<object>} A promise that resolves to an object with the cheapest listing and other market data.
 */
async function scrapeTcgplayerData(page, tcgplayer_id, foilType, targetCondition) {
    console.log(`   -> Scraping TCGplayer for the FIRST ${foilType} listing at ${targetCondition} or better...`);
    const productUrl = `https://www.tcgplayer.com/product/${tcgplayer_id}?Language=English`;
    await page.goto(productUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });

    // --- 1. GATHER MARKET DATA FIRST ---
    const data = {};
    try {
        const lastSoldPriceText = await page.locator('tr:has-text("Most Recent Sale") .price-points__upper__price').textContent({ timeout: 3000 });
        data.lastSoldPrice = parseFloat(lastSoldPriceText.replace('$', ''));
    } catch (e) { data.lastSoldPrice = null; }
    
    try {
        const volatility = await page.locator('.volatility__label').textContent({ timeout: 5000 });
        data.volatility = volatility;
    } catch(e){ data.volatility = 'N/A'; }

    // --- 2. ALWAYS APPLY FILTER ---
    try {
        console.log(`      -> Applying '${foilType}' printing filter...`);
        const allFiltersButton = page.locator('button[data-testid="showFilters"]');
        await allFiltersButton.waitFor({ state: 'visible', timeout: 15000 });
        await allFiltersButton.click();

        const filterDrawer = page.locator('.tcg-drawer__content');
        await filterDrawer.waitFor({ state: 'visible', timeout: 10000 });

        let filterCheckbox;
        if (foilType === 'foil') {
            filterCheckbox = filterDrawer.locator('label:has-text("Foil")');
        } else if (foilType === 'etched') {
            filterCheckbox = filterDrawer.locator('label:has-text("Etched Foil"), label:has-text("Etched")');
        } else {
            filterCheckbox = filterDrawer.locator('label:has-text("Normal")');
        }
        
        if (await filterCheckbox.count() > 0) {
            await filterCheckbox.first().click();
            const saveButton = filterDrawer.locator('.filter-drawer-footer__button-save');
            await saveButton.waitFor({ state: 'visible', timeout: 5000 });
            await saveButton.click();
            
            console.log(`      -> Filter applied. Waiting 1 second for listings to reload...`);
            await page.waitForTimeout(1000);

        } else {
            console.log(`      -> NOTE: Could not find a specific filter for '${foilType}'.`);
            await page.locator('.tcg-drawer__header button[aria-label="Close drawer"]').click();
        }
    } catch (filterError) {
        console.warn(`      -> WARN: Could not apply filter. Error: ${filterError.message.split('\n')[0]}`);
    }


    // --- 3. FIND THE FIRST MATCHING LISTING (NO PAGINATION) ---
    const conditionHierarchy = ['NM', 'LP', 'MP', 'HP', 'DMG'];
    const targetConditionIndex = conditionHierarchy.indexOf(targetCondition);
    if (targetConditionIndex === -1) {
        throw new Error(`Invalid target condition provided: ${targetCondition}`);
    }

    try {
        await page.waitForSelector('.listing-item', { timeout: 10000 });
    } catch (e) {
        console.log('      -> No listings found on the page or it took too long to load.');
        data.cheapestListing = null;
        return data; // Return with no listing data
    }

    console.log(`      -> Processing page 1 listings...`);
    const listingElements = await page.locator('.listing-item').all();

    for (const item of listingElements) {
        try {
            // --- THIS IS THE FIX ---
            // 1. Get the raw condition text, which might be "Near Mint Foil".
            const rawConditionText = await item.locator('.listing-item__listing-data__info__condition').textContent();

            // 2. Clean the text by removing "Foil" before looking it up in the map.
            const cleanConditionText = rawConditionText.replace('Foil', '').trim();
            const conditionCode = conditionMap[cleanConditionText];

            if (conditionCode) {
                const listingConditionIndex = conditionHierarchy.indexOf(conditionCode);
                if (listingConditionIndex !== -1 && listingConditionIndex <= targetConditionIndex) {
                    
                    console.log(`      -> Found first valid listing with condition '${rawConditionText}'. Extracting price...`);
                    
                    const priceText = await item.locator('.listing-item__listing-data__info__price').textContent();
                    const shippingText = await item.locator('.listing-item__listing-data__info > span').textContent();
                    
                    const price = parseFloat(priceText.replace('$', ''));
                    
                    let shippingCost = 0;
                    const shippingMatch = shippingText.match(/\$(\d+\.\d+)/);
                    if (shippingMatch && shippingMatch[1]) {
                        shippingCost = parseFloat(shippingMatch[1]);
                    }

                    const totalPrice = price + shippingCost;
                    
                    data.cheapestListing = { totalPrice, itemPrice: price, shippingCost };
                    
                    console.log(`      -> Success! Cheapest listing found: $${price} + $${shippingCost} shipping.`);
                    return data; 
                }
            }
        } catch {
            continue; 
        }
    }
    
    // --- 4. RETURN IF NO MATCH WAS FOUND ON THE FIRST PAGE ---
    data.cheapestListing = null;
    console.log(`      -> No listing meeting the criteria was found on the first page.`);
    return data;
}

export { scrapeTcgplayerData };

