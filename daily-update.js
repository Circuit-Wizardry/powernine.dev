import fs from 'fs';
import path from 'path';
import sqlite3 from 'sqlite3';
import axios from 'axios';
import cliProgress from 'cli-progress';
import { log } from './discord.js'

// --- Configuration ---
const DATA_DIR = 'data';
const BACKUP_DIR = path.join(DATA_DIR, 'backups');
const SOURCE_DB_PATH = path.join(DATA_DIR, 'AllPrintings.sqlite');
const TARGET_DB_PATH = path.join(DATA_DIR, 'AllData.sqlite');
const TODAY_PRICES_PATH = path.join(DATA_DIR, 'AllPricesToday.json');

const URLS = {
    AllPrintings: 'https://mtgjson.com/api/v5/AllPrintings.sqlite',
    AllPricesToday: 'https://mtgjson.com/api/v5/AllPricesToday.json'
};

const PRESERVED_DB_OBJECTS = [
    'price_history',
    'inventory',
    'transactions',
    'transaction_items',
    'inventory_metadata',
    'imported_lists',
    'expense_entries',
    'inventory_snapshots',
    'manapool_automation_settings',
    'manapool_automation_baselines'
];

const PROGRESS_STAGES = [
    { key: 'backup', label: 'Backup AllData.sqlite' },
    { key: 'downloadPrintings', label: 'Download AllPrintings.sqlite' },
    { key: 'downloadPrices', label: 'Download AllPricesToday.json' },
    { key: 'refreshPrintings', label: 'Refresh printings data' },
    { key: 'mergePriceHistory', label: 'Merge daily price history' },
    { key: 'refreshInventoryPrices', label: 'Refresh inventory market prices' },
    { key: 'consolidateInventory', label: 'Consolidate duplicate inventory rows' }
];

const PROGRESS_BAR_WIDTH = 20;

const progressMarker = (status) => {
    if (status === 'done') return '[x]';
    if (status === 'running') return '[>]';
    if (status === 'error') return '[!]';
    return '[ ]';
};

const buildProgressContent = (statusMap, note = '') => {
    const stages = PROGRESS_STAGES.map((stage) => ({
        ...stage,
        status: statusMap[stage.key] || 'pending'
    }));
    const completed = stages.filter((stage) => stage.status === 'done').length;
    const total = stages.length || 1;
    const percent = Math.round((completed / total) * 100);
    const filled = Math.round((completed / total) * PROGRESS_BAR_WIDTH);
    const bar = `[${'#'.repeat(filled)}${'.'.repeat(PROGRESS_BAR_WIDTH - filled)}] ${percent}%`;
    const stageLines = stages.map((stage) => ` - ${progressMarker(stage.status)} ${stage.label}`).join('\n');
    return [
        percent === 100 ? 'Daily update finished.' : 'Daily update running...',
        `${bar} (${completed}/${total} stages complete)`,
        note ? `Now: ${note}` : null,
        'Stages:',
        stageLines
    ].filter(Boolean).join('\n');
};

const createProgressTracker = async () => {
    const statusMap = PROGRESS_STAGES.reduce((acc, stage) => {
        acc[stage.key] = 'pending';
        return acc;
    }, {});

    let message = null;

    const safeEdit = async (content) => {
        if (message?.edit) {
            try {
                await message.edit({ content });
                return;
            } catch (err) {
                console.warn('[daily-update] Failed to edit Discord progress message:', err.message || err);
            }
        }
        console.log('[daily-update] progress update:\n', content);
    };

    const update = async (note) => safeEdit(buildProgressContent(statusMap, note));

    try {
        message = await log(buildProgressContent(statusMap, 'Starting daily update...'));
    } catch (err) {
        console.warn('[daily-update] Failed to send Discord progress message:', err.message || err);
    }

    await update('Preparing to start...');

    const setStatus = async (key, status, note) => {
        if (!(key in statusMap)) return;
        statusMap[key] = status;
        await update(note || PROGRESS_STAGES.find((stage) => stage.key === key)?.label);
    };

    return {
        markRunning: (key, note) => setStatus(key, 'running', note),
        markDone: (key, note) => setStatus(key, 'done', note),
        markError: (key, note) => setStatus(key, 'error', note),
        finalize: (note) => {
            PROGRESS_STAGES.forEach((stage) => { statusMap[stage.key] = 'done'; });
            return update(note || 'All stages complete.');
        }
    };
};

