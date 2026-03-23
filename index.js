import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import sqlite3Base from 'sqlite3';
import cron from 'node-cron';
import { exec } from 'child_process';
import apiRoutes from './utils/api.js';
import 'dotenv/config';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import fs from 'fs';
import { initializeCardNameCache } from './utils/card-data.js';
import { startDynDnsUpdater } from './utils/dyn-dns.js';
import { createSessionAuth } from './utils/session-auth.js';
import { setWebhookUrl, setManaPoolWebhookUrl } from './discord.js';
import {
    initAutomationScheduler,
    setAutomationEnabled,
    triggerAutomationRun,
    getAutomationRuntimeState,
    applyAutomationSettingsUpdate
} from './utils/automation-runner.js';
import { startDiscordBot, logDiscordConsole } from './utils/discord-bot.js';
import { setInventoryLockState, getInventoryLockState } from './utils/manapool-service.js';
import { startBuylistReporter, refreshInventoryBuylistSnapshot } from './utils/buylist-reporter.js';

// --- Workaround for __dirname in ES Modules ---
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.set('trust proxy', 1); // Trust Railway's reverse proxy for secure cookies/rate limiting
const PORT = process.env.PORT || 3000;

const APP_USER = process.env.APP_USER;
const APP_PASSWORD = process.env.APP_PASSWORD;
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;
const MANAPOOL_WEBHOOK_URL = process.env.MANAPOOL_WEBHOOK_URL;

if (DISCORD_WEBHOOK_URL) {
      setWebhookUrl(DISCORD_WEBHOOK_URL);
} else {
      console.warn('[discord] DISCORD_WEBHOOK_URL is not configured. Discord logging is disabled.');
}

if (MANAPOOL_WEBHOOK_URL) {
      setManaPoolWebhookUrl(MANAPOOL_WEBHOOK_URL);
} else {
      console.warn('[discord] MANAPOOL_WEBHOOK_URL is not configured. ManaPool automation alerts are disabled.');
}

if (!APP_USER || !APP_PASSWORD) {
      throw new Error('APP_USER and APP_PASSWORD environment variables must be set.');
}

if (APP_USER === 'admin' && APP_PASSWORD === 'password') {
      throw new Error('Default credentials detected. Update APP_USER and APP_PASSWORD before starting the server.');
}

process.on('uncaughtException', (error) => {
      console.error('[server] Uncaught exception:', error);
      logDiscordConsole(`[server] Uncaught exception: ${error?.message || error}`).catch(() => {});
});

process.on('unhandledRejection', (reason) => {
      console.error('[server] Unhandled rejection:', reason);
      const message = reason && reason.message ? reason.message : String(reason);
      logDiscordConsole(`[server] Unhandled rejection: ${message}`).catch(() => {});
});

// --- CORE MIDDLEWARE ---

// Security headers (XSS, clickjacking, MIME sniffing, etc.)
app.use(helmet({
      contentSecurityPolicy: false // disable CSP to avoid breaking inline scripts in public/
}));

// CORS - restrict to your own domain(s)
const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS
      ? process.env.ALLOWED_ORIGINS.split(',').map(o => o.trim())
      : [];
app.use(cors({
      origin: (origin, callback) => {
            // Allow requests with no origin (server-to-server, curl, same-origin forms)
            // For unrecognized origins, just don't set CORS headers (browser enforces)
            if (!origin || ALLOWED_ORIGINS.length === 0 || ALLOWED_ORIGINS.includes(origin)) {
                  callback(null, true);
            } else {
                  callback(null, false);
            }
      },
      credentials: true
}));

// Body parsing
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false }));

const sessionAuth = createSessionAuth({ username: APP_USER, password: APP_PASSWORD });
app.use(sessionAuth.attachSession);

