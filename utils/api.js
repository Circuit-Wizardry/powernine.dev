import express from 'express';
import { Readable } from 'stream';
import multer from 'multer';
import csv from 'csv-parser';
import { getCardNames } from './card-data.js';
import axios from 'axios';
import { randomUUID } from 'crypto';
import { log } from '../discord.js'
import { chromium } from 'playwright'; // Import Playwright
// Import your scraper functions (ensure paths are correct)
import { scrapeTcgplayerData } from '../scrapers/tcgplayer.js';
import { scrapeManaPoolListings } from '../scrapers/manapool.js';
import { scrapeStarCityGamesBuylist } from '../scrapers/starcitygames.js';

const FIXED_SHIPPING_EXPENSE = 1.25; // The cost of an envelope and materials

const calculateFees = (salePrice, platform) => {
    if (salePrice <= 0) return 0;
    const TCGPLAYER_FEE_RATE = 0.1275;
    const MANAPOOL_FEE_RATE = 0.079;
    const FLAT_FEE = 0.30;
    const rate = platform === 'TCGPlayer' ? TCGPLAYER_FEE_RATE : MANAPOOL_FEE_RATE;
    return (salePrice * rate) + FLAT_FEE;
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
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, './private/uploads/');
    },
    filename: (req, file, cb) => {
        // Create a unique filename: timestamp-originalName.pdf
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, uniqueSuffix + path.extname(file.originalname));
    }
});
const upload = multer({
    storage: storage,
    fileFilter: (req, file, cb) => {
        // --- ADDED LOGGING ---
        // This will print the exact file details the server sees.
        console.log('[DEBUG] Multer file filter received:', {
            fileName: file.originalname,
            mimeType: file.mimetype
        });
        // --- END LOGGING ---

        if (file.mimetype === "application/pdf") {
            cb(null, true);
        } else {
            // Reject the file with a specific error message.
            cb(new Error("File format not supported. Please upload a PDF."), false);
        }
    }
});


