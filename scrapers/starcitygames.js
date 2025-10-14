/**
 * Scrapes the Star City Games buylist for a specific Magic: The Gathering card.
 * This function navigates to the buylist, performs a search, and then parses
 * the results to find the exact printing that matches the provided identifiers,
 * specifically IGNORING promo versions.
 *
 * @param {object} page - The Playwright page object used for browsing.
 * @param {string} cardName - The English name of the card to search for.
 * @param {string} collectorNumber - The collector number of the specific printing.
 * @param {string} foilType - The finish of the card ('normal', 'foil', or 'etched').
 * @returns {Promise<number|null>} A Promise that resolves to the NM buylist price, or null if not found.
 */
async function scrapeStarCityGamesBuylist(page, cardName, collectorNumber, foilType) {
    console.log(`   -> Scraping SCG Buylist for: ${cardName} #${collectorNumber} (${foilType})`);
    const targetUrl = 'https://sellyourcards.starcitygames.com/mtg';

    try {
        await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });

        const searchInput = page.getByPlaceholder('Chandra Nalaar...');
        await searchInput.fill(cardName);
        await searchInput.press('Enter');
        console.log(`      -> Typed "${cardName}" into search and pressed Enter.`);

        console.log(`      -> Waiting for search results to render...`);
        await page.locator('#product-list .product.mtg .coll-number').first().waitFor({ timeout: 20000 });
        console.log(`      -> Product list container found and results are visible.`);

        const productElements = await page.locator('div.product.mtg').all();
        if (productElements.length === 0) {
            console.log("      -> DEBUG: No product divs found on the page.");
            return null;
        }
        console.log(`      -> DEBUG: Found ${productElements.length} product results. Iterating...`);

        for (const [index, item] of productElements.entries()) {
            try {
                await item.locator('.coll-number').waitFor({ timeout: 5000 });

                // --- THIS IS THE FIX ---
                // 1. Get the entire header text content which includes the title, subtitle, and set name.
                const headerText = await item.locator('.product-header').textContent({ timeout: 2000 });

                // 2. Check if the text contains "promo" or "prerelease". If it does, skip this item entirely.
                if (headerText.toLowerCase().includes('promo') || headerText.toLowerCase().includes('prerelease')) {
                    console.log(`      [Item ${index+1}] Skipping: Detected as a promo version.`);
                    continue; // "Ditch it" and move to the next item in the loop.
                }
                
                // --- Proceed with normal parsing only if it's not a promo ---
                const rawCollNumber = await item.locator('.coll-number').textContent({ timeout: 2000 });
                
                const normalizedCollNumber = rawCollNumber.replace('#', '').trim();
                const hasFoilClass = await item.locator('.finish.is-foil').count() > 0;
                const normalizedFinish = hasFoilClass ? 'foil' : 'normal';
                
                console.log(`      [Item ${index+1}] Parsed: #${normalizedCollNumber}, ${normalizedFinish}`);
                
                const numberMatch = parseInt(normalizedCollNumber, 10) === parseInt(collectorNumber, 10);
                const finishMatch = (foilType === 'normal' && normalizedFinish === 'normal') || 
                                    ((foilType === 'foil' || foilType === 'etched') && normalizedFinish === 'foil');
                
                console.log(`          -> Comparing: [Coll#: '${normalizedCollNumber}' vs '${collectorNumber}' -> ${numberMatch}] AND [Finish: '${normalizedFinish}' vs '${foilType}' -> ${finishMatch}]`);


                if (numberMatch && finishMatch) {
                    console.log(`      -> Potential match found at Item ${index+1}. Now checking for NM price...`);
                    
                    const nmPriceRow = item.locator('.variant-price:has-text("NM")');

                    if (await nmPriceRow.count() > 0) {
                        const priceElement = nmPriceRow.locator('.buy-price .price');
                        const priceText = await priceElement.textContent({ timeout: 5000 });
                        const price = parseFloat(priceText.replace('$', ''));

                        console.log(`      ✅ SUCCESS: Extracted NM price: $${price}. Returning this value.`);
                        return price;
                    } else {
                        console.log(`      -> Match found, but no NM price listed. Checking next result...`);
                    }
                }
            } catch (parseError) {
                console.warn(`      -> WARN: Could not fully parse item ${index+1}, skipping. Error: ${parseError.message.split('\n')[0]}`);
                continue;
            }
        }

        console.log("      -> DEBUG: Loop finished. No exact non-promo match with an NM price was found in any of the results.");
        return null;

    } catch (error) {
        console.error(`❌ CRITICAL FAILURE in SCG scraper for ${cardName}:`, error);
        return null;
    }
}

export { scrapeStarCityGamesBuylist };

