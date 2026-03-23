import express from 'express';
import { Readable } from 'stream';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import csv from 'csv-parser';
import { getCardNames } from './card-data.js';
import axios from 'axios';
import { randomUUID } from 'crypto';
import { log } from '../discord.js';
import { chromium } from 'playwright'; // Import Playwright
// Import your scraper functions (ensure paths are correct)
import { scrapeTcgplayerData } from '../scrapers/tcgplayer.js';
import { scrapeManaPoolListings } from '../scrapers/manapool.js';
import { scrapeStarCityGamesBuylist } from '../scrapers/starcitygames.js';
import { spawn } from 'child_process';
import {
    getAccountStatus as getManaPoolStatus,
    pullInventoryFromManaPool,
    pushInventoryToManaPool,
    pushInventoryItemsToManaPool,
    pullOrdersFromManaPool,
    bulkAdjustPrices,
    getInventoryDiscrepancies,
    getMarginData,
    importOrdersToTransactions,
    forceImportOrder,
    cleanupRemoteInventory,
    getAutomationSettings,
    getLocalInventoryRows,
    simulateAutomationForItems
} from './manapool-service.js';
import { buildAutomationPayload, applyAutomationSettingsUpdate } from './automation-runner.js';
import {
    recordShippingExpense,
    SHIPPING_EXPENSE_CATEGORIES,
    MANAPOOL_AUTO_SHIPPING_AMOUNT,
    MANAPOOL_AUTO_SHIPPING_THRESHOLD,
} from './expense-helpers.js';
import { refreshBuylistReport, getStoredBuylistReport, refreshInventoryBuylistSnapshot, getBuylistProgress } from './buylist-reporter.js';

const FIXED_SHIPPING_EXPENSE = 0; // Default packaging cost when none supplied
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-1.5-flash-latest';
const BUYLIST_MESSAGE_SYSTEM_PROMPT = ""

const normalizeManaPoolSlug = (cardName = '') => {
    return cardName
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9\s-]/g, '')
        .trim()
        .replace(/\s+/g, '-');
};

const getLatestFromPriceHistory = (history) => {
    if (!history || typeof history !== 'object') return null;
    const dates = Object.keys(history);
    if (!dates.length) return null;
    dates.sort((a, b) => new Date(b) - new Date(a));
    return history[dates[0]];
};

const fetchTcgMarketPriceFromDb = (db, { setCode, collectorNumber, foilType = 'normal' }) => {
    return new Promise((resolve) => {
        if (!setCode || !collectorNumber) return resolve(null);
        const sql = `
            SELECT price_json FROM price_history
            WHERE uuid = (
                SELECT uuid FROM cards WHERE setCode = ? AND number = ? LIMIT 1
            )
        `;
        db.get(sql, [setCode.toUpperCase(), collectorNumber], (err, row) => {
            if (err || !row) {
                if (err) console.error('[inventory] price lookup failed:', err.message);
                return resolve(null);
            }
            try {
                const priceJson = JSON.parse(row.price_json);
                const history = priceJson?.paper?.tcgplayer?.retail?.[foilType] || priceJson?.paper?.tcgplayer?.retail?.normal;
                resolve(getLatestFromPriceHistory(history));
            } catch (parseErr) {
                console.error('[inventory] price JSON parse error:', parseErr.message);
                resolve(null);
            }
        });
    });
};

const calculateFees = (salePrice, platform) => {
    if (salePrice <= 0) return 0;
    const TCGPLAYER_FEE_RATE = 0.1275;
    const MANAPOOL_FEE_RATE = 0.079;
    const FLAT_FEE = 0.30;

    if (platform === 'TCGPlayer') {
        return (salePrice * TCGPLAYER_FEE_RATE) + FLAT_FEE;
    }
    if (platform === 'ManaPool') {
        return (salePrice * MANAPOOL_FEE_RATE) + FLAT_FEE;
    }
    return 0; // Independent / in-person sales have no platform fee
};

const mapInternalConditionToManabox = (internalCondition) => {
    // Map internal DB abbreviations (NM, LP, etc.) to Manabox descriptive terms
    // based on the reverse of the provided import logic.
    switch (internalCondition.toUpperCase()) {
        case 'NM':
        case 'M': // Assuming 'M' might also map to Mint
            return 'mint'; 
        case 'LP':
            return 'near_mint'; // Mapped from 'near mint'
        case 'MP':
            return 'excellent'; // Mapped from 'excellent' or 'good'
        case 'HP':
            return 'lightly played'; // Mapped from 'light played' or 'played'
        case 'DMG':
            return 'poor'; // Mapped from 'poor'
        default:
            return 'near mint'; // Default to a safe, common state
    }
};


// --- Multer Configuration for PDF Uploads ---
const pdfStorage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, './private/uploads/');
    },
    filename: (req, file, cb) => {
        // Create a unique filename: timestamp-originalName.pdf
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, uniqueSuffix + path.extname(file.originalname));
    }
});
const pdfUpload = multer({
    storage: pdfStorage,
    limits: { fileSize: 10 * 1024 * 1024 }, // 10MB max
    fileFilter: (req, file, cb) => {
        if (file.mimetype === "application/pdf") {
            cb(null, true);
        } else {
            cb(new Error("File format not supported. Please upload a PDF."), false);
        }
    }
});


