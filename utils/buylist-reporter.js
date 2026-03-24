import fs from 'fs';
import path from 'path';
import { chromium } from 'playwright';
import { scrapeStarCityGamesBuylist } from '../scrapers/starcitygames.js';
import { scrapeTcgplayerData } from '../scrapers/tcgplayer.js';

const PUBLIC_REPORT_PATH = path.join(process.cwd(), 'public', 'buylist-report.json');
const REPORT_INTERVAL_MS = 60 * 60 * 1000 * 16;
let beforeBuildHook = null;
const DEFAULT_TARGET_PERCENT = 0.85;
const progressState = {
    active: false,
    total: 0,
    processed: 0,
    startedAt: null,
    finishedAt: null,
    message: ''
};

const ensureDir = (filePath) => {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
};

const readStoredReport = () => {
    try {
        if (fs.existsSync(PUBLIC_REPORT_PATH)) {
            const raw = fs.readFileSync(PUBLIC_REPORT_PATH, 'utf-8');
            return JSON.parse(raw);
        }
    } catch (error) {
        console.warn('[buylist] Failed reading stored report:', error.message || error);
    }
    return null;
};

const fetchInventoryRows = (db) => new Promise((resolve, reject) => {
    db.all('SELECT * FROM inventory WHERE quantity > 0', (err, rows) => {
        if (err) return reject(err);
        resolve(rows || []);
    });
});

const getLatestPriceFromHistory = (json, path) => {
    try {
        const priceJson = typeof json === 'string' ? JSON.parse(json) : json;
        const parts = path.split('.');
        let cursor = priceJson;
        for (const part of parts) {
            cursor = cursor?.[part];
            if (!cursor) return null;
        }
        if (typeof cursor !== 'object') return null;
        const dates = Object.keys(cursor);
        if (!dates.length) return null;
        dates.sort((a, b) => new Date(b) - new Date(a));
        return cursor[dates[0]] ?? null;
    } catch {
        return null;
    }
};

const getCkBuylistPrice = (db, setCode, collectorNumber, foilType = 'normal') => new Promise((resolve) => {
    const sql = `
        SELECT price_json FROM price_history
        WHERE uuid = (SELECT uuid FROM cards WHERE setCode = ? AND number = ? LIMIT 1)
    `;
    db.get(sql, [String(setCode || '').toUpperCase(), String(collectorNumber || '').trim()], (err, row) => {
        if (err || !row?.price_json) return resolve(null);
        const key = foilType === 'foil' || foilType === 'etched' ? 'foil' : 'normal';
        const price = getLatestPriceFromHistory(row.price_json, `paper.cardkingdom.buylist.${key}`);
        resolve(toSafeNumber(price));
    });
});

const saveInventorySnapshot = (db, snapshot) => new Promise((resolve, reject) => {
    let serialized;
    try {
        serialized = JSON.stringify(snapshot);
    } catch (err) {
        return reject(err);
    }
    const sql = `
        INSERT INTO inventory_metadata (id, buylistSnapshot, updatedAt)
        VALUES ('inventory', ?, CURRENT_TIMESTAMP)
        ON CONFLICT(id) DO UPDATE SET
            buylistSnapshot = excluded.buylistSnapshot,
            updatedAt = CURRENT_TIMESTAMP
    `;
    db.run(sql, [serialized], (err2) => {
        if (err2) return reject(err2);
        resolve();
    });
});

const toSafeNumber = (value) => {
    const num = Number(value);
    return Number.isFinite(num) ? num : null;
};

