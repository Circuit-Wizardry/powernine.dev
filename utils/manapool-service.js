import axios from 'axios';
import { randomUUID } from 'crypto';
import { chromium } from 'playwright';
import { scrapeManaPoolListings } from '../scrapers/manapool.js';
import {
    recordShippingExpense,
    SHIPPING_EXPENSE_CATEGORIES,
    MANAPOOL_AUTO_SHIPPING_AMOUNT,
    MANAPOOL_AUTO_SHIPPING_THRESHOLD,
} from './expense-helpers.js';
import { sendManaPoolWebhook } from '../discord.js';
import { logDiscordConsole, logDiscordEvent, updateAutomationBotState } from './discord-bot.js';

const API_BASE = process.env.MANAPOOL_API_BASE || 'https://manapool.com/api/v1';
const API_KEY = process.env.MANAPOOL_API_KEY || '';
const API_EMAIL = process.env.MANAPOOL_EMAIL || '';
const SCRYFALL_API_BASE = 'https://api.scryfall.com/cards';
const SCRYFALL_VALIDATION_DELAY_MS = 200;
const REMOTE_LOOKUP_DELAY_MS = 200;
const REMOTE_INVENTORY_CACHE_TTL_MS = 2 * 60 * 1000;
const remoteInventoryCache = {
    timestamp: 0,
    snapshot: null
};

const inventoryLockState = {
    locked: false,
    reason: '',
    actor: '',
    lockedAt: null
};

export function getInventoryLockState() {
    return { ...inventoryLockState };
}

export function setInventoryLockState(locked, options = {}) {
    const nowLocked = Boolean(locked);
    inventoryLockState.locked = nowLocked;
    inventoryLockState.reason = nowLocked ? (options.reason || '') : '';
    inventoryLockState.actor = nowLocked ? (options.actor || '') : '';
    inventoryLockState.lockedAt = nowLocked ? new Date().toISOString() : null;
    updateAutomationBotState({
        inventoryLocked: inventoryLockState.locked,
        inventoryLockReason: inventoryLockState.reason,
        inventoryLockActor: inventoryLockState.actor
    });
    const action = nowLocked ? 'locked' : 'unlocked';
    const reason = inventoryLockState.reason ? `: ${inventoryLockState.reason}` : '';
    logDiscordConsole(`[inventory] Inventory sync ${action}${reason}`).catch(() => {});
    return getInventoryLockState();
}

const manapoolClient = axios.create({
    baseURL: API_BASE,
    timeout: 20000,
});

const fetchRemoteInventorySnapshot = async () => {
    if (!hasCredentials()) {
        return {
            source: 'placeholder',
            fetchedAt: new Date().toISOString(),
            items: SAMPLE_REMOTE_INVENTORY
        };
    }
    try {
        let allItems = [];
        const limit = 500;
        let offset = 0;
        while (true) {
            const response = await manapoolClient.get('/seller/inventory', {
                headers: authHeaders(),
                params: { limit, offset }
            });
            const inventoryPage = normalizeInventoryResponse(response.data?.inventory);
            allItems = allItems.concat(inventoryPage);
            const pagination = response.data?.pagination;
            const returned = pagination?.returned ?? inventoryPage.length;
            if (!pagination || returned === 0) break;
            offset += returned;
            if (offset >= pagination.total) break;
        }
        return {
            source: 'manapool',
            fetchedAt: new Date().toISOString(),
            items: normalizeRemoteInventory(allItems)
        };
    } catch (error) {
        return {
            source: 'error',
            fetchedAt: new Date().toISOString(),
            items: SAMPLE_REMOTE_INVENTORY,
            error: parseAxiosError(error)
        };
    }
};

const getCachedRemoteInventorySnapshot = async () => {
    const now = Date.now();
    if (remoteInventoryCache.snapshot && (now - remoteInventoryCache.timestamp) < REMOTE_INVENTORY_CACHE_TTL_MS) {
        return remoteInventoryCache.snapshot;
    }
    const snapshot = await fetchRemoteInventorySnapshot();
    if (snapshot?.source === 'manapool') {
        remoteInventoryCache.snapshot = snapshot;
        remoteInventoryCache.timestamp = now;
    } else {
        remoteInventoryCache.snapshot = null;
        remoteInventoryCache.timestamp = 0;
    }
    return snapshot;
};

const SAMPLE_REMOTE_INVENTORY = [
    {
        id: 'mp-1001',
        name: 'Sol Ring',
        setCode: 'CMR',
        scryfallId: 'd582b3c3-996e-4f4b-9efd-134e127d563c',
        foilType: 'normal',
        condition: 'NM',
        quantity: 4,
        price: 12.25
    },
    {
        id: 'mp-2042',
        name: 'Lightning Bolt',
        setCode: '2XM',
        scryfallId: '5f0616e6-6f9c-46b6-90e3-6d2f6f0d375c',
        foilType: 'foil',
        condition: 'LP',
        quantity: 8,
        price: 3.5
    }
];

const SAMPLE_ORDERS = [
    {
        id: 'order-001',
        buyer: 'MTGCollector',
        total: 42.18,
        createdAt: new Date().toISOString(),
        lineItems: [
            { name: 'Sol Ring', setCode: 'CMR', collectorNumber: '392', scryfallId: 'd582b3c3-996e-4f4b-9efd-134e127d563c', foilType: 'normal', condition: 'NM', quantity: 1, salePrice: 12.5 },
            { name: 'Lightning Bolt', setCode: '2XM', collectorNumber: '162', scryfallId: '5f0616e6-6f9c-46b6-90e3-6d2f6f0d375c', foilType: 'foil', condition: 'LP', quantity: 2, salePrice: 5.2 }
        ]
    }
];

const FINISH_ID_MAP = {
    normal: 'NF',
    foil: 'FO',
    etched: 'EF'
};

const FINISH_ID_TO_FOIL = {
    NF: 'normal',
    FO: 'foil',
    EF: 'etched'
};

const CONDITION_ID_MAP = {
    NM: 'NM',
    M: 'NM',
    LP: 'LP',
    MP: 'MP',
    HP: 'HP',
    DMG: 'DMG'
};

const LANGUAGE_ID = 'EN';

const MANAPOOL_FEE_RATE = 0.079;
const MANAPOOL_FEE_FLAT = 0.30;
const SELF_SELLER_NAME = (process.env.MANAPOOL_SELLER_NAME || 'Fells Forge TCG').trim().toLowerCase();

const normalizeSellerNameValue = (value) => {
    if (value === null || typeof value === 'undefined') return '';
    if (typeof value === 'string' || typeof value === 'number') {
        return String(value).trim().toLowerCase();
    }
    if (Array.isArray(value)) {
        for (const entry of value) {
            const normalized = normalizeSellerNameValue(entry);
            if (normalized) return normalized;
        }
        return '';
    }
    if (typeof value === 'object') {
        const candidate = value.name ?? value.display_name ?? value.store_name ?? value.storeName;
        if (candidate) {
            return normalizeSellerNameValue(candidate);
        }
    }
    return '';
};

const extractListingSellerName = (listing = {}) => {
    const candidates = [
        listing.seller_name,
        listing.sellerName,
        listing.seller_display_name,
        listing.seller_slug,
        listing.seller,
        listing.store,
        listing.store_name,
        listing.storeName,
        listing.store?.seller,
        listing.store?.name,
        listing.store?.display_name,
        listing.seller?.name,
        listing.seller?.display_name
    ];
    for (const candidate of candidates) {
        const normalized = normalizeSellerNameValue(candidate);
        if (normalized) return normalized;
    }
    return '';
};

const hasCredentials = () => Boolean(API_KEY);

const authHeaders = () => {
    if (!hasCredentials()) {
        throw new Error('MANAPOOL_API_KEY is not configured.');
    }
    const headers = {
        Authorization: `Bearer ${API_KEY}`,
        'X-ManaPool-Access-Token': API_KEY
    };
    if (API_EMAIL) {
        headers['X-ManaPool-Email'] = API_EMAIL;
    }
    return headers;
};

const parseAxiosError = (error) => {
    if (error.response) {
        return error.response.data?.error
            || error.response.data?.message
            || `ManaPool API responded with ${error.response.status}`;
    }
    if (error.request) {
        return 'No response received from ManaPool API.';
    }
    return error.message || 'Unknown ManaPool error.';
};

const getLocalInventoryCount = (db) => new Promise((resolve) => {
    db.get('SELECT COUNT(*) as count FROM inventory WHERE quantity IS NOT NULL AND quantity > 0', [], (err, row) => {
        if (err) {
            console.error('[manapool] Failed counting inventory:', err.message);
            resolve(0);
            return;
        }
        resolve(row?.count || 0);
    });
});

export const getLocalInventoryRows = (db) => new Promise((resolve, reject) => {
    db.all('SELECT id, name, setCode, collectorNumber, foilType, pricePaid, quantity, scryfallId, tcgMarketPrice, condition, tcgplayerId, manaPoolLow FROM inventory', [], (err, rows) => {
        if (err) {
            reject(err);
        } else {
            resolve(rows || []);
        }
    });
});

const normalizeVariantCondition = (value) => {
    const upper = String(value || 'NM').toUpperCase();
    if (upper === 'LP') return 'NM';
    return upper;
};

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const chunkArray = (arr, size = 100) => {
    const chunks = [];
    for (let i = 0; i < arr.length; i += size) {
        chunks.push(arr.slice(i, i + size));
    }
    return chunks;
};

const SHIPPED_STATUS_SET = new Set(['shipped', 'fulfilled', 'complete', 'completed', 'delivered', 'closed']);

const determineOrderShipmentStatus = (order = {}) => {
    const normalize = (value) => (value || '').toString().trim().toLowerCase();
    const directStatus = normalize(order.status || order.state || order.fulfillment_status);
    if (SHIPPED_STATUS_SET.has(directStatus)) {
        return true;
    }
    if (Array.isArray(order.fulfillments)) {
        for (const fulfillment of order.fulfillments) {
            const fStatus = normalize(fulfillment?.status);
            if (SHIPPED_STATUS_SET.has(fStatus)) {
                return true;
            }
            if (fulfillment?.shipped_at || fulfillment?.fulfilled_at || fulfillment?.delivered_at) {
                return true;
            }
        }
    }
    return false;
};

const getTransactionRecordForOrder = (db, orderId) => new Promise((resolve, reject) => {
    db.get(
        `SELECT id, COALESCE(isShipped, 1) as isShipped FROM transactions WHERE manapoolOrderId = ? LIMIT 1`,
        [orderId],
        (err, row) => {
            if (err) return reject(err);
            resolve(row || null);
        }
    );
});

const updateTransactionShipmentStatus = (db, transactionId, isShipped) => {
    return runAsync(
        db,
        `UPDATE transactions SET isShipped = ? WHERE id = ?`,
        [isShipped ? 1 : 0, transactionId]
    );
};

const runAsync = (db, sql, params = []) => new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
        if (err) return reject(err);
        resolve(this);
    });
});

const allAsync = (db, sql, params = []) => new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
        if (err) return reject(err);
        resolve(rows || []);
    });
});

const normalizeInventoryResponse = (payload) => {
    if (!payload) return [];
    if (Array.isArray(payload)) return payload;
    if (Array.isArray(payload.data)) return payload.data;
    return [];
};


const isUuid = (value) => /^[0-9a-fA-F-]{36}$/.test(String(value || '').trim());

const getInventoryRowsByIds = (db, ids = []) => new Promise((resolve, reject) => {
    if (!ids.length) return resolve([]);
    const placeholders = ids.map(() => '?').join(',');
    const sql = `
        SELECT id, name, setCode, collectorNumber, foilType, pricePaid, quantity, scryfallId, tcgMarketPrice, condition, tcgplayerId, manaPoolLow
        FROM inventory
        WHERE id IN (${placeholders})
    `;
    db.all(sql, ids, (err, rows) => {
        if (err) return reject(err);
        resolve(rows || []);
    });
});

