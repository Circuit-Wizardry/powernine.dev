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

// The router is a function that accepts the database (db) connection
export default function(db) {
    const router = express.Router();

    const storage = multer.memoryStorage();
    const upload = multer({ storage });



    router.post('/scrape-lows', express.json(), async (req, res) => {
        // `condition` is now optional
        const { tcgplayerId, cardName, setCode, collectorNumber, foilType, condition } = req.body;

        // `condition` is removed from the required check
        if (!tcgplayerId || !cardName || !setCode || !collectorNumber || !foilType) {
            return res.status(400).json({ error: 'Missing required card identifiers for scraping.' });
        }

        let browser;
        try {
            const logMessage = condition ? `${cardName} (${condition} ${foilType})` : `${cardName} (Cheapest ${foilType})`;
            console.log(`🚀 Starting scrape job for: ${logMessage}`);
            
            browser = await chromium.launch({ headless: true });
            const context = await browser.newContext({
                userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
            });
            const page = await context.newPage();
            
            const tcgData = await scrapeTcgplayerData(page, tcgplayerId, foilType);
            const cardSlug = cardName.toLowerCase().replace(/\s/g, '-').replace(/[^a-z0-9-]/g, '');
            const manaPoolUrl = `https://manapool.com/card/${setCode.toLowerCase()}/${collectorNumber}/${cardSlug}`;
            const mpData = await scrapeManaPoolListings(page, manaPoolUrl, foilType);

            let tcgLow;
            let manaPoolLow;

            if (condition) {
                // Logic for inventory.js: get price for a specific condition
                tcgLow = tcgData.lowestPrices[condition];
                manaPoolLow = mpData.lowestPrices[condition];
            } else {
                // Logic for list.js: get the absolute lowest price from all conditions
                const tcgPrices = Object.values(tcgData.lowestPrices).filter(p => p > 0);
                tcgLow = tcgPrices.length > 0 ? Math.min(...tcgPrices) : null;

                const mpPrices = Object.values(mpData.lowestPrices).filter(p => p > 0);
                manaPoolLow = mpPrices.length > 0 ? Math.min(...mpPrices) : null;
            }

            console.log(`✅ Scrape successful: TCG=${tcgLow}, MP=${manaPoolLow}`);
            
            res.json({
                tcgLow: tcgLow || null,
                manaPoolLow: manaPoolLow || null
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
        db.all("SELECT * FROM inventory ORDER BY createdAt DESC", [], (err, rows) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json(rows);
        });
    });

    // NEW: PUT endpoint to save scraped prices for an item
    router.put('/inventory/:id/prices', express.json(), (req, res) => {
        const { id } = req.params;
        const { tcgLow, manaPoolLow } = req.body;

        const sql = `UPDATE inventory SET 
                        tcgLow = ?, 
                        manaPoolLow = ?, 
                        pricesLastUpdatedAt = CURRENT_TIMESTAMP 
                     WHERE id = ?`;
        
        db.run(sql, [tcgLow, manaPoolLow, id], function(err) {
            if (err) return res.status(400).json({ error: err.message });
            if (this.changes === 0) return res.status(404).json({ message: 'Item not found.'});
            res.status(200).json({ message: 'Prices updated successfully.' });
        });
    });


    // POST a new item to inventory
    router.post('/inventory', express.json(), (req, res) => {
        // Add 'condition' to the destructured properties
        const { name, setCode, collectorNumber, foilType, pricePaid, quantity, tcgplayerId, condition } = req.body;
        const id = randomUUID();
        // Add the new column to the INSERT statement
        const sql = `INSERT INTO inventory (id, name, setCode, collectorNumber, foilType, pricePaid, quantity, tcgplayerId, condition)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`;
        // Add the condition to the parameters array
        const params = [id, name, setCode, collectorNumber, foilType, pricePaid, quantity, tcgplayerId, condition || 'NM'];
        db.run(sql, params, function(err) {
            if (err) return res.status(400).json({ error: err.message });
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

    // --- Endpoint for getting price data from the unified database ---
    router.get('/prices/:setCode/:collectorNumber', (req, res) => {
        const { setCode, collectorNumber } = req.params;
        const uuidSql = `SELECT uuid FROM cards WHERE setCode = ? AND number = ?`;
        db.get(uuidSql, [setCode.toUpperCase(), collectorNumber], (err, cardRow) => {
            if (err || !cardRow) return res.status(404).json({ error: 'Card UUID not found in database.' });
            
            const mtgjsonUUID = cardRow.uuid;
            const priceSql = `SELECT price_json FROM price_history WHERE uuid = ?`;
            db.get(priceSql, [mtgjsonUUID], (err, priceRow) => {
                if (err || !priceRow) return res.status(404).json({ error: 'Price data not found for this card.' });
                res.json(JSON.parse(priceRow.price_json));
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