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
 * @param {object} options - Extra options.
 * @param {boolean} options.collectAll - When true, returns all visible listings (after filters) with metadata.
 */
async function scrapeManaPoolListings(page, manaPoolUrl, foilType, targetCondition, options = {}) {
    console.log(`  -> Scraping ManaPool for ${foilType} listings at ${targetCondition} or better...`);
    await page.goto(manaPoolUrl.toLowerCase(), { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForSelector('li .font-bold.text-green-700, li .font-bold.text-green-600', { timeout: 20000 });
    const collectAll = Boolean(options.collectAll);

    const openSelectTrigger = async (trigger) => {
        await trigger.scrollIntoViewIfNeeded({ timeout: 4000 }).catch(() => {});
        await page.waitForTimeout(300).catch(() => {});
        await trigger.click({ timeout: 3000 });
        // Wait for the trigger itself to reflect the open state
        await trigger.filter({ has: page.locator('[data-state="open"]') })
            .or(trigger.locator('xpath=self::*[@data-state="open"]'))
            .waitFor({ timeout: 3000 })
            .catch(() => {});
        // Then find the portal content
        const content = page.locator('[data-select-content][data-state="open"], [role="listbox"][data-state="open"]').first();
        await content.waitFor({ timeout: 3000 });
        return content;
    };

    const selectFromDropdown = async (triggerSelector, labels = []) => {
        if (!labels.length) return false;
        const trigger = page.locator(triggerSelector).first();
        if (!(await trigger.count())) return false;
        try {
            const content = await openSelectTrigger(trigger);

            for (const label of labels) {
                const labelRegex = new RegExp(`^\\s*${label.replace(/\s+/g, '\\s+')}\\s*$`, 'i');
                const option = content.getByRole('option', { name: labelRegex }).first();
                if (await option.count()) {
                    await option.click({ timeout: 2000 });
                    await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
                    return true;
                }
                const looseOption = content.locator('[data-select-item]', { hasText: labelRegex }).first();
                if (await looseOption.count()) {
                    await looseOption.click({ timeout: 2000 });
                    await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
                    return true;
                }
            }
            await page.keyboard.press('Escape').catch(() => {});
        } catch (err) {
            console.warn(`[manapool] Dropdown selection failed for ${labels.join(', ')}:`, err.message || err);
        }
        return false;
    };

    const applyConditionFilters = async (triggerSelector, targetCondition) => {
        const trigger = page.locator(triggerSelector).first();
        if (!(await trigger.count())) return false;
        const upperTarget = String(targetCondition || 'NM').toUpperCase();
        const allowSet = new Set(
            upperTarget === 'DMG' ? ['NM', 'LP', 'MP', 'HP', 'DMG']
                : upperTarget === 'HP' ? ['NM', 'LP', 'MP', 'HP']
                : upperTarget === 'MP' ? ['NM', 'LP', 'MP']
                : ['NM', 'LP'] // NM or LP treated the same
        );
        try {
            const content = await openSelectTrigger(trigger);
            const options = await content.locator('[data-select-item]').all();
            for (const option of options) {
                const rawValue = (await option.getAttribute('data-value')) || '';
                const value = rawValue.toUpperCase();
                const isSelected = (await option.getAttribute('data-selected')) !== null
                    || (await option.getAttribute('aria-selected')) === 'true';
                const shouldBeSelected = allowSet.has(value);
                if (isSelected !== shouldBeSelected) {
                    await option.click({ timeout: 2000 }).catch(() => {});
                    await page.waitForTimeout(100).catch(() => {});
                }
            }
            await page.keyboard.press('Escape').catch(() => {});
            await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
            return true;
        } catch (err) {
            console.warn('[manapool] Condition dropdown update failed:', err.message || err);
            return false;
        }
    };

    const applyUiFilters = async () => {
        // Try to use the built-in dropdowns instead of filtering purely in-memory.
        const finishLabels = {
            normal: ['Non-foils', 'Non-Foil', 'Nonfoil', 'Non foil', 'NF'],
            foil: ['Foils', 'Foil', 'FO'],
            etched: ['Etched', 'Etch', 'EF']
        };
        const conditionLabels = {
            NM: ['NM', 'Near Mint'],
            LP: ['LP', 'Lightly Played'],
            MP: ['MP', 'Moderately Played'],
            HP: ['HP', 'Heavily Played'],
            DMG: ['DMG', 'Damaged']
        };

        const finishTrigger = '[data-select-trigger][aria-label="Finish"], button[aria-label="Finish"], #bits-4, button:has-text("Any finish")';
        const conditionTrigger = '[data-select-trigger][aria-label="Condition"], button[aria-label="Condition"], #bits-5, button:has-text("Any condition")';

        const finishApplied = await selectFromDropdown(finishTrigger, finishLabels[foilType] || []);
        if (finishApplied) {
            console.log(`     -> Selected finish filter for ${foilType}.`);
        } else {
            console.log(`     -> No finish filter applied for ${foilType}.`);
        }
        const conditionApplied = await applyConditionFilters(conditionTrigger, targetCondition);
        if (conditionApplied) {
            console.log(`     -> Adjusted condition filters for ${targetCondition} (hiding worse).`);
        } else {
            console.log(`     -> No condition filter changes applied for ${targetCondition}.`);
        }
    };

    await applyUiFilters();

    const conditionHierarchy = ['NM', 'LP', 'MP', 'HP', 'DMG'];
    const targetConditionIndex = conditionHierarchy.indexOf(targetCondition);
    if (targetConditionIndex === -1) {
        throw new Error(`Invalid target condition provided: ${targetCondition}`);
    }

    const parseListing = async (item) => {
        // Seller
        const sellerNameElement = item.locator('a.text-sm.truncate.font-medium, div.text-sm.truncate.font-medium').first();
        const sellerName = await sellerNameElement.textContent({ timeout: 1000 });

        // Badges
        const badges = (await item.locator('span[class*=\"rounded\"]').allTextContents()).map(b => b.trim()).filter(Boolean);
        const normalizedBadges = badges.map(b => b.toLowerCase());

        // Language badges (non-English) should be ignored. English has no badge/flag.
        // Check for explicit language pill with flag (non-English). English has no pill.
        const languagePill = await item.locator('span.inline-flex.items-center.rounded-full.border img[alt]').evaluateAll((els) =>
            els.map(el => (el.getAttribute('alt') || '').trim().toLowerCase())
        ).catch(() => []);
        if (languagePill.some(alt => alt && !alt.includes('english'))) {
            return null; // ignore non-English listing
        }

        const listingIsEtched = normalizedBadges.some(b => b.includes('etched'));
        const listingHasFoilTrait = normalizedBadges.some(b => b.includes('foil')) && !normalizedBadges.some(b => b.includes('non-foil'));
        let parsedFoilType = 'normal';
        if (listingIsEtched) parsedFoilType = 'etched';
        else if (listingHasFoilTrait) parsedFoilType = 'foil';

        let listingCondition = 'NM'; // Default
        badges.forEach(badgeText => {
            const text = badgeText.toUpperCase();
            if (conditionHierarchy.includes(text)) listingCondition = text;
        });

        const priceElement = item.locator('.font-bold.text-green-700, .font-bold.text-green-600').first();
        const priceText = await priceElement.textContent();
        if (!priceText) return null;
        const numeric = parseFloat(priceText.replace(/[^0-9.]/g, ''));
        if (!Number.isFinite(numeric)) return null;

        return {
            price: numeric,
            sellerName: sellerName ? sellerName.trim() : null,
            condition: listingCondition,
            foilType: parsedFoilType
        };
    };

    const matchesVariant = (listing) => {
        if (!listing) return false;
        // Condition: listing condition index must be <= target condition (target or better)
        const listingConditionIndex = conditionHierarchy.indexOf((listing.condition || 'NM').toUpperCase());
        if (listingConditionIndex === -1) return false;
        if (listingConditionIndex > targetConditionIndex) return false;
        // Foil type match
        if (foilType === 'foil' && listing.foilType !== 'foil') return false;
        if (foilType === 'etched' && listing.foilType !== 'etched') return false;
        if (foilType === 'normal' && listing.foilType !== 'normal') return false;
        return true;
    };

    const collectVisibleListings = async () => {
        const listingElements = await page.locator('.flow-root li').all();
        if (listingElements.length === 0) throw new Error("No ManaPool listings found on page load.");
        const collected = [];
        for (const item of listingElements) {
            try {
                const parsed = await parseListing(item);
                const normalizedSeller = parsed?.sellerName ? parsed.sellerName.trim().toLowerCase() : '';
                if (normalizedSeller && SELF_SELLER_NAME && normalizedSeller === SELF_SELLER_NAME) {
                    continue; // ignore own listings
                }
                if (matchesVariant(parsed)) {
                    collected.push(parsed);
                }
            } catch {
                continue;
            }
        }
        return collected;
    };

    // 1. Try initial load; if needed, click Show More up to 5 times.
    let cheapestPrice = null;
    let cheapestSeller = null;

    // 2. If no price was found, then try clicking "Show More".
    console.log('     -> Ensuring enough listings are visible via "Show More"...');
    for (let i = 0; i < 5; i++) {
        try {
            const showMoreButton = page.getByRole('button', { name: /show more/i });
            if (!(await showMoreButton.count())) break;
            await showMoreButton.click({ timeout: 2000 });
            console.log('     -> Clicked "Show More" button.');
            await page.waitForLoadState('networkidle', { timeout: 5000 });
        } catch {
            break;
        }
    }

    // Collect listings after applying filters and expanding.
    const listings = await collectVisibleListings();
    if (listings.length) {
        cheapestPrice = listings[0].price;
        cheapestSeller = listings[0].sellerName || null;
    }
    
    return {
        cheapestPrice: cheapestPrice, // This will be the price or null
        sellerName: cheapestSeller || null,
        listings: collectAll ? listings : undefined
    };
}

export { scrapeManaPoolListings };