// Rate limit login attempts: 10 attempts per 15 minutes per IP
const loginLimiter = rateLimit({
      windowMs: 15 * 60 * 1000,
      max: 10,
      message: { error: 'Too many login attempts, please try again later.' },
      standardHeaders: true,
      legacyHeaders: false
});
app.use('/login', loginLimiter, sessionAuth.loginRouter);
app.use('/logout', sessionAuth.logoutRouter);

// Health check endpoint (public, no auth required)
app.get('/health', (req, res) => res.status(200).json({ status: 'ok' }));



// --- TEMPORARY: Chunked database upload (remove after initial import) ---
app.post('/upload-db/clean', (req, res) => {
      const token = req.headers['x-upload-token'];
      if (token !== process.env.DB_UPLOAD_TOKEN) {
            return res.status(403).json({ error: 'Forbidden' });
      }
      const dataDir = path.join(__dirname, 'data');
      let deleted = [];
      if (fs.existsSync(dataDir)) {
            for (const f of fs.readdirSync(dataDir)) {
                  const fp = path.join(dataDir, f);
                  if (fs.statSync(fp).isFile()) {
                        fs.unlinkSync(fp);
                        deleted.push(f);
                  }
            }
      }
      console.log(`[upload-db] Cleaned ${deleted.length} files from data/`);
      res.json({ ok: true, deleted });
});

app.put('/upload-db/:chunk', (req, res) => {
      const token = req.headers['x-upload-token'];
      if (token !== process.env.DB_UPLOAD_TOKEN) {
            return res.status(403).json({ error: 'Forbidden' });
      }
      const chunkNum = parseInt(req.params.chunk, 10);
      const dest = path.join(__dirname, 'data', `AllData.sqlite.part${chunkNum}`);
      const writeStream = fs.createWriteStream(dest);
      let bytes = 0;
      req.on('data', (c) => { bytes += c.length; });
      req.pipe(writeStream);
      writeStream.on('finish', () => {
            console.log(`[upload-db] Chunk ${chunkNum}: ${(bytes / 1024 / 1024).toFixed(1)} MB`);
            res.json({ ok: true, chunk: chunkNum, bytes });
      });
      writeStream.on('error', (err) => res.status(500).json({ error: err.message }));
});

app.post('/upload-db/assemble', (req, res) => {
      const token = req.headers['x-upload-token'];
      if (token !== process.env.DB_UPLOAD_TOKEN) {
            return res.status(403).json({ error: 'Forbidden' });
      }
      const dataDir = path.join(__dirname, 'data');
      const dest = path.join(dataDir, 'AllData.sqlite');
      const parts = fs.readdirSync(dataDir)
            .filter(f => f.startsWith('AllData.sqlite.part'))
            .sort((a, b) => parseInt(a.split('part')[1]) - parseInt(b.split('part')[1]));

      if (parts.length === 0) return res.status(400).json({ error: 'No parts found' });

      const writeStream = fs.createWriteStream(dest);
      let i = 0;
      const writeNext = () => {
            if (i >= parts.length) {
                  writeStream.end(() => {
                        // Clean up parts
                        parts.forEach(p => fs.unlinkSync(path.join(dataDir, p)));
                        // Verify integrity
                        const testDb = new sqlite3.Database(dest, sqlite3.OPEN_READONLY, (err) => {
                              if (err) return res.status(500).json({ ok: false, error: err.message });
                              testDb.get("PRAGMA integrity_check", (err, row) => {
                                    testDb.close();
                                    if (err || row?.integrity_check !== 'ok') {
                                          return res.status(500).json({ ok: false, error: 'Integrity check failed' });
                                    }
                                    const size = fs.statSync(dest).size;
                                    console.log(`[upload-db] Assembled and verified ${(size / 1024 / 1024).toFixed(1)} MB`);
                                    res.json({ ok: true, size, integrity: 'ok' });
                              });
                        });
                  });
                  return;
            }
            const partStream = fs.createReadStream(path.join(dataDir, parts[i]));
            partStream.pipe(writeStream, { end: false });
            partStream.on('end', () => { i++; writeNext(); });
            partStream.on('error', (err) => res.status(500).json({ error: err.message }));
      };
      writeNext();
});
// --- END TEMPORARY ---