const extractTcgplayerId = (cardData = {}, options = {}) => {
    const finish = String(options.finish || options.foilType || '').toLowerCase();
    const preferEtched = finish.includes('etch');

    const direct = cardData?.tcgplayer_id;
    const etched = cardData?.tcgplayer_etched_id;

    if (preferEtched && etched) return etched;
    if (direct) return direct;
    if (etched) return etched;

    if (Array.isArray(cardData?.card_faces)) {
        for (const face of cardData.card_faces) {
            const faceDirect = face?.tcgplayer_id;
            const faceEtched = face?.tcgplayer_etched_id;
            if (preferEtched && faceEtched) return faceEtched;
            if (faceDirect) return faceDirect;
            if (faceEtched) return faceEtched;
        }
    }
    return null;
};

const fetchTcgplayerIdFromScryfall = async (scryfallId, index = 0, options = {}) => {
    if (!isUuid(scryfallId)) return null;
    if (index > 0) {
        await delay(SCRYFALL_VALIDATION_DELAY_MS);
    }
    try {
        const response = await axios.get(`${SCRYFALL_API_BASE}/${encodeURIComponent(scryfallId)}`);
        return extractTcgplayerId(response.data, options);
    } catch (error) {
        console.warn('[scryfall] tcgplayer lookup failed:', scryfallId, error.response?.status || error.message);
        return null;
    }
};

const normalizeCollectorNumber = (value) => String(value || '').trim().toUpperCase();

const normalizeManaPoolSlug = (cardName = '') => {
    return cardName
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9\s-]/g, '')
        .trim()
        .replace(/\s+/g, '-');
};

const normalizeFoilTypeForScrape = (value = 'normal') => {
    const lower = String(value || 'normal').toLowerCase();
    if (lower.includes('etch')) return 'etched';
    if (lower.includes('foil') && !lower.includes('non')) return 'foil';
    return 'normal';
};

const normalizeConditionForScrape = (value = 'NM') => {
    const upper = String(value || 'NM').toUpperCase();
    if (upper === 'M') return 'NM';
    return upper;
};

const buildManaPoolCardUrl = (item = {}) => {
    const setCode = (item.setCode || item.set_code || '').toLowerCase();
    const number = normalizeCollectorNumber(item.collectorNumber || item.number || '');
    const name = item.name || item.cardName || '';
    if (!setCode || !number || !name) return null;
    const slug = normalizeManaPoolSlug(name) || encodeURIComponent(name.toLowerCase());
    return `https://manapool.com/card/${setCode}/${encodeURIComponent(number)}/${slug}`;
};

const buildVariantKey = (item = {}) => {
    const setCode = (item.setCode || '').toUpperCase();
    const number = normalizeCollectorNumber(item.collectorNumber || item.number);
    const finish = FINISH_ID_MAP[item.foilType] || (item.finish_id || 'NF');
    const condition = normalizeVariantCondition(item.condition || item.condition_id);
    if (!setCode || !number) return null;
    return `${setCode}|${number}|${finish}|${condition}`;
};

const formatVariantKeyFromListing = (listing = {}) => {
    const setCode = (listing.set_code || '').toUpperCase();
    const number = normalizeCollectorNumber(listing.number);
    const finish = (listing.finish_id || 'NF').toUpperCase();
    const condition = normalizeVariantCondition(listing.condition_id);
    if (!setCode || !number) return null;
    return `${setCode}|${number}|${finish}|${condition}`;
};

export const fetchVariantFloorsForInventory = async (items = [], options = {}) => {
    const result = new Map();
    if (!Array.isArray(items) || !items.length) return result;
    const concurrency = Math.max(1, Math.min(Number(options.concurrency) || 5, 10));

    // Deduplicate variant keys so each card is scraped once.
    const queue = [];
    const seen = new Set();
    for (const item of items) {
        const key = buildVariantKey(item);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        queue.push({ key, item });
    }
    if (!queue.length) return result;

    const maxWorkers = Math.min(concurrency, queue.length);
    let browser;
    try {
        browser = await chromium.launch({ headless: true });
        const context = await browser.newContext({
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36'
        });

        let index = 0;
        const pages = await Promise.all(Array.from({ length: maxWorkers }).map(() => context.newPage()));

        const worker = async (page) => {
            while (true) {
                const currentIndex = index;
                index += 1;
                if (currentIndex >= queue.length) break;
                const { key, item } = queue[currentIndex];
                const url = buildManaPoolCardUrl(item);
                if (!url) continue;
                const foilType = normalizeFoilTypeForScrape(item.foilType || item.finish_id || 'normal');
                const targetCondition = normalizeConditionForScrape(item.condition || item.condition_id || 'NM');
                try {
                    const scrapeResult = await scrapeManaPoolListings(page, url, foilType, targetCondition, { collectAll: true });
                    const listings = Array.isArray(scrapeResult?.listings) ? scrapeResult.listings : [];
                    const fallbackListing = Number.isFinite(scrapeResult?.cheapestPrice) && scrapeResult.cheapestPrice > 0
                        ? [{
                            price: scrapeResult.cheapestPrice,
                            sellerName: scrapeResult.sellerName || null,
                            condition: targetCondition,
                            foilType
                        }]
                        : [];
                    const normalizedCandidates = (listings.length ? listings : fallbackListing)
                        .map((entry) => {
                            const priceValue = Number(entry?.price);
                            return {
                                ...entry,
                                priceCents: Number.isFinite(priceValue) ? Math.round(priceValue * 100) : null
                            };
                        })
                        .filter((entry) => Number.isFinite(entry.priceCents) && entry.priceCents > 0);
                    if (!normalizedCandidates.length) continue;
                    normalizedCandidates.sort((a, b) => a.priceCents - b.priceCents);
                    const best = normalizedCandidates[0];
                    const normalizedSeller = normalizeSellerNameValue(best.sellerName);
                    const isSelf = Boolean(normalizedSeller && SELF_SELLER_NAME && normalizedSeller === SELF_SELLER_NAME);
                    result.set(key, {
                        priceCents: best.priceCents,
                        floorPriceCents: best.priceCents,
                        available: null,
                        url,
                        sellerName: normalizedSeller || (best.sellerName ? best.sellerName.trim().toLowerCase() : null),
                        isSelf,
                        rawListing: null
                    });
                } catch (error) {
                    console.warn(`[manapool] Failed scraping ${item.name || key}:`, error.message || error);
                }
            }
        };

        await Promise.all(pages.map((page) => worker(page).finally(() => page.close().catch(() => {}))));
    } catch (error) {
        console.error('[manapool] Failed to scrape ManaPool variant prices:', error.message || error);
        return new Map();
    } finally {
        if (browser) await browser.close().catch(() => {});
    }

    return result;
};

const buildPushPayload = async (items = [], options = {}) => {
    const filterCandidate = typeof options.filterCandidate === 'function' ? options.filterCandidate : null;
    const maxQuantityPerCard = Number.isFinite(Number(options.maxQuantityPerCard)) && Number(options.maxQuantityPerCard) >= 1
        ? Math.round(Number(options.maxQuantityPerCard))
        : null;
    const candidates = items.filter(item => {
        if (!Number.isFinite(item.quantity) || item.quantity <= 0) return false;
        if (filterCandidate && !filterCandidate(item)) return false;
        return true;
    });
    if (!candidates.length) {
        return { payload: [], missing: [], skipped: items.length };
    }

    const missingIds = [];
    let lookupIndex = 0;

    const payload = [];
    const contexts = [];
    const entryIndexByKey = new Map();
    for (const item of candidates) {
        let tcgId = item.tcgplayerId && String(item.tcgplayerId).trim() !== '' ? item.tcgplayerId : null;
        if (!tcgId && item.scryfallId) {
            tcgId = await fetchTcgplayerIdFromScryfall(item.scryfallId, lookupIndex, { finish: item.foilType });
            lookupIndex += 1;
        }
        if (!tcgId) {
            missingIds.push({
                id: item.id,
                name: item.name,
                scryfallId: item.scryfallId || null
            });
            continue;
        }

        let priceBasis = Number(item.tcgMarketPrice ?? item.pricePaid ?? 0) || 0;
        if (!(priceBasis > 0)) {
            priceBasis = 100;
        }
        const priceCents = Math.max(1, Math.round(priceBasis * 100));
        const rawQuantity = Math.max(0, Number(item.quantity) || 0);
        const cappedQuantity = maxQuantityPerCard ? Math.min(rawQuantity, maxQuantityPerCard) : rawQuantity;
        const entry = {
            tcgplayer_id: Number(tcgId),
            language_id: LANGUAGE_ID,
            finish_id: FINISH_ID_MAP[item.foilType] || 'NF',
            condition_id: CONDITION_ID_MAP[String(item.condition || 'NM').toUpperCase()] || 'NM',
            base_price_cents: priceCents,
            price_cents: priceCents,
            quantity: cappedQuantity
        };
        const context = {
            inventory: { ...item },
            variantKey: buildVariantKey(item)
        };
        const key = entryKey(entry);
        if (entryIndexByKey.has(key)) {
            const idx = entryIndexByKey.get(key);
            const existingEntry = payload[idx];
            const existingContext = contexts[idx];
            const existingQty = Math.max(0, Number(existingEntry.quantity) || 0);
            const incomingQty = Math.max(0, Number(entry.quantity) || 0);
            const totalQty = existingQty + incomingQty;
            if (totalQty > 0) {
                const weighted = Math.round(
                    ((existingEntry.price_cents || 0) * existingQty + (entry.price_cents || 0) * incomingQty) / totalQty
                );
                existingEntry.quantity = maxQuantityPerCard ? Math.min(totalQty, maxQuantityPerCard) : totalQty;
                existingEntry.price_cents = Math.max(1, weighted || existingEntry.price_cents);
                existingEntry.base_price_cents = existingEntry.price_cents;
                existingContext.inventory.quantity = totalQty;
                existingContext.combinedIds = Array.isArray(existingContext.combinedIds)
                    ? existingContext.combinedIds.concat(item.id).filter(Boolean)
                    : [existingContext.inventory.id, item.id].filter(Boolean);
            }
            continue;
        }
        entryIndexByKey.set(key, payload.length);
        payload.push(entry);
        contexts.push(context);
    }

    return { payload, contexts, missing: missingIds };
};

const logVariantSellersForItems = async (items = []) => {
    if (!items.length) return;
    try {
        const variantMap = await fetchVariantFloorsForInventory(items, { includeSelfSellers: true });
        items.forEach((item) => {
            const key = buildVariantKey(item);
            const variant = key ? variantMap.get(key) : null;
            const descriptor = `${item.name || 'Unknown'} [${item.setCode || ''} ${item.collectorNumber || ''} ${item.foilType || 'normal'}/${item.condition || 'NM'}]`;
            if (!variant) {
                console.log(`[manapool] Variant seller for ${descriptor}: no live variant data (key=${key || 'none'})`);
                return;
            }
            const sellerName = variant.sellerName || 'unknown';
            const selfNote = variant.isSelf ? ' (self listing)' : '';
            console.log(`[manapool] Variant seller for ${descriptor}: ${sellerName}${selfNote}`);
            if (variant.rawListing) {
                try {
                    console.log('[manapool] Variant raw payload:', JSON.stringify(variant.rawListing, null, 2));
                } catch (jsonError) {
                    console.log('[manapool] Variant raw payload (stringify failed):', variant.rawListing);
                }
            }
        });
    } catch (error) {
        console.warn('[manapool] Failed to log variant sellers:', error.message);
    }
};

