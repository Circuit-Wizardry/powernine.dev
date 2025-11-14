import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import sqlite3Base from 'sqlite3';
import cron from 'node-cron';
import { exec } from 'child_process';
import apiRoutes from './utils/api.js';
import 'dotenv/config';
import cors from 'cors';
import fs from 'fs';
import { initializeCardNameCache } from './utils/card-data.js';
import { startDynDnsUpdater } from './utils/dyn-dns.js';
import { createSessionAuth } from './utils/session-auth.js';
import { setWebhookUrl } from './discord.js';

// --- Workaround for __dirname in ES Modules ---
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

const APP_USER = process.env.APP_USER;
const APP_PASSWORD = process.env.APP_PASSWORD;
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;

if (DISCORD_WEBHOOK_URL) {
      setWebhookUrl(DISCORD_WEBHOOK_URL);
} else {
      console.warn('[discord] DISCORD_WEBHOOK_URL is not configured. Discord logging is disabled.');
}

if (!APP_USER || !APP_PASSWORD) {
      throw new Error('APP_USER and APP_PASSWORD environment variables must be set.');
}

if (APP_USER === 'admin' && APP_PASSWORD === 'password') {
      throw new Error('Default credentials detected. Update APP_USER and APP_PASSWORD before starting the server.');
}

// --- CORE MIDDLEWARE ---
// 1. Enable CORS for all requests. This handles the OPTIONS preflight.
app.use(cors()); 
// 2. Enable JSON body parsing. This MUST come before any routes that use req.body.
app.use(express.json());

app.use(express.urlencoded({ extended: false }));

const sessionAuth = createSessionAuth({ username: APP_USER, password: APP_PASSWORD });
app.use(sessionAuth.attachSession);
app.use('/login', sessionAuth.loginRouter);
app.use('/logout', sessionAuth.logoutRouter);

const PUBLIC_PATH_PREFIXES = ['/login', '/logout'];
const isPublicPath = (req) => {
      const pathname = req.path || req.url || '';
      return PUBLIC_PATH_PREFIXES.some(prefix => pathname.startsWith(prefix));
};

app.use((req, res, next) => {
      if (req.method === 'OPTIONS') {
            return next();
      }
      if (isPublicPath(req)) {
            return next();
      }
      return sessionAuth.requireAuth(req, res, next);
});

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
                              name TEXT,
                              createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
                              updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP,
                              lastAccessedAt DATETIME DEFAULT CURRENT_TIMESTAMP,
                              buylistSnapshot TEXT,
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
                              scryfallId TEXT,
                              createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
                              tcgLow REAL,
                              manaPoolLow REAL,
                              tcgLowPlusShipping REAL,
                              pricesLastUpdatedAt DATETIME,
                              
                              -- NEW COLUMN --
                              condition TEXT NOT NULL DEFAULT 'NM'
                        )
                  `); 
                  db.run(`
                        CREATE TABLE IF NOT EXISTS transactions (
                              id TEXT PRIMARY KEY,
                              soldAt DATETIME DEFAULT CURRENT_TIMESTAMP,
                              platform TEXT NOT NULL,
                              shippingCost REAL NOT NULL,
                              packagingCost REAL NOT NULL DEFAULT 0,
                              totalSalePrice REAL NOT NULL,
                              netProfit REAL NOT NULL,
                              packingSlipPath TEXT
                        )
                  `);

                  db.run(`
                        CREATE TABLE IF NOT EXISTS transaction_items (
                              id INTEGER PRIMARY KEY AUTOINCREMENT,
                              transactionId TEXT NOT NULL,
                              inventoryId TEXT NOT NULL,
                              salePrice REAL NOT NULL,
                              quantity INTEGER NOT NULL DEFAULT 1,
                              FOREIGN KEY (transactionId) REFERENCES transactions (id) ON DELETE CASCADE,
                              FOREIGN KEY (inventoryId) REFERENCES inventory (id)
                        )
                  `);
                  db.run(`
                        CREATE TABLE IF NOT EXISTS inventory_metadata (
                              id TEXT PRIMARY KEY,
                              buylistSnapshot TEXT,
                              updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP
                        )
                  `);

                  cleanupTemporaryLists();
                  ensureColumn(db, 'imported_lists', 'name', 'TEXT');
                  ensureColumn(db, 'imported_lists', 'updatedAt', 'DATETIME DEFAULT CURRENT_TIMESTAMP');
                  ensureColumn(db, 'imported_lists', 'lastAccessedAt', 'DATETIME DEFAULT CURRENT_TIMESTAMP');
                  ensureColumn(db, 'imported_lists', 'buylistSnapshot', 'TEXT');
                  ensureColumn(db, 'inventory', 'scryfallId', 'TEXT');
                  ensureColumn(db, 'inventory', 'tcgLowPlusShipping', 'REAL');
                  ensureColumn(db, 'transactions', 'packagingCost', 'REAL DEFAULT 0');
            }
      }
);

function ensureColumn(database, table, columnName, definition) {
      database.all(`PRAGMA table_info(${table})`, (err, rows) => {
            if (err) {
                  console.error(`[db] Failed to inspect ${table}:`, err.message);
                  return;
            }
            const hasColumn = rows.some(row => row.name === columnName);
            if (!hasColumn) {
                  database.run(`ALTER TABLE ${table} ADD COLUMN ${columnName} ${definition}`, (alterErr) => {
                        if (alterErr) {
                              console.error(`[db] Failed adding ${columnName} to ${table}:`, alterErr.message);
                        } else {
                              console.log(`[db] Added missing column ${columnName} to ${table}.`);
                        }
                  });
            }
      });
}


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

const uploadDir = path.join(__dirname, 'private', 'uploads');
if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
}

// --- Middleware & API Routes ---
initializeCardNameCache();
startDynDnsUpdater();
app.use('/api', apiRoutes(db, { uploadRoot: uploadDir }));
app.use(express.static(path.join(__dirname, 'public')));

// --- Page-Serving Routes ---
app.get('/cards/:set/:number', (req, res) => res.sendFile(path.join(__dirname, 'public', 'card-info.html')));
app.get('/list/:listId', (req, res) => res.sendFile(path.join(__dirname, 'public', 'list.html')));
app.get('/list-buylist/:listId', (req, res) => res.sendFile(path.join(__dirname, 'public', 'list-buylist.html')));
app.get('/binder/:listId', (req, res) => res.sendFile(path.join(__dirname, 'public', 'binder.html')));

// --- Scheduled Tasks ---
console.log('Scheduling the daily data pipeline update for 12:00 PM UTC...');
cron.schedule('0 12 * * *', () => {
      console.log(`[${new Date().toISOString()}] Kicking off daily database merge job...`);
      const updateScriptPath = path.join(__dirname, 'daily-update.js');
      exec(`node ${updateScriptPath}`, (error, stdout, stderr) => {
            if (error) console.error(`❌ [CRON-ERROR] Failed to run update script: ${error.message}`);
            if (stderr) console.error(`❌ [CRON-STDERR] ${stderr}`);
            console.log(`✅ [CRON-STDOUT] Daily update finished:\n${stdout}`);
      });
});

// --- Server Start ---
app.listen(PORT, () => {
      console.log(`Server running on http://localhost:${PORT}`);
});

