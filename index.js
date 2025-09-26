import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import basicAuth from 'basic-auth';
import sqlite3Base from 'sqlite3';
import cron from 'node-cron';
import { exec } from 'child_process';
import apiRoutes from './utils/api.js';
import 'dotenv/config';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { initializeCardNameCache } from './utils/card-data.js';

// --- Workaround for __dirname in ES Modules ---
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

// --- Authentication Middleware ---
const auth = (req, res, next) => {
    const user = basicAuth(req);
    const appUser = process.env.APP_USER || 'admin';
    const appPassword = process.env.APP_PASSWORD || 'password';

    if (!user || user.name !== appUser || user.pass !== appPassword) {
        res.setHeader('WWW-Authenticate', 'Basic realm="Enter credentials"');
        return res.status(401).send('Authentication required.');
    }
    return next();
};


// --- Database Connection and Setup ---
const sqlite3 = sqlite3Base.verbose();
const DB_PATH = path.join(__dirname, 'data', 'AllData.sqlite');

const db = new sqlite3.Database(DB_PATH, sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE, 
    (err) => {
        if (err) {
            console.error('Error connecting to AllData.sqlite:', err.message);
        } else {
            console.log('Successfully connected to AllData.sqlite database.');
            
            // Existing table (no errors here)
            db.run(`
                CREATE TABLE IF NOT EXISTS imported_lists (
                    id TEXT PRIMARY KEY,
                    content TEXT NOT NULL,
                    createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
                    isPermanent BOOLEAN DEFAULT 0
                )
            `);
            db.run(`
                CREATE TABLE IF NOT EXISTS inventory (
                    id TEXT PRIMARY KEY,
                    name TEXT NOT NULL,
                    setCode TEXT NOT NULL,
                    collectorNumber TEXT NOT NULL,
                    foilType TEXT NOT NULL,
                    pricePaid REAL NOT NULL,
                    quantity INTEGER NOT NULL,
                    tcgplayerId TEXT,
                    createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
                    tcgLow REAL,
                    manaPoolLow REAL,
                    pricesLastUpdatedAt DATETIME,
                    
                    -- NEW COLUMN --
                    condition TEXT NOT NULL DEFAULT 'NM'
                )
            `); 
            db.run(`
                CREATE TABLE IF NOT EXISTS transactions (
                    id TEXT PRIMARY KEY,
                    inventoryId TEXT NOT NULL,
                    soldAt DATETIME DEFAULT CURRENT_TIMESTAMP,
                    salePrice REAL NOT NULL,
                    shippingCost REAL NOT NULL,
                    platform TEXT NOT NULL,
                    netProfit REAL NOT NULL,
                    packingSlipPath TEXT,
                    FOREIGN KEY (inventoryId) REFERENCES inventory (id)
                )
            `);

            cleanupTemporaryLists();
        }
    }
);


/**
 * Deletes any temporary lists that are older than 24 hours.
 * This function is now called on server startup.
 */
function cleanupTemporaryLists() {
    console.log('Running cleanup of old temporary lists...');
    const sql = `DELETE FROM imported_lists WHERE isPermanent = 0 AND createdAt <= datetime('now', '-24 hours')`;
    
    db.run(sql, function(err) {
        if (err) {
            console.error("Error during startup cleanup:", err.message);
        } else if (this.changes > 0) {
            console.log(`Cleanup complete. Deleted ${this.changes} old temporary lists.`);
        } else {
            console.log("Cleanup ran. No old temporary lists found to delete.");
        }
    });
}

const uploadDir = './private/uploads';
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
}

// --- Middleware & API Routes ---
app.use(auth);
app.use(express.static(path.join(__dirname, 'public')));
initializeCardNameCache();
app.use('/api', apiRoutes(db));

// --- Page-Serving Routes ---
app.get('/cards/:set/:number', (req, res) => res.sendFile(path.join(__dirname, 'public', 'card-info.html')));
app.get('/list/:listId', (req, res) => res.sendFile(path.join(__dirname, 'public', 'list.html')));
app.get('/binder/:listId', (req, res) => res.sendFile(path.join(__dirname, 'public', 'binder.html')));

// --- Scheduled Tasks ---

// The daily data pipeline update should still run on a schedule.
// Your 3 AM issue might be timezone related. 3 AM EDT is 7 AM UTC.
// Let's schedule it for a more reliable time, like noon UTC.
console.log('Scheduling the daily data pipeline update for 12:00 PM UTC...');
cron.schedule('0 12 * * *', () => { // Runs at 12:00 PM UTC (8 AM EDT)
    console.log(`[${new Date().toISOString()}] Kicking off daily database merge job...`);
    const updateScriptPath = path.join(__dirname, 'daily-update.js');
    exec(`node ${updateScriptPath}`, (error, stdout, stderr) => {
        if (error) console.error(`❌ [CRON-ERROR] Failed to run update script: ${error.message}`);
        if (stderr) console.error(`❌ [CRON-STDERR] ${stderr}`);
        console.log(`✅ [CRON-STDOUT] Daily update finished:\n${stdout}`);
    });
});

app.use(express.json())

// --- Server Start ---
app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});