const PUBLIC_PATH_PREFIXES = ['/login', '/logout', '/health', '/upload-db'];
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
                  process.exit(1);
            } else {
                  console.log('Successfully connected to AllData.sqlite database.');

                  const columnEnsureTasks = [];
                  db.serialize(() => {
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
                                    tcgMarketPrice REAL,
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
                              packingSlipPath TEXT,
                              manapoolOrderId TEXT UNIQUE,
                              isShipped INTEGER DEFAULT 1,
                              entryType TEXT NOT NULL DEFAULT 'sale',
                              notes TEXT
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
                        db.run(`
                              CREATE TABLE IF NOT EXISTS expense_entries (
                                    id TEXT PRIMARY KEY,
                                    createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
                                    incurredOn DATETIME DEFAULT CURRENT_TIMESTAMP,
                                    amount REAL NOT NULL,
                                    category TEXT,
                                    description TEXT NOT NULL,
                                    paymentMethod TEXT,
                                    linkedInventoryId TEXT,
                                    notes TEXT,
                                    FOREIGN KEY (linkedInventoryId) REFERENCES inventory (id) ON DELETE SET NULL
                              )
                        `);
                        db.run(`
                              CREATE TABLE IF NOT EXISTS inventory_snapshots (
                                    id TEXT PRIMARY KEY,
                                    capturedAt DATETIME DEFAULT CURRENT_TIMESTAMP,
                                    totalValue REAL NOT NULL,
                                    inventoryCount INTEGER NOT NULL DEFAULT 0,
                                    costBasis REAL NOT NULL DEFAULT 0,
                                    notes TEXT
                              )
                        `);

                        columnEnsureTasks.push(ensureColumn(db, 'imported_lists', 'name', 'TEXT'));
                        columnEnsureTasks.push(ensureColumn(db, 'imported_lists', 'updatedAt', 'DATETIME DEFAULT CURRENT_TIMESTAMP'));
                        columnEnsureTasks.push(ensureColumn(db, 'imported_lists', 'lastAccessedAt', 'DATETIME DEFAULT CURRENT_TIMESTAMP'));
                        columnEnsureTasks.push(ensureColumn(db, 'imported_lists', 'buylistSnapshot', 'TEXT'));
                        columnEnsureTasks.push(ensureColumn(db, 'inventory', 'scryfallId', 'TEXT'));
                        columnEnsureTasks.push(ensureColumn(db, 'inventory', 'tcgLowPlusShipping', 'REAL'));
                        columnEnsureTasks.push(ensureColumn(db, 'inventory', 'tcgMarketPrice', 'REAL'));
                        columnEnsureTasks.push(ensureColumn(db, 'transactions', 'manapoolOrderId', 'TEXT'));
                        columnEnsureTasks.push(ensureColumn(db, 'transactions', 'packagingCost', 'REAL DEFAULT 0'));
                        columnEnsureTasks.push(ensureColumn(db, 'transactions', 'isShipped', 'INTEGER DEFAULT 1'));
                        columnEnsureTasks.push(ensureColumn(db, 'transactions', 'entryType', "TEXT DEFAULT 'sale'"));
                        columnEnsureTasks.push(ensureColumn(db, 'transactions', 'notes', 'TEXT'));
                        columnEnsureTasks.push(ensureColumn(db, 'inventory_snapshots', 'costBasis', 'REAL NOT NULL DEFAULT 0'));
                  });

                  const waitForColumns = columnEnsureTasks.length
                        ? Promise.allSettled(columnEnsureTasks)
                        : Promise.resolve([]);

                  waitForColumns.then(async (results) => {
                        const failures = results.filter(result => result.status === 'rejected');
                        if (failures.length) {
                              failures.forEach(({ reason }) => {
                                    console.error('[db] Column ensure failure:', reason?.message || reason);
                              });
                        }
                        try {
                        await ensureManaPoolIndex(db);
                        } catch (indexErr) {
                              console.error('[db] Failed ensuring ManaPool index:', indexErr.message);
                        }
                        cleanupTemporaryLists();
                        removeMigratedExpenseEntries();
                        startServerOnce();
                        await initAutomationScheduler(db);
                        startBuylistReporter(db, {
                              beforeBuild: async () => {
                                    console.log('[buylist] Pre-refresh hook: refreshing inventory snapshot...');
                                    try {
                                          await refreshInventoryBuylistSnapshot(db);
                                          console.log('[buylist] Inventory snapshot refreshed.');
                                    } catch (error) {
                                          console.warn('[buylist] Snapshot refresh failed:', error.message || error);
                                    }
                              }
                        });
                        await startDiscordBot({
                              startAutomation: () => setAutomationEnabled(true, { reason: 'Started from Discord', db }),
                              stopAutomation: () => setAutomationEnabled(false, { reason: 'Stopped from Discord', db }),
                              runAutomation: () => triggerAutomationRun(),
                              lockInventory: () => setInventoryLockState(true, { reason: 'Emergency stop via Discord', actor: 'Discord' }),
                              unlockInventory: () => setInventoryLockState(false, { actor: 'Discord' }),
                              applySetting: (update) => applyAutomationSettingsUpdate(update, { db, reason: 'Updated via Discord slash command' }),
                              fetchStatus: async () => ({
                                    automation: getAutomationRuntimeState(),
                                    inventoryLock: getInventoryLockState()
                              })
                        });
                  });
            }
      }
);