// The router is a function that accepts the database (db) connection
export default function(db) {
    const router = express.Router();

    const storage = multer.memoryStorage();
    const upload = multer({ storage });


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
            console.log(`🚀 Starting buylist scrape job for: ${cardName} (${setCode} #${collectorNumber})`);

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

            console.log(`✅ Buylist scrape successful:`, buylistData);
            
            res.json(buylistData);

        } catch (error) {
            console.error(`❌ Buylist scrape failed for ${cardName}:`, error);
            res.status(500).json({ error: 'An unexpected error occurred during the buylist scrape.' });
        } finally {
            if (browser) await browser.close();
        }
    });



    router.post('/scrape-lows', express.json(), async (req, res) => {
        // `condition` is optional, and `store` is a new optional parameter
        const { tcgplayerId, cardName, setCode, collectorNumber, foilType, condition, store } = req.body;

        // `condition` and `store` are not required
        if (!tcgplayerId || !cardName || !setCode || !collectorNumber || !foilType) {
            return res.status(400).json({ error: 'Missing required card identifiers for scraping.' });
        }

        let browser;
        try {
            const logMessage = condition ? `${cardName} (${condition} ${foilType})` : `${cardName} (Cheapest ${foilType})`;
            
            browser = await chromium.launch({ headless: true });
            const context = await browser.newContext({
                userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
            });
            const page = await context.newPage();
            
            let tcgLow = null;
            let tcgLowPlusShipping = null;
            let manaPoolLow = null;
            
            // --- NEW: Conditional scraping logic based on the 'store' parameter ---

            // If the store is specified as 'manapool', only scrape ManaPool.
            if (store === 'manapool') {
                console.log(`🚀 Starting ManaPool-only scrape job for: ${logMessage}`);

                const cardSlug = cardName.toLowerCase().replace(/\s/g, '-').replace(/[^a-z0-9-]/g, '');
                const manaPoolUrl = `https://manapool.com/card/${setCode.toLowerCase()}/${collectorNumber}/${cardSlug}`;
                const mpData = await scrapeManaPoolListings(page, manaPoolUrl, foilType, condition ? condition : "DMG");
                manaPoolLow = mpData.cheapestPrice;
                
                console.log(`✅ Scrape successful: MP=${manaPoolLow}`);
            } 
            // Otherwise, perform the default behavior of scraping both.
            else {
                console.log(`🚀 Starting full scrape job for: ${logMessage}`);

                const tcgData = await scrapeTcgplayerData(page, tcgplayerId, foilType, condition ? condition : "DMG");
                console.log (`   -> TCGplayer scrape returned:`, tcgData);
                tcgLow = tcgData.cheapestListing?.itemPrice ?? null; 
                tcgLowPlusShipping = tcgData.cheapestListing?.totalPrice ?? null;
                
                const cardSlug = cardName.toLowerCase().replace(/\s/g, '-').replace(/[^a-z0-9-]/g, '');
                const manaPoolUrl = `https://manapool.com/card/${setCode.toLowerCase()}/${collectorNumber}/${cardSlug}`;
                const mpData = await scrapeManaPoolListings(page, manaPoolUrl, foilType, condition ? condition : "DMG");
                manaPoolLow = mpData.cheapestPrice;

                console.log(`✅ Scrape successful: TCG=${tcgLow}, MP=${manaPoolLow}`);
            }
            
            res.json({
                tcgLow: tcgLow, // Will be null if only ManaPool was scraped
                tcgLowPlusShipping: tcgLowPlusShipping,
                manaPoolLow: manaPoolLow
            });

        } catch (error) {
            console.error(`❌ Scrape failed for ${cardName}:`, error);
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
    router.post('/inventory', express.json(), (req, res) => {
        // Add 'condition' to the destructured properties
        const { name, setCode, collectorNumber, foilType, pricePaid, quantity, tcgplayerId, condition, scryfallId } = req.body;
        const id = randomUUID();
        // Add the new column to the INSERT statement
        const sql = `INSERT INTO inventory (id, name, setCode, collectorNumber, foilType, pricePaid, quantity, tcgplayerId, condition, scryfallId)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
        // Add the condition to the parameters array
        const params = [id, name, setCode, collectorNumber, foilType, pricePaid, quantity, tcgplayerId, condition || 'NM', scryfallId];
        db.run(sql, params, function(err) {
            if (err) {
              console.error("Failed to add inventory item:", err);
              return res.status(400).json({ error: err.message });
            }
            res.status(201).json({ id: id });
        });
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
                t.id, t.soldAt, t.platform, t.shippingCost, t.totalSalePrice, t.netProfit, t.packingSlipPath,
                json_group_array(
                    json_object(
                        'name', i.name, 'setCode', i.setCode, 'condition', i.condition, 
                        'foilType', i.foilType, 'pricePaid', i.pricePaid, 
                        'salePrice', ti.salePrice, 'quantity', ti.quantity 
                    )
                ) as items
            FROM transactions t
            JOIN transaction_items ti ON t.id = ti.transactionId
            JOIN inventory i ON ti.inventoryId = i.id
            GROUP BY t.id
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
            });
            res.json(rows);
        });
    });


    /**
     * UPDATED: POST a new transaction with quantities and new profit logic.
     */
    router.post('/transactions', express.json(), (req, res) => {
        const { items, platform, shippingCost: customerPaidShipping } = req.body;

        if (!items || !Array.isArray(items) || items.length === 0) {
            return res.status(400).json({ error: 'Transaction must include at least one item.' });
        }

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

                const fees = calculateFees(totalSalePrice, platform);
                const grossRevenue = totalSalePrice + parseFloat(customerPaidShipping);
                const totalCost = totalPurchasePrice + fees + FIXED_SHIPPING_EXPENSE;
                const netProfit = grossRevenue - totalCost;
                const transactionId = randomUUID();

                const transSql = `INSERT INTO transactions (id, platform, shippingCost, totalSalePrice, netProfit) VALUES (?, ?, ?, ?, ?)`;
                db.run(transSql, [transactionId, platform, customerPaidShipping, totalSalePrice, netProfit], function(err) {
                    if (err) {
                        db.run("ROLLBACK");
                        return res.status(500).json({ error: `Failed to create transaction record: ${err.message}` });
                    }

                    // This function will process each item one by one.
                    function processItems(index) {
                        if (index >= items.length) {
                            // All items are processed, commit the transaction.
                            db.run("COMMIT", (err) => {
                                if (err) {
                                    db.run("ROLLBACK");
                                    return res.status(500).json({ error: `Failed to commit transaction: ${err.message}` });
                                }
                                return res.status(201).json({ id: transactionId });
                            });
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
            db.all("SELECT inventoryId, quantity, packingSlipPath FROM transactions t JOIN transaction_items ti ON t.id = ti.transactionId WHERE t.id = ?", [id], (err, items) => {
                if (err) { db.run("ROLLBACK"); return res.status(500).json({ error: err.message }); }
                if (items.length === 0) { db.run("ROLLBACK"); return res.status(404).json({ message: "Transaction not found." }); }
                
                const invSql = `UPDATE inventory SET quantity = quantity + ? WHERE id = ?`;
                const invStmt = db.prepare(invSql);
                for (const item of items) {
                    invStmt.run(item.quantity, item.inventoryId);
                }
                invStmt.finalize();

                db.run("DELETE FROM transaction_items WHERE transactionId = ?", [id]);
                db.run("DELETE FROM transactions WHERE id = ?", [id]);

                const slipPath = items[0].packingSlipPath;
                if (slipPath) {
                    fs.unlink(path.resolve(slipPath), (unlinkErr) => {
                        if (unlinkErr) console.error("Failed to delete packing slip file:", unlinkErr);
                    });
                }

                db.run("COMMIT", (commitErr) => {
                    if (commitErr) { db.run("ROLLBACK"); return res.status(500).json({ error: commitErr.message }); }
                    res.status(200).json({ message: "Transaction deleted and inventory restored." });
                });
            });
        });
    });

    /**
     * NEW: Endpoint for uploading a packing slip after a transaction is created.
     */
    // router.post('/transactions/:id/packing-slip', (req, res) => {
    //     const singleUpload = upload.single('packingSlip');

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
    router.post('/import-csv', upload.single('cardList'), (req, res) => {
        if (!req.file) return res.status(400).json({ message: 'No file uploaded.' });

        const results = [];
        const fileContent = req.file.buffer.toString('utf8');
        
        // --- NEW: File type detection and parsing logic ---
        if (req.file.originalname.endsWith('.txt')) {
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
        const sql = `INSERT INTO imported_lists (id, content, isPermanent) VALUES (?, ?, 0)`;
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
            // UPDATED: Select both content and isPermanent status
            const sql = `SELECT content, isPermanent FROM imported_lists WHERE id = ?`;

            db.get(sql, [listId], (err, row) => {
                if (err) return res.status(500).json({ message: 'Database error.' });
                if (!row) return res.status(404).json({ message: 'List not found.' });
                
                // Send back an object with both pieces of data
                res.json({
                    content: JSON.parse(row.content),
                    isPermanent: !!row.isPermanent // Convert 0/1 to false/true
                });
            });
        })

    // --- Endpoint to permanently save a list ---
    router.post('/list/:listId/save', (req, res) => {
        const { listId } = req.params;
        const sql = `UPDATE imported_lists SET isPermanent = 1 WHERE id = ?`;
        db.run(sql, [listId], function(err) {
            if (err) return res.status(500).json({ message: 'Database error.' });
            if (this.changes === 0) return res.status(404).json({ message: 'List not found.' });
            res.status(200).json({ message: 'List permanently saved.' });
            log(`✅ List ${listId} has been permanently saved.`);
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
        const sql = `INSERT INTO imported_lists (id, content, isPermanent) VALUES (?, ?, 1)`;
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
            
            let content = JSON.parse(row.content);
            
            // 2. Add the new card to the content array
            content.push({ name, setCode, collectorNumber, foilType, quantity });
            
            // 3. Update the database with the new content
            const newContentJson = JSON.stringify(content);
            const updateSql = `UPDATE imported_lists SET content = ? WHERE id = ?`;
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