const buildUndercutAutomationContext = async (items = [], offsetCents = 1, options = {}) => {
    let variantPriceMap = new Map();
    const normalizedOffset = Number.isFinite(Number(offsetCents)) ? Math.max(1, Number(offsetCents)) : 1;
    const concurrency = options?.concurrency;
    const automation = {
        strategy: { type: 'undercutBest', value: normalizedOffset },
        variantPriceMap,
        floorRules: null,
        baselineMap: new Map(),
        exclusionMatcher: null,
        dropThresholdPercent: 0
    };
    try {
        variantPriceMap = await fetchVariantFloorsForInventory(items, { concurrency });
        automation.variantPriceMap = variantPriceMap;
    } catch (error) {
        automation.variantPriceMap = new Map();
        automation.variantFetchError = error?.message || 'Failed to fetch variant prices.';
        console.warn('[manapool] Failed to fetch variant prices for manual push:', automation.variantFetchError);
    }
    return automation;
};

const formatCentsValue = (value) => {
    if (!Number.isFinite(value)) return '--';
    return `$${(value / 100).toFixed(2)}`;
};

const logPricingDecision = (context, entry) => {
    if (!context?.inventory || !entry) return;
    const item = context.inventory;
    const descriptor = `${item.name || 'Unknown'} [${item.setCode || ''} ${item.collectorNumber || ''} ${item.foilType || 'normal'}/${item.condition || 'NM'}]`;
    const ourBefore = Number(entry.previous_price_cents);
    const ourAfter = Number(entry.price_cents);
    const competitor = context.__automationVariant?.priceCents;
    if (context?.__variantFeedError) {
        console.log(`[manapool] ${descriptor}: skipped detailed decision logging (${context.__variantFeedError})`);
        return;
    }
    const action = context.__automationAction || (ourAfter !== ourBefore ? 'update' : 'hold');
    const reason = context.__automationReason ? ` - ${context.__automationReason}` : '';
    console.log(`[manapool] Pricing decision for ${descriptor}: ours ${formatCentsValue(ourBefore)} -> ${formatCentsValue(ourAfter)} | competitor ${formatCentsValue(competitor)} | action ${action}${reason}`);
};

const entryKey = (entry) => [
    entry.tcgplayer_id,
    entry.language_id,
    entry.finish_id,
    entry.condition_id
].join('|');

