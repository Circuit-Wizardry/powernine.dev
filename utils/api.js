import express from 'express';
import sqlite3Base from 'sqlite3';
import { getCardNames } from './card-data.js';
import axios from 'axios';

const router = express.Router();
const sqlite3 = sqlite3Base.verbose();

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