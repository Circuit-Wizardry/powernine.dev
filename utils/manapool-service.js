import axios from 'axios';
import { randomUUID } from 'crypto';

const API_BASE = process.env.MANAPOOL_API_BASE || 'https://manapool.com/api/v1';
const API_KEY = process.env.MANAPOOL_API_KEY || '';
const API_EMAIL = process.env.MANAPOOL_EMAIL || '';
const SCRYFALL_API_BASE = 'https://api.scryfall.com/cards';
const SCRYFALL_VALIDATION_DELAY_MS = 200;
const REMOTE_LOOKUP_DELAY_MS = 200;

const manapoolClient = axios.create({
    baseURL: API_BASE,
    timeout: 20000,
});

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
const HIGH_VALUE_PACKAGING_THRESHOLD = 45;
const PACKAGING_LOW_COST = 1.25;
const PACKAGING_HIGH_COST = 5;

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

const getLocalInventoryRows = (db) => new Promise((resolve, reject) => {
    db.all('SELECT id, name, setCode, collectorNumber, foilType, pricePaid, quantity, scryfallId, tcgMarketPrice, condition FROM inventory', [], (err, rows) => {
        if (err) {
            reject(err);
        } else {
            resolve(rows || []);
        }
    });
});

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const chunkArray = (arr, size = 100) => {
    const chunks = [];
    for (let i = 0; i < arr.length; i += size) {
        chunks.push(arr.slice(i, i + size));
    }
    return chunks;
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
        SELECT id, name, setCode, collectorNumber, foilType, pricePaid, quantity, scryfallId, tcgMarketPrice, condition
        FROM inventory
        WHERE id IN (${placeholders})
    `;
    db.all(sql, ids, (err, rows) => {
        if (err) return reject(err);
        resolve(rows || []);
    });
});

const extractTcgplayerId = (cardData = {}) => {
    if (cardData?.tcgplayer_id) return cardData.tcgplayer_id;
    if (Array.isArray(cardData?.card_faces)) {
        for (const face of cardData.card_faces) {
            if (face?.tcgplayer_id) return face.tcgplayer_id;
        }
    }
    return null;
};

const fetchTcgplayerIdFromScryfall = async (scryfallId, index = 0) => {
    if (!isUuid(scryfallId)) return null;
    if (index > 0) {
        await delay(SCRYFALL_VALIDATION_DELAY_MS);
    }
    try {
        const response = await axios.get(`${SCRYFALL_API_BASE}/${encodeURIComponent(scryfallId)}`);
        return extractTcgplayerId(response.data);
    } catch (error) {
        console.warn('[scryfall] tcgplayer lookup failed:', scryfallId, error.response?.status || error.message);
        return null;
    }
};

const buildPushPayload = async (items = [], options = {}) => {
    const candidates = items.filter(item => Number.isFinite(item.quantity) && item.quantity > 0);
    if (!candidates.length) {
        return { payload: [], missing: [], skipped: items.length };
    }

    const missingIds = [];
    let lookupIndex = 0;

    const payload = [];
    for (const item of candidates) {
        let tcgId = item.tcgplayerId && String(item.tcgplayerId).trim() !== '' ? item.tcgplayerId : null;
        if (!tcgId && item.scryfallId) {
            tcgId = await fetchTcgplayerIdFromScryfall(item.scryfallId, lookupIndex);
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
        payload.push({
            tcgplayer_id: Number(tcgId),
            language_id: LANGUAGE_ID,
            finish_id: FINISH_ID_MAP[item.foilType] || 'NF',
            condition_id: CONDITION_ID_MAP[String(item.condition || 'NM').toUpperCase()] || 'NM',
            base_price_cents: priceCents,
            price_cents: priceCents,
            quantity: Math.max(0, Number(item.quantity) || 0)
        });
    }

    return { payload, missing: missingIds };
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
    const { payload, missing } = await buildPushPayload(items, options);

    if (!payload.length) {
        const skipMsg = 'No inventory items with positive quantity and valid TCGPlayer IDs to sync.';
        return {
            updated: 0,
            message: skipMsg,
            preview: [],
            missing
        };
    }

    if (!hasCredentials()) {
        return {
            updated: 0,
            message: 'MANAPOOL_API_KEY missing. Performed dry run only.',
            preview: payload.slice(0, 25),
            missing
        };
    }

    const previewEntries = [];
    const payloadMap = new Map(payload.map(entry => [entryKey(entry), entry]));
    const missingEntries = new Map();
    let updatedCount = 0;
    let createdCount = 0;
    const messages = [];

    let remoteSnapshot = null;
    let remoteMap = new Map();
    try {
        remoteSnapshot = await pullInventoryFromManaPool();
        if (remoteSnapshot?.items?.length) {
            remoteMap = buildRemoteListingMap(remoteSnapshot.items);
        }
    } catch (error) {
        console.warn('[manapool] failed to pull inventory snapshot:', error.message);
    }

    payload.forEach(entry => {
        const key = entryKey(entry);
        const remoteListing = remoteMap.get(key);
        if (remoteListing && typeof remoteListing.priceCents === 'number') {
            const adjusted = Math.max(1, remoteListing.priceCents - priceOffsetCents);
            entry.price_cents = adjusted;
        } else if (!entry.price_cents) {
            // fallback if not already set
            entry.price_cents = Math.max(1, entry.base_price_cents || 10000);
        }
        delete entry.base_price_cents;
    });

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

    const endpointBase = '/seller/inventory/tcgplayer_id';
    const localKeySet = new Set(payload.map(entry => entryKey(entry)));

    const postChunk = async (chunk) => {
        try {
            await manapoolClient.post(endpointBase, chunk, { headers: authHeaders() });
            updatedCount += chunk.length;
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
                const succeeded = chunk.filter(entry => !failedKeys.has(entryKey(entry)));
                updatedCount += succeeded.length;
            } else {
                throw error;
            }
        }
    };

    const chunks = chunkArray(payload, 100);
    for (const chunk of chunks) {
        await postChunk(chunk);
    }

    if (missingEntries.size) {
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
                if (previewEntries.length < 25) {
                    previewEntries.push(entry);
                }
            } catch (error) {
                messages.push(`Failed creating ${entry.tcgplayer_id}: ${parseAxiosError(error)}`);
            }
        }
    }

    let deletedCount = 0;
    if (deleteMissing && remoteMap.size) {
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

    return {
        updated: updatedCount + createdCount,
        message: messages.join(' '),
        preview: previewEntries,
        missing
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
        const key = entryKey({
            tcgplayer_id: tcgId,
            language_id: language,
            finish_id: FINISH_ID_MAP[item.foilType] || 'NF',
            condition_id: item.condition || 'NM'
        });
        map.set(key, {
            tcgplayerId: tcgId,
            language_id: language,
            finish_id: FINISH_ID_MAP[item.foilType] || 'NF',
            condition_id: item.condition || 'NM',
            priceCents: typeof item.price === 'number' ? Math.round(item.price * 100) : null,
            quantity: item.quantity ?? 0
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
}

export async function pushInventoryToManaPool(db, options = {}) {
    const localInventory = await getLocalInventoryRows(db);
    return pushInventoryRows(localInventory, { priceOffsetCents: options.priceOffsetCents ?? 1, deleteMissing: options.deleteMissing ?? true });
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
    return pushInventoryRows(rows, { priceOffsetCents: options?.priceOffsetCents, deleteMissing: false });
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

const hasTransactionForOrder = (db, orderId) => new Promise((resolve, reject) => {
    db.get(`SELECT 1 FROM transactions WHERE manapoolOrderId = ? LIMIT 1`, [orderId], (err, row) => {
        if (err) return reject(err);
        resolve(Boolean(row));
    });
});

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
    let packagingCost = saleSubtotal > HIGH_VALUE_PACKAGING_THRESHOLD
        ? PACKAGING_HIGH_COST
        : PACKAGING_LOW_COST;
    let feeAmount;
    if (saleSubtotal > 0) {
        if (payment.fee_cents != null && !allowPartial) {
            feeAmount = (payment.fee_cents || 0) / 100;
        } else {
            feeAmount = (saleSubtotal * MANAPOOL_FEE_RATE) + MANAPOOL_FEE_FLAT;
        }
    } else {
        packagingCost = 0;
        feeAmount = 0;
    }
    const grossRevenue = saleSubtotal + shippingForTxn;
    const netProfit = saleSubtotal > 0
        ? Number((grossRevenue - (totalPurchasePrice + feeAmount + packagingCost)).toFixed(2))
        : 0;

    await runAsync(db, 'BEGIN TRANSACTION');
    try {
        await runAsync(
            db,
            `INSERT INTO transactions (id, soldAt, platform, shippingCost, packagingCost, totalSalePrice, netProfit, packingSlipPath, manapoolOrderId)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                transactionId,
                soldAt,
                'ManaPool',
                shippingForTxn,
                packagingCost,
                saleSubtotal,
                netProfit,
                null,
                order.id
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

    for (const summary of orders) {
        try {
            const exists = await hasTransactionForOrder(db, summary.id);
            if (exists) {
                skipped.push(summary.id);
                continue;
            }
            const detailsResponse = await fetchOrderDetails(summary.id);
            const orderDetails = detailsResponse?.order;
            if (!orderDetails) {
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

    return { imported, skipped, errors, unmatchedOrders };
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

    const buildKey = (item) => {
        if (item.scryfallId) {
            return `scry:${item.scryfallId}|${item.foilType || 'normal'}|${item.condition || 'NM'}`;
        }
        return `${(item.name || '').toLowerCase()}|${(item.setCode || '').toLowerCase()}|${item.foilType || 'normal'}|${(item.condition || 'NM').toUpperCase()}`;
    };

    const remoteIndex = new Map();
    remoteInventory.forEach(item => remoteIndex.set(buildKey(item), item));

    const discrepancies = [];
    localInventory.forEach((item) => {
        const key = buildKey({
            scryfallId: item.scryfallId,
            name: item.name,
            setCode: item.setCode,
            foilType: item.foilType,
            condition: item.condition
        });
        const remoteItem = remoteIndex.get(key);
        const remoteQuantity = remoteItem?.quantity ?? 0;
        const remotePrice = remoteItem?.price ?? 0;
        const isNew = !remoteItem || remoteQuantity === 0;
        if (!remoteItem) {
            discrepancies.push({
                name: item.name,
                setCode: item.setCode,
                localQuantity: item.quantity,
                remoteQuantity: 0,
                localPrice: item.tcgMarketPrice ?? item.pricePaid,
                remotePrice: '-',
                isNew
            });
            return;
        }

        const localPrice = item.tcgMarketPrice ?? item.pricePaid ?? 0;
        if (remoteItem.quantity !== item.quantity || Math.abs(remotePrice - localPrice) > 0.01) {
            discrepancies.push({
                name: item.name,
                setCode: item.setCode,
                localQuantity: item.quantity,
                remoteQuantity,
                localPrice: localPrice ? `$${localPrice.toFixed(2)}` : '-',
                remotePrice: remotePrice ? `$${Number(remotePrice).toFixed(2)}` : '-',
                isNew
            });
        }
    });

    const filtered = discrepancies
        .filter(row => !(Number(row.localQuantity) === 0 && Number(row.remoteQuantity) === 0))
        .sort((a, b) => Number(b.isNew) - Number(a.isNew));
    return { discrepancies: filtered };
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