const getLatestFromHistory = (history) => {
    if (!history || typeof history !== 'object') return null;
    const dates = Object.keys(history);
    if (!dates.length) return null;
    dates.sort((a, b) => new Date(b) - new Date(a));
    return history[dates[0]];
};

const fetchTcgMarketPriceForCard = (db, setCode, collectorNumber, foilType = 'normal') => {
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
                if (err) console.error('[daily-update] price lookup failed:', err.message);
                return resolve(null);
            }
            try {
                const priceJson = JSON.parse(row.price_json);
                const history = priceJson?.paper?.tcgplayer?.retail?.[foilType] || priceJson?.paper?.tcgplayer?.retail?.normal;
                resolve(getLatestFromHistory(history));
            } catch (parseErr) {
                console.error('[daily-update] price JSON parse error:', parseErr.message);
                resolve(null);
            }
        });
    });
};

async function consolidateInventory(targetDbPath) {
    console.log('\nConsolidating duplicate inventory rows...');
    const db = new sqlite3.Database(targetDbPath);
    const rows = await new Promise((resolve, reject) => {
        db.all(
            'SELECT id, setCode, collectorNumber, foilType, condition, pricePaid, quantity, scryfallId, tcgplayerId, createdAt FROM inventory',
            [],
            (err, data) => err ? reject(err) : resolve(data || [])
        );
    });
    const groups = new Map();
    rows.forEach((row) => {
        const key = [
            (row.setCode || '').toUpperCase(),
            String(row.collectorNumber || '').trim(),
            String(row.foilType || 'normal').toLowerCase(),
            String(row.condition || 'NM').toUpperCase(),
            (row.scryfallId || '').toLowerCase(),
            row.tcgplayerId ? String(row.tcgplayerId) : ''
        ].join('|');
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(row);
    });
    let merged = 0;
    for (const [, group] of groups.entries()) {
        if (group.length <= 1) continue;
        merged += group.length - 1;
        group.sort((a, b) => new Date(a.createdAt || 0) - new Date(b.createdAt || 0));
        const keeper = group[0];
        const rest = group.slice(1);
        const totalQty = group.reduce((sum, r) => sum + (Number(r.quantity) || 0), 0);
        const totalCost = group.reduce((sum, r) => sum + (Number(r.pricePaid) || 0) * (Number(r.quantity) || 0), 0);
        const avgPaid = totalQty > 0 ? Number((totalCost / totalQty).toFixed(2)) : 0;
        await new Promise((resolve, reject) => {
            db.run('UPDATE inventory SET quantity = ?, pricePaid = ? WHERE id = ?', [totalQty, avgPaid, keeper.id], (err) => err ? reject(err) : resolve());
        });
        if (rest.length) {
            const ids = rest.map(r => r.id);
            const placeholders = ids.map(() => '?').join(',');
            await new Promise((resolve, reject) => {
                db.run(`DELETE FROM inventory WHERE id IN (${placeholders})`, ids, (err) => err ? reject(err) : resolve());
            });
        }
    }
    console.log(` -> Consolidated ${merged} duplicate rows.`);
    db.close();
}

async function refreshInventoryMarketPrices(targetDbPath) {
    console.log('\nUpdating tcgMarketPrice for inventory items...');
    const db = new sqlite3.Database(targetDbPath);
    const inventoryRows = await new Promise((resolve, reject) => {
        db.all('SELECT id, setCode, collectorNumber, foilType FROM inventory', [], (err, rows) => {
            if (err) return reject(err);
            resolve(rows || []);
        });
    });
    let processed = 0;
    for (const row of inventoryRows) {
        const price = await fetchTcgMarketPriceForCard(db, row.setCode, row.collectorNumber, row.foilType || 'normal');
        await new Promise((resolve, reject) => {
            db.run('UPDATE inventory SET tcgMarketPrice = ? WHERE id = ?', [price ?? null, row.id], (err) => {
                if (err) return reject(err);
                resolve();
            });
        });
        processed += 1;
        if (processed % 250 === 0) {
            process.stdout.write(`\r -> Updated ${processed}/${inventoryRows.length} items`);
        }
    }
    console.log(`\r -> Updated ${processed}/${inventoryRows.length} items`);
    db.close();
}

/**
 * Recursively merges properties of two objects. The source's properties overwrite the target's.
 * @param {object} target The object to merge into.
 * @param {object} source The object to merge from.
 * @returns {object} The merged object.
 */
