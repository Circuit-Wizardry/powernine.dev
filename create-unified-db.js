// create_unified_db.js

import fs from 'fs';
import path from 'path';
import sqlite3 from 'sqlite3';
import parser from 'stream-json';
import streamObject from 'stream-json/streamers/StreamObject.js';
import axios from 'axios';
import cliProgress from 'cli-progress';

// --- Configuration ---
const DATA_DIR = 'data';
const SOURCE_DB_PATH = path.join(DATA_DIR, 'AllPrintings.sqlite');
const SOURCE_JSON_PATH = path.join(DATA_DIR, 'AllPrices.json');
const TARGET_DB_PATH = path.join(DATA_DIR, 'AllData.sqlite');

const URLS = {
    AllPrintings: 'https://mtgjson.com/api/v5/AllPrintings.sqlite',
    AllPrices: 'https://mtgjson.com/api/v5/AllPrices.json'
};

async function downloadFile(url, destPath) {
    console.log(`\nDownloading ${path.basename(destPath)}...`);
    fs.mkdirSync(path.dirname(destPath), { recursive: true });

    const { data, headers } = await axios({
        url,
        method: 'GET',
        responseType: 'stream',
    });

    const totalLength = headers['content-length'];
    const progressBar = new cliProgress.SingleBar({}, cliProgress.Presets.shades_classic);
    progressBar.start(parseInt(totalLength, 10), 0);

    const writer = fs.createWriteStream(destPath);
    data.on('data', (chunk) => progressBar.increment(chunk.length));
    data.pipe(writer);

    return new Promise((resolve, reject) => {
        writer.on('finish', () => {
            progressBar.stop();
            console.log(` -> Download complete: ${destPath}`);
            resolve();
        });
        writer.on('error', (err) => {
            progressBar.stop();
            console.error(` -> Download failed for ${destPath}`);
            reject(err);
        });
    });
}

async function runDataPipeline() {
    const startTime = Date.now();
    console.log(`[${new Date().toISOString()}] Starting the daily data pipeline...`);

    try {
        console.log('--- Step 1: Downloading source files ---');
        await downloadFile(URLS.AllPrintings, SOURCE_DB_PATH);
        await downloadFile(URLS.AllPrices, SOURCE_JSON_PATH);
        console.log('✅ All source files downloaded.');

        console.log('\n--- Step 2: Preparing the target database ---');
        if (fs.existsSync(TARGET_DB_PATH)) {
            fs.unlinkSync(TARGET_DB_PATH);
            console.log(` -> Deleted existing target database at ${TARGET_DB_PATH}`);
        }
        fs.copyFileSync(SOURCE_DB_PATH, TARGET_DB_PATH);
        console.log(` -> Copied printings data to ${TARGET_DB_PATH}`);
        
        const db = new sqlite3.Database(TARGET_DB_PATH);
        await new Promise((resolve, reject) => {
            db.run(`CREATE TABLE prices (uuid TEXT PRIMARY KEY, price_json TEXT NOT NULL)`, 
            (err) => err ? reject(err) : resolve());
        });
        console.log(' -> Added the prices table.');
        console.log('✅ Target database is ready.');

        console.log(`\n--- Step 3: Streaming prices from ${SOURCE_JSON_PATH} ---`);
        const stmt = db.prepare(`INSERT INTO prices (uuid, price_json) VALUES (?, ?)`);
        db.run('BEGIN TRANSACTION');

        let count = 0;
        await new Promise((resolve, reject) => {
            const pipeline = fs.createReadStream(SOURCE_JSON_PATH)
                .pipe(parser())
                // This is the corrected line
                .pipe(new streamObject())
                .on('data', ({ key: uuid, value: priceObject }) => {
                    stmt.run(uuid, JSON.stringify(priceObject));
                    count++;
                    if (count % 50000 === 0) {
                        process.stdout.write(` -> Processed ${count.toLocaleString()} price records...\r`);
                    }
                })
                .on('end', () => resolve())
                .on('error', (err) => reject(err));
        });

        console.log(`\n -> Finalizing the import of ${count.toLocaleString()} price records...`);
        await new Promise((resolve, reject) => stmt.finalize((err) => err ? reject(err) : resolve()));
        await new Promise((resolve, reject) => db.run('COMMIT', (err) => err ? reject(err) : resolve()));
        console.log('✅ Price import complete.');

        await new Promise((resolve, reject) => db.close((err) => err ? reject(err) : resolve()));
        console.log('\n--- Step 4: Database connection closed ---');

        const endTime = Date.now();
        console.log(`\n🎉 [${new Date().toISOString()}] Data pipeline finished successfully!`);
        console.log(` -> Unified database is ready at: ${TARGET_DB_PATH}`);
        console.log(` -> Total time: ${((endTime - startTime) / 1000 / 60).toFixed(2)} minutes.`);

    } catch (error) {
        console.error('\n❌ An error occurred during the data pipeline:', error);
        process.exit(1);
    }
}

runDataPipeline();