export const refreshInventoryBuylistSnapshot = async (db) => {
    if (!db) throw new Error('Database handle missing for buylist snapshot.');
    if (progressState.active) {
        console.log('[buylist] Snapshot rebuild skipped; another run is already active.');
        return { count: progressState.total, skipped: true };
    }
    const rows = await fetchInventoryRows(db);
    if (!rows.length) {
        await saveInventorySnapshot(db, { savedAt: new Date().toISOString(), items: [], targetPercent: DEFAULT_TARGET_PERCENT * 100 });
        return { count: 0 };
    }

    const browser = await chromium.launch({ headless: true, timeout: 30000 });
    const items = [];
    progressState.active = true;
    progressState.startedAt = new Date().toISOString();
    progressState.finishedAt = null;
    progressState.processed = 0;
    progressState.total = rows.length;
    progressState.message = `Updating card 1 of ${rows.length}`;

    for (const row of rows) {
        if (!row.tcgplayerId) continue;
        const condition = (row.condition || 'NM').toUpperCase();
        let context = null;
        let page = null;
        try {
            context = await browser.newContext({
                userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
            });
            page = await context.newPage();

            const tcgData = await scrapeTcgplayerData(page, row.tcgplayerId, row.foilType || 'normal', condition);
            const tcgLow = toSafeNumber(tcgData?.cheapestListing?.itemPrice);
            const tcgLowPlusShipping = toSafeNumber(tcgData?.cheapestListing?.totalPrice) || tcgLow;
            const tcgMarketPrice = toSafeNumber(tcgData?.marketPrice ?? tcgData?.lastSoldPrice);
            const scgPrice = await scrapeStarCityGamesBuylist(page, row.name, row.collectorNumber, row.foilType || 'normal');
            const ckPrice = await getCkBuylistPrice(db, row.setCode, row.collectorNumber, row.foilType || 'normal');
            const csiPrice = null; // placeholder for future CSI scrape integration

            const targetBuyPrice = tcgLowPlusShipping && tcgLowPlusShipping > 0
                ? tcgLowPlusShipping * DEFAULT_TARGET_PERCENT
                : null;

            items.push({
                card: {
                    id: row.id,
                    name: row.name,
                    setCode: row.setCode,
                    collectorNumber: row.collectorNumber,
                    foilType: row.foilType,
                    condition: row.condition,
                    quantity: row.quantity,
                    tcgplayerId: row.tcgplayerId,
                    imageUrl: row.imageUrl || null
                },
                metrics: {
                    tcgMarketPrice,
                    tcgLow,
                    tcgLowPlusShipping,
                    ckBuylist: ckPrice,
                    scgBuylist: toSafeNumber(scgPrice),
                    csiBuylist: toSafeNumber(csiPrice),
                    targetBuyPrice
                }
            });
        } catch (error) {
            console.error(`[buylist] Failed scraping ${row.name}:`, error.message || error);
            continue;
        } finally {
            if (page) {
                try { await page.close(); } catch {}
            }
            if (context) {
                try { await context.close(); } catch {}
            }
            progressState.processed += 1;
            const nextIndex = Math.min(progressState.processed + 1, progressState.total);
            progressState.message = progressState.processed < progressState.total
                ? `Updating card ${nextIndex} of ${progressState.total}`
                : 'Finalizing...';
        }
    }

    await browser.close();
    const snapshot = {
        savedAt: new Date().toISOString(),
        targetPercent: DEFAULT_TARGET_PERCENT * 100,
        sortKey: 'margin-percent-desc',
        items
    };
    await saveInventorySnapshot(db, snapshot);
    progressState.active = false;
    progressState.finishedAt = new Date().toISOString();
    progressState.message = 'Completed.';
    return { count: items.length };
};

const saveReport = (report) => {
    try {
        ensureDir(PUBLIC_REPORT_PATH);
        fs.writeFileSync(PUBLIC_REPORT_PATH, JSON.stringify(report, null, 2), 'utf-8');
    } catch (error) {
        console.warn('[buylist] Failed saving report:', error.message || error);
    }
};

const loadInventoryBuylistSnapshot = (db) => new Promise((resolve) => {
    if (!db) return resolve(null);
    db.get(`SELECT buylistSnapshot FROM inventory_metadata WHERE id = 'inventory'`, (err, row) => {
        if (err) {
            console.error('[buylist] Failed to load inventory buylist snapshot:', err.message);
            return resolve(null);
        }
        if (!row?.buylistSnapshot) return resolve(null);
        try {
            const parsed = JSON.parse(row.buylistSnapshot);
            resolve(parsed);
        } catch (error) {
            console.error('[buylist] Failed to parse inventory buylist snapshot:', error.message);
            resolve(null);
        }
    });
});

const normalizeNumber = (value) => {
    const num = Number(value);
    return Number.isFinite(num) ? num : null;
};

const pickBestBuylist = (metrics = {}) => {
    const candidates = [
        { key: 'ckBuylist', value: normalizeNumber(metrics.ckBuylist) },
        { key: 'scgBuylist', value: normalizeNumber(metrics.scgBuylist) },
        { key: 'csiBuylist', value: normalizeNumber(metrics.csiBuylist) }
    ].filter((entry) => Number.isFinite(entry.value));
    if (!candidates.length) return null;
    candidates.sort((a, b) => b.value - a.value);
    const best = candidates[0];
    const labelMap = {
        ckBuylist: 'Card Kingdom',
        scgBuylist: 'Star City Games',
        csiBuylist: 'CoolStuffInc'
    };
    return {
        vendorKey: best.key,
        vendorLabel: labelMap[best.key] || best.key,
        price: best.value
    };
};