const pushInventoryRows = async (items = [], options = {}) => {
    const priceOffsetCents = Number.isFinite(options.priceOffsetCents) ? Number(options.priceOffsetCents) : 1;
    const deleteMissing = Boolean(options.deleteMissing);
    const shouldNotifyAutomation = Boolean(options.notifyAutomation);
    const simulateOnly = Boolean(options.simulateOnly);
    const debugCollector = Array.isArray(options.debugCollector) ? options.debugCollector : null;
    const automationOptions = options.automation || null;
    const filterCandidate = automationOptions?.exclusionMatcher
        ? (item) => !automationOptions.exclusionMatcher(item)
        : null;
    const maxQuantityPerCard = options.maxQuantityPerCard ?? null;
    const { payload, contexts, missing } = await buildPushPayload(items, { filterCandidate, maxQuantityPerCard });
    const lockState = getInventoryLockState();
    let automationCardsUpdated = 0;
    let automationValueDeltaCents = 0;
    const automationDropAlerts = [];
    const automationPriceDrops = [];
    const automationPriceIncreases = [];
    let automationIncreaseCents = 0;
    let automationDecreaseCents = 0;
    let sortedDrops = [];
    let sortedRaises = [];

    const getBaselineForContext = (context) => {
        if (!automationOptions?.baselineMap || !context?.inventory?.id) return null;
        const baseline = automationOptions.baselineMap.get(context.inventory.id);
        return Number.isFinite(baseline) && baseline > 0 ? baseline : null;
    };

    if (!payload.length) {
        const skipMsg = 'No inventory items with positive quantity and valid TCGPlayer IDs to sync.';
        return {
            updated: 0,
            message: skipMsg,
            preview: [],
            missing
        };
    }

    if (!hasCredentials() && !simulateOnly) {
        return {
            updated: 0,
            message: 'MANAPOOL_API_KEY missing. Performed dry run only.',
            preview: payload.slice(0, 25),
            missing
        };
    }

    if (!simulateOnly && lockState.locked) {
        const lockMessage = `Inventory sync locked${lockState.reason ? `: ${lockState.reason}` : ''}`;
        return {
            updated: 0,
            deleted: 0,
            message: lockMessage,
            preview: [],
            missing,
            automationSummary: automationOptions ? {
                blocked: true,
                reason: lockState.reason || 'Inventory locked',
                cardsUpdated: 0,
                valueDeltaCents: 0,
                priceDrops: [],
                alerts: [],
                runAt: new Date().toISOString(),
                message: lockMessage
            } : null
        };
    }

    const previewEntries = [];
    const payloadPairs = payload.map((entry, index) => ({ entry, context: contexts[index] || null }));
    const contextMap = new Map(payloadPairs.map(pair => [entryKey(pair.entry), pair.context || null]));
    const payloadMap = new Map(payloadPairs.map(pair => [entryKey(pair.entry), pair.entry]));
    const missingEntries = new Map();
    let updatedCount = 0;
    let createdCount = 0;
    const messages = [];

    let remoteSnapshot = null;
    let remoteMap = new Map();
    let hasRemoteBaseline = false;
    try {
        remoteSnapshot = await getCachedRemoteInventorySnapshot();
        if (remoteSnapshot?.items?.length) {
            remoteMap = buildRemoteListingMap(remoteSnapshot.items);
            hasRemoteBaseline = true;
        }
    } catch (error) {
        console.warn('[manapool] failed to pull inventory snapshot:', error.message);
    }

    const applyAutomationFloors = (targetCents, context, remoteListing) => {
        if (!automationOptions?.floorRules) return Math.max(1, Math.round(targetCents));
        const floorRules = automationOptions.floorRules;
        const baselinePrice = getBaselineForContext(context);
        const remotePriceValue = Number(remoteListing?.priceCents);
        const remotePriceCents = Number.isFinite(remotePriceValue) && remotePriceValue > 0
            ? Math.round(remotePriceValue)
            : null;
        const inventoryPriceValue = context?.inventory?.tcgMarketPrice;
        const inventoryPriceCents = Number.isFinite(Number(inventoryPriceValue))
            ? Math.round(Number(inventoryPriceValue) * 100)
            : null;
        const normalizedTarget = Math.max(1, Math.round(targetCents));
        const startingPrice = Number.isFinite(baselinePrice) && baselinePrice > 0
            ? baselinePrice
            : ([remotePriceCents, inventoryPriceCents, normalizedTarget]
                .find((value) => Number.isFinite(value) && value > 0) || normalizedTarget);
        let minAllowed = 1;
        let floorSource = null;
        const clampPercent = (value) => Math.min(100, Math.max(0, Number(value) || 0));
        const applyFloor = (value, source) => {
            if (!Number.isFinite(value)) return;
            const rounded = Math.max(1, Math.round(value));
            if (rounded >= minAllowed) {
                minAllowed = rounded;
                floorSource = source || floorSource;
            }
        };
        if (floorRules.global && startingPrice > 0) {
            if (floorRules.global.type === 'percent') {
                const pct = clampPercent(floorRules.global.value);
                applyFloor(startingPrice * (1 - pct / 100), `Global ${pct}% drop limit`);
            } else if (floorRules.global.type === 'absolute') {
                const drop = Math.max(0, Number(floorRules.global.value) || 0);
                applyFloor(startingPrice - Math.round(drop * 100), `Global $${drop.toFixed(2)} drop limit`);
            }
        }
        const overrides = floorRules.overrides;
        if (overrides && context?.inventory?.name) {
            const name = (context.inventory.name || '').toLowerCase();
            const setCode = (context.inventory.setCode || '').toLowerCase();
            const specificKey = `${name}|${setCode}`;
            const fallbackKey = `${name}|`;
            const override = overrides.get(specificKey) || overrides.get(fallbackKey);
            if (override) {
                if (override.type === 'percent' && startingPrice > 0) {
                    const pct = clampPercent(override.value);
                    applyFloor(startingPrice * (pct / 100), `Override ${pct}% of anchor`);
                } else if (override.type === 'absolute') {
                    const absValue = Math.max(0, Number(override.value) || 0);
                    applyFloor(absValue * 100, `Override floor $${absValue.toFixed(2)}`);
                }
            }
        }
        const finalPrice = Math.max(minAllowed, normalizedTarget);
        if (context) {
            context.__automationFloorAnchor = startingPrice;
            context.__automationFloorMin = minAllowed;
            context.__automationFloorSource = floorSource;
        }
        return finalPrice;
    };

    const determineAutomationPrice = (pair, remoteListing) => {
        if (!automationOptions || !pair?.context?.inventory) return null;
        const { strategy, variantPriceMap } = automationOptions;
        if (!strategy) return null;
        const item = pair.context.inventory;
        const variantKey = pair.context.variantKey || buildVariantKey(item);
        const variant = variantKey ? variantPriceMap?.get(variantKey) : null;
        pair.context.__automationVariant = variant || null;
        let targetCents = null;
        if (strategy.type === 'undercutBest') {
            const ourPrice = Number.isFinite(Number(remoteListing?.priceCents))
                ? Number(remoteListing.priceCents)
                : (getBaselineForContext(pair.context) || null);
            if (!Number.isFinite(ourPrice) || ourPrice <= 0) {
                pair.context.__automationReason = 'No current ManaPool price available';
                return null;
            }
            if (!variant?.priceCents || !Number.isFinite(variant.priceCents)) {
                pair.context.__automationReason = 'No competitor price data';
                return null;
            }
            const competitorFloor = Number.isFinite(variant.floorPriceCents) ? variant.floorPriceCents : null;
            const effectiveCompetitorPrice = Math.min(
                Number.isFinite(variant.priceCents) ? variant.priceCents : Infinity,
                Number.isFinite(competitorFloor) ? competitorFloor : Infinity
            );
            if (!Number.isFinite(effectiveCompetitorPrice) || effectiveCompetitorPrice === Infinity) {
                pair.context.__automationReason = 'No competitor price data';
                return null;
            }
            const competitorIsSelf = Boolean(
                (variant.isSelf) ||
                (variant.sellerName && SELF_SELLER_NAME && variant.sellerName === SELF_SELLER_NAME)
            );
            if (competitorIsSelf) {
                pair.context.__automationReason = 'Cheapest listing is yours';
                return null;
            }
            const offset = Number.isFinite(strategy.value) ? strategy.value : 1;
            if (effectiveCompetitorPrice < ourPrice) {
                // Under our price: undercut to stay ahead
                targetCents = Math.max(1, effectiveCompetitorPrice - offset);
                pair.context.__automationReason = `Undercutting ${variant.sellerName || 'unknown'} by ${offset}¢ (competitor $${(effectiveCompetitorPrice / 100).toFixed(2)})`;
            } else if (effectiveCompetitorPrice > ourPrice + offset) {
                // Above our price: raise up to just under competitor
                targetCents = Math.max(1, effectiveCompetitorPrice - offset);
                pair.context.__automationReason = `Raising to ${offset}¢ under ${variant.sellerName || 'unknown'} (competitor $${(effectiveCompetitorPrice / 100).toFixed(2)})`;
            } else {
                pair.context.__automationReason = 'Competitor within offset; holding price';
                return null;
            }
        } else if (strategy.type === 'manaPoolLowPercent') {
            const base = Number(item.manaPoolLow);
            if (base > 0) {
                const percent = Number.isFinite(strategy.value) ? strategy.value : 5;
                targetCents = Math.round(Math.max(0.01, base) * 100 * (1 - percent / 100));
                pair.context.__automationReason = `Targeting ${percent}% under ManaPool low`;
            }
        } else if (strategy.type === 'manaPoolLowCents') {
            const base = Number(item.manaPoolLow);
            if (base > 0) {
                const drop = Number.isFinite(strategy.value) ? strategy.value : 0.25;
                targetCents = Math.round(Math.max(0.01, base - drop) * 100);
                pair.context.__automationReason = `Targeting $${drop.toFixed(2)} under ManaPool low`;
            }
        } else if (strategy.type === 'tcgMarketMatch') {
            const base = Number(item.tcgMarketPrice);
            if (base > 0) {
                targetCents = Math.round(base * 100);
                pair.context.__automationReason = 'Matching TCG Market';
            }
        }
        if (!Number.isFinite(targetCents) || targetCents <= 0) return null;
        const adjusted = applyAutomationFloors(targetCents, pair.context, remoteListing);
        if (adjusted !== targetCents && pair.context.__automationReason) {
            pair.context.__automationReason += ` (floored to $${(adjusted / 100).toFixed(2)})`;
        }
        return adjusted;
    };

    payloadPairs.forEach(pair => {
        const { entry, context } = pair;
        if (context) {
            context.__automationVariant = null;
            context.__automationReason = '';
            context.__variantFeedError = automationOptions?.variantFetchError || null;
        }
        const key = entryKey(entry);
        const remoteListing = remoteMap.get(key);
        const fallbackPrice = Math.max(0, Number(entry.base_price_cents) || 0);
        const previousPrice = (remoteListing && typeof remoteListing.priceCents === 'number')
            ? remoteListing.priceCents
            : (hasRemoteBaseline ? 0 : fallbackPrice);
        entry.previous_price_cents = previousPrice;
        const automationTarget = determineAutomationPrice(pair, remoteListing);
        if (Number.isFinite(automationTarget) && automationTarget > 0) {
            entry.price_cents = automationTarget;
        } else if (automationOptions) {
            entry.price_cents = previousPrice > 0 ? previousPrice : Math.max(1, fallbackPrice || 10000);
            if (context) {
                context.__automationReason = context.__automationReason || 'Holding current ManaPool price';
            }
        } else if (remoteListing && typeof remoteListing.priceCents === 'number') {
            entry.price_cents = Math.max(1, remoteListing.priceCents - priceOffsetCents);
        } else if (!entry.price_cents) {
            entry.price_cents = Math.max(1, fallbackPrice || 10000);
        }
        if (automationOptions) {
            const flooredPrice = applyAutomationFloors(entry.price_cents, context, remoteListing);
            if (flooredPrice !== entry.price_cents) {
                entry.price_cents = flooredPrice;
                if (context) {
                    const enforcedNote = `Floor enforced at $${(flooredPrice / 100).toFixed(2)}`;
                    context.__automationReason = context.__automationReason
                        ? `${context.__automationReason}; ${enforcedNote}`
                        : enforcedNote;
                }
            }
        }
        delete entry.base_price_cents;

        if (debugCollector && context?.inventory) {
            const baselinePrice = getBaselineForContext(context);
            const variantInfo = context.__automationVariant || null;
            debugCollector.push({
                inventoryId: context.inventory.id,
                name: context.inventory.name,
                setCode: context.inventory.setCode || '',
                collectorNumber: context.inventory.collectorNumber || '',
                foilType: context.inventory.foilType || 'normal',
                condition: context.inventory.condition || 'NM',
                ourPriceCents: previousPrice || null,
                targetPriceCents: entry.price_cents || null,
                baselinePriceCents: baselinePrice || null,
                floorAnchorCents: context.__automationFloorAnchor || baselinePrice || null,
                floorStopCents: context.__automationFloorMin || null,
                floorSource: context.__automationFloorSource || null,
                competitorPriceCents: variantInfo?.priceCents ?? null,
                competitorSeller: variantInfo?.sellerName || null,
                competitorIsSelf: Boolean(variantInfo?.isSelf),
                variantFetchError: automationOptions?.variantFetchError || null,
                action: Number.isFinite(automationTarget) && automationTarget > 0 ? 'undercut' : 'hold',
                reason: context.__automationReason || (Number.isFinite(automationTarget) && automationTarget > 0 ? 'Automation target applied' : 'No change')
            });
        }

        if (context) {
            if (automationOptions) {
                context.__automationAction = Number.isFinite(automationTarget) && automationTarget > 0 ? 'undercut' : 'hold';
            } else {
                const updated = entry.price_cents !== previousPrice;
                context.__automationAction = updated ? 'manual-update' : 'manual-hold';
                if (!context.__automationReason) {
                    context.__automationReason = updated ? 'Manual push adjusted price' : 'Manual push kept price';
                }
            }
            if (automationOptions) {
                if (previousPrice > entry.price_cents) {
                    automationPriceDrops.push({
                        name: context.inventory?.name || 'Unknown',
                        setCode: context.inventory?.setCode || '',
                        foilType: context.inventory?.foilType || 'normal',
                        condition: context.inventory?.condition || 'NM',
                        previous: previousPrice,
                        current: entry.price_cents,
                        delta: previousPrice - entry.price_cents,
                        reason: context.__automationReason || ''
                    });
                } else if (previousPrice < entry.price_cents) {
                    automationPriceIncreases.push({
                        name: context.inventory?.name || 'Unknown',
                        setCode: context.inventory?.setCode || '',
                        foilType: context.inventory?.foilType || 'normal',
                        condition: context.inventory?.condition || 'NM',
                        previous: previousPrice,
                        current: entry.price_cents,
                        delta: entry.price_cents - previousPrice,
                        reason: context.__automationReason || ''
                    });
                }
            }
        }
    });

    if (!simulateOnly) {
        payloadPairs.forEach(pair => {
            if (!pair?.context) return;
            logPricingDecision(pair.context, pair.entry);
        });
    }

    const addMissingEntry = (detail) => {
        const key = entryKey({
            tcgplayer_id: Number(detail.tcgplayer_id),
            language_id: detail.language_id || LANGUAGE_ID,
            finish_id: detail.finish_id || 'NF',
            condition_id: detail.condition_id || 'NM'
        });
        if (missingEntries.has(key)) return;
        const match = payloadMap.get(key);
        if (match) {
            missingEntries.set(key, match);
        }
    };

    const recordAutomationMetrics = (pairs = []) => {
        if (!shouldNotifyAutomation || !Array.isArray(pairs) || !pairs.length) return;
        pairs.forEach(({ entry, context }) => {
            const qty = Math.max(0, Number(entry.quantity) || Number(context?.inventory?.quantity) || 0);
            if (!qty) return;
            const previous = Number(entry.previous_price_cents ?? 0);
            const current = Number(entry.price_cents ?? previous);
            const deltaPer = current - previous;
            automationCardsUpdated += qty;
            automationValueDeltaCents += deltaPer * qty;
            if (deltaPer > 0) {
                automationIncreaseCents += deltaPer * qty;
            } else if (deltaPer < 0) {
                automationDecreaseCents += Math.abs(deltaPer * qty);
            }
            const baselineReference = getBaselineForContext(context);
            const reference = Number.isFinite(baselineReference) && baselineReference > 0 ? baselineReference : previous;
            const threshold = Number(automationOptions?.dropThresholdPercent);
            if (threshold > 0 && reference > 0 && current < reference) {
                const dropPct = ((reference - current) / reference) * 100;
                if (dropPct >= threshold) {
                    automationDropAlerts.push({
                        name: context?.inventory?.name || 'Unknown',
                        setCode: context?.inventory?.setCode || '',
                        previous: reference / 100,
                        current: current / 100,
                        percent: dropPct
                    });
                }
            }
        });
    };

    const endpointBase = '/seller/inventory/tcgplayer_id';
    const localKeySet = new Set(payloadPairs.map(pair => entryKey(pair.entry)));

    const postChunk = async (pairChunk) => {
        if (simulateOnly) {
            recordAutomationMetrics(pairChunk);
            return;
        }
        const chunkEntries = pairChunk.map(pair => pair.entry);
        try {
            await manapoolClient.post(endpointBase, chunkEntries, { headers: authHeaders() });
            updatedCount += chunkEntries.length;
            recordAutomationMetrics(pairChunk);
        } catch (error) {
            if (error.response?.status === 404 && Array.isArray(error.response.data?.details)) {
                error.response.data.details.forEach(addMissingEntry);
                const failedKeys = new Set(
                    error.response.data.details.map(detail => entryKey({
                        tcgplayer_id: Number(detail.tcgplayer_id),
                        language_id: detail.language_id || LANGUAGE_ID,
                        finish_id: detail.finish_id || 'NF',
                        condition_id: detail.condition_id || 'NM'
                    }))
                );
                const succeededPairs = pairChunk.filter(pair => !failedKeys.has(entryKey(pair.entry)));
                updatedCount += succeededPairs.length;
                recordAutomationMetrics(succeededPairs);
            } else {
                throw error;
            }
        }
    };

    const chunkedPairs = chunkArray(payloadPairs, 100);
    for (const chunkPairs of chunkedPairs) {
        await postChunk(chunkPairs);
    }

    if (!simulateOnly && missingEntries.size) {
        for (const entry of missingEntries.values()) {
            try {
                await delay(SCRYFALL_VALIDATION_DELAY_MS);
                await manapoolClient.put(
                    `/seller/inventory/tcgplayer_id/${entry.tcgplayer_id}`,
                    {
                        price_cents: entry.price_cents,
                        quantity: entry.quantity
                    },
                    {
                        headers: authHeaders(),
                        params: {
                            language_id: entry.language_id,
                            finish_id: entry.finish_id,
                            condition_id: entry.condition_id
                        }
                    }
                );
                createdCount += 1;
                recordAutomationMetrics([{ entry, context: contextMap.get(entryKey(entry)) || null }]);
                if (previewEntries.length < 25) {
                    previewEntries.push(entry);
                }
            } catch (error) {
                messages.push(`Failed creating ${entry.tcgplayer_id}: ${parseAxiosError(error)}`);
            }
        }
    }

    let deletedCount = 0;
    if (!simulateOnly && deleteMissing && remoteMap.size) {
        for (const [key, listing] of remoteMap.entries()) {
            if (localKeySet.has(key)) continue;
            try {
                await delay(REMOTE_LOOKUP_DELAY_MS);
                await manapoolClient.delete(
                    `/seller/inventory/tcgplayer_id/${listing.tcgplayerId}`,
                    {
                        headers: authHeaders(),
                        params: {
                            language_id: listing.language_id,
                            finish_id: listing.finish_id,
                            condition_id: listing.condition_id
                        }
                    }
                );
                deletedCount += 1;
            } catch (error) {
                console.warn('[manapool] delete missing failed:', error.message);
            }
        }
    }

    if (!previewEntries.length) {
        previewEntries.push(...payload.slice(0, 25));
    }

    messages.unshift(`Updated ${updatedCount} listings on ManaPool.`);
    if (createdCount) {
        messages.splice(1, 0, `Created ${createdCount} new listings via PUT.`);
    }
    if (deletedCount) {
        messages.push(`Deleted ${deletedCount} ManaPool listings removed from local inventory.`);
    }
    if (missing?.length) {
        messages.push(`Missing TCGPlayer IDs for ${missing.length} cards; try re-importing identifiers.`);
    }

    if (!simulateOnly && shouldNotifyAutomation && automationCardsUpdated > 0) {
        const formatSigned = (cents) => `${cents >= 0 ? '+' : '-'}$${(Math.abs(cents) / 100).toFixed(2)}`;
        const formattedDelta = formatSigned(automationValueDeltaCents);
        const incText = automationIncreaseCents ? `↑${formatSigned(automationIncreaseCents)}` : '';
        const decText = automationDecreaseCents ? `↓-${(automationDecreaseCents / 100).toFixed(2)}` : '';

        sortedDrops = automationPriceDrops
            .filter(entry => Number.isFinite(entry.delta) && entry.delta > 0)
            .sort((a, b) => b.delta - a.delta)
            .slice(0, 15);
        sortedRaises = automationPriceIncreases
            .filter(entry => Number.isFinite(entry.delta) && entry.delta > 0)
            .sort((a, b) => b.delta - a.delta)
            .slice(0, 15);

        const alertLines = automationDropAlerts.slice(0, 10).map((alert) => {
            const label = alert.setCode ? `${alert.name} (${alert.setCode})` : alert.name;
            return `• **${label}**: -${alert.percent.toFixed(1)}% → $${alert.current.toFixed(2)}`;
        });

        const dropLines = sortedDrops.map((entry) =>
            `• ${entry.name}${entry.setCode ? ` (${entry.setCode})` : ''}: -${formatCentsValue(entry.delta)} (${formatCentsValue(entry.previous)} → ${formatCentsValue(entry.current)})`
        );
        const raiseLines = sortedRaises.map((entry) =>
            `• ${entry.name}${entry.setCode ? ` (${entry.setCode})` : ''}: +${formatCentsValue(entry.delta)} (${formatCentsValue(entry.previous)} → ${formatCentsValue(entry.current)})`
        );

        const embed = {
            title: 'ManaPool Automation',
            color: 0x2ecc71,
            description: [
                `Cards updated: **${automationCardsUpdated}**`,
                `Δ value: **${formattedDelta}** ${[incText, decText].filter(Boolean).join(' ')}`.trim()
            ].join('\n'),
            fields: []
        };

        if (raiseLines.length) {
            embed.fields.push({
                name: 'Top increases',
                value: raiseLines.join('\n')
            });
        }
        if (dropLines.length) {
            embed.fields.push({
                name: 'Top decreases',
                value: dropLines.join('\n')
            });
        }
        if (alertLines.length) {
            embed.fields.push({
                name: 'Alerts',
                value: alertLines.join('\n')
            });
        }

        await sendManaPoolWebhook({ embeds: [embed] });
    }

    const automationSummary = automationOptions ? {
        cardsUpdated: automationCardsUpdated,
        valueDeltaCents: automationValueDeltaCents,
        priceDrops: sortedDrops,
        priceIncreases: sortedRaises,
        alerts: automationDropAlerts,
        message: messages.join(' '),
        runAt: new Date().toISOString()
    } : null;

    if (simulateOnly) {
        return {
            updated: 0,
            deleted: 0,
            message: 'Simulation complete.',
            preview: previewEntries,
            missing,
            automationSummary
        };
    }

    return {
        updated: updatedCount + createdCount,
        deleted: deleteMissing ? deletedCount : 0,
        message: messages.join(' '),
        preview: previewEntries,
        missing,
        automationSummary
    };
};

