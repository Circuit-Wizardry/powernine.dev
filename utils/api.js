const Database = require('better-sqlite3');
const express = require('express');
const { getCardNames } = require('./card-data');
const axios = require('axios');


const router = express.Router();

router.get('/printings/:cardName', async (req, res) => {
    try {
        const cardName = req.params.cardName;
        const url = `https://api.scryfall.com/cards/search?q=!%22${encodeURIComponent(cardName)}%22&unique=prints&order=released`;
        const response = await axios.get(url);
        res.json(response.data.data);
    } catch (error) {
        res.status(404).json({ error: "Could not find printings." });
    }
});

router.get('/card-names', (req, res) => res.json(getCardNames()));


module.exports = router;