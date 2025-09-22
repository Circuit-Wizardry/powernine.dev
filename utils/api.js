const Database = require('better-sqlite3');
const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const { getCardNames } = require('./card-data');
const cron = require('node-cron');
const fs = require('fs');
const axios = require('axios');
const { mtgPricesData } = require('./pricing');

const router = express.Router();

const db = new sqlite3.Database('./AllPrintings.sqlite', sqlite3.OPEN_READONLY, (err) => {
    if (err) {
        console.error('Error connecting to the MTGJSON database:', err.message);
    } else {
        console.log('Successfully connected to the MTGJSON database.');
    }
});

router.get('/printings/:cardName', async (req, res) => {
    try {
        const cardName = req.params.cardName;
        const url = `https://api.scryfall.com/cards/search?q=!%22${encodeURIComponent(cardName)}%22&unique=prints&order=released`;

        const response = await axios.get(url);
        const allPrintings = response.data.data;

        const foilPrintings = [];
        const nonfoilPrintings = [];
        const etchedPrintings = [];

        for (const card of allPrintings) {
            // Check if the 'nonfoil' finish is available for this printing
            if (card.finishes.includes('nonfoil')) {
                nonfoilPrintings.push(card);
            }
            // Check if the 'foil' finish is available for this printing
            if (card.finishes.includes('foil')) {
                foilPrintings.push(card);
            }
            // Check if the 'etched' finish is available for this printing
            if (card.finishes.includes('etched')) {
                etchedPrintings.push(card);
            }
        }

        // Send a structured object with both arrays
        res.json({
            nonfoil: nonfoilPrintings,
            foil: foilPrintings,
            etched: etchedPrintings
        });

    } catch (error) {
        res.status(404).json({ error: "Could not find printings." });
    }
});

router.get('/prices/:setCode/:collectorNumber', (req, res) => {
    const { setCode, collectorNumber } = req.params;

    // Step 1: Query the database to get the MTGJSON UUID
    const sql = `SELECT uuid FROM cards WHERE setCode = ? AND number = ?`;
 
    db.get(sql, [setCode.toUpperCase(), collectorNumber], (err, row) => {
        if (err) {
            console.error(err);
            return res.status(500).json({ error: 'Database error occurred.' });
        }
        if (!row || !row.uuid) {
            return res.status(404).json({ error: 'Card not found in MTGJSON database.' });
        }

        // Step 2: Use the found MTGJSON UUID to look up the price in memory
        const mtgjsonUUID = row.uuid;
        const priceInfo = mtgPricesData[mtgjsonUUID];

        if (priceInfo) {
            res.json(priceInfo);
        } else {
            res.status(404).json({ error: 'Price data not found for this card.' });
        }
    });
});


router.get('/card-names', (req, res) => res.json(getCardNames()));


module.exports = router;