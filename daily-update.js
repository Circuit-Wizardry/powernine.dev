import fs from 'fs';
import path from 'path';
import sqlite3 from 'sqlite3';
import axios from 'axios';
import cliProgress from 'cli-progress';

// --- Configuration ---
const DATA_DIR = 'data';
const SOURCE_DB_PATH = path.join(DATA_DIR, 'AllPrintings.sqlite');
const TARGET_DB_PATH = path.join(DATA_DIR, 'AllData.sqlite');
const TODAY_PRICES_PATH = path.join(DATA_DIR, 'AllPricesToday.json');

const URLS = {
    AllPrintings: 'https://mtgjson.com/api/v5/AllPrintings.sqlite',
    AllPricesToday: 'https://mtgjson.com/api/v5/AllPricesToday.json'
};

/**
 * Recursively merges properties of two objects. The source's properties overwrite the target's.
 * @param {object} target The object to merge into.
 * @param {object} source The object to merge from.
 * @returns {object} The merged object.
 */
function deepMerge(target, source) {
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
 * Reads AllPricesToday.json and merges the new data with existing price history.
 * @param {string} pricesJsonPath Path to the AllPricesToday.json file.
 * @param {string} targetDbPath Path to the target SQLite database.
 */
async function updatePriceHistory(pricesJsonPath, targetDbPath) {
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

    try {
        // --- Step 1: Download the latest files ---
        // await downloadFile(URLS.AllPrintings, SOURCE_DB_PATH);
        // await downloadFile(URLS.AllPricesToday, TODAY_PRICES_PATH);

        // --- Step 2: Refresh the main database ---
        console.log(`\nRefreshing printings data in ${TARGET_DB_PATH}...`);
        const db = new sqlite3.Database(TARGET_DB_PATH);

        const oldObjects = await new Promise((resolve, reject) => {
            db.all("SELECT name, type FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND name != 'price_history'",
                (err, rows) => err ? reject(err) : resolve(rows));
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
        console.log('✅ Printings data refreshed successfully.');

        // --- Step 3: Update the price history ---
        await updatePriceHistory(TODAY_PRICES_PATH, TARGET_DB_PATH);
        console.log('✅ Price history merged successfully.');

    } catch (error) {
        console.error('\n❌ An error occurred during the daily update:', error);
        process.exit(1);
    }

    const endTime = Date.now();
    console.log(`\n🎉 Daily update finished successfully in ${((endTime - startTime) / 1000).toFixed(2)} seconds.`);
}

runDailyUpdate();