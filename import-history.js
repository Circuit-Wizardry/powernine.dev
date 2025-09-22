// import-history.js
const fs = require('fs');
const sqlite3 = require('sqlite3').verbose();
const { parser } = require('stream-json');
const { streamObject } = require('stream-json/streamers/StreamObject');

const DB_FILE = './AllPrintings.sqlite';
const HISTORY_JSON_FILE = './AllPrices.json'; // The large file

console.log(`Opening database at ${DB_FILE}...`);
const db = new sqlite3.Database(DB_FILE);

db.serialize(() => {
    console.log('Creating "price_history" table (if it doesn\'t exist)...');
    db.run(`
        CREATE TABLE IF NOT EXISTS price_history (
            uuid TEXT PRIMARY KEY,
            json TEXT NOT NULL
        )
    `);

    console.log(`Streaming historical price data from ${HISTORY_JSON_FILE}...`);
    console.log('This will take a few minutes. Please be patient.');

    // Prepare the database statement for efficient inserts
    const stmt = db.prepare(`INSERT OR REPLACE INTO price_history (uuid, json) VALUES (?, ?)`);

    // Begin a transaction for massive performance improvement
    db.run('BEGIN TRANSACTION');

    let count = 0;
    const pipeline = fs.createReadStream(HISTORY_JSON_FILE)
        .pipe(parser())
        .pipe(streamObject()) // We are streaming the 'data' object
        .on('data', ({ key: uuid, value: priceObject }) => {
            // This event fires for each key-value pair in the main "data" object
            const historyObjectAsString = JSON.stringify(priceObject);
            stmt.run(uuid, historyObjectAsString);
            count++;
            if (count % 50000 === 0) {
                process.stdout.write(`Processed ${count} records...\r`);
            }
        })
        .on('end', () => {
            console.log(`\nFinalizing database transaction...`);
            stmt.finalize();
            db.run('COMMIT');
            console.log(`\n✅ Success! Imported price history for ${count} unique cards.`);
            db.close();
        })
        .on('error', (err) => {
            console.error('\n❌ An error occurred during the stream:', err);
            db.close();
        });
});