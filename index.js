const express = require('express');
const apiRoutes = require('./utils/api');
const { initializeCardNameCache } = require('./utils/card-data');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '10mb' }));
app.use(express.static('public'));

initializeCardNameCache();

app.use('/api', apiRoutes);

// Start server
app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});