export const buildBuylistReport = async (db, options = {}) => {
    if (typeof beforeBuildHook === 'function') {
        try {
            await beforeBuildHook();
        } catch (error) {
            console.warn('[buylist] beforeBuild hook failed:', error.message || error);
        }
    }
    const snapshot = options.snapshot || await loadInventoryBuylistSnapshot(db);
    const nowIso = new Date().toISOString();
    if (!snapshot || !Array.isArray(snapshot.items)) {
        const emptyReport = {
            generatedAt: nowIso,
            source: 'missing-snapshot',
            totalItems: 0,
            totalDeals: 0,
            topDeals: []
        };
        saveReport(emptyReport);
        return emptyReport;
    }

    const deals = snapshot.items.map((item) => {
        const best = pickBestBuylist(item.metrics || {});
        const tcgLowPlusShipping = normalizeNumber(item.metrics?.tcgLowPlusShipping);
        if (!best || !Number.isFinite(tcgLowPlusShipping) || tcgLowPlusShipping <= 0) return null;
        const marginDollar = best.price - tcgLowPlusShipping;
        const marginPercent = ((best.price - tcgLowPlusShipping) / tcgLowPlusShipping) * 100;
        const fallbackImage = item.card?.tcgplayerId
            ? `https://tcgplayer-cdn.tcgplayer.com/product/${item.card.tcgplayerId}_in_200x200.jpg`
            : 'https://placehold.co/200x280/1a1a1a/e0e0e0?text=No+Image';
        const ckBuylist = normalizeNumber(item.metrics?.ckBuylist);
        const scgBuylist = normalizeNumber(item.metrics?.scgBuylist);
        const csiBuylist = normalizeNumber(item.metrics?.csiBuylist);
        return {
            name: item.card?.name || 'Unknown',
            setCode: item.card?.setCode || '',
            collectorNumber: item.card?.collectorNumber || '',
            foilType: item.card?.foilType || 'normal',
            condition: item.card?.condition || 'NM',
            quantity: item.card?.quantity || 0,
            imageUrl: item.card?.imageUrl || fallbackImage,
            tcgplayerId: item.card?.tcgplayerId || '',
            tcgLowPlusShipping,
            tcgMarketPrice: normalizeNumber(item.metrics?.tcgMarketPrice),
            ckBuylist,
            scgBuylist,
            csiBuylist,
            bestVendor: best.vendorLabel,
            bestPrice: best.price,
            marginDollar,
            marginPercent,
            vendorKey: best.vendorKey
        };
    }).filter(Boolean);

    deals.sort((a, b) => b.marginDollar - a.marginDollar);
    const topDeals = deals.slice(0, 15);
    const report = {
        generatedAt: nowIso,
        source: 'inventory-snapshot',
        targetPercent: snapshot.targetPercent || null,
        totalItems: snapshot.items.length,
        totalDeals: deals.length,
        topDeals,
        allDeals: deals,
        summary: {
            averageMarginPercent: deals.length
                ? deals.reduce((sum, d) => sum + (d.marginPercent || 0), 0) / deals.length
                : null,
            totalPositive: deals.filter((d) => d.marginDollar > 0).length
        }
    };
    saveReport(report);
    return report;
};

export const getStoredBuylistReport = async () => {
    return readStoredReport();
};

export const refreshBuylistReport = async (db, options = {}) => {
    if (progressState.active) {
        console.log('[buylist] Refresh skipped; snapshot rebuild in progress.');
        const stored = readStoredReport();
        if (stored) return stored;
    }
    console.log('[buylist] Refresh requested.');
    const report = await buildBuylistReport(db, options);
    console.log('[buylist] Refresh complete.');
    return report;
};

export const getBuylistProgress = () => ({
    active: progressState.active,
    total: progressState.total,
    processed: progressState.processed,
    startedAt: progressState.startedAt,
    finishedAt: progressState.finishedAt,
    message: progressState.message
});

let buylistTimer = null;
export const startBuylistReporter = (db, options = {}) => {
    if (!db) return;
    beforeBuildHook = typeof options.beforeBuild === 'function' ? options.beforeBuild : null;
    const run = async () => {
        try {
            await refreshBuylistReport(db);
        } catch (error) {
            console.error('[buylist] Scheduled refresh failed:', error);
        }
    };
    if (buylistTimer) clearInterval(buylistTimer);
    buylistTimer = setInterval(run, REPORT_INTERVAL_MS);
};
