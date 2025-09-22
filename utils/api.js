import express from 'express';
import sqlite3Base from 'sqlite3';
import { Readable } from 'stream';
import multer from 'multer';
import csv from 'csv-parser';

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
    try {
        if (!req.file) {
            return res.status(400).json({ message: 'No file uploaded.' });
        }

        const results = [];
        const requiredColumns = ['Name', 'Set code', 'Collector number', 'Foil', 'Quantity'];
        const stream = Readable.from(req.file.buffer.toString('utf8'));
        let hasSentResponse = false; // Add a flag to prevent multiple responses

        stream
            .pipe(csv())
            .on('data', (row) => {
                if (hasSentResponse) return; // Ignore data if a response has already been sent

                if (results.length === 0) {
                    const headers = Object.keys(row);
                    if (!requiredColumns.every(col => headers.includes(col))) {
                        hasSentResponse = true;
                        stream.destroy(); // Stop the stream immediately
                        return res.status(400).json({ message: 'CSV is missing required columns.' });
                    }
                }

                const cardData = {
                    name: row['Name'],
                    setCode: row['Set code'],
                    collectorNumber: row['Collector number'],
                    isFoil: row['Foil'] ? row['Foil'].toLowerCase() !== 'normal' : false,
                    quantity: parseInt(row['Quantity'], 10) || 1,
                };
                results.push(cardData);
            })
            .on('end', () => {
                if (hasSentResponse) return; // Don't send a response if one was already sent
                
                res.status(200).json({
                    message: 'File processed successfully.',
                    processedCount: results.length,
                    data: results
                });
            })
            .on('error', (error) => {
                if (hasSentResponse) return; // Don't send a response if one was already sent
                
                console.error('Error processing CSV:', error);
                hasSentResponse = true;
                res.status(500).json({ message: 'Failed to process CSV file.' });
            });

    } catch (error) {
        console.error('Unexpected error:', error);
        res.status(500).json({ message: 'An unexpected error occurred.' });
    }
});


const db = new sqlite3.Database('./data/AllData.sqlite', sqlite3.OPEN_READONLY, (err) => {
    if (err) {
        console.error('Error connecting to the AllData database:', err.message);
    } else {
        console.log('Successfully connected to the AllData database for API routes.');
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