const normalizeRemoteInventory = (items = []) => {
    return items.map(item => {
        const product = item.product || {};
        const single = product.single || {};
        const sealed = product.sealed || {};
        return {
            id: item.id,
            productId: item.product_id,
            productType: product.type,
            name: single.name || sealed.name || 'Unknown',
            setCode: single.set || sealed.set || '',
            scryfallId: single.scryfall_id || null,
            tcgplayerId: single.tcgplayer_id || null,
            foilType: FINISH_ID_TO_FOIL[single.finish_id] || 'normal',
            condition: single.condition_id || 'NM',
            collectorNumber: single.number || single.collector_number || null,
            languageId: item.language_id || 'EN',
            quantity: item.quantity ?? 0,
            price: typeof item.price_cents === 'number' ? item.price_cents / 100 : null
        };
    });
};

const buildRemoteListingMap = (remoteItems = []) => {
    const map = new Map();
    remoteItems.forEach(item => {
        const tcgId = item.tcgplayerId ? Number(item.tcgplayerId) : null;
        if (!tcgId) return;
        const language = item.languageId || LANGUAGE_ID;
        const finishId = FINISH_ID_MAP[item.foilType] || 'NF';
        const conditionId = item.condition || 'NM';
        const key = entryKey({
            tcgplayer_id: tcgId,
            language_id: language,
            finish_id: finishId,
            condition_id: conditionId
        });
        map.set(key, {
            tcgplayerId: tcgId,
            language_id: language,
            finish_id: finishId,
            condition_id: conditionId,
            priceCents: typeof item.price === 'number' ? Math.round(item.price * 100) : null,
            quantity: item.quantity ?? 0,
            scryfallId: item.scryfallId || null,
            name: item.name || 'Unknown',
            setCode: item.setCode || '',
            collectorNumber: item.collectorNumber || null,
            foilType: item.foilType || 'normal',
            condition: conditionId
        });
    });
    return map;
};

export async function getAccountStatus(db) {
    const localCount = await getLocalInventoryCount(db);
    if (!hasCredentials()) {
        return {
            connected: false,
            message: 'MANAPOOL_API_KEY is not configured. Configure it to enable synchronization.',
            localInventoryCount: localCount,
            remoteInventoryCount: null,
            lastSync: null
        };
    }

    try {
        const response = await manapoolClient.get('/seller/inventory', {
            headers: authHeaders(),
            params: { limit: 1, offset: 0 }
        });
        const remoteInventory = normalizeInventoryResponse(response.data?.inventory);
        const pagination = response.data?.pagination;
        return {
            connected: true,
            message: `Connected to ManaPool (${API_BASE}).`,
            localInventoryCount: localCount,
            remoteInventoryCount: pagination?.total ?? remoteInventory.length,
            lastSync: new Date().toISOString()
        };
    } catch (error) {
        return {
            connected: false,
            message: parseAxiosError(error),
            localInventoryCount: localCount,
            remoteInventoryCount: null,
            lastSync: null
        };
    }
}

export async function pullInventoryFromManaPool() {
    const snapshot = await fetchRemoteInventorySnapshot();
    if (snapshot?.source === 'manapool') {
        remoteInventoryCache.snapshot = snapshot;
        remoteInventoryCache.timestamp = Date.now();
    } else {
        remoteInventoryCache.snapshot = null;
        remoteInventoryCache.timestamp = 0;
    }
    return snapshot;
}

export async function pushInventoryToManaPool(db, options = {}) {
    const localInventory = await getLocalInventoryRows(db);
    const concurrency = Math.max(1, Math.min(Number(options.concurrency) || 5, 10));
    let automation = options.automation || null;
    if (!automation && !options.skipAutomation) {
        automation = await buildUndercutAutomationContext(localInventory, options.priceOffsetCents ?? 1, { concurrency });
    }
    let maxQuantityPerCard = options.maxQuantityPerCard ?? null;
    if (maxQuantityPerCard === null) {
        try {
            const settings = await getAutomationSettings(db);
            maxQuantityPerCard = settings.maxQuantityPerCard ?? null;
        } catch { /* ignore */ }
    }
    return pushInventoryRows(localInventory, {
        priceOffsetCents: options.priceOffsetCents ?? 1,
        deleteMissing: options.deleteMissing ?? true,
        notifyAutomation: Boolean(options.notifyAutomation),
        automation,
        maxQuantityPerCard
    });
}

export async function pushInventoryItemsToManaPool(db, inventoryIds = [], options = {}) {
    if (!Array.isArray(inventoryIds) || !inventoryIds.length) {
        return {
            updated: 0,
            message: 'No inventory IDs provided.',
            preview: []
        };
    }
    const rows = await getInventoryRowsByIds(db, inventoryIds);
    if (!rows.length) {
        return {
            updated: 0,
            message: 'No matching inventory items found for provided IDs.',
            preview: []
        };
    }
    let automation = options?.automation || null;
    if (!automation) {
        const concurrency = Math.max(1, Math.min(Number(options?.concurrency) || 5, 10));
        automation = await buildUndercutAutomationContext(rows, options?.priceOffsetCents ?? 1, { concurrency });
    }
    let maxQuantityPerCard = options?.maxQuantityPerCard ?? null;
    if (maxQuantityPerCard === null) {
        try {
            const settings = await getAutomationSettings(db);
            maxQuantityPerCard = settings.maxQuantityPerCard ?? null;
        } catch { /* ignore */ }
    }
    return pushInventoryRows(rows, {
        priceOffsetCents: options?.priceOffsetCents,
        deleteMissing: false,
        notifyAutomation: Boolean(options?.notifyAutomation),
        automation,
        maxQuantityPerCard
    });
}

export async function cleanupRemoteInventory(db) {
    const localRows = await getLocalInventoryRows(db);
    const { payload } = await buildPushPayload(localRows, {});
    const localKeySet = new Set(payload.map(entry => entryKey(entry)));
    let remoteMap = new Map();
    try {
        const snapshot = await pullInventoryFromManaPool();
        if (snapshot?.items?.length) {
            remoteMap = buildRemoteListingMap(snapshot.items);
        }
    } catch (error) {
        console.warn('[manapool] cleanup failed to pull inventory:', error.message);
        return { deleted: 0 };
    }
    let deleted = 0;
    for (const [key, listing] of remoteMap.entries()) {
        if (localKeySet.has(key)) continue;
        try {
            await delay(REMOTE_LOOKUP_DELAY_MS);
            await manapoolClient.delete(
                `/seller/inventory/tcgplayer_id/${listing.tcgplayerId}`,
                {
                    headers: authHeaders(),
                    params: {
                        language_id: listing.language_id,
                        finish_id: listing.finish_id,
                        condition_id: listing.condition_id
                    }
                }
            );
            deleted += 1;
        } catch (error) {
            console.warn('[manapool] cleanup delete failed:', error.message);
        }
    }
    return { deleted };
}

export async function restockBelowMaxQuantity(db) {
    let settings;
    try {
        settings = await getAutomationSettings(db);
    } catch { return { restocked: 0 }; }
    const maxQty = settings?.maxQuantityPerCard;
    if (!maxQty || !Number.isFinite(maxQty) || maxQty < 1) return { restocked: 0 };

    const localInventory = await getLocalInventoryRows(db);
    const { payload, contexts } = await buildPushPayload(localInventory, { maxQuantityPerCard: maxQty });
    if (!payload.length) return { restocked: 0 };

    let remoteMap = new Map();
    try {
        const snapshot = await getCachedRemoteInventorySnapshot();
        if (snapshot?.items?.length) {
            remoteMap = buildRemoteListingMap(snapshot.items);
        }
    } catch { return { restocked: 0 }; }

    const restockEntries = [];
    payload.forEach((entry, index) => {
        const context = contexts[index];
        const localQty = Number(context?.inventory?.quantity) || 0;
        const expectedQty = Math.min(localQty, maxQty);
        const key = entryKey(entry);
        const remoteListing = remoteMap.get(key);
        const remoteQty = Number(remoteListing?.quantity) || 0;
        if (remoteQty < expectedQty && localQty > remoteQty) {
            restockEntries.push({
                ...entry,
                quantity: expectedQty,
                price_cents: remoteListing?.priceCents || entry.price_cents
            });
        }
    });

    if (!restockEntries.length) return { restocked: 0 };

    if (!hasCredentials()) {
        return { restocked: 0, message: 'No credentials - dry run only.' };
    }

    let restocked = 0;
    for (const entry of restockEntries) {
        try {
            await delay(REMOTE_LOOKUP_DELAY_MS);
            const updatePayload = {
                tcgplayer_id: entry.tcgplayer_id,
                language_id: entry.language_id,
                finish_id: entry.finish_id,
                condition_id: entry.condition_id,
                quantity: entry.quantity,
                price_cents: entry.price_cents
            };
            await manapoolClient.put('/seller/inventory', updatePayload, { headers: authHeaders() });
            restocked += 1;
        } catch (error) {
            console.warn(`[manapool] restock failed for tcg_id=${entry.tcgplayer_id}:`, error.message);
        }
    }
    return { restocked };
}