function deepMerge(target, source) {
    // ... (This function is unchanged)
    const isObject = (item) => (item && typeof item === 'object' && !Array.isArray(item));
    const output = { ...target };
    if (isObject(target) && isObject(source)) {
        Object.keys(source).forEach(key => {
            if (isObject(source[key])) {
                if (!(key in target)) {
                    Object.assign(output, { [key]: source[key] });
                } else {
                    output[key] = deepMerge(target[key], source[key]);
                }
            } else {
                Object.assign(output, { [key]: source[key] });
            }
        });
    }
    return output;
}

/**
 * Downloads a file from a URL, showing a progress bar.
 * @param {string} url The URL to download from.
 * @param {string} destPath The local path to save the file.
 */
async function downloadFile(url, destPath) {
    // ... (This function is unchanged)
    console.log(`\nDownloading ${path.basename(destPath)}...`);
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    const { data, headers } = await axios({ url, method: 'GET', responseType: 'stream' });
    const totalLength = headers['content-length'];
    const progressBar = new cliProgress.SingleBar({}, cliProgress.Presets.shades_classic);
    progressBar.start(parseInt(totalLength, 10), 0);
    const writer = fs.createWriteStream(destPath);
    data.on('data', (chunk) => progressBar.increment(chunk.length));
    data.pipe(writer);
    return new Promise((resolve, reject) => {
        writer.on('finish', () => { progressBar.stop(); console.log(` -> Download complete: ${destPath}`); resolve(); });
        writer.on('error', (err) => { progressBar.stop(); console.error(` -> Download failed for ${destPath}`); reject(err); });
    });
}

/**
 * Creates a lightweight backup containing only user data tables (not the huge
 * cards/price_history tables that can be re-downloaded from MTGJSON).
 * @param {string} targetDbPath Path to the AllData.sqlite file.
 * @param {string} backupDir Directory to place the backup.
 * @returns {Promise<string|null>} The backup path or null if the source doesn't exist.
 */
async function backupAllData(targetDbPath, backupDir) {
    if (!fs.existsSync(targetDbPath)) {
        console.warn('[daily-update] No AllData.sqlite found to back up.');
        return null;
    }
    fs.mkdirSync(backupDir, { recursive: true });
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupPath = path.join(backupDir, `AllData-${timestamp}.sqlite`);
    console.log(`\nBacking up user data tables to ${backupPath}...`);

    const BACKUP_TABLES = [
        'inventory',
        'transactions',
        'transaction_items',
        'inventory_metadata',
        'imported_lists',
        'expense_entries',
        'inventory_snapshots',
        'manapool_automation_settings',
        'manapool_automation_baselines'
    ];

    const sourceDb = new sqlite3.Database(targetDbPath);
    await new Promise((resolve, reject) => {
        sourceDb.run(`ATTACH DATABASE ? AS backup`, [backupPath], (err) => {
            if (err) return reject(err);

            sourceDb.serialize(() => {
                for (const table of BACKUP_TABLES) {
                    sourceDb.run(
                        `CREATE TABLE IF NOT EXISTS backup.${table} AS SELECT * FROM main.${table}`,
                        (err) => { if (err) console.warn(`[backup] Skipping ${table}: ${err.message}`); }
                    );
                }
                sourceDb.run(`DETACH DATABASE backup`, (err) => {
                    sourceDb.close();
                    if (err) return reject(err);
                    const size = fs.statSync(backupPath).size;
                    console.log(` -> Backup completed: ${(size / 1024 / 1024).toFixed(1)} MB`);

                    // Prune backups older than 10 days
                    const maxAge = 10 * 24 * 60 * 60 * 1000;
                    const now = Date.now();
                    for (const f of fs.readdirSync(backupDir)) {
                        if (!f.endsWith('.sqlite')) continue;
                        const fp = path.join(backupDir, f);
                        if (now - fs.statSync(fp).mtimeMs > maxAge) {
                            fs.unlinkSync(fp);
                            console.log(` -> Pruned old backup: ${f}`);
                        }
                    }

                    resolve();
                });
            });
        });
    });
    return backupPath;
}

/**
 * Reads AllPricesToday.json and merges the new data with existing price history.
 * @param {string} pricesJsonPath Path to the AllPricesToday.json file.
 * @param {string} targetDbPath Path to the target SQLite database.
 */
