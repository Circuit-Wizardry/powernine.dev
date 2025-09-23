import express from 'express';
import path from 'path';
import cron from 'node-cron';
import { exec } from 'child_process';
import { fileURLToPath } from 'url';
import { initializeCardNameCache } from './utils/card-data.js';
import apiRoutes from './utils/api.js'; 

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '10mb' }));
app.use(express.static('public'));

initializeCardNameCache();

// Use the API routes
app.use('/api', apiRoutes);

// For any route matching the pattern, send the card-info.html file
app.get('/cards/:set/:number', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'card-info.html'));
});

app.get('/list/:listId', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'list.html'));
});

app.get('/binder/:listId', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'binder.html'));
});

console.log('Scheduling the daily database merge task...');
// Schedule to run at 3:00 AM every day
cron.schedule('0 3 * * *', () => {
    console.log(`[${new Date().toISOString()}] Kicking off daily database merge job...`);

    const mergeProcess = exec('node daily-update.js', (error, stdout, stderr) => {
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