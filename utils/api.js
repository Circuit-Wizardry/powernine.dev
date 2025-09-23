import express from 'express';
import { Readable } from 'stream';
import multer from 'multer';
import csv from 'csv-parser';
import { getCardNames } from './card-data.js';
import axios from 'axios';
import { randomUUID } from 'crypto';
import { log } from '../discord.js'

// The router is a function that accepts the database (db) connection
export default function(db) {
    const router = express.Router();

    const storage = multer.memoryStorage();
    const upload = multer({ storage });

    // --- Endpoint to create a new, temporary list from a CSV ---
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
                    name: row['Name'], setCode: row['Set code'], collectorNumber: row['Collector number'],
                    foilType: foilType, quantity: parseInt(row['Quantity'], 10) || 1,
                });
            })
            .on('end', () => {
                if (results.length === 0) return res.status(400).json({ message: 'CSV is empty or invalid.' });

                const listId = randomUUID();
                const content = JSON.stringify(results);
                const sql = `INSERT INTO imported_lists (id, content, isPermanent) VALUES (?, ?, 0)`;
                db.run(sql, [listId, content], (err) => {
                    if (err) return res.status(500).json({ message: 'Failed to save card list.' });
                    res.status(200).json({ listId: listId });
                });
            })
            .on('error', (err) => res.status(500).json({ message: 'Failed to process CSV file.' }));
    });
    
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
    
    return router;
}