async function updatePriceHistory(pricesJsonPath, targetDbPath) {
    // ... (This function is unchanged)
    console.log(`\nMerging daily prices into ${targetDbPath}...`);
    const db = new sqlite3.Database(targetDbPath);
    await new Promise((resolve, reject) => {
        const schema = `CREATE TABLE IF NOT EXISTS price_history (uuid TEXT PRIMARY KEY, price_json TEXT NOT NULL);`;
        db.run(schema, (err) => err ? reject(err) : resolve());
    });
    console.log(' -> price_history table verified.');
    console.log(` -> Reading ${path.basename(pricesJsonPath)}...`);
    const pricesFileContent = fs.readFileSync(pricesJsonPath, 'utf-8');
    const pricesJson = JSON.parse(pricesFileContent);
    const todayPriceData = pricesJson.data;
    const uuidsToUpdate = Object.keys(todayPriceData);
    console.log(` -> Found ${uuidsToUpdate.length} price updates for today.`);
    const progressBar = new cliProgress.SingleBar({}, cliProgress.Presets.shades_classic);
    progressBar.start(uuidsToUpdate.length, 0);
    await new Promise((resolve, reject) => {
        db.serialize(() => {
            db.run('BEGIN TRANSACTION');
            const selectStmt = db.prepare('SELECT price_json FROM price_history WHERE uuid = ?');
            const upsertStmt = db.prepare('INSERT INTO price_history (uuid, price_json) VALUES (?, ?) ON CONFLICT(uuid) DO UPDATE SET price_json = excluded.price_json');
            let chain = Promise.resolve();
            for (const uuid of uuidsToUpdate) {
                chain = chain.then(() => new Promise((next, fail) => {
                    selectStmt.get([uuid], (err, row) => {
                        if (err) return fail(err);
                        const existingHistory = row ? JSON.parse(row.price_json) : {};
                        const todayData = todayPriceData[uuid];
                        const mergedData = deepMerge(existingHistory, todayData);
                        upsertStmt.run([uuid, JSON.stringify(mergedData)], (writeErr) => {
                            progressBar.increment();
                            if (writeErr) return fail(writeErr);
                            next();
                        });
                    });
                }));
            }
            chain.then(() => {
                selectStmt.finalize();
                upsertStmt.finalize();
                db.run('COMMIT', (commitErr) => {
                    progressBar.stop();
                    if (commitErr) return reject(commitErr);
                    console.log(' -> Database commit successful.');
                    resolve();
                });
            }).catch(reject);
        });
    });
    await new Promise((res, rej) => db.close(e => e ? rej(e) : res()));
}

/**
 * The main function to run the daily update pipeline.
 */