const normalizeOrdersResponse = (payload) => {
    if (!payload) return [];
    if (Array.isArray(payload.orders)) return payload.orders;
    if (Array.isArray(payload)) return payload;
    return [];
};

const fetchOrderDetails = async (orderId) => {
    if (!hasCredentials()) {
        const sample = SAMPLE_ORDERS[0];
        return sample
            ? {
                order: {
                    id: sample.id,
                    created_at: sample.createdAt,
                    label: sample.label || 'N/A',
                    payment: {
                        subtotal_cents: sample.lineItems.reduce((sum, item) => sum + item.salePrice * 100 * item.quantity, 0),
                        shipping_cents: 0,
                        total_cents: sample.total * 100,
                        fee_cents: Math.round(sample.total * 100 * 0.1),
                        net_cents: Math.round(sample.total * 100 * 0.9)
                    },
                    items: sample.lineItems.map(item => ({
                        product_type: 'mtg_single',
                        product: {
                            single: {
                                name: item.name,
                                set: item.setCode,
                                number: item.collectorNumber || '',
                                scryfall_id: item.scryfallId || null,
                                finish_id: item.foilType === 'foil' ? 'FO' : 'NF',
                                condition_id: item.condition || 'NM',
                                language_id: 'EN',
                                tcgplayer_id: item.tcgplayerId || null
                            }
                        },
                        quantity: item.quantity,
                        price_cents: item.salePrice * 100
                    })),
                    fulfillments: [],
                    buyer_id: 'placeholder',
                    shipping_address: {}
                }
            }
            : null;
    }

    const response = await manapoolClient.get(`/seller/orders/${orderId}`, { headers: authHeaders() });
    return response.data;
};

export async function pullOrdersFromManaPool(options = {}) {
    if (!hasCredentials()) {
        return {
            source: 'placeholder',
            pulledAt: new Date().toISOString(),
            orders: SAMPLE_ORDERS
        };
    }
    try {
        let allOrders = [];
        const limit = 100;
        let offset = 0;
        while (true) {
            const params = { limit, offset };
            if (options.since) params.since = options.since;
            const response = await manapoolClient.get('/seller/orders', {
                headers: authHeaders(),
                params
            });
            const ordersPage = normalizeOrdersResponse(response.data);
            allOrders = allOrders.concat(ordersPage);
            const returned = ordersPage.length;
            if (returned < limit) break;
            offset += returned;
        }
        return {
            source: 'manapool',
            pulledAt: new Date().toISOString(),
            orders: allOrders
        };
    } catch (error) {
        return {
            source: 'error',
            pulledAt: new Date().toISOString(),
            orders: SAMPLE_ORDERS,
            error: parseAxiosError(error)
        };
    }
}

const mapFinishIdToFoil = (finishId) => FINISH_ID_TO_FOIL[finishId] || 'normal';
const mapConditionIdToLocal = (conditionId) => CONDITION_ID_MAP[conditionId?.toUpperCase()] ? conditionId.toUpperCase() : 'NM';

const fetchInventoryCandidates = async (db, { scryfallId, setCode, collectorNumber, foilType, condition }) => {
    const clauses = [];
    const params = [];

    if (scryfallId) {
        clauses.push('scryfallId = ?');
        params.push(scryfallId);
    } else if (setCode && collectorNumber) {
        clauses.push('setCode = ?');
        params.push(setCode.toUpperCase());
        clauses.push('collectorNumber = ?');
        params.push(String(collectorNumber));
    } else {
        return [];
    }

    clauses.push('foilType = ?');
    params.push(foilType || 'normal');
    clauses.push('condition = ?');
    params.push(condition || 'NM');
    clauses.push('quantity > 0');

    const sql = `
        SELECT id, quantity, pricePaid
        FROM inventory
        WHERE ${clauses.join(' AND ')}
        ORDER BY COALESCE(datetime(createdAt), datetime('1970-01-01')) ASC, rowid ASC
    `;

    const rows = await allAsync(db, sql, params);
    if (rows.length || !scryfallId || !setCode || !collectorNumber) {
        return rows;
    }

    const fallbackSql = `
        SELECT id, quantity, pricePaid
        FROM inventory
        WHERE setCode = ? AND collectorNumber = ? AND foilType = ? AND condition = ? AND quantity > 0
        ORDER BY COALESCE(datetime(createdAt), datetime('1970-01-01')) ASC, rowid ASC
    `;
    return allAsync(db, fallbackSql, [setCode.toUpperCase(), String(collectorNumber), foilType || 'normal', condition || 'NM']);
};

const allocateInventoryForItem = async (db, criteria, requestedQuantity) => {
    const candidates = await fetchInventoryCandidates(db, criteria);
    const allocations = [];
    let remaining = requestedQuantity;
    let allocatedCost = 0;
    for (const row of candidates) {
        if (remaining <= 0) break;
        const useQuantity = Math.min(row.quantity, remaining);
        const unitCost = Number(row.pricePaid) || 0;
        allocations.push({ inventoryId: row.id, quantity: useQuantity, pricePaid: unitCost });
        allocatedCost += unitCost * useQuantity;
        remaining -= useQuantity;
    }
    return { allocations, remaining, allocatedCost };
};