function ensureColumn(database, table, columnName, definition) {
      return new Promise((resolve, reject) => {
            database.all(`PRAGMA table_info(${table})`, (err, rows) => {
                  if (err) {
                        console.error(`[db] Failed to inspect ${table}:`, err.message);
                        return reject(err);
                  }
                  const hasColumn = rows.some(row => row.name === columnName);
                  if (hasColumn) {
                        return resolve(false);
                  }
                  database.run(`ALTER TABLE ${table} ADD COLUMN ${columnName} ${definition}`, (alterErr) => {
                        if (alterErr) {
                              if (/duplicate column name/i.test(alterErr.message)) {
                                    return resolve(false);
                              }
                              console.error(`[db] Failed adding ${columnName} to ${table}:`, alterErr.message);
                              return reject(alterErr);
                        }
                        console.log(`[db] Added missing column ${columnName} to ${table}.`);
                        resolve(true);
                  });
            });
      });
}

function ensureManaPoolIndex(database) {
      return new Promise((resolve, reject) => {
            database.run(
                  `CREATE UNIQUE INDEX IF NOT EXISTS idx_transactions_manapool ON transactions(manapoolOrderId) WHERE manapoolOrderId IS NOT NULL`,
                  (err) => {
                        if (err) {
                              return reject(err);
                        }
                        resolve();
                  }
            );
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

function removeMigratedExpenseEntries() {
      const sql = `DELETE FROM expense_entries WHERE notes LIKE 'Migrated packagingCost:%'`;
      db.run(sql, function(err) {
            if (err) {
                  console.error('[expenses] Failed to remove legacy packaging expenses:', err.message);
                  return;
            }
            if (this.changes > 0) {
                  console.log(`[expenses] Removed ${this.changes} migrated packaging cost entries.`);
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
app.get('/finances', (req, res) => res.sendFile(path.join(__dirname, 'public', 'finances.html')));
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
function startServerOnce() {
      if (startServerOnce.started) return;
      startServerOnce.started = true;
      app.listen(PORT, () => {
            console.log(`Server running on http://localhost:${PORT}`);
      });
}
startServerOnce.started = false;
