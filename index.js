const express = require('express');
const apiRoutes = require('./utils/api');
import cron from 'node-cron';
import { exec } from 'child_process';
const path = require('path');
const { initializeCardNameCache } = require('./utils/card-data');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '10mb' }));
app.use(express.static('public'));

initializeCardNameCache();

app.use('/api', apiRoutes);

// For any route matching the pattern, send the card-info.html file
app.get('/cards/:set/:number', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'card-info.html'));
});

console.log('Scheduling the daily database merge task...');
// Schedule to run at 3:00 AM every day
cron.schedule('0 3 * * *', () => {
    console.log(`[${new Date().toISOString()}] Kicking off daily database merge job...`);

    const mergeProcess = exec('node create_unified_db.js', (error, stdout, stderr) => {
        if (error) {
            console.error(`❌ [CRON-ERROR] Failed to run merge script: ${error.message}`);
            return;
        }
        if (stderr) {
            console.error(`❌ [CRON-STDERR] ${stderr}`);
        }
        console.log(`✅ [CRON-STDOUT] ${stdout}`);
    });
});

// Start server
app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});