// The router is a function that accepts the database (db) connection
export default function(db, options = {}) {
    const router = express.Router();
    const uploadRoot = options.uploadRoot ? path.resolve(options.uploadRoot) : path.resolve('./private/uploads');
    let dailyUpdateProcess = null;

    const csvUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

    const dbGet = (sql, params = []) => new Promise((resolve, reject) => {
        db.get(sql, params, (err, row) => {
            if (err) return reject(err);
            resolve(row || null);
        });
    });

    const dbAllAsync = (sql, params = []) => new Promise((resolve, reject) => {
        db.all(sql, params, (err, rows) => {
            if (err) return reject(err);
            resolve(rows || []);
        });
    });

    const normalizeInventoryKey = (row = {}) => {
        const setCode = (row.setCode || '').toUpperCase();
        const number = String(row.collectorNumber || '').trim();
        const foil = String(row.foilType || 'normal').toLowerCase();
        const condition = String(row.condition || 'NM').toUpperCase();
        const scryfall = (row.scryfallId || '').toLowerCase();
        const tcgId = row.tcgplayerId ? String(row.tcgplayerId) : '';
        return [setCode, number, foil, condition, scryfall, tcgId].join('|');
    };

    const startDailyUpdate = () => {
        if (dailyUpdateProcess?.proc && dailyUpdateProcess.proc.exitCode === null) {
            return { alreadyRunning: true };
        }
        const scriptPath = path.resolve('./daily-update.js');
        const child = spawn(process.execPath, [scriptPath], {
            cwd: path.dirname(scriptPath),
            env: { ...process.env },
            stdio: ['ignore', 'pipe', 'pipe']
        });

        dailyUpdateProcess = { proc: child, startedAt: new Date().toISOString() };

        child.stdout.on('data', (chunk) => {
            console.log(`[command DAILY_UPDATE stdout] ${chunk.toString().trimEnd()}`);
        });
        child.stderr.on('data', (chunk) => {
            console.warn(`[command DAILY_UPDATE stderr] ${chunk.toString().trimEnd()}`);
        });
        child.on('close', (code) => {
            console.log(`[command DAILY_UPDATE] exited with code ${code}`);
            dailyUpdateProcess = null;
        });

        return { pid: child.pid, startedAt: dailyUpdateProcess.startedAt };
    };

    const consolidateInventoryDuplicates = async () => {
        const rows = await dbAllAsync(`
            SELECT id, name, setCode, collectorNumber, foilType, condition, pricePaid, quantity, scryfallId, tcgplayerId, createdAt
            FROM inventory
        `);
        if (!rows.length) return { merged: 0 };
        const groups = new Map();
        rows.forEach((row) => {
            const key = normalizeInventoryKey(row);
            if (!groups.has(key)) groups.set(key, []);
            groups.get(key).push(row);
        });
        let mergedCount = 0;
        for (const [, group] of groups.entries()) {
            if (group.length <= 1) continue;
            mergedCount += group.length - 1;
            // Keep the oldest row (createdAt) as the canonical record.
            group.sort((a, b) => new Date(a.createdAt || 0) - new Date(b.createdAt || 0));
            const keeper = group[0];
            const rest = group.slice(1);
            const totalQuantity = group.reduce((sum, row) => sum + (Number(row.quantity) || 0), 0);
            const totalCost = group.reduce((sum, row) => sum + (Number(row.pricePaid) || 0) * (Number(row.quantity) || 0), 0);
            const avgPricePaid = totalQuantity > 0 ? Number((totalCost / totalQuantity).toFixed(2)) : 0;
            await new Promise((resolve, reject) => {
                db.run(
                    `UPDATE inventory SET quantity = ?, pricePaid = ? WHERE id = ?`,
                    [totalQuantity, avgPricePaid, keeper.id],
                    (err) => (err ? reject(err) : resolve())
                );
            });
            if (rest.length) {
                const idsToDelete = rest.map(r => r.id);
                await new Promise((resolve, reject) => {
                    const placeholders = idsToDelete.map(() => '?').join(',');
                    db.run(`DELETE FROM inventory WHERE id IN (${placeholders})`, idsToDelete, (err) => (err ? reject(err) : resolve()));
                });
            }
        }
        return { merged: mergedCount };
    };

    const normalizeIsoDate = (value) => {
        if (!value) return new Date().toISOString();
        const parsed = new Date(value);
        if (Number.isNaN(parsed.getTime())) {
            return new Date().toISOString();
        }
        return parsed.toISOString();
    };

    const getInventoryValuation = async () => {
        const sql = `
            SELECT 
                IFNULL(SUM(
                    COALESCE(
                        NULLIF(tcgMarketPrice, 0),
                        NULLIF(pricePaid, 0),
                        0
                    ) * quantity
                ), 0) AS totalValue,
                IFNULL(SUM(pricePaid * quantity), 0) AS costBasis,
                IFNULL(SUM(quantity), 0) AS totalQuantity
            FROM inventory
            WHERE quantity IS NOT NULL AND quantity > 0
        `;
        const row = await dbGet(sql);
        return {
            totalValue: Number(row?.totalValue || 0),
            costBasis: Number(row?.costBasis || 0),
            totalQuantity: Number(row?.totalQuantity || 0)
        };
    };

    const getSecretLairCostBasis = () => new Promise((resolve, reject) => {
        const sql = `
            SELECT IFNULL(SUM(amount), 0) AS total
            FROM expense_entries
            WHERE LOWER(category) LIKE 'secret lair%'
        `;
        db.get(sql, [], (err, row) => {
            if (err) return reject(err);
            resolve(Number(row?.total || 0));
        });
    });

    const captureInventorySnapshot = async (notes = null) => {
        const valuation = await getInventoryValuation();
        const snapshotId = randomUUID();
        const capturedAt = new Date().toISOString();
        const sql = `
            INSERT INTO inventory_snapshots (id, capturedAt, totalValue, inventoryCount, costBasis, notes)
            VALUES (?, ?, ?, ?, ?, ?)
        `;
        await new Promise((resolve, reject) => {
            db.run(sql, [
                snapshotId,
                capturedAt,
                valuation.totalValue,
                valuation.totalQuantity,
                valuation.costBasis,
                notes || null
            ], (err) => {
                if (err) return reject(err);
                resolve();
            });
        });
        return {
            id: snapshotId,
            capturedAt,
            totalValue: valuation.totalValue,
            inventoryCount: valuation.totalQuantity,
            costBasis: valuation.costBasis,
            notes: notes || null
        };
    };

    const getSoldCostBasis = () => new Promise((resolve, reject) => {
        const sql = `
            SELECT IFNULL(SUM(i.pricePaid * ti.quantity), 0) AS totalCost
            FROM transaction_items ti
            JOIN transactions t ON t.id = ti.transactionId
            JOIN inventory i ON ti.inventoryId = i.id
            WHERE COALESCE(t.entryType, 'sale') = 'sale'
        `;
        db.get(sql, [], (err, row) => {
            if (err) return reject(err);
            resolve(Number(row?.totalCost || 0));
        });
    });

    const fetchInventoryLowByScryfall = (scryfallId) => new Promise((resolve) => {
        if (!scryfallId) return resolve(null);
        const sql = `
            SELECT tcgLow, tcgLowPlusShipping
            FROM inventory
            WHERE scryfallId = ?
            ORDER BY datetime(createdAt) DESC
            LIMIT 1
        `;
        db.get(sql, [scryfallId], (err, row) => {
            if (err || !row) return resolve(null);
            const value = Number(row.tcgLow ?? row.tcgLowPlusShipping);
            resolve(Number.isFinite(value) && value > 0 ? value : null);
        });
    });

    const fetchPriceHistoryByUuid = (uuid) => new Promise((resolve) => {
        if (!uuid) return resolve(null);
        db.get('SELECT price_json FROM price_history WHERE uuid = ? LIMIT 1', [uuid], (err, row) => {
            if (err || !row) return resolve(null);
            try {
                resolve(JSON.parse(row.price_json));
            } catch (error) {
                console.error('[finances] price JSON parse error:', error.message);
                resolve(null);
            }
        });
    });

const normalizeFinish = (value = 'normal') => {
    const normalized = String(value || 'normal').toLowerCase();
    if (normalized === 'nonfoil' || normalized === 'normal') return 'normal';
    if (normalized === 'etched') return 'etched';
    if (normalized === 'foil') return 'foil';
    return normalized;
};

const extractRetailPrice = (priceJson, finish = 'normal') => {
        if (!priceJson?.paper?.tcgplayer?.retail) return null;
    const retailBlock = priceJson.paper.tcgplayer.retail;
    const finishKey = retailBlock[finish] ? finish : Object.keys(retailBlock)[0];
    if (!finishKey) return null;
    const history = retailBlock[finishKey];
    return getLatestFromPriceHistory(history);
};

const findUuidByScryfallId = (scryfallId) => new Promise((resolve) => {
    if (!scryfallId) return resolve(null);
    db.get('SELECT uuid FROM cards WHERE scryfallId = ? LIMIT 1', [scryfallId], (err, row) => {
        if (err || !row) return resolve(null);
        resolve(row.uuid);
    });
});

    const buildFinanceSummary = async () => {
        const [
            salesRows,
            expenseRow,
            unshippedRow,
            valuation,
            categoryRows,
            snapshotRows,
            recentExpenses,
            costOfGoodsSold,
            secretLairCostBasis
        ] = await Promise.all([
            dbAllAsync(`
                SELECT totalSalePrice, netProfit, packagingCost, platform
                FROM transactions
                WHERE COALESCE(entryType, 'sale') = 'sale'
            `),
            dbGet(`
                SELECT 
                    IFNULL(SUM(amount), 0) AS expenses,
                    COUNT(*) AS expenseCount
                FROM expense_entries
                WHERE NOT (
                    LOWER(category) LIKE 'secret lair%'
                    OR LOWER(category) = 'card purchase'
                )
            `),
            dbGet(`
                SELECT COUNT(*) AS pending
                FROM transactions
                WHERE platform = 'ManaPool' AND COALESCE(isShipped, 1) = 0
                  AND EXISTS (SELECT 1 FROM transaction_items ti WHERE ti.transactionId = transactions.id)
            `),
            getInventoryValuation(),
            dbAllAsync(`
                SELECT 
                    COALESCE(NULLIF(category, ''), 'Uncategorized') AS category,
                    COUNT(*) AS count,
                    SUM(amount) AS total
                FROM expense_entries
                WHERE NOT (
                    LOWER(category) LIKE 'secret lair%'
                    OR LOWER(category) = 'card purchase'
                )
                GROUP BY category
                ORDER BY total DESC
            `),
            dbAllAsync(`
                SELECT id, capturedAt, totalValue, inventoryCount, costBasis, notes
                FROM inventory_snapshots
                ORDER BY datetime(capturedAt) DESC
                LIMIT 20
            `),
            dbAllAsync(`
                SELECT id, description, amount, category, paymentMethod, incurredOn, notes
                FROM expense_entries
                WHERE NOT (
                    LOWER(category) LIKE 'secret lair%'
                    OR LOWER(category) = 'card purchase'
                )
                ORDER BY datetime(incurredOn) DESC
                LIMIT 5
            `),
            getSoldCostBasis(),
            getSecretLairCostBasis()
        ]);

        const revenue = salesRows.reduce((sum, row) => sum + Number(row.totalSalePrice || 0), 0);
        const estimatedFees = salesRows.reduce((sum, row) => {
            return sum + Number(calculateFees(Number(row.totalSalePrice || 0), row.platform || ''));
        }, 0);
        const shippingEstimate = salesRows.reduce((sum, row) => sum + Number(row.packagingCost || 0), 0);
        const salesCount = salesRows.length;
        const expenses = Number(expenseRow?.expenses || 0);
        const expenseCount = Number(expenseRow?.expenseCount || 0);
        const totalCogs = costOfGoodsSold + secretLairCostBasis;
        const salesNetBeforeExpenses = revenue - estimatedFees - totalCogs;
        const netProfit = salesNetBeforeExpenses - expenses;
        const pendingOrders = Number(unshippedRow?.pending || 0);

        return {
            revenue,
            salesCount,
            expenses,
            expenseCount,
            netProfit,
            pendingOrders,
            inventoryValue: valuation.totalValue,
            inventoryUnits: valuation.totalQuantity,
            inventoryCostBasis: valuation.costBasis,
            estimatedFees,
            shippingEstimate,
            salesNetProfit: salesNetBeforeExpenses,
            costOfGoodsSold: totalCogs,
            expenseCategories: categoryRows.map(row => ({
                category: row.category,
                total: Number(row.total || 0),
                count: Number(row.count || 0)
            })),
            snapshots: snapshotRows,
            recentExpenses: recentExpenses.map(row => ({
                ...row,
                amount: Number(row.amount || 0)
            }))
        };
    };

    const normalizeExpensePayload = (payload = {}) => {
        const description = (payload.description || '').trim();
        if (!description) {
            throw new Error('Description is required.');
        }
        const amount = Number(payload.amount);
        if (!Number.isFinite(amount) || amount <= 0) {
            throw new Error('Amount must be greater than zero.');
        }
        const normalized = {
            description,
            amount: Number(amount.toFixed(2)),
            category: payload.category ? String(payload.category).trim() : null,
            paymentMethod: payload.paymentMethod ? String(payload.paymentMethod).trim() : null,
            incurredOn: normalizeIsoDate(payload.incurredOn),
            linkedInventoryId: payload.linkedInventoryId ? String(payload.linkedInventoryId).trim() : null,
            notes: payload.notes ? String(payload.notes).trim() : null
        };
        if (normalized.linkedInventoryId === '') {
            normalized.linkedInventoryId = null;
        }
        return normalized;
    };

    const mapExpenseRow = (row) => {
        if (!row) return null;
        return {
            ...row,
            amount: Number(row.amount || 0)
        };
    };

    router.post('/admin/command', express.json(), (req, res) => {
        const command = (req.body?.command || '').toString().trim().toUpperCase();
        if (!command) {
            return res.status(400).json({ error: 'Command is required.' });
        }

        if (command === 'DAILY_UPDATE') {
            const result = startDailyUpdate();
            if (result.alreadyRunning) {
                return res.status(409).json({ error: 'DAILY_UPDATE already running.' });
            }
            return res.json({
                status: 'started',
                pid: result.pid || null,
                startedAt: result.startedAt
            });
        }

        return res.status(404).json({ error: `Unknown command: ${command}` });
    });

    // --- Backup management ---
    const BACKUP_DIR = path.resolve('./data/backups');

    router.get('/backups', (req, res) => {
        if (!fs.existsSync(BACKUP_DIR)) return res.json([]);
        const files = fs.readdirSync(BACKUP_DIR)
            .filter(f => f.endsWith('.sqlite'))
            .map(f => {
                const stat = fs.statSync(path.join(BACKUP_DIR, f));
                return { name: f, size: stat.size, created: stat.mtime.toISOString() };
            })
            .sort((a, b) => b.created.localeCompare(a.created));
        res.json(files);
    });

    router.post('/backups/restore', express.json(), (req, res) => {
        const { name } = req.body || {};
        if (!name || typeof name !== 'string') {
            return res.status(400).json({ error: 'Backup name is required.' });
        }
        // Prevent path traversal
        const safeName = path.basename(name);
        const backupPath = path.join(BACKUP_DIR, safeName);
        if (!fs.existsSync(backupPath)) {
            return res.status(404).json({ error: `Backup not found: ${safeName}` });
        }

        const DB_PATH = path.resolve('./data/AllData.sqlite');
        const sqlite3 = db.constructor;

        // Attach the backup and restore each table
        db.serialize(() => {
            db.run(`ATTACH DATABASE ? AS backup`, [backupPath], (err) => {
                if (err) return res.status(500).json({ error: err.message });

                // Get the list of tables in the backup
                db.all(`SELECT name FROM backup.sqlite_master WHERE type='table'`, (err, tables) => {
                    if (err) {
                        db.run('DETACH DATABASE backup');
                        return res.status(500).json({ error: err.message });
                    }

                    const tableNames = tables.map(t => t.name);
                    let restored = [];
                    let errors = [];

                    db.run('BEGIN TRANSACTION', () => {
                        let remaining = tableNames.length;
                        if (remaining === 0) {
                            db.run('COMMIT');
                            db.run('DETACH DATABASE backup');
                            return res.json({ restored: [], errors: [] });
                        }

                        for (const table of tableNames) {
                            // Delete current data, insert from backup
                            db.run(`DELETE FROM main.${table}`, (err) => {
                                if (err) {
                                    errors.push({ table, error: err.message });
                                    checkDone();
                                    return;
                                }
                                db.run(`INSERT INTO main.${table} SELECT * FROM backup.${table}`, (err) => {
                                    if (err) errors.push({ table, error: err.message });
                                    else restored.push(table);
                                    checkDone();
                                });
                            });
                        }

                        function checkDone() {
                            remaining--;
                            if (remaining <= 0) {
                                if (errors.length > 0) {
                                    db.run('ROLLBACK', () => {
                                        db.run('DETACH DATABASE backup');
                                        res.status(500).json({ error: 'Restore failed, rolled back.', restored, errors });
                                    });
                                } else {
                                    db.run('COMMIT', () => {
                                        db.run('DETACH DATABASE backup');
                                        console.log(`[backup] Restored ${restored.length} tables from ${safeName}`);
                                        res.json({ restored, errors });
                                    });
                                }
                            }
                        }
                    });
                });
            });
        });
    });

    router.delete('/backups/:name', (req, res) => {
        const safeName = path.basename(req.params.name);
        const backupPath = path.join(BACKUP_DIR, safeName);
        if (!fs.existsSync(backupPath)) {
            return res.status(404).json({ error: 'Backup not found.' });
        }
        fs.unlinkSync(backupPath);
        res.json({ ok: true, deleted: safeName });
    });

    router.post('/scrape-buylists', express.json(), async (req, res) => {
        if (!req.body) {
            return res.status(400).json({ error: 'Request body is missing.' });
        }

        const { cardName, setCode, collectorNumber, foilType } = req.body;

        if (!cardName || !setCode || !collectorNumber || !foilType) {
            return res.status(400).json({ error: 'Missing required card identifiers for scraping.' });
        }

        let browser;
        try {
            console.log(`[buylist] Starting scrape job for ${cardName} (${setCode} #${collectorNumber})`);

            // Launch a single browser instance for all scrapes in this job.
            browser = await chromium.launch({ headless: true });
            const context = await browser.newContext({
                userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
            });
            const page = await context.newPage();

            // --- Modular Scraping Section ---
            // Each scraper is called here. The results are collected in an object.
            // Using Promise.all would run them in parallel, but sequential can be
            // safer to avoid rate-limiting issues.

            const scgPrice = await scrapeStarCityGamesBuylist(page, cardName, collectorNumber, foilType);
            
            // EXAMPLE: This is where you would add another scraper call.
            // const ckPrice = await scrapeCardKingdomBuylist(page, cardName, setCode, collectorNumber, foilType);


            // --- Consolidate Results ---
            const buylistData = {
                scgBuylist: scgPrice,
                // ckBuylist: ckPrice, // Add results from other scrapers here
            };

            console.log('[scrape-buylists] Scrape successful:', buylistData);
            
            res.json(buylistData);

        } catch (error) {
            console.error('[scrape-buylists] Scrape failed for ' + cardName + ':', error);
            res.status(500).json({ error: 'An unexpected error occurred during the buylist scrape.' });
        } finally {
            if (browser) await browser.close();
        }
    });


    router.post('/buylist/generate-message', express.json(), async (req, res) => {
        const apiKey = process.env.GOOGLE_API_KEY;
        if (!apiKey) {
            return res.status(500).json({ error: 'Google API key is not configured on the server.' });
        }

        const { cards, prompt } = req.body || {};
        if (!Array.isArray(cards) || !cards.length) {
            return res.status(400).json({ error: 'No cards supplied for message generation.' });
        }

        const instructions = typeof prompt === 'string' && prompt.trim().length > 0
            ? prompt.trim()
            : 'Draft a concise, friendly outreach asking if the seller will accept these offers. Keep it professional and avoid extra fluff. Do NOT include asterisks or markdown formatting. Keep it 1-2 sentences. Confirm the total offer amount at the end.';

        const normalizedCards = cards.slice(0, 50).map((card) => ({
            name: String(card.name || '').trim(),
            quantity: Number(card.quantity) || 0,
            buylistPrice: Number(card.buylistPrice) || null
        })).filter((card) => card.name && Number.isFinite(card.buylistPrice));

        if (!normalizedCards.length) {
            return res.status(400).json({ error: 'No valid cards were supplied.' });
        }

        const cardLines = normalizedCards.map((card, index) => {
            const priceText = Number.isFinite(card.buylistPrice) ? `$${card.buylistPrice.toFixed(2)}` : 'N/A';
            const qty = card.quantity > 0 ? `x${card.quantity}` : 'x1';
            return `${index + 1}. ${card.name} (${qty}) - Offer per copy: ${priceText}`;
        }).join('\n');

        const total = normalizedCards.reduce((sum, card) => {
            const qty = card.quantity > 0 ? card.quantity : 1;
            const price = Number.isFinite(card.buylistPrice) ? card.buylistPrice : 0;
            return sum + qty * price;
        }, 0);
        const totalRounded = Math.floor(total * 2) / 2; // round down to nearest $0.50

        const userPrompt = [
            instructions,
            '',
            'Cards:',
            cardLines,
            '',
            `Total offer (all copies): $${totalRounded.toFixed(2)} (rounded down to nearest $0.50)`
        ].join('\n');

        try {
            const response = await axios.post(
                `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`,
                {
                    contents: [
                        {
                            parts: [
                                { text: BUYLIST_MESSAGE_SYSTEM_PROMPT },
                                { text: userPrompt }
                            ]
                        }
                    ],
                    safetySettings: [
                        { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' },
                        { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' },
                        { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' },
                        { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
                        { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' }
                    ]
                },
                {
                    params: { key: apiKey }
                }
            );

            const text = response.data?.candidates?.[0]?.content?.parts?.map((p) => p.text).join('') || '';
            res.json({ message: text.trim() });
        } catch (error) {
            const apiErrorMessage = error?.response?.data?.error?.message;
            console.error('[buylist/generate-message] Gemini error:', error?.response?.data || error.message);
            res.status(500).json({
                error: apiErrorMessage || 'Failed to generate message with Gemini.'
            });
        }
    });


    router.post('/scrape-lows', express.json(), async (req, res) => {
        const { tcgplayerId, cardName, setCode, collectorNumber, foilType, condition, store } = req.body;

        if (!tcgplayerId || !cardName || !setCode || !collectorNumber || !foilType) {
            return res.status(400).json({ error: 'Missing required card identifiers for scraping.' });
        }

        const normalizedCondition = (condition || 'NM').toUpperCase();

        let browser;
        try {
            const logMessage = `${cardName} (${normalizedCondition} ${foilType})`;
            browser = await chromium.launch({ headless: true });
            const context = await browser.newContext({
                userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
            });
            const page = await context.newPage();

            let tcgLow = null;
            let tcgLowPlusShipping = null;
            let manaPoolLow = null;
            const slugCandidate = normalizeManaPoolSlug(cardName);
            const cardSlug = slugCandidate || encodeURIComponent(cardName.toLowerCase());

            if (store === 'manapool') {
                console.log('[scrape-lows] Starting ManaPool-only scrape for ' + logMessage);
                const manaPoolUrl = `https://manapool.com/card/${setCode.toLowerCase()}/${collectorNumber}/${cardSlug}`;
                const mpData = await scrapeManaPoolListings(page, manaPoolUrl, foilType, normalizedCondition);
                manaPoolLow = mpData.cheapestPrice;
                console.log('[scrape-lows] ManaPool scrape successful:', { manaPoolLow });
            } else {
                console.log('[scrape-lows] Starting full scrape job for ' + logMessage);
                const tcgData = await scrapeTcgplayerData(page, tcgplayerId, foilType, normalizedCondition);
                console.log('   -> TCGplayer scrape returned:', tcgData);
                tcgLow = tcgData.cheapestListing?.itemPrice ?? null;
                tcgLowPlusShipping = tcgData.cheapestListing?.totalPrice ?? null;

                const shouldScrapeManaPool = store !== 'tcgplayer' && store !== 'tcgplayer-only' && store !== 'tcg';
                if (shouldScrapeManaPool) {
                    const manaPoolUrl = `https://manapool.com/card/${setCode.toLowerCase()}/${collectorNumber}/${cardSlug}`;
                    const mpData = await scrapeManaPoolListings(page, manaPoolUrl, foilType, normalizedCondition);
                    manaPoolLow = mpData.cheapestPrice;
                } else {
                    console.log('     -> Skipping ManaPool scrape per request.');
                }

                console.log('[scrape-lows] Scrape successful:', { tcgLow, tcgLowPlusShipping, manaPoolLow });
            }

            res.json({
                tcgLow,
                tcgLowPlusShipping,
                manaPoolLow
            });
        } catch (error) {
            console.error('[scrape-lows] Scrape failed for ' + cardName + ':', error);
            res.status(500).json({ error: 'Failed to scrape pricing data.' });
        } finally {
            if (browser) await browser.close();
        }
    });


    // UPDATED: GET all inventory items (selects all new columns)
    router.get('/inventory', (req, res) => {
        // The WHERE clause is the only modification.
        const sql = "SELECT * FROM inventory WHERE quantity > 0 ORDER BY createdAt DESC";
        db.all(sql, [], (err, rows) => {
            if (err) {
                res.status(500).json({ error: err.message });
                return;
            }
            res.json(rows);
        });
    });

    // NEW: Lightweight portfolio summary + value history (60-day window)
    router.get('/inventory/summary', async (_req, res) => {
        try {
            const inventoryRows = await dbAllAsync(`
                SELECT id, name, setCode, collectorNumber, foilType, pricePaid, quantity,
                       tcgMarketPrice, tcgLow, tcgLowPlusShipping, tcgplayerId, scryfallId
                FROM inventory
                WHERE quantity > 0
            `);

            if (!inventoryRows.length) {
                return res.json({
                    totals: {
                        marketValue: 0,
                        costBasis: 0,
                        quantity: 0,
                        avgArbPct: 0,
                        avgArbDollar: 0,
                        avgBuyPrice: 0,
                        avgMarketPrice: 0
                    },
                    valueHistory: [],
                    spotlights: []
                });
            }

            const keyFor = (row) => `${(row.setCode || '').toUpperCase()}|${String(row.collectorNumber || '').trim()}`;
            const uniqueKeys = [...new Set(inventoryRows.map(keyFor))];

            let priceRows = [];
            if (uniqueKeys.length) {
                const placeholders = uniqueKeys.map(() => '?').join(',');
                priceRows = await dbAllAsync(`
                    SELECT c.setCode, c.number, ph.price_json
                    FROM cards c
                    JOIN price_history ph ON ph.uuid = c.uuid
                    WHERE (c.setCode || '|' || c.number) IN (${placeholders})
                `, uniqueKeys);
            }

            const priceMap = new Map();
            for (const row of priceRows) {
                const key = `${(row.setCode || '').toUpperCase()}|${String(row.number || '').trim()}`;
                try {
                    priceMap.set(key, JSON.parse(row.price_json));
                } catch (error) {
                    console.error('[inventory] summary price JSON parse error:', error.message);
                }
            }

            const cutoff = new Date();
            cutoff.setDate(cutoff.getDate() - 60);
            const valueByDate = new Map();

            let totalMarket = 0;
            let costBasis = 0;
            let quantity = 0;
            let arbDollarSum = 0;

            for (const row of inventoryRows) {
                const qty = Number(row.quantity) || 0;
                if (!qty) continue;
                quantity += qty;
                const itemCostBasis = (Number(row.pricePaid) || 0) * qty;
                costBasis += itemCostBasis;

                const priceJson = priceMap.get(keyFor(row));
                const finish = (row.foilType || 'normal').toLowerCase();
                const history = priceJson?.paper?.tcgplayer?.retail?.[finish] || priceJson?.paper?.tcgplayer?.retail?.normal || null;

                let marketPrice = Number(row.tcgMarketPrice);
                if (!Number.isFinite(marketPrice) || marketPrice <= 0) {
                    marketPrice = Number(getLatestFromPriceHistory(history)) || 0;
                }
                const itemMarketTotal = marketPrice * qty;
                totalMarket += itemMarketTotal;
                arbDollarSum += (marketPrice - (Number(row.pricePaid) || 0)) * qty;

                if (history) {
                    for (const [dateStr, value] of Object.entries(history)) {
                        const asDate = new Date(dateStr);
                        if (Number.isNaN(asDate.getTime()) || asDate < cutoff) continue;
                        const price = Number(value);
                        if (!Number.isFinite(price) || price <= 0) continue;
                        const iso = dateStr.slice(0, 10);
                        const entry = valueByDate.get(iso) || { marketValue: 0 };
                        entry.marketValue += price * qty;
                        valueByDate.set(iso, entry);
                    }
                }
            }

            const valueHistory = [...valueByDate.entries()]
                .sort((a, b) => new Date(a[0]) - new Date(b[0]))
                .map(([date, values]) => ({
                    date,
                    marketValue: Number((values.marketValue || 0).toFixed(2)),
                    costBasis: Number(costBasis.toFixed(2))
                }));

            const avgArbDollar = quantity > 0 ? Number((arbDollarSum / quantity).toFixed(2)) : 0;
            const avgArbPct = costBasis > 0 ? Number(((totalMarket - costBasis) / costBasis * 100).toFixed(2)) : 0;
            const avgBuyPrice = quantity > 0 ? Number((costBasis / quantity).toFixed(2)) : 0;
            const avgMarketPrice = quantity > 0 ? Number((totalMarket / quantity).toFixed(2)) : 0;

            const spotlights = [...inventoryRows]
                .sort((a, b) => ((Number(b.tcgMarketPrice) || 0) * (Number(b.quantity) || 0)) - ((Number(a.tcgMarketPrice) || 0) * (Number(a.quantity) || 0)))
                .slice(0, 12)
                .map(row => ({
                    id: row.id,
                    name: row.name,
                    setCode: row.setCode,
                    collectorNumber: row.collectorNumber,
                    foilType: row.foilType,
                    quantity: row.quantity,
                    tcgMarketPrice: row.tcgMarketPrice ?? null,
                    pricePaid: row.pricePaid ?? null,
                    tcgplayerId: row.tcgplayerId || null,
                    scryfallId: row.scryfallId || null,
                    imageUrl: row.tcgplayerId
                        ? `https://tcgplayer-cdn.tcgplayer.com/product/${row.tcgplayerId}_in_1000x1000.jpg`
                        : (row.scryfallId
                            ? `https://cards.scryfall.io/normal/front/${row.scryfallId[0]}/${row.scryfallId[1]}/${row.scryfallId}.jpg`
                            : null)
                }));

            res.json({
                totals: {
                    marketValue: Number(totalMarket.toFixed(2)),
                    costBasis: Number(costBasis.toFixed(2)),
                    quantity,
                    avgArbPct,
                    avgArbDollar,
                    avgBuyPrice,
                    avgMarketPrice
                },
                valueHistory,
                spotlights
            });
        } catch (error) {
            console.error('[inventory] summary error:', error);
            res.status(500).json({ error: error.message || 'Failed to load inventory summary.' });
        }
    });

    router.get('/manapool/status', async (req, res) => {
        try {
            const status = await getManaPoolStatus(db);
            res.json(status);
        } catch (error) {
            console.error('[manapool] status error:', error);
            res.status(500).json({ error: error.message || 'Failed to load ManaPool status.' });
        }
    });

    router.post('/manapool/inventory/pull', async (_req, res) => {
        try {
            const payload = await pullInventoryFromManaPool();
            res.json(payload);
        } catch (error) {
            console.error('[manapool] pull inventory error:', error);
            res.status(500).json({ error: error.message || 'Failed pulling ManaPool inventory.' });
        }
    });

    router.post('/manapool/inventory/push', express.json(), async (req, res) => {
        try {
            const priceOffsetCents = Number.isFinite(Number(req.body?.priceOffsetCents))
                ? Number(req.body.priceOffsetCents)
                : 1;
            const concurrency = Math.max(1, Math.min(Number(req.body?.concurrency) || 5, 10));
            const skipAutomation = Boolean(req.body?.skipAutomation);
            const result = await pushInventoryToManaPool(db, { priceOffsetCents, deleteMissing: true, concurrency, skipAutomation });
            res.json(result);
        } catch (error) {
            console.error('[manapool] push inventory error:', error);
            res.status(500).json({ error: error.message || 'Failed pushing inventory to ManaPool.' });
        }
    });

    router.post('/manapool/inventory/push-item', express.json(), async (req, res) => {
        try {
            const bodyIds = Array.isArray(req.body?.inventoryIds) ? req.body.inventoryIds : [];
            const singleId = req.body?.inventoryId ? [req.body.inventoryId] : [];
            const ids = [...bodyIds, ...singleId].filter(Boolean);
            if (!ids.length) {
                return res.status(400).json({ error: 'inventoryId is required.' });
            }
            const priceOffsetCents = Number.isFinite(Number(req.body?.priceOffsetCents))
                ? Number(req.body.priceOffsetCents)
                : 1;
            const concurrency = Math.max(1, Math.min(Number(req.body?.concurrency) || 5, 10));
            const result = await pushInventoryItemsToManaPool(db, ids, { priceOffsetCents, concurrency });
            res.json(result);
        } catch (error) {
            console.error('[manapool] push inventory item error:', error);
            res.status(500).json({ error: error.message || 'Failed pushing inventory item to ManaPool.' });
        }
    });

    router.post('/manapool/inventory/cleanup', async (_req, res) => {
        try {
            const result = await cleanupRemoteInventory(db);
            res.json(result);
        } catch (error) {
            console.error('[manapool] cleanup error:', error);
            res.status(500).json({ error: error.message || 'Failed cleaning up ManaPool inventory.' });
        }
    });

    router.post('/manapool/orders/pull', express.json(), async (req, res) => {
        try {
            const since = req.body?.since || req.query?.since;
            const payload = await pullOrdersFromManaPool({ since });
            const importResult = await importOrdersToTransactions(db, payload.orders || []);
            res.json({
                source: payload.source,
                pulledAt: payload.pulledAt,
                imported: importResult.imported,
                skipped: importResult.skipped,
                errors: importResult.errors,
                unmatchedOrders: importResult.unmatchedOrders,
                shipmentUpdates: importResult.shipmentUpdates || 0,
                totalFetched: (payload.orders || []).length
            });
        } catch (error) {
            console.error('[manapool] orders error:', error);
            res.status(500).json({ error: error.message || 'Failed pulling ManaPool orders.' });
        }
    });

    router.post('/manapool/orders/force-import', express.json(), async (req, res) => {
        try {
            const orderId = req.body?.orderId;
            if (!orderId) {
                return res.status(400).json({ error: 'orderId is required.' });
            }
            const result = await forceImportOrder(db, orderId);
            res.json(result);
        } catch (error) {
            console.error('[manapool] force import error:', error);
            res.status(500).json({ error: error.message || 'Failed to save ManaPool order.' });
        }
    });

    router.post('/manapool/prices/bulk', express.json(), async (req, res) => {
        try {
            const preview = await bulkAdjustPrices(req.body?.strategy, db);
            res.json(preview);
        } catch (error) {
            console.error('[manapool] bulk pricing error:', error);
            res.status(500).json({ error: error.message || 'Failed to generate bulk pricing preview.' });
        }
    });

    router.get('/manapool/prices/automation', async (_req, res) => {
        try {
            const settings = await getAutomationSettings(db);
            res.json({ settings });
        } catch (error) {
            console.error('[manapool] automation fetch error:', error);
            res.status(500).json({ error: error.message || 'Failed to load automation settings.' });
        }
    });

    router.post('/manapool/prices/automation', express.json(), async (req, res) => {
        try {
            const result = await applyAutomationSettingsUpdate(req.body || {}, { db, reason: req.body?.reason });
            res.json({ settings: result.settings });
        } catch (error) {
            console.error('[manapool] automation save error:', error);
            res.status(500).json({ error: error.message || 'Failed to save automation settings.' });
        }
    });

    router.get('/manapool/prices/automation/debug', async (req, res) => {
        try {
            const limit = Math.min(Math.max(parseInt(req.query?.limit, 10) || 100, 1), 500);
            const settings = await getAutomationSettings(db);
            const concurrency = Math.max(1, Math.min(parseInt(req.query?.concurrency, 10) || 5, 10));
            const automationContext = await buildAutomationPayload(settings, { concurrency });
            if (!automationContext) {
                return res.status(400).json({ error: 'Automation context not ready yet.' });
            }
            const rows = await getLocalInventoryRows(db);
            const activeRows = rows.filter(row => Number(row.quantity) > 0).slice(0, limit);
            const entries = [];
            await simulateAutomationForItems(activeRows, automationContext, { debugCollector: entries });
            const formatted = entries.map((entry) => ({
                ...entry,
                ourPrice: entry.ourPriceCents != null ? entry.ourPriceCents / 100 : null,
                targetPrice: entry.targetPriceCents != null ? entry.targetPriceCents / 100 : null,
                baselinePrice: entry.baselinePriceCents != null ? entry.baselinePriceCents / 100 : null,
                floorAnchor: entry.floorAnchorCents != null ? entry.floorAnchorCents / 100 : null,
                floorStop: entry.floorStopCents != null ? entry.floorStopCents / 100 : null,
                floorSource: entry.floorSource || null,
                competitorPrice: entry.competitorPriceCents != null ? entry.competitorPriceCents / 100 : null
            }));
            res.json({
                inspected: activeRows.length,
                entries: formatted
            });
        } catch (error) {
            console.error('[manapool] automation debug error:', error);
            res.status(500).json({ error: error.message || 'Failed to generate automation debug data.' });
        }
    });

    router.get('/manapool/discrepancies', async (_req, res) => {
        try {
            const discrepancies = await getInventoryDiscrepancies(db);
            res.json(discrepancies);
        } catch (error) {
            console.error('[manapool] discrepancy error:', error);
            res.status(500).json({ error: error.message || 'Failed to load discrepancies.' });
        }
    });

    router.get('/manapool/margins', async (_req, res) => {
        try {
            const data = await getMarginData(db);
            res.json(data);
        } catch (error) {
            console.error('[manapool] margin data error:', error);
            res.status(500).json({ error: error.message || 'Failed to load margin data.' });
        }
    });

    // NEW: PUT endpoint to save scraped prices for an item
    router.put('/inventory/:id/prices', express.json(), (req, res) => {
        const { id } = req.params;
        const { tcgLow, manaPoolLow, tcgLowPlusShipping } = req.body;

        const sql = `UPDATE inventory SET 
                        tcgLow = ?, 
                        manaPoolLow = ?,
                        tcgLowPlusShipping = ?,
                        pricesLastUpdatedAt = CURRENT_TIMESTAMP 
                     WHERE id = ?`;
        
        db.run(sql, [tcgLow, manaPoolLow, tcgLowPlusShipping, id], function(err) {
            if (err) return res.status(400).json({ error: err.message });
            if (this.changes === 0) return res.status(404).json({ message: 'Item not found.'});
            res.status(200).json({ message: 'Prices updated successfully.' });
        });
    });


    // POST a new item to inventory
    router.post('/inventory', express.json(), async (req, res) => {
        // Add 'condition' to the destructured properties
        const { name, setCode, collectorNumber, foilType, pricePaid, quantity, tcgplayerId, condition, scryfallId } = req.body;
        const normalizedFoil = foilType || 'normal';
        const normalizedCondition = (condition || 'NM').toUpperCase();
        const normalizedQty = Math.max(0, Number(quantity) || 0);
        const normalizedPricePaid = Number.isFinite(Number(pricePaid)) ? Number(pricePaid) : 0;
        let tcgMarketPrice = null;
        try {
            tcgMarketPrice = await fetchTcgMarketPriceFromDb(db, { setCode, collectorNumber, foilType: normalizedFoil });
        } catch (error) {
            console.error('[inventory] Failed to fetch tcgMarketPrice:', error.message);
        }
        try {
            const existing = await dbGet(
                `SELECT id, quantity, pricePaid FROM inventory 
                 WHERE setCode = ? AND collectorNumber = ? AND foilType = ? AND condition = ? 
                   AND LOWER(name) = LOWER(?) 
                   AND (scryfallId = ? OR scryfallId IS NULL OR ? IS NULL)
                   AND (tcgplayerId = ? OR tcgplayerId IS NULL OR ? IS NULL)
                 LIMIT 1`,
                [
                    setCode,
                    collectorNumber,
                    normalizedFoil,
                    normalizedCondition,
                    name,
                    scryfallId || null,
                    scryfallId || null,
                    tcgplayerId || null,
                    tcgplayerId || null
                ]
            );

            if (existing) {
                const currentQty = Math.max(0, Number(existing.quantity) || 0);
                const totalQty = currentQty + normalizedQty;
                const weightedCost = (Number(existing.pricePaid) || 0) * currentQty + normalizedPricePaid * normalizedQty;
                const avgPricePaid = totalQty > 0 ? Number((weightedCost / totalQty).toFixed(2)) : 0;
                await new Promise((resolve, reject) => {
                    db.run(
                        `UPDATE inventory SET quantity = ?, pricePaid = ?, tcgMarketPrice = COALESCE(tcgMarketPrice, ?) WHERE id = ?`,
                        [totalQty, avgPricePaid, tcgMarketPrice, existing.id],
                        (err) => (err ? reject(err) : resolve())
                    );
                });
                return res.status(200).json({ id: existing.id, merged: true, quantity: totalQty, pricePaid: avgPricePaid });
            }

            const id = randomUUID();
            const sql = `INSERT INTO inventory (id, name, setCode, collectorNumber, foilType, pricePaid, quantity, tcgplayerId, condition, scryfallId, tcgMarketPrice)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
            const params = [id, name, setCode, collectorNumber, normalizedFoil, normalizedPricePaid, normalizedQty, tcgplayerId, normalizedCondition, scryfallId, tcgMarketPrice];
            db.run(sql, params, function(err) {
                if (err) {
                  console.error("Failed to add inventory item:", err);
                  return res.status(400).json({ error: err.message });
                }
                res.status(201).json({ id });
            });
        } catch (error) {
            console.error('[inventory] add/merge failed:', error);
            res.status(500).json({ error: error.message || 'Failed to add inventory item.' });
        }
    });

    // DELETE an item from inventory
    router.delete('/inventory/:id', (req, res) => {
        const { id } = req.params;
        db.run("DELETE FROM inventory WHERE id = ?", id, function(err) {
            if (err) return res.status(400).json({ error: err.message });
            if (this.changes === 0) return res.status(404).json({ message: 'Item not found.' });
            res.status(200).json({ message: 'Item deleted.' });
        });
    });

    router.get('/transactions', (req, res) => {
        const sql = `
            SELECT 
                t.id, t.soldAt, t.platform, t.shippingCost, t.packagingCost, t.totalSalePrice, t.netProfit, t.packingSlipPath, t.manapoolOrderId, t.isShipped, t.entryType,
                COALESCE((
                    SELECT json_group_array(
                        json_object(
                            'name', i.name, 'setCode', i.setCode, 'condition', i.condition, 
                            'foilType', i.foilType, 'pricePaid', i.pricePaid, 
                            'salePrice', ti.salePrice, 'quantity', ti.quantity 
                        )
                    )
                    FROM transaction_items ti
                    JOIN inventory i ON ti.inventoryId = i.id
                    WHERE ti.transactionId = t.id
                ), '[]') as items
            FROM transactions t
            WHERE EXISTS (SELECT 1 FROM transaction_items ti WHERE ti.transactionId = t.id)
            ORDER BY t.soldAt DESC
        `;
        db.all(sql, [], (err, rows) => {
            if (err) {
                console.error('Error fetching transactions:', err);
                return res.status(500).json({ error: err.message });
            }
            // The JSON function in SQLite returns a string, so we need to parse it
            rows.forEach(row => {
                try {
                    row.items = JSON.parse(row.items);
                } catch (e) {
                    console.error('Failed to parse items JSON for transaction ID:', row.id);
                    row.items = []; // Default to an empty array on failure
                }
                row.isShipped = row.isShipped === null ? 1 : row.isShipped;
                row.isShipped = Boolean(row.isShipped);
            });
            res.json(rows);
        });
    });

    router.get('/transactions/unshipped', (req, res) => {
        const sql = `
            SELECT id, soldAt, manapoolOrderId
            FROM transactions
            WHERE platform = 'ManaPool' 
              AND COALESCE(isShipped, 1) = 0
              AND EXISTS (SELECT 1 FROM transaction_items ti WHERE ti.transactionId = transactions.id)
            ORDER BY soldAt DESC
        `;
        db.all(sql, [], (err, rows) => {
            if (err) {
                console.error('Error fetching unshipped transactions:', err);
                return res.status(500).json({ error: err.message });
            }
            res.json({ count: rows.length, orders: rows });
        });
    });

    router.get('/finances/summary', async (_req, res) => {
        try {
            const summary = await buildFinanceSummary();
            res.json(summary);
        } catch (error) {
            console.error('[finances] summary error:', error);
            res.status(500).json({ error: error.message || 'Failed to load finance summary.' });
        }
    });

    router.get('/finances/expenses', async (req, res) => {
        try {
            const includeCardPurchases = String(req.query?.includeCardPurchases || '').toLowerCase() === 'true';
            const limit = Math.min(Math.max(parseInt(req.query?.limit, 10) || 200, 1), 500);
            const filters = [
                "NOT (LOWER(category) LIKE 'secret lair%')"
            ];
            if (!includeCardPurchases) {
                filters.push("LOWER(category) <> 'card purchase'");
            }
            const whereClause = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
            const sql = `
                SELECT id, description, amount, category, paymentMethod, incurredOn, createdAt, linkedInventoryId, notes
                FROM expense_entries
                ${whereClause}
                ORDER BY datetime(incurredOn) DESC, datetime(createdAt) DESC
                LIMIT ?
            `;
            const rows = await dbAllAsync(sql, [limit]);
            res.json({ expenses: rows.map(mapExpenseRow) });
        } catch (error) {
            console.error('[finances] fetch expenses error:', error);
            res.status(500).json({ error: error.message || 'Failed to load expenses.' });
        }
    });

    router.post('/finances/expenses', express.json(), (req, res) => {
        let payload;
        try {
            payload = normalizeExpensePayload(req.body || {});
        } catch (error) {
            return res.status(400).json({ error: error.message });
        }
        const expenseId = randomUUID();
        const sql = `
            INSERT INTO expense_entries (id, incurredOn, amount, category, description, paymentMethod, linkedInventoryId, notes)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `;
        db.run(sql, [
            expenseId,
            payload.incurredOn,
            payload.amount,
            payload.category,
            payload.description,
            payload.paymentMethod,
            payload.linkedInventoryId,
            payload.notes
        ], function(err) {
            if (err) {
                console.error('[finances] create expense error:', err);
                return res.status(500).json({ error: err.message || 'Failed to save expense.' });
            }
            res.status(201).json({
                id: expenseId,
                createdAt: new Date().toISOString(),
                ...payload
            });
        });
    });

    router.put('/finances/expenses/:id', express.json(), async (req, res) => {
        const { id } = req.params;
        let payload;
        try {
            payload = normalizeExpensePayload(req.body || {});
        } catch (error) {
            return res.status(400).json({ error: error.message });
        }
        const sql = `
            UPDATE expense_entries
            SET incurredOn = ?, amount = ?, category = ?, description = ?, paymentMethod = ?, linkedInventoryId = ?, notes = ?
            WHERE id = ?
        `;
        db.run(sql, [
            payload.incurredOn,
            payload.amount,
            payload.category,
            payload.description,
            payload.paymentMethod,
            payload.linkedInventoryId,
            payload.notes,
            id
        ], function(err) {
            if (err) {
                console.error('[finances] update expense error:', err);
                return res.status(500).json({ error: err.message || 'Failed to update expense.' });
            }
            if (this.changes === 0) {
                return res.status(404).json({ error: 'Expense entry not found.' });
            }
            res.json({ id, ...payload });
        });
    });

    router.delete('/finances/expenses/:id', (req, res) => {
        const { id } = req.params;
        db.get('SELECT linkedInventoryId FROM expense_entries WHERE id = ?', [id], (fetchErr, expense) => {
            if (fetchErr) {
                console.error('[finances] delete expense fetch error:', fetchErr);
                return res.status(500).json({ error: fetchErr.message || 'Failed to load expense.' });
            }
            if (!expense) {
                return res.status(404).json({ error: 'Expense entry not found.' });
            }

            const finalize = (inventoryDeleted = false, inventoryReason = null) => {
                db.run('DELETE FROM expense_entries WHERE id = ?', [id], function(err) {
                    if (err) {
                        console.error('[finances] delete expense error:', err);
                        return res.status(500).json({ error: err.message || 'Failed to delete expense.' });
                    }
                    if (this.changes === 0) {
                        return res.status(404).json({ error: 'Expense entry not found.' });
                    }
                    res.json({
                        message: 'Expense deleted.',
                        inventoryDeleted,
                        inventoryReason,
                    });
                });
            };

            const linkedInventoryId = expense.linkedInventoryId;
            if (!linkedInventoryId) {
                return finalize(false, 'no_inventory_linked');
            }

            db.get('SELECT COUNT(*) AS usageCount FROM transaction_items WHERE inventoryId = ?', [linkedInventoryId], (usageErr, usageRow) => {
                if (usageErr) {
                    console.error('[finances] inventory usage check error:', usageErr);
                    return res.status(500).json({ error: usageErr.message || 'Failed to check inventory usage.' });
                }
                if ((usageRow?.usageCount || 0) > 0) {
                    return finalize(false, 'inventory_in_use');
                }
                db.run('DELETE FROM inventory WHERE id = ?', [linkedInventoryId], function(invErr) {
                    if (invErr) {
                        console.error('[finances] delete linked inventory error:', invErr);
                        return res.status(500).json({ error: invErr.message || 'Failed to delete linked inventory.' });
                    }
                    const inventoryDeleted = this.changes > 0;
                    const inventoryReason = inventoryDeleted ? null : 'inventory_not_found';
                    finalize(inventoryDeleted, inventoryReason);
                });
            });
        });
    });

    router.get('/finances/snapshots', async (req, res) => {
        try {
            const limit = Math.min(Math.max(parseInt(req.query?.limit, 10) || 30, 1), 180);
            const rows = await dbAllAsync(`
                SELECT id, capturedAt, totalValue, inventoryCount, costBasis, notes
                FROM inventory_snapshots
                ORDER BY datetime(capturedAt) DESC
                LIMIT ?
            `, [limit]);
            res.json({ snapshots: rows });
        } catch (error) {
            console.error('[finances] snapshots error:', error);
            res.status(500).json({ error: error.message || 'Failed to load snapshots.' });
        }
    });

    router.post('/finances/snapshots', express.json(), async (req, res) => {
        try {
            const snapshot = await captureInventorySnapshot(req.body?.notes || null);
            res.status(201).json(snapshot);
        } catch (error) {
            console.error('[finances] snapshot capture error:', error);
            res.status(500).json({ error: error.message || 'Failed to capture snapshot.' });
        }
    });


    /**
     * UPDATED: POST a new transaction with quantities and new profit logic.
     */
    router.post('/transactions', express.json(), (req, res) => {
        const { items, platform, shippingMaterialsCost } = req.body;

        if (!items || !Array.isArray(items) || items.length === 0) {
            return res.status(400).json({ error: 'Transaction must include at least one item.' });
        }

        const shippingMaterialsValue = Number(shippingMaterialsCost);
        const normalizedShippingMaterialsCost = Number.isFinite(shippingMaterialsValue) && shippingMaterialsValue > 0
            ? Number(shippingMaterialsValue.toFixed(2))
            : 0;

        // We begin the transaction here, and every subsequent step is nested
        // in a callback to guarantee sequential execution.
        db.run("BEGIN TRANSACTION", function(err) {
            if (err) return res.status(500).json({ error: `Failed to begin transaction: ${err.message}` });

            const itemIds = items.map(i => i.inventoryId);
            const placeholders = itemIds.map(() => '?').join(',');
            const priceQuery = `SELECT id, pricePaid, quantity FROM inventory WHERE id IN (${placeholders})`;

            db.all(priceQuery, itemIds, (err, rows) => {
                if (err) {
                    db.run("ROLLBACK");
                    return res.status(500).json({ error: `Failed to query inventory: ${err.message}` });
                }

                const dbInventoryMap = new Map(rows.map(row => [row.id, { pricePaid: row.pricePaid, quantity: row.quantity }]));
                let totalSalePrice = 0, totalPurchasePrice = 0;

                for (const item of items) {
                    const dbItem = dbInventoryMap.get(item.inventoryId);
                    if (!dbItem || item.quantity > dbItem.quantity) {
                        db.run("ROLLBACK");
                        return res.status(400).json({ error: `Not enough stock for an item.` });
                    }
                    totalSalePrice += item.salePrice * item.quantity;
                    totalPurchasePrice += dbItem.pricePaid * item.quantity;
                }

                const shippingPaid = 0; // shipping is no longer recorded as customer-paid revenue
                const fees = calculateFees(totalSalePrice, platform);
                const grossRevenue = totalSalePrice + shippingPaid;
                const parsedPackaging = 0;
                const totalCost = totalPurchasePrice + fees;
                const netProfit = grossRevenue - totalCost;
                const transactionId = randomUUID();
                const shippingExpenseEntries = [];
                const incurredOn = new Date().toISOString();
                if (platform === 'ManaPool' && totalSalePrice > MANAPOOL_AUTO_SHIPPING_THRESHOLD) {
                    shippingExpenseEntries.push({
                        amount: MANAPOOL_AUTO_SHIPPING_AMOUNT,
                        category: SHIPPING_EXPENSE_CATEGORIES.POSTAGE,
                        description: `ManaPool shipping for transaction ${transactionId}`,
                        paymentMethod: 'Auto',
                        notes: `Auto-added because sale exceeded $${MANAPOOL_AUTO_SHIPPING_THRESHOLD}.`,
                        incurredOn,
                    });
                }
                if (normalizedShippingMaterialsCost > 0) {
                    shippingExpenseEntries.push({
                        amount: normalizedShippingMaterialsCost,
                        category: SHIPPING_EXPENSE_CATEGORIES.POSTAGE,
                        description: `Shipping label/postage for transaction ${transactionId}`,
                        paymentMethod: 'Postage',
                        notes: 'Logged from manual transaction entry.',
                        incurredOn,
                    });
                }

                const transSql = `INSERT INTO transactions (id, platform, shippingCost, packagingCost, totalSalePrice, netProfit, isShipped, entryType) VALUES (?, ?, ?, ?, ?, ?, 1, ?)`;
                db.run(transSql, [transactionId, platform, shippingPaid, parsedPackaging, totalSalePrice, netProfit, 'sale'], function(err) {
                    if (err) {
                        db.run("ROLLBACK");
                        return res.status(500).json({ error: `Failed to create transaction record: ${err.message}` });
                    }

                    // This function will process each item one by one.
                    function finalizeTransaction() {
                        db.run("COMMIT", (err) => {
                            if (err) {
                                db.run("ROLLBACK");
                                return res.status(500).json({ error: `Failed to commit transaction: ${err.message}` });
                            }
                            return res.status(201).json({ id: transactionId });
                        });
                    }

                    function persistShippingExpenses() {
                        if (!shippingExpenseEntries.length) {
                            finalizeTransaction();
                            return;
                        }
                        const saveNext = (index) => {
                            if (index >= shippingExpenseEntries.length) {
                                finalizeTransaction();
                                return;
                            }
                            recordShippingExpense(db, shippingExpenseEntries[index])
                                .then(() => saveNext(index + 1))
                                .catch((error) => {
                                    console.error('[transactions] shipping expense insert failed:', error);
                                    db.run("ROLLBACK");
                                    res.status(500).json({ error: error.message || 'Failed to save shipping expense.' });
                                });
                        };
                        saveNext(0);
                    }

                    function processItems(index) {
                        if (index >= items.length) {
                            persistShippingExpenses();
                            return;
                        }

                        const item = items[index];
                        const itemSql = `INSERT INTO transaction_items (transactionId, inventoryId, salePrice, quantity) VALUES (?, ?, ?, ?)`;
                        db.run(itemSql, [transactionId, item.inventoryId, item.salePrice, item.quantity], function(err) {
                            if (err) {
                                db.run("ROLLBACK");
                                return res.status(500).json({ error: `Failed to log transaction item: ${err.message}` });
                            }
                            
                            const invSql = `UPDATE inventory SET quantity = quantity - ? WHERE id = ?`;
                            db.run(invSql, [item.quantity, item.inventoryId], function(err) {
                                if (err) {
                                    db.run("ROLLBACK");
                                    return res.status(500).json({ error: `Failed to update inventory: ${err.message}` });
                                }
                                // Process the next item in the list.
                                processItems(index + 1);
                            });
                        });
                    }

                    // Start processing with the first item (index 0).
                    processItems(0);
                });
            });
        });
    });

    /**
     * UPDATED: DELETE a transaction and restore the correct inventory quantity.
     */
    router.delete('/transactions/:id', (req, res) => {
        const { id } = req.params;
        db.serialize(() => {
            db.run("BEGIN TRANSACTION");

            db.get("SELECT id, packingSlipPath FROM transactions WHERE id = ?", [id], (txnErr, txnRow) => {
                if (txnErr) { db.run("ROLLBACK"); return res.status(500).json({ error: txnErr.message }); }
                if (!txnRow) { db.run("ROLLBACK"); return res.status(404).json({ message: "Transaction not found." }); }

                db.all("SELECT inventoryId, quantity FROM transaction_items WHERE transactionId = ?", [id], (itemsErr, items) => {
                    if (itemsErr) { db.run("ROLLBACK"); return res.status(500).json({ error: itemsErr.message }); }

                    if (items.length) {
                        const invSql = `UPDATE inventory SET quantity = quantity + ? WHERE id = ?`;
                        const invStmt = db.prepare(invSql);
                        for (const item of items) {
                            invStmt.run(item.quantity, item.inventoryId);
                        }
                        invStmt.finalize();
                    }

                    db.run("DELETE FROM transaction_items WHERE transactionId = ?", [id], (delItemsErr) => {
                        if (delItemsErr) { db.run("ROLLBACK"); return res.status(500).json({ error: delItemsErr.message }); }

                        db.run("DELETE FROM transactions WHERE id = ?", [id], (delTxnErr) => {
                            if (delTxnErr) { db.run("ROLLBACK"); return res.status(500).json({ error: delTxnErr.message }); }

                            const slipPath = txnRow.packingSlipPath;
                            if (slipPath) {
                                const resolvedSlip = path.resolve(slipPath);
                                if (resolvedSlip.startsWith(uploadRoot)) {
                                    fs.unlink(resolvedSlip, (unlinkErr) => {
                                        if (unlinkErr) console.error("Failed to delete packing slip file:", unlinkErr);
                                    });
                                } else {
                                    console.warn('[transactions] Skipped deleting packing slip outside upload directory:', resolvedSlip);
                                }
                            }

                            db.run("COMMIT", (commitErr) => {
                                if (commitErr) {
                                    db.run("ROLLBACK");
                                    return res.status(500).json({ error: commitErr.message });
                                }
                                res.status(200).json({ message: "Transaction deleted and inventory restored." });
                            });
                        });
                    });
                });
            });
        });
    });

    /**
     * NEW: Endpoint for uploading a packing slip after a transaction is created.
     */
    // router.post('/transactions/:id/packing-slip', (req, res) => {
    //     const singleUpload = pdfUpload.single('packingSlip');

    //     singleUpload(req, res, function(err) {
    //         // --- This block catches all upload-related errors ---
    //         if (err instanceof multer.MulterError) {
    //             // A Multer error occurred (e.g., file too large).
    //             console.error('[ERROR] Multer error:', err);
    //             return res.status(400).json({ message: `File upload error: ${err.message}` });
    //         } else if (err) {
    //             // A custom error occurred (e.g., our "not a PDF" error).
    //             console.error('[ERROR] Custom upload error:', err);
    //             return res.status(400).json({ message: err.message });
    //         }
    //         // --- End of error handling ---

    //         // If we get here, the upload was successful.
    //         const { id } = req.params;
    //         const packingSlipPath = req.file ? req.file.path : null;

    //         if (!packingSlipPath) {
    //             return res.status(400).json({ message: 'No file was uploaded or it was rejected.' });
    //         }

    //         const sql = `UPDATE transactions SET packingSlipPath = ? WHERE id = ?`;
    //         db.run(sql, [packingSlipPath, id], function(dbErr) {
    //             if (dbErr) return res.status(500).json({ message: dbErr.message });
    //             if (this.changes === 0) return res.status(404).json({ message: 'Transaction not found.' });
    //             res.status(200).json({ message: 'Packing slip uploaded successfully.' });
    //         });
    //     });
    // });


    // --- Endpoint to create a new, temporary list from a CSV ---
    router.post('/import-csv', csvUpload.single('cardList'), (req, res) => {
        if (!req.file) return res.status(400).json({ message: 'No file uploaded.' });

        const results = [];
        const fileContent = req.file.buffer.toString('utf8');
        
        // --- NEW: File type detection and parsing logic ---
        if (req.file.originalname.toLowerCase().endsWith('.txt')) {
            const lines = fileContent.split(/\r?\n/);
            // Regex to capture: 1. Quantity, 2. Name, 3. Set Code, 4. Collector #, 5. Foil type (optional)
            const lineRegex = /^(\d+)\s+(.+?)\s+\((\w+)\)\s+([\w\d]+)\s*(?:\*([FE])\*)?$/;

            for (const line of lines) {
                const match = line.trim().match(lineRegex);
                if (match) {
                    let foilType = 'normal';
                    if (match[5] === 'F') foilType = 'foil';
                    if (match[5] === 'E') foilType = 'etched';

                    results.push({
                        quantity: parseInt(match[1], 10),
                        name: match[2].trim(),
                        setCode: match[3].toUpperCase(),
                        collectorNumber: match[4],
                        foilType: foilType,
                    });
                }
            }
        } else { // Assume CSV otherwise
            const stream = Readable.from(fileContent);
            stream.pipe(csv())
                .on('data', (row) => {
                    let foilType = (row['Foil'] || 'normal').toLowerCase();
                    if (!['normal', 'foil', 'etched'].includes(foilType)) foilType = 'normal';
                    results.push({
                        name: row['Name'], setCode: row['Set code'], collectorNumber: row['Collector number'],
                        foilType: foilType, quantity: parseInt(row['Quantity'], 10) || 1,
                    });
                })
                .on('end', () => processResults(results, res, db));
            return; // Return early since CSV parsing is async
        }
        
        processResults(results, res, db);
    });

    // Helper function to process parsed results and save to DB
    const processResults = (results, res, db) => {
        if (results.length === 0) {
            return res.status(400).json({ message: 'File is empty or in an invalid format.' });
        }
        const listId = randomUUID();
        const content = JSON.stringify(results);
        const sql = `
            INSERT INTO imported_lists (id, content, isPermanent, updatedAt, lastAccessedAt)
            VALUES (?, ?, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        `;
        db.run(sql, [listId, content], (err) => {
            if (err) return res.status(500).json({ message: 'Failed to save card list.' });
            res.status(200).json({ listId: listId });
        });
    };

    
    // --- Combined route for handling a specific list ---
    router.route('/list/:listId')
        // GET: Fetches the list content for the frontend
        .get((req, res) => {
            const { listId } = req.params;
            const sql = `
                SELECT content, isPermanent, name, buylistSnapshot, createdAt, updatedAt, lastAccessedAt
                FROM imported_lists
                WHERE id = ?
            `;

            db.get(sql, [listId], (err, row) => {
                if (err) return res.status(500).json({ message: 'Database error.' });
                if (!row) return res.status(404).json({ message: 'List not found.' });

                let parsedContent = [];
                try {
                    parsedContent = JSON.parse(row.content) || [];
                } catch {
                    parsedContent = [];
                }

                let parsedBuylist = null;
                if (row.buylistSnapshot) {
                    try {
                        parsedBuylist = JSON.parse(row.buylistSnapshot);
                    } catch (parseErr) {
                        console.warn(`[lists] Failed to parse buylist snapshot for ${listId}:`, parseErr.message);
                    }
                }

                res.json({
                    content: parsedContent,
                    isPermanent: !!row.isPermanent,
                    name: row.name || null,
                    buylistSnapshot: parsedBuylist,
                    createdAt: row.createdAt || null,
                    updatedAt: row.updatedAt || null,
                    lastAccessedAt: row.lastAccessedAt || null
                });

                db.run(
                    `UPDATE imported_lists SET lastAccessedAt = CURRENT_TIMESTAMP WHERE id = ?`,
                    [listId],
                    (updateErr) => {
                        if (updateErr) {
                            console.error(`[lists] Failed to stamp lastAccessedAt for ${listId}:`, updateErr.message);
                        }
                    }
                );
            });
        });

    // --- Endpoint to permanently save a list ---
    router.post('/list/:listId/save', express.json(), (req, res) => {
        const { listId } = req.params;
        const { name } = req.body || {};
        const normalizedName = typeof name === 'string' ? name.trim() : '';
        const finalName = normalizedName.length > 0 ? normalizedName : null;

        const sql = `
            UPDATE imported_lists
            SET isPermanent = 1,
                name = ?,
                updatedAt = CURRENT_TIMESTAMP,
                lastAccessedAt = CURRENT_TIMESTAMP
            WHERE id = ?
        `;

        db.run(sql, [finalName, listId], function(err) {
            if (err) return res.status(500).json({ message: 'Database error.' });
            if (this.changes === 0) return res.status(404).json({ message: 'List not found.' });

            res.status(200).json({
                message: 'List permanently saved.',
                name: finalName
            });
            log(`[lists] List ${listId} has been permanently saved.`);
        });
    });

    // --- Endpoint to rename/update list metadata ---
    router.put('/list/:listId/name', express.json(), (req, res) => {
        const { listId } = req.params;
        const { name } = req.body || {};
        const normalizedName = typeof name === 'string' ? name.trim() : '';
        const finalName = normalizedName.length > 0 ? normalizedName : null;

        const sql = `
            UPDATE imported_lists
            SET name = ?,
                updatedAt = CURRENT_TIMESTAMP,
                lastAccessedAt = CURRENT_TIMESTAMP
            WHERE id = ?
        `;

        db.run(sql, [finalName, listId], function(err) {
            if (err) return res.status(500).json({ message: 'Database error.' });
            if (this.changes === 0) return res.status(404).json({ message: 'List not found.' });

            res.status(200).json({
                message: 'List name updated.',
                name: finalName
            });
        });
    });

    router.put('/inventory/:id/details', express.json(), (req, res) => {
        const { id } = req.params;
        let { condition, foilType, pricePaid } = req.body || {};

        const validConditions = ['NM', 'M', 'LP', 'MP', 'HP', 'DMG'];
        condition = typeof condition === 'string' ? condition.toUpperCase() : 'NM';
        if (!validConditions.includes(condition)) {
            return res.status(400).json({ error: 'Invalid condition provided.' });
        }

        const allowedFoils = ['normal', 'foil', 'etched', 'glossy'];
        foilType = typeof foilType === 'string' ? foilType : 'normal';
        if (!allowedFoils.includes(foilType)) {
            foilType = 'normal';
        }

        pricePaid = Number(pricePaid);
        if (!Number.isFinite(pricePaid) || pricePaid < 0) {
            return res.status(400).json({ error: 'Invalid purchase price.' });
        }

        const sql = `UPDATE inventory SET condition = ?, foilType = ?, pricePaid = ? WHERE id = ?`;
        db.run(sql, [condition, foilType, pricePaid, id], function(err) {
            if (err) return res.status(400).json({ error: err.message });
            if (this.changes === 0) return res.status(404).json({ message: 'Item not found.' });
            res.status(200).json({ message: 'Inventory item updated.', condition, foilType, pricePaid });
        });
    });

    // --- Endpoint to delete a list entirely ---
    router.delete('/list/:listId', (req, res) => {
        const { listId } = req.params;
        const sql = `DELETE FROM imported_lists WHERE id = ?`;

        db.run(sql, [listId], function(err) {
            if (err) return res.status(500).json({ message: 'Database error.' });
            if (this.changes === 0) return res.status(404).json({ message: 'List not found.' });
            res.status(204).send();
        });
    });

    // --- Endpoint to store a buylist snapshot for a list ---
    router.post('/list/:listId/buylist-snapshot', express.json(), (req, res) => {
        const { listId } = req.params;
        const payload = {
            savedAt: new Date().toISOString(),
            ...req.body
        };

        let serialized;
        try {
            serialized = JSON.stringify(payload);
        } catch (err) {
            return res.status(400).json({ message: 'Snapshot payload could not be serialized.' });
        }

        const sql = `
            UPDATE imported_lists
            SET buylistSnapshot = ?,
                updatedAt = CURRENT_TIMESTAMP,
                lastAccessedAt = CURRENT_TIMESTAMP
            WHERE id = ?
        `;

      db.run(sql, [serialized, listId], function(err) {
          if (err) return res.status(500).json({ message: 'Database error.' });
          if (this.changes === 0) return res.status(404).json({ message: 'List not found.' });

          res.status(200).json({ message: 'Buylist snapshot saved.' });
      });
  });

    router.get('/inventory/buylist-snapshot', (req, res) => {
        const sql = "SELECT buylistSnapshot FROM inventory_metadata WHERE id = 'inventory'";
        db.get(sql, [], (err, row) => {
            if (err) return res.status(500).json({ message: 'Database error.' });
            if (!row || !row.buylistSnapshot) return res.json({ snapshot: null });
            try {
                const parsed = JSON.parse(row.buylistSnapshot);
                return res.json({ snapshot: parsed });
            } catch (parseError) {
                console.error('Failed to parse inventory buylist snapshot:', parseError.message);
                return res.status(500).json({ message: 'Stored snapshot is invalid JSON.' });
            }
        });
    });

    router.post('/inventory/buylist-snapshot', express.json(), (req, res) => {
        const payload = {
            savedAt: new Date().toISOString(),
            ...req.body
        };

        let serialized;
        try {
            serialized = JSON.stringify(payload);
        } catch (err) {
            return res.status(400).json({ message: 'Snapshot payload could not be serialized.' });
        }

        const sql = `
            INSERT INTO inventory_metadata (id, buylistSnapshot, updatedAt)
            VALUES ('inventory', ?, CURRENT_TIMESTAMP)
            ON CONFLICT(id) DO UPDATE SET
                buylistSnapshot = excluded.buylistSnapshot,
                updatedAt = CURRENT_TIMESTAMP
        `;

        db.run(sql, [serialized], function(err) {
            if (err) return res.status(500).json({ message: 'Database error.' });
            res.status(200).json({ message: 'Inventory buylist snapshot saved.' });
        });
    });

    router.get('/buylist/report', async (_req, res) => {
        try {
            const report = await getStoredBuylistReport();
            const needsRefresh = !report || !Array.isArray(report.allDeals);
            if (!needsRefresh) {
                return res.json(report);
            }
            const refreshed = await refreshBuylistReport(db);
            res.json(refreshed);
        } catch (error) {
            console.error('[buylist] report error:', error);
            res.status(500).json({ error: error.message || 'Failed to load buylist report.' });
        }
    });

    router.post('/buylist/report/refresh', async (_req, res) => {
        try {
            // Snapshot will be refreshed inside the beforeBuild hook; avoid double runs.
            const report = await refreshBuylistReport(db);
            res.json(report);
        } catch (error) {
            console.error('[buylist] refresh error:', error);
            res.status(500).json({ error: error.message || 'Failed to refresh buylist report.' });
        }
    });

    router.get('/buylist/report/status', (_req, res) => {
        try {
            res.json(getBuylistProgress());
        } catch (error) {
            res.status(500).json({ error: error.message || 'Failed to load buylist status.' });
        }
    });

    // --- Endpoint to browse/search lists ---
    router.get('/lists', (req, res) => {
        const { search = '', sort = 'recent', limit = '10' } = req.query;
        const trimmedSearch = typeof search === 'string' ? search.trim() : '';
        const limitNumber = Math.min(Math.max(parseInt(limit, 10) || 10, 1), 100);

        const params = [];
        const whereParts = [];

        if (trimmedSearch) {
            const likeTerm = `%${trimmedSearch}%`;
            whereParts.push(`(COALESCE(name, '') LIKE ? OR id LIKE ?)`);
            params.push(likeTerm, likeTerm);
        }

        const whereClause = whereParts.length ? `WHERE ${whereParts.join(' AND ')}` : '';

        let orderClause = 'ORDER BY COALESCE(lastAccessedAt, updatedAt, createdAt) DESC';
        switch ((sort || '').toLowerCase()) {
            case 'name':
                orderClause = `
                    ORDER BY
                        CASE WHEN name IS NULL OR TRIM(name) = '' THEN 1 ELSE 0 END,
                        LOWER(name),
                        id
                `;
                break;
            case 'created':
                orderClause = 'ORDER BY createdAt DESC';
                break;
            case 'updated':
                orderClause = 'ORDER BY COALESCE(updatedAt, createdAt) DESC';
                break;
            case 'recent':
            default:
                orderClause = 'ORDER BY COALESCE(lastAccessedAt, updatedAt, createdAt) DESC';
                break;
        }

        const sql = `
            SELECT id, name, isPermanent, createdAt, updatedAt, lastAccessedAt
            FROM imported_lists
            ${whereClause}
            ${orderClause}
            LIMIT ?
        `;

        params.push(limitNumber);

        db.all(sql, params, (err, rows) => {
            if (err) return res.status(500).json({ message: 'Database error.' });

            const payload = rows.map((row) => ({
                id: row.id,
                name: row.name || null,
                isPermanent: !!row.isPermanent,
                createdAt: row.createdAt || null,
                updatedAt: row.updatedAt || null,
                lastAccessedAt: row.lastAccessedAt || null
            }));

            res.json({ lists: payload });
        });
    });

    router.get('/card/details/:setCode/:collectorNumber', (req, res) => {
        const { setCode, collectorNumber } = req.params;

        // Step 1: Get the primary card data. This also gives us the UUID for other lookups.
        const cardSql = `SELECT * FROM cards WHERE setCode = ? AND number = ?`;
        db.get(cardSql, [setCode.toUpperCase(), collectorNumber], (err, cardRow) => {
            if (err) return res.status(500).json({ error: "Database error on initial card lookup.", details: err.message });
            if (!cardRow) return res.status(404).json({ error: 'Card not found in the database.' });

            const { uuid } = cardRow;
            let combinedData = {}; // This object will hold all our final data.

            // We have 4 additional queries to run. We'll run them in parallel.
            const totalQueries = 4;
            let queriesCompleted = 0;

            // This function will be called after each parallel query finishes.
            // When all are done, it sends the final combined response.
            const checkCompletion = () => {
                queriesCompleted++;
                if (queriesCompleted === totalQueries) {
                    res.json(combinedData);
                }
            };

            // --- Start Parallel Queries ---

            // Query 2: Get Price History
            const priceSql = `SELECT price_json FROM price_history WHERE uuid = ?`;
            db.get(priceSql, [uuid], (priceErr, priceRow) => {
                if (priceErr) console.error("Error fetching price data:", priceErr.message);
                try {
                    // We add the parsed price data, or null if it doesn't exist.
                    combinedData.prices = priceRow ? JSON.parse(priceRow.price_json) : null;
                } catch (parseError) {
                    console.error("Error parsing price JSON:", parseError.message);
                    combinedData.prices = { error: 'Failed to parse price data.' };
                }
                checkCompletion();
            });

            // Query 3: Get Card Identifiers
            const identifiersSql = `SELECT * FROM cardIdentifiers WHERE uuid = ?`;
            db.get(identifiersSql, [uuid], (identifiersErr, identifiersRow) => {
                if (identifiersErr) console.error("Error fetching identifiers:", identifiersErr.message);
                combinedData.identifiers = identifiersRow || null;
                checkCompletion();
            });

            // Query 4: Get Purchase URLs
            const purchaseUrlsSql = `SELECT * FROM cardPurchaseUrls WHERE uuid = ?`;
            db.get(purchaseUrlsSql, [uuid], (purchaseUrlsErr, purchaseUrlsRow) => {
                if (purchaseUrlsErr) console.error("Error fetching purchase URLs:", purchaseUrlsErr.message);
                combinedData.purchaseUrls = purchaseUrlsRow || null;
                checkCompletion();
            });

            // Query 5: Get Set Information
            const setSql = `SELECT * FROM sets WHERE code = ?`;
            db.get(setSql, [setCode.toUpperCase()], (setErr, setRow) => {
                if (setErr) console.error("Error fetching set data:", setErr.message);
                combinedData.set = setRow || null;
                // The main `cardRow` data is added last to ensure it's present.
                combinedData.card = cardRow; 
                checkCompletion();
            });
        });
    });


    // --- Other utility routes ---
    router.get('/card-names', (req, res) => res.json(getCardNames()));

    router.get('/cards/search', async (req, res) => {
        const query = (req.query.q || '').trim();
        const limitParam = parseInt(req.query.limit, 10);
        const limit = Number.isFinite(limitParam) ? Math.min(Math.max(limitParam, 1), 15) : 8;

        if (query.length < 2) {
            return res.json([]);
        }

        try {
            const response = await axios.get('https://api.scryfall.com/cards/search', {
                params: {
                    q: query,
                    unique: 'cards',
                    order: 'released',
                    include_extras: false,
                    include_variations: false,
                }
            });

            const cards = Array.isArray(response.data?.data) ? response.data.data.slice(0, limit) : [];

            const suggestions = cards.map(card => {
                const primaryFace = Array.isArray(card.card_faces) && card.card_faces.length > 0
                    ? card.card_faces[0]
                    : null;
                const imageSmall = card.image_uris?.small || primaryFace?.image_uris?.small || null;
                const imageNormal = card.image_uris?.normal || primaryFace?.image_uris?.normal || null;

                return {
                    id: card.id,
                    name: card.name,
                    set: card.set,
                    set_name: card.set_name,
                    collector_number: card.collector_number,
                    image_small: imageSmall,
                    image_normal: imageNormal,
                    finishes: card.finishes || [],
                    tcgplayer_id: card.tcgplayer_id || null,
                };
            });

            res.json(suggestions);
        } catch (error) {
            if (error.response?.status === 404) {
                return res.json([]);
            }
            console.error('Card search failed:', error.message);
            res.status(502).json({ error: 'Failed to search cards.' });
        }
    });

    router.get('/cards/price-basis', async (req, res) => {
        const scryfallId = (req.query.scryfallId || '').trim();
        const finish = normalizeFinish(req.query.finish || 'normal');
        if (!scryfallId) {
            return res.status(400).json({ error: 'scryfallId is required.' });
        }
        try {
            const inventoryLow = await fetchInventoryLowByScryfall(scryfallId);
            if (Number.isFinite(inventoryLow) && inventoryLow > 0) {
                return res.json({ tcgLow: inventoryLow, source: 'inventory' });
            }
            const uuid = await findUuidByScryfallId(scryfallId);
            const priceJson = uuid ? await fetchPriceHistoryByUuid(uuid) : null;
            if (priceJson) {
                const referencePrice = extractRetailPrice(priceJson, finish) ?? extractRetailPrice(priceJson, 'normal');
                if (Number.isFinite(referencePrice)) {
                    return res.json({ tcgLow: referencePrice, source: 'price_history' });
                }
            }
            res.json({ tcgLow: null, source: 'unavailable' });
        } catch (error) {
            console.error('[cards] price basis error:', error);
            res.status(500).json({ error: 'Failed to load pricing reference.' });
        }
    });

    router.get('/printings/:cardName', async (req, res) => {
        try {
            const cardName = req.params.cardName;
            const url = `https://api.scryfall.com/cards/search?q=!%22${encodeURIComponent(cardName)}%22&unique=prints&order=released`;
            const response = await axios.get(url);
            res.json(response.data.data);
        } catch (error) {
            res.status(404).json({ error: "Could not find printings on Scryfall." });
        }
    });

    /**
     * NEW: PUT endpoint to update the quantity of a specific inventory item.
     */
    router.put('/inventory/:id/quantity', express.json(), (req, res) => {
        const { id } = req.params;
        const { quantity } = req.body;

        if (typeof quantity !== 'number' || quantity < 0) {
            return res.status(400).json({ error: 'Invalid quantity provided.' });
        }

        const sql = `UPDATE inventory SET quantity = ? WHERE id = ?`;
        
        db.run(sql, [quantity, id], function(err) {
            if (err) return res.status(400).json({ error: err.message });
            if (this.changes === 0) return res.status(404).json({ message: 'Item not found.'});
            res.status(200).json({ message: 'Quantity updated successfully.' });
        });
    });


    router.post('/lists/create', (req, res) => {
        const listId = randomUUID();
        const emptyContent = JSON.stringify([]); // An empty array of cards

        // Insert the new list as permanent (isPermanent = 1)
        const sql = `
            INSERT INTO imported_lists (id, content, isPermanent, updatedAt, lastAccessedAt)
            VALUES (?, ?, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        `;
        db.run(sql, [listId, emptyContent], (err) => {
            if (err) {
                console.error("Failed to create new list:", err);
                return res.status(500).json({ message: 'Failed to create new list.' });
            }
            // Return the new ID so the frontend can redirect
            res.status(201).json({ listId: listId });
        });
    });
    
    router.post('/list/:listId/add', express.json(), (req, res) => {
        const { listId } = req.params;
        const { name, setCode, collectorNumber, foilType, quantity } = req.body;

        // 1. First, get the current list content
        const getSql = `SELECT content FROM imported_lists WHERE id = ?`;
        db.get(getSql, [listId], (err, row) => {
            if (err || !row) return res.status(404).json({ message: 'List not found.' });
            
            let content = [];
            try {
                content = JSON.parse(row.content) || [];
            } catch {
                content = [];
            }
            
            // 2. Add the new card to the content array
            content.push({ name, setCode, collectorNumber, foilType, quantity });
            
            // 3. Update the database with the new content
            const newContentJson = JSON.stringify(content);
            const updateSql = `
                UPDATE imported_lists
                SET content = ?,
                    updatedAt = CURRENT_TIMESTAMP,
                    lastAccessedAt = CURRENT_TIMESTAMP
                WHERE id = ?
            `;
            db.run(updateSql, [newContentJson, listId], function(err) {
                if (err) return res.status(500).json({ message: 'Failed to update list.' });
                res.status(200).json({ message: 'Card added successfully.' });
            });
        });
    });
    // --- Endpoint to handle pasted text ---
    router.post('/import-text', express.text(), (req, res) => {
        const results = [];
        const fileContent = req.body;
        if (!fileContent) {
            return res.status(400).json({ message: 'No text was provided.' });
        }

        const lines = fileContent.split(/\r?\n/);
        const lineRegex = /^(\d+)\s+(.+?)\s+\((\w+)\)\s+([\w\d]+)\s*(?:\*([FE])\*)?$/;

        for (const line of lines) {
            const match = line.trim().match(lineRegex);
            if (match) {
                let foilType = 'normal';
                if (match[5] === 'F') foilType = 'foil';
                if (match[5] === 'E') foilType = 'etched';

                results.push({
                    quantity: parseInt(match[1], 10),
                    name: match[2].trim(),
                    setCode: match[3].toUpperCase(),
                    collectorNumber: match[4],
                    foilType: foilType,
                });
            }
        }    
        processResults(results, res, db);
    });
    
    
    return router;
}