const createTransactionFromOrder = async (db, order, options = {}) => {
    const allowPartial = Boolean(options.allowPartial);
    const payment = order.payment || {};
    const shippingCost = (payment.shipping_cents ?? 0) / 100;
    const soldAt = order.created_at ? new Date(order.created_at).toISOString() : new Date().toISOString();
    const transactionId = randomUUID();
    const unmatchedItems = [];
    const forcedSkips = [];
    const preparedItems = [];
    let totalPurchasePrice = 0;
    const isShipped = determineOrderShipmentStatus(order);

    for (const orderItem of order.items || []) {
        const single = orderItem.product?.single || {};
        const foilType = mapFinishIdToFoil(single.finish_id);
        const condition = mapConditionIdToLocal(single.condition_id);
        const requestedQuantity = Number(orderItem.quantity) || 1;
        const criteria = {
            scryfallId: single.scryfall_id,
            setCode: single.set,
            collectorNumber: single.number,
            foilType,
            condition
        };
        const { allocations, remaining, allocatedCost } = await allocateInventoryForItem(db, criteria, requestedQuantity);
        if (remaining > 0) {
            const missingDetail = {
                name: single.name || orderItem.product?.name || 'Unknown Card',
                setCode: single.set || '',
                collectorNumber: single.number || '',
                foilType,
                condition,
                requestedQuantity,
                missingQuantity: remaining
            };
            if (allowPartial) {
                forcedSkips.push(missingDetail);
                continue;
            }
            unmatchedItems.push(missingDetail);
            continue;
        }
        if (!allocations.length) {
            continue;
        }
        preparedItems.push({
            name: single.name || orderItem.product?.name || 'Unknown Card',
            salePrice: (orderItem.price_cents ?? 0) / 100,
            quantity: requestedQuantity,
            allocations
        });
        totalPurchasePrice += allocatedCost;
    }

    if (!allowPartial && unmatchedItems.length) {
        return { transactionId: null, unmatchedItems };
    }

    const saleSubtotal = preparedItems.reduce((sum, item) => sum + (item.salePrice * item.quantity), 0);
    const shippingForTxn = saleSubtotal > 0 ? shippingCost : 0;
    let packagingCost = 0;
    let feeAmount;
    if (saleSubtotal > 0) {
        if (payment.fee_cents != null && !allowPartial) {
            feeAmount = (payment.fee_cents || 0) / 100;
        } else {
            feeAmount = (saleSubtotal * MANAPOOL_FEE_RATE) + MANAPOOL_FEE_FLAT;
        }
    } else {
        feeAmount = 0;
    }
    const grossRevenue = saleSubtotal + shippingForTxn;
    const netProfit = saleSubtotal > 0
        ? Number((grossRevenue - (totalPurchasePrice + feeAmount)).toFixed(2))
        : 0;

    await runAsync(db, 'BEGIN TRANSACTION');
    try {
        await runAsync(
            db,
            `INSERT INTO transactions (id, soldAt, platform, shippingCost, packagingCost, totalSalePrice, netProfit, packingSlipPath, manapoolOrderId, isShipped, entryType)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                transactionId,
                soldAt,
                'ManaPool',
                shippingForTxn,
                packagingCost,
                saleSubtotal,
                netProfit,
                null,
                order.id,
                isShipped ? 1 : 0,
                'sale'
            ]
        );

        for (const item of preparedItems) {
            for (const allocation of item.allocations) {
                await runAsync(
                    db,
                    `INSERT INTO transaction_items (transactionId, inventoryId, salePrice, quantity)
                     VALUES (?, ?, ?, ?)`,
                    [transactionId, allocation.inventoryId, item.salePrice, allocation.quantity]
                );
                const updateResult = await runAsync(
                    db,
                    `UPDATE inventory SET quantity = quantity - ?
                     WHERE id = ? AND quantity >= ?`,
                    [allocation.quantity, allocation.inventoryId, allocation.quantity]
                );
                if (!updateResult.changes) {
                    throw new Error('Inventory update failed for item allocation.');
                }
            }
        }

        if (saleSubtotal > MANAPOOL_AUTO_SHIPPING_THRESHOLD) {
            await recordShippingExpense(db, {
                amount: MANAPOOL_AUTO_SHIPPING_AMOUNT,
                category: SHIPPING_EXPENSE_CATEGORIES.POSTAGE,
                description: `ManaPool shipping for order ${order.id}`,
                paymentMethod: 'Auto',
                notes: 'Auto-added from ManaPool import.',
                incurredOn: soldAt,
            });
        }

        await runAsync(db, 'COMMIT');
        return { transactionId, unmatchedItems: [], skippedItems: forcedSkips };
    } catch (error) {
        await runAsync(db, 'ROLLBACK');
        throw error;
    }
};

export async function importOrdersToTransactions(db, orders = []) {
    let imported = 0;
    const skipped = [];
    const errors = [];
    const unmatchedOrders = [];
    let shipmentUpdates = 0;

    for (const summary of orders) {
        try {
            const existing = await getTransactionRecordForOrder(db, summary.id);
            if (existing && Number(existing.isShipped) === 1) {
                skipped.push(summary.id);
                continue;
            }
            const detailsResponse = await fetchOrderDetails(summary.id);
            const orderDetails = detailsResponse?.order;
            if (!orderDetails) {
                skipped.push(summary.id);
                continue;
            }
            const orderShipped = determineOrderShipmentStatus(orderDetails);
            if (existing) {
                if (Number(existing.isShipped) !== Number(orderShipped)) {
                    await updateTransactionShipmentStatus(db, existing.id, orderShipped);
                    shipmentUpdates += 1;
                }
                skipped.push(summary.id);
                continue;
            }
            const { transactionId, unmatchedItems } = await createTransactionFromOrder(db, orderDetails);
            if (unmatchedItems?.length) {
                unmatchedOrders.push({
                    orderId: summary.id,
                    createdAt: orderDetails.created_at || null,
                    buyer: orderDetails.buyer?.display_name || orderDetails.buyer?.username || 'Unknown buyer',
                    items: unmatchedItems
                });
                continue;
            }
            if (transactionId) {
                imported += 1;
            }
        } catch (error) {
            console.error('[manapool] import order failed:', error);
            errors.push({ orderId: summary.id, message: error.message });
        }
    }

    return { imported, skipped, errors, unmatchedOrders, shipmentUpdates };
}

export async function syncOrdersBeforePricing(db, options = {}) {
    if (!db) {
        throw new Error('Database handle is required for order synchronization.');
    }
    try {
        const since = options.since || null;
        const payload = await pullOrdersFromManaPool({ since });
        const orders = payload?.orders || [];
        const importResult = await importOrdersToTransactions(db, orders);
        return {
            source: payload?.source || 'unknown',
            pulledAt: payload?.pulledAt || new Date().toISOString(),
            imported: importResult.imported || 0,
            skipped: importResult.skipped || [],
            errors: importResult.errors || [],
            unmatchedOrders: importResult.unmatchedOrders || [],
            shipmentUpdates: importResult.shipmentUpdates || 0
        };
    } catch (error) {
        console.error('[automation] Failed to sync ManaPool orders before pricing:', error);
        throw error;
    }
}

export async function forceImportOrder(db, orderId) {
    if (!orderId) {
        throw new Error('orderId is required.');
    }
    const detailsResponse = await fetchOrderDetails(orderId);
    const orderDetails = detailsResponse?.order;
    if (!orderDetails) {
        throw new Error('ManaPool order not found.');
    }
    const { transactionId, skippedItems } = await createTransactionFromOrder(db, orderDetails, { allowPartial: true });
    if (!transactionId) {
        throw new Error('Unable to save order.');
    }
    return {
        transactionId,
        skippedItems: skippedItems || []
    };
}

export async function getInventoryDiscrepancies(db) {
    const localInventory = await getLocalInventoryRows(db);
    const remotePayload = await pullInventoryFromManaPool();
    const remoteInventory = remotePayload.items || [];
    const remoteMap = buildRemoteListingMap(remoteInventory);
    let maxQuantityPerCard = null;
    try {
        const settings = await getAutomationSettings(db);
        maxQuantityPerCard = settings.maxQuantityPerCard ?? null;
    } catch { /* ignore */ }
    const usedRemoteKeys = new Set();
    const collectorMatches = (a, b) => {
        if (!a || !b) return true;
        return String(a).trim().toLowerCase() === String(b).trim().toLowerCase();
    };

    const matchRemoteListing = (item) => {
        if (item.tcgplayerId) {
            const key = entryKey({
                tcgplayer_id: Number(item.tcgplayerId),
                language_id: LANGUAGE_ID,
                finish_id: FINISH_ID_MAP[item.foilType] || 'NF',
                condition_id: item.condition || 'NM'
            });
            const listing = remoteMap.get(key);
            if (listing && collectorMatches(item.collectorNumber, listing.collectorNumber)) return { listing, key };
        }
        if (item.scryfallId) {
            for (const [key, listing] of remoteMap.entries()) {
                if (
                    listing.scryfallId === item.scryfallId &&
                    listing.finish_id === (FINISH_ID_MAP[item.foilType] || 'NF') &&
                    listing.condition_id === (item.condition || 'NM') &&
                    collectorMatches(item.collectorNumber, listing.collectorNumber)
                ) {
                    return { listing, key };
                }
            }
        }
        return null;
    };

    const discrepancies = [];
    localInventory.forEach((item) => {
        const localPriceValue = Number(item.tcgMarketPrice ?? item.pricePaid ?? 0);
        const formattedLocalPrice = localPriceValue > 0 ? `$${localPriceValue.toFixed(2)}` : '-';
        const match = matchRemoteListing(item);
        if (!match) {
            discrepancies.push({
                name: item.name,
                setCode: item.setCode,
                collectorNumber: item.collectorNumber || '',
                foilType: item.foilType || 'normal',
                condition: item.condition || 'NM',
                localQuantity: Number(item.quantity) || 0,
                remoteQuantity: 0,
                localPrice: formattedLocalPrice,
                remotePrice: '-',
                isNew: true
            });
            return;
        }
        usedRemoteKeys.add(match.key);
        const remoteItem = match.listing;
        const localQuantity = Number(item.quantity) || 0;
        const remoteQuantity = Number(remoteItem.quantity) || 0;
        const remotePrice = typeof remoteItem.priceCents === 'number' ? remoteItem.priceCents / 100 : 0;
        const expectedRemoteQty = maxQuantityPerCard ? Math.min(localQuantity, maxQuantityPerCard) : localQuantity;
        if (expectedRemoteQty !== remoteQuantity || Math.abs(remotePrice - localPriceValue) > 0.01) {
            discrepancies.push({
                name: item.name,
                setCode: item.setCode,
                collectorNumber: item.collectorNumber || '',
                foilType: item.foilType || 'normal',
                condition: item.condition || 'NM',
                localQuantity: expectedRemoteQty,
                remoteQuantity,
                localPrice: formattedLocalPrice,
                remotePrice: remotePrice ? `$${remotePrice.toFixed(2)}` : '-',
                isNew: false
            });
        }
    });

    remoteMap.forEach((listing, key) => {
        if (usedRemoteKeys.has(key)) return;
        discrepancies.push({
            name: listing.name || 'Unknown',
            setCode: listing.setCode || '',
            collectorNumber: listing.collectorNumber || '',
            foilType: listing.foilType || 'normal',
            condition: listing.condition || 'NM',
            localQuantity: 0,
            remoteQuantity: Number(listing.quantity) || 0,
            localPrice: '-',
            remotePrice: listing.priceCents ? `$${(listing.priceCents / 100).toFixed(2)}` : '-',
            remoteOnly: true
        });
    });

    const rowFlag = (row) => (row.isNew || row.remoteOnly ? 1 : 0);
    const filtered = discrepancies
        .filter(row => !(Number(row.localQuantity) === 0 && Number(row.remoteQuantity) === 0))
        .sort((a, b) => {
            return rowFlag(b) - rowFlag(a);
        });
    return { discrepancies: filtered };
}

export async function getMarginData(db) {
    const localInventory = await getLocalInventoryRows(db);
    const remotePayload = await pullInventoryFromManaPool();
    const remoteInventory = remotePayload.items || [];
    const remoteMap = buildRemoteListingMap(remoteInventory);
    const usedRemoteKeys = new Set();

    const collectorMatches = (a, b) => {
        if (!a || !b) return true;
        return String(a).trim().toLowerCase() === String(b).trim().toLowerCase();
    };

    const matchRemoteListing = (item) => {
        if (item.tcgplayerId) {
            const key = entryKey({
                tcgplayer_id: Number(item.tcgplayerId),
                language_id: LANGUAGE_ID,
                finish_id: FINISH_ID_MAP[item.foilType] || 'NF',
                condition_id: item.condition || 'NM'
            });
            const listing = remoteMap.get(key);
            if (listing && collectorMatches(item.collectorNumber, listing.collectorNumber)) return { listing, key };
        }
        if (item.scryfallId) {
            for (const [key, listing] of remoteMap.entries()) {
                if (
                    listing.scryfallId === item.scryfallId &&
                    listing.finish_id === (FINISH_ID_MAP[item.foilType] || 'NF') &&
                    listing.condition_id === (item.condition || 'NM') &&
                    collectorMatches(item.collectorNumber, listing.collectorNumber)
                ) {
                    return { listing, key };
                }
            }
        }
        return null;
    };

    const rows = [];
    localInventory.forEach((item) => {
        const match = matchRemoteListing(item);
        if (!match) return;
        usedRemoteKeys.add(match.key);
        const remote = match.listing;
        const pricePaid = Number(item.pricePaid) || 0;
        const remotePriceCents = typeof remote.priceCents === 'number' ? remote.priceCents : 0;
        const quantity = Number(item.quantity) || 0;
        if (quantity <= 0 && (Number(remote.quantity) || 0) <= 0) return;
        rows.push({
            name: item.name,
            setCode: item.setCode || '',
            collectorNumber: item.collectorNumber || '',
            foilType: item.foilType || 'normal',
            condition: item.condition || 'NM',
            quantity,
            remoteQuantity: Number(remote.quantity) || 0,
            pricePaid,
            remotePriceCents,
        });
    });

    return { margins: rows };
}

const computeSuggestedPrice = (strategy, item) => {
    const current = Number(item.tcgMarketPrice ?? item.pricePaid ?? 0);
    const manaPoolLow = Number(item.manaPoolLow ?? current);
    if (!strategy || !strategy.type) return current;

    switch (strategy.type) {
        case 'manaPoolLowPercent': {
            const percent = Number(strategy.value || 5);
            return Math.max(manaPoolLow * (1 - percent / 100), 0).toFixed(2);
        }
        case 'manaPoolLowCents': {
            const cents = Number(strategy.value || 0.25);
            return Math.max(manaPoolLow - cents, 0).toFixed(2);
        }
        case 'tcgMarketMatch':
        default:
            return Math.max(current, 0).toFixed(2);
    }
};

export async function bulkAdjustPrices(strategy = {}, db) {
    const localInventory = await getLocalInventoryRows(db);
    const preview = localInventory.slice(0, 50).map((item) => {
        const suggested = computeSuggestedPrice(strategy, item);
        return {
            id: item.id,
            name: item.name,
            setCode: item.setCode,
            currentPrice: item.tcgMarketPrice ? `$${Number(item.tcgMarketPrice).toFixed(2)}` : '-',
            suggestedPrice: `$${suggested}`
        };
    });
    return { preview };
}

const AUTOMATION_SETTINGS_TABLE = 'manapool_automation_settings';
const AUTOMATION_BASELINE_TABLE = 'manapool_automation_baselines';
const DEFAULT_AUTOMATION_SETTINGS = {
    enabled: false,
    intervalMinutes: 30,
    strategy: 'manaPoolLowPercent',
    floorType: 'percent',
    floorValue: 5,
    discordWebhook: '',
    dropThresholdPercent: 15,
    floorOverrides: [],
    exclusions: [],
    lastRunAt: null,
    nextRunAt: null,
    maxQuantityPerCard: null
};

const VALID_FLOOR_TYPES = new Set(['percent', 'absolute']);

const sanitizeAutomationList = (value) => {
    if (Array.isArray(value)) {
        return value.map((entry) => String(entry).trim()).filter(Boolean);
    }
    if (typeof value === 'string') {
        return value
            .split(/\r?\n/)
            .map((entry) => entry.trim())
            .filter(Boolean);
    }
    return [];
};

const serializeAutomationList = (value) => JSON.stringify(sanitizeAutomationList(value));

const parseStoredAutomationList = (value) => {
    if (!value) return [];
    try {
        const parsed = JSON.parse(value);
        return sanitizeAutomationList(parsed);
    } catch (error) {
        return sanitizeAutomationList(value);
    }
};

const ensureAutomationSettingsTable = (db) => new Promise((resolve, reject) => {
    db.run(`
        CREATE TABLE IF NOT EXISTS ${AUTOMATION_SETTINGS_TABLE} (
            id TEXT PRIMARY KEY,
            enabled INTEGER DEFAULT 0,
            intervalMinutes INTEGER DEFAULT 30,
            strategy TEXT DEFAULT 'manaPoolLowPercent',
            floorType TEXT DEFAULT 'percent',
            floorValue REAL DEFAULT 5,
            discordWebhook TEXT,
            dropThresholdPercent INTEGER DEFAULT 15,
            floorOverrides TEXT,
            exclusions TEXT,
            lastRunAt TEXT,
            nextRunAt TEXT,
            maxQuantityPerCard INTEGER,
            createdAt TEXT DEFAULT CURRENT_TIMESTAMP,
            updatedAt TEXT DEFAULT CURRENT_TIMESTAMP
        )
    `, (err) => {
        if (err) return reject(err);
        // Migrate existing tables that lack the maxQuantityPerCard column
        db.run(`ALTER TABLE ${AUTOMATION_SETTINGS_TABLE} ADD COLUMN maxQuantityPerCard INTEGER`, () => {
            resolve();
        });
    });
});

const ensureAutomationBaselineTable = (db) => new Promise((resolve, reject) => {
    db.run(`
        CREATE TABLE IF NOT EXISTS ${AUTOMATION_BASELINE_TABLE} (
            inventoryId TEXT PRIMARY KEY,
            priceCents INTEGER NOT NULL,
            createdAt TEXT DEFAULT CURRENT_TIMESTAMP,
            updatedAt TEXT DEFAULT CURRENT_TIMESTAMP
        )
    `, (err) => {
        if (err) return reject(err);
        resolve();
    });
});

const replaceAutomationBaselines = (db, baselines = []) => new Promise((resolve, reject) => {
    db.serialize(() => {
        db.run(`DELETE FROM ${AUTOMATION_BASELINE_TABLE}`, (deleteErr) => {
            if (deleteErr) {
                return reject(deleteErr);
            }
            if (!baselines.length) {
                return resolve();
            }
            const stmt = db.prepare(`
                INSERT INTO ${AUTOMATION_BASELINE_TABLE} (inventoryId, priceCents, createdAt, updatedAt)
                VALUES (?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
            `);
            baselines.forEach(({ inventoryId, priceCents }) => {
                if (!inventoryId || !Number.isFinite(priceCents)) return;
                stmt.run([inventoryId, Math.round(priceCents)]);
            });
            stmt.finalize((stmtErr) => {
                if (stmtErr) return reject(stmtErr);
                resolve();
            });
        });
    });
});

const fetchAutomationBaselineRows = (db) => new Promise((resolve, reject) => {
    db.all(
        `SELECT inventoryId, priceCents FROM ${AUTOMATION_BASELINE_TABLE}`,
        [],
        (err, rows) => {
            if (err) return reject(err);
            resolve(rows || []);
        }
    );
});

const fetchAutomationSettingsRow = (db) => new Promise((resolve, reject) => {
    db.get(
        `SELECT * FROM ${AUTOMATION_SETTINGS_TABLE} WHERE id = ? LIMIT 1`,
        ['default'],
        (err, row) => {
            if (err) return reject(err);
            resolve(row || null);
        }
    );
});

const normalizeAutomationSettingsPayload = (input = {}) => {
    const normalized = { ...DEFAULT_AUTOMATION_SETTINGS };

    if (typeof input.enabled !== 'undefined') {
        normalized.enabled = Boolean(input.enabled);
    }

    const interval = Number(input.intervalMinutes);
    if (Number.isFinite(interval)) {
        normalized.intervalMinutes = Math.max(5, Math.round(interval));
    }

    if (typeof input.strategy === 'string' && input.strategy.trim()) {
        normalized.strategy = input.strategy.trim();
    }

    if (VALID_FLOOR_TYPES.has(input.floorType)) {
        normalized.floorType = input.floorType;
    }

    const floorValue = Number(input.floorValue);
    if (Number.isFinite(floorValue) && floorValue >= 0) {
        normalized.floorValue = floorValue;
    }

    const dropThreshold = Number(input.dropThresholdPercent);
    if (Number.isFinite(dropThreshold)) {
        normalized.dropThresholdPercent = Math.min(100, Math.max(1, Math.round(dropThreshold)));
    }

    if (typeof input.discordWebhook === 'string') {
        normalized.discordWebhook = input.discordWebhook.trim();
    }

    normalized.floorOverrides = sanitizeAutomationList(
        typeof input.floorOverrides === 'undefined' ? normalized.floorOverrides : input.floorOverrides
    );
    normalized.exclusions = sanitizeAutomationList(
        typeof input.exclusions === 'undefined' ? normalized.exclusions : input.exclusions
    );

    const lastRunAt = input.lastRunAt ?? normalized.lastRunAt;
    normalized.lastRunAt = typeof lastRunAt === 'string' && lastRunAt.trim() ? lastRunAt : null;

    const nextRunAt = input.nextRunAt ?? normalized.nextRunAt;
    normalized.nextRunAt = typeof nextRunAt === 'string' && nextRunAt.trim() ? nextRunAt : null;

    if (typeof input.maxQuantityPerCard !== 'undefined') {
        const mqpc = Number(input.maxQuantityPerCard);
        normalized.maxQuantityPerCard = Number.isFinite(mqpc) && mqpc >= 1 ? Math.round(mqpc) : null;
    }

    return normalized;
};

const mapAutomationRowToSettings = (row = {}) => {
    const mapped = { ...DEFAULT_AUTOMATION_SETTINGS };
    mapped.enabled = Boolean(row.enabled);
    mapped.intervalMinutes = Number.isFinite(Number(row.intervalMinutes))
        ? Number(row.intervalMinutes)
        : DEFAULT_AUTOMATION_SETTINGS.intervalMinutes;
    mapped.strategy = row.strategy || DEFAULT_AUTOMATION_SETTINGS.strategy;
    mapped.floorType = VALID_FLOOR_TYPES.has(row.floorType) ? row.floorType : DEFAULT_AUTOMATION_SETTINGS.floorType;
    mapped.floorValue = Number.isFinite(Number(row.floorValue))
        ? Number(row.floorValue)
        : DEFAULT_AUTOMATION_SETTINGS.floorValue;
    mapped.discordWebhook = row.discordWebhook || '';
    mapped.dropThresholdPercent = Number.isFinite(Number(row.dropThresholdPercent))
        ? Number(row.dropThresholdPercent)
        : DEFAULT_AUTOMATION_SETTINGS.dropThresholdPercent;
    mapped.floorOverrides = parseStoredAutomationList(row.floorOverrides);
    mapped.exclusions = parseStoredAutomationList(row.exclusions);
    mapped.lastRunAt = row.lastRunAt || null;
    mapped.nextRunAt = row.nextRunAt || null;
    const mqpc = Number(row.maxQuantityPerCard);
    mapped.maxQuantityPerCard = Number.isFinite(mqpc) && mqpc >= 1 ? mqpc : null;
    return mapped;
};

const persistAutomationSettings = (db, settings) => new Promise((resolve, reject) => {
    const params = [
        'default',
        settings.enabled ? 1 : 0,
        settings.intervalMinutes,
        settings.strategy,
        settings.floorType,
        settings.floorValue,
        settings.discordWebhook || null,
        settings.dropThresholdPercent,
        serializeAutomationList(settings.floorOverrides),
        serializeAutomationList(settings.exclusions),
        settings.lastRunAt,
        settings.nextRunAt,
        settings.maxQuantityPerCard ?? null
    ];
    const sql = `
        INSERT INTO ${AUTOMATION_SETTINGS_TABLE} (
            id,
            enabled,
            intervalMinutes,
            strategy,
            floorType,
            floorValue,
            discordWebhook,
            dropThresholdPercent,
            floorOverrides,
            exclusions,
            lastRunAt,
            nextRunAt,
            maxQuantityPerCard
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
            enabled=excluded.enabled,
            intervalMinutes=excluded.intervalMinutes,
            strategy=excluded.strategy,
            floorType=excluded.floorType,
            floorValue=excluded.floorValue,
            discordWebhook=excluded.discordWebhook,
            dropThresholdPercent=excluded.dropThresholdPercent,
            floorOverrides=excluded.floorOverrides,
            exclusions=excluded.exclusions,
            lastRunAt=excluded.lastRunAt,
            nextRunAt=excluded.nextRunAt,
            maxQuantityPerCard=excluded.maxQuantityPerCard,
            updatedAt=CURRENT_TIMESTAMP
    `;
    db.run(sql, params, (err) => {
        if (err) return reject(err);
        resolve(settings);
    });
});

export async function getAutomationSettings(db) {
    await ensureAutomationSettingsTable(db);
    const row = await fetchAutomationSettingsRow(db);
    if (!row) {
        return { ...DEFAULT_AUTOMATION_SETTINGS };
    }
    return mapAutomationRowToSettings(row);
}

export async function saveAutomationSettings(update = {}, db) {
    await ensureAutomationSettingsTable(db);
    const current = await getAutomationSettings(db);
    const normalized = normalizeAutomationSettingsPayload({ ...current, ...update });
    await persistAutomationSettings(db, normalized);
    return normalized;
}

export async function snapshotAutomationBaselines(db) {
    await ensureAutomationSettingsTable(db);
    await ensureAutomationBaselineTable(db);
    const localRows = await getLocalInventoryRows(db);
    if (!localRows.length) {
        await replaceAutomationBaselines(db, []);
        return 0;
    }

    const { payload, contexts } = await buildPushPayload(localRows, {});
    let remoteMap = new Map();
    try {
        const remoteSnapshot = await pullInventoryFromManaPool();
        if (remoteSnapshot?.items?.length) {
            remoteMap = buildRemoteListingMap(remoteSnapshot.items);
        }
    } catch (error) {
        console.warn('[automation] Failed to pull ManaPool listings for baseline snapshot:', error.message);
    }
    const variantPriceMap = await fetchVariantFloorsForInventory(localRows);
    const baselines = [];
    const recordedIds = new Set();

    const addBaseline = (inventoryId, priceCents) => {
        if (!inventoryId || !Number.isFinite(priceCents) || priceCents <= 0) return;
        const rounded = Math.round(priceCents);
        baselines.push({ inventoryId, priceCents: rounded });
        recordedIds.add(inventoryId);
    };

    payload.forEach((entry, index) => {
        const context = contexts[index];
        const inventoryId = context?.inventory?.id;
        if (!inventoryId) return;
        const key = entryKey(entry);
        const remoteListing = remoteMap.get(key);
        let priceCents = remoteListing?.priceCents;
        if (!Number.isFinite(priceCents) || priceCents <= 0) {
            const variantKey = context?.variantKey || buildVariantKey(context?.inventory);
            const variant = variantKey ? variantPriceMap.get(variantKey) : null;
            if (variant?.priceCents > 0) {
                priceCents = variant.priceCents;
            }
        }
        if (!Number.isFinite(priceCents) || priceCents <= 0) {
            const fallback = Number(context?.inventory?.tcgMarketPrice ?? context?.inventory?.pricePaid ?? 0);
            if (fallback > 0) {
                priceCents = Math.round(fallback * 100);
            }
        }
        addBaseline(inventoryId, priceCents);
    });

    localRows.forEach((row) => {
        if (recordedIds.has(row.id)) return;
        const variantKey = buildVariantKey(row);
        let priceCents = null;
        const variant = variantKey ? variantPriceMap.get(variantKey) : null;
        if (variant?.priceCents > 0) {
            priceCents = variant.priceCents;
        }
        if (!Number.isFinite(priceCents) || priceCents <= 0) {
            const fallback = Number(row.tcgMarketPrice ?? row.pricePaid ?? 0);
            if (fallback > 0) {
                priceCents = Math.round(fallback * 100);
            }
        }
        addBaseline(row.id, priceCents);
    });

    await replaceAutomationBaselines(db, baselines);
    return baselines.length;
}

export async function getAutomationBaselines(db) {
    await ensureAutomationBaselineTable(db);
    const rows = await fetchAutomationBaselineRows(db);
    const map = new Map();
    rows.forEach((row) => {
        const priceCents = Number(row.priceCents);
        if (row.inventoryId && Number.isFinite(priceCents) && priceCents > 0) {
            map.set(row.inventoryId, priceCents);
        }
    });
    return map;
}

export async function simulateAutomationForItems(items = [], automationOptions = null, options = {}) {
    if (!Array.isArray(items) || !items.length) {
        return [];
    }
    const collector = Array.isArray(options.debugCollector) ? options.debugCollector : [];
    await pushInventoryRows(items, {
        priceOffsetCents: options.priceOffsetCents ?? 1,
        deleteMissing: false,
        notifyAutomation: false,
        automation: automationOptions,
        simulateOnly: true,
        debugCollector: collector
    });
    return collector;
}
