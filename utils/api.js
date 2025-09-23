import express from 'express';
import sqlite3Base from 'sqlite3';
import { Readable } from 'stream';
import multer from 'multer';
import csv from 'csv-parser';
import { randomUUID } from 'crypto';

import { getCardNames } from './card-data.js';
import axios from 'axios';

const router = express.Router();
const sqlite3 = sqlite3Base.verbose();

// Configure multer for file uploads
const storage = multer.memoryStorage(); // Store file in memory
const upload = multer({ 
    storage: storage,
    limits: { fileSize: 5 * 1024 * 1024 } // 5MB limit
});

    router.post('/import-csv', upload.single('cardList'), (req, res) => {
        if (!req.file) return res.status(400).json({ message: 'No file uploaded.' });

        const results = [];
        const requiredColumns = ['Name', 'Set code', 'Collector number', 'Foil', 'Quantity'];
        const stream = Readable.from(req.file.buffer.toString('utf8'));
        
        stream.pipe(csv())
            .on('data', (row) => {
                let foilType = (row['Foil'] || 'normal').toLowerCase();
                if (!['normal', 'foil', 'etched'].includes(foilType)) foilType = 'normal';

                results.push({
                    name: row['Name'],
                    setCode: row['Set code'],
                    collectorNumber: row['Collector number'],
                    foilType: foilType,
                    quantity: parseInt(row['Quantity'], 10) || 1,
                });
            })
            .on('end', () => {
                if (results.length === 0) {
                    return res.status(400).json({ message: 'CSV file is empty or invalid.' });
                }

                // 1. Generate a new unique ID for this list
                const listId = randomUUID();
                // 2. Convert the processed card data to a JSON string for storage
                const content = JSON.stringify(results);

                // 3. Save the new list to the database
                const sql = `INSERT INTO imported_lists (id, content) VALUES (?, ?)`;
                db.run(sql, [listId, content], (err) => {
                    if (err) {
                        console.error('Database error on CSV import:', err);
                        return res.status(500).json({ message: 'Failed to save card list.' });
                    }
                    // 4. Send the new ID back to the frontend
                    res.status(200).json({
                        message: 'List saved successfully.',
                        listId: listId // This is the key for the shareable URL
                    });
                    console.log(`New card list saved with ID: ${listId}`);
                });
            })
            .on('error', (err) => {
                res.status(500).json({ message: 'Failed to process CSV file.' });
            });
    });
    
    // --- NEW ENDPOINT to fetch a saved list ---
    router.get('/list/:listId', (req, res) => {
        const { listId } = req.params;
        const sql = `SELECT content FROM imported_lists WHERE id = ?`;

        db.get(sql, [listId], (err, row) => {
            if (err) return res.status(500).json({ message: 'Database error.' });
            if (!row) return res.status(404).json({ message: 'List not found.' });

            // The content is a JSON string, so send it directly
            res.setHeader('Content-Type', 'application/json');
            res.send(row.content);
        });
    });


const db = new sqlite3.Database('./data/AllData.sqlite', sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE, (err) => {
    if (err) {
        console.error('Error connecting to AllData.sqlite:', err.message);
    } else {
        console.log('Successfully connected to AllData.sqlite database.');
        // Create the table for storing shared lists if it doesn't exist
        db.run(`
            CREATE TABLE IF NOT EXISTS imported_lists (
                id TEXT PRIMARY KEY,
                content TEXT NOT NULL,
                createdAt DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `, (err) => {
            if (err) console.error("Error creating 'imported_lists' table:", err.message);
            else console.log("'imported_lists' table is ready.");
        });
    }
});

router.get('/printings/:cardName', async (req, res) => {
    try {
        const cardName = req.params.cardName;
        const url = `https://api.scryfall.com/cards/search?q=!%22${encodeURIComponent(cardName)}%22&unique=prints&order=released`;
        const response = await axios.get(url);
        // ... (rest of the logic is the same)
        const allPrintings = response.data.data;
        const foilPrintings = [], nonfoilPrintings = [], etchedPrintings = [];
        for (const card of allPrintings) {
            if (card.finishes.includes('nonfoil')) nonfoilPrintings.push(card);
            if (card.finishes.includes('foil')) foilPrintings.push(card);
            if (card.finishes.includes('etched')) etchedPrintings.push(card);
        }
        res.json({ nonfoil: nonfoilPrintings, foil: foilPrintings, etched: etchedPrintings });
    } catch (error) {
        res.status(404).json({ error: "Could not find printings on Scryfall." });
    }
});

router.get('/prices/:setCode/:collectorNumber', (req, res) => {
    const { setCode, collectorNumber } = req.params;

    // Step 1: Get the card's MTGJSON UUID from the 'cards' table.
    const uuidSql = `SELECT uuid FROM cards WHERE setCode = ? AND number = ?`;

    db.get(uuidSql, [setCode.toUpperCase(), collectorNumber], (err, cardRow) => {
        if (err) {
            console.error(err);
            return res.status(500).json({ error: 'Database error while finding card UUID.' });
        }
        if (!cardRow || !cardRow.uuid) {
            return res.status(404).json({ error: 'Card not found in the database.' });
        }

        const mtgjsonUUID = cardRow.uuid;

        // Step 2: Use the UUID to get price data from the 'price_history' table.
        // UPDATED the table to 'price_history' and the column to 'price_json'
        const priceSql = `SELECT price_json FROM price_history WHERE uuid = ?`;
        
        db.get(priceSql, [mtgjsonUUID], (err, priceRow) => {
            if (err) {
                console.error(err);
                return res.status(500).json({ error: 'Database error while fetching prices.' });
            }
            if (!priceRow || !priceRow.price_json) {
                return res.status(404).json({ error: 'Price data not found for this card.' });
            }

            // Step 3: The data is stored as a text string, so parse it before sending.
            // UPDATED to parse the 'price_json' column
            const priceObject = JSON.parse(priceRow.price_json);
            res.json(priceObject);
        });
    });
});

router.get('/card-names', (req, res) => {
    res.json(getCardNames());
});

export default router;