async function runDailyUpdate() {
    const startTime = Date.now();
    console.log(`[${new Date().toISOString()}] Starting daily data refresh pipeline...`);
    const progress = await createProgressTracker().catch(() => null);
    const track = async (method, ...args) => {
        if (!progress || typeof progress[method] !== 'function') return;
        try {
            await progress[method](...args);
        } catch (err) {
            console.warn(`[daily-update] progress ${method} failed:`, err.message || err);
        }
    };
    await log('Starting daily data refresh pipeline...');

    let currentStage = null;
    try {
        currentStage = 'backup';
        await track('markRunning', currentStage, 'Backing up existing AllData.sqlite...');
        await log('Backing up existing AllData.sqlite...');
        const backupPath = await backupAllData(TARGET_DB_PATH, BACKUP_DIR);
        if (backupPath) {
            console.log(` -> Backup created at ${backupPath}`);
            await log(`Backup created at ${backupPath}`);
            await track('markDone', currentStage, 'Backup created.');
        } else {
            console.log(' -> No existing AllData.sqlite found; skipping backup.');
            await log('No existing AllData.sqlite found; skipping backup.');
            await track('markDone', currentStage, 'No existing AllData.sqlite; skipped.');
        }

        currentStage = 'downloadPrintings';
        await track('markRunning', currentStage, 'Downloading AllPrintings.sqlite...');
        await log('Downloading latest data files from MTGJSON...');
        await downloadFile(URLS.AllPrintings, SOURCE_DB_PATH);
        await log('AllPrintings.sqlite downloaded successfully.');
        await track('markDone', currentStage, 'AllPrintings.sqlite downloaded.');

        currentStage = 'downloadPrices';
        await track('markRunning', currentStage, 'Downloading AllPricesToday.json...');
        await log('Downloading latest price data from MTGJSON...');
        await downloadFile(URLS.AllPricesToday, TODAY_PRICES_PATH);
        await log('AllPricesToday.json downloaded successfully.');
        await track('markDone', currentStage, 'AllPricesToday.json downloaded.');

        currentStage = 'refreshPrintings';
        await track('markRunning', currentStage, 'Refreshing printings data...');
        console.log(`\nRefreshing printings data in ${TARGET_DB_PATH}...`);
        const db = new sqlite3.Database(TARGET_DB_PATH);

        const preservationPlaceholders = PRESERVED_DB_OBJECTS.map(() => '?').join(', ');
        const oldObjectsQuery = `
            SELECT name, type FROM sqlite_master 
            WHERE name NOT LIKE 'sqlite_%' 
            AND name NOT IN (${preservationPlaceholders})
        `;
        const oldObjects = await new Promise((resolve, reject) => {
            db.all(oldObjectsQuery, PRESERVED_DB_OBJECTS, (err, rows) => err ? reject(err) : resolve(rows));
        });

        if (oldObjects.length > 0) {
            console.log(` -> Dropping ${oldObjects.length} old database objects...`);
            await new Promise((resolve, reject) => {
                db.serialize(() => {
                    db.run('BEGIN TRANSACTION');
                    for (const item of oldObjects) {
                        db.run(`DROP ${item.type.toUpperCase()} IF EXISTS "${item.name}"`);
                    }
                    db.run('COMMIT', (err) => err ? reject(err) : resolve());
                });
            });
        } else {
            console.log(' -> No old objects to drop.');
        }

        console.log(' -> Attaching new printings database...');
        await new Promise((res, rej) => db.run(`ATTACH DATABASE '${SOURCE_DB_PATH}' AS new_printings`, e => e ? rej(e) : res()));

        const tablesToCopy = await new Promise((resolve, reject) => {
            db.all("SELECT name FROM new_printings.sqlite_master WHERE type='table'",
                (err, rows) => err ? reject(err) : resolve(rows.map(r => r.name)));
        });

        console.log(` -> Found ${tablesToCopy.length} tables to copy: ${tablesToCopy.join(', ')}`);
        await log(`Copying ${tablesToCopy.length} tables to main database...`);
        await new Promise((resolve, reject) => {
            db.serialize(() => {
                db.run('BEGIN TRANSACTION');
                for (const tableName of tablesToCopy) {
                    db.run(`CREATE TABLE "${tableName}" AS SELECT * FROM new_printings."${tableName}"`);
                }
                db.run('COMMIT', (err) => err ? reject(err) : resolve());
            });
        });

        await new Promise((res, rej) => db.run('DETACH DATABASE new_printings', e => e ? rej(e) : res()));
        await new Promise((res, rej) => db.close(e => e ? rej(e) : res()));
        console.log('Printings data refreshed successfully.');
        await track('markDone', currentStage, 'Printings data refreshed.');

        currentStage = 'mergePriceHistory';
        await track('markRunning', currentStage, 'Merging daily price history...');
        await updatePriceHistory(TODAY_PRICES_PATH, TARGET_DB_PATH);
        console.log('Price history merged successfully.');
        await track('markDone', currentStage, 'Price history merged.');

        currentStage = 'refreshInventoryPrices';
        await track('markRunning', currentStage, 'Refreshing inventory market prices...');
        await refreshInventoryMarketPrices(TARGET_DB_PATH);
        console.log('Inventory market prices refreshed.');
        await track('markDone', currentStage, 'Inventory market prices refreshed.');

        currentStage = 'consolidateInventory';
        await track('markRunning', currentStage, 'Consolidating duplicate inventory rows...');
        await consolidateInventory(TARGET_DB_PATH);
        console.log('Inventory consolidation complete.');
        await track('markDone', currentStage, 'Inventory consolidation complete.');

        await track('finalize', 'Daily data refresh pipeline completed successfully.');
        await log('Daily data refresh pipeline completed successfully.');

    } catch (error) {
        console.error('\nX An error occurred during the daily update:', error);
        await track('markError', currentStage || 'backup', `Failed during ${currentStage || 'startup'}: ${error.message || error}`);
        await log(`X An error occurred during the daily update: ${error.message}`);
        process.exit(1);
    }

    const endTime = Date.now();
    console.log(`\nDaily update finished successfully in ${((endTime - startTime) / 1000).toFixed(2)} seconds.`);
}

runDailyUpdate();
