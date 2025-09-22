document.addEventListener('DOMContentLoaded', async () => {
    const container = document.querySelector('.container');

    // --- Helper Functions ---
    const formatPrice = (price) => price ? `$${price.toFixed(2)}` : 'N/A';
    const capitalize = (s) => s ? s.charAt(0).toUpperCase() + s.slice(1) : '';
    const formatManaCost = (cost) => cost ? cost.replace(/\{/g, '').replace(/\}/g, '') : '';
    const formatOracleText = (text) => text ? text.replace(/\n/g, '<br>') : 'This card has no oracle text.';

    try {
        // 1. Get card identifiers from the URL path
        const pathParts = window.location.pathname.split('/').filter(p => p);
        if (pathParts.length < 3 || pathParts[0] !== 'cards') {
            throw new Error('Invalid URL. Expected /cards/[set_code]/[collector_number]');
        }
        const [setCode, collectorNumber] = [pathParts[1], pathParts[2]];

        // 2. Fetch primary card data from Scryfall (best for images, text, etc.)
        const scryfallResponse = await fetch(`https://api.scryfall.com/cards/${setCode}/${collectorNumber}`);
        if (!scryfallResponse.ok) throw new Error('Card not found on Scryfall.');
        const cardData = await scryfallResponse.json();

        // 3. Inject the main HTML structure
        container.innerHTML = `
            <div class="left-panel">
                <img src="${cardData.image_uris?.large || ''}" alt="Card Image" class="card-image">
                <div class="oracle-text">${formatOracleText(cardData.oracle_text)}</div>
            </div>
            <div class="right-panel">
                <h2 class="card-name">${cardData.name}</h2>
                <p class="card-type">${cardData.type_line} <span class="mana-cost">${formatManaCost(cardData.mana_cost)}</span></p>
                
                <h3 class="table-header">Purchase This Card</h3>
                <table class="prices-table" id="purchaseLinksTable">
                    <thead><tr><th>Storefront</th><th>Link</th></tr></thead>
                    <tbody></tbody>
                </table>

                <h3 class="table-header">Market Prices</h3>
                <table class="prices-table" id="pricesTable">
                    <thead><tr><th>Vendor</th><th>Normal</th><th>Foil</th></tr></thead>
                    <tbody></tbody>
                </table>
                
                <h3 class="table-header">Price History (TCGPlayer)</h3>
                <canvas id="priceChart"></canvas>
            </div>
        `;
        document.title = `${cardData.name} - Card Info`;

        // 4. Fetch price, history, and purchase data from YOUR server's unified API
        const pricesTableBody = document.getElementById('pricesTable').querySelector('tbody');
        try {
            const apiResponse = await fetch(`/api/prices/${setCode}/${collectorNumber}`);
            if (!apiResponse.ok) throw new Error('Price data not found on server.');
            
            const priceData = await apiResponse.json();
            const paperData = priceData.paper;

            if (!paperData) throw new Error('No paper pricing data available.');

            // --- Populate Purchase Links Table ---
            const purchaseLinksTableBody = document.getElementById('purchaseLinksTable').querySelector('tbody');
            const purchaseUrls = paperData.purchaseUrls;
            if (purchaseUrls && Object.keys(purchaseUrls).length > 0) {
                for (const [vendor, url] of Object.entries(purchaseUrls)) {
                    const tr = document.createElement('tr');
                    tr.innerHTML = `
                        <td>${capitalize(vendor)}</td>
                        <td><a href="${url}" target="_blank" rel="noopener noreferrer">Buy Now</a></td>
                    `;
                    purchaseLinksTableBody.appendChild(tr);
                }
            } else {
                purchaseLinksTableBody.innerHTML = '<tr><td colspan="2">No purchase links available.</td></tr>';
            }

            // --- Populate Vendor Price Table ---
            const vendors = ['tcgplayer', 'cardkingdom', 'cardmarket'];
            let vendorsFound = 0;
            vendors.forEach(vendor => {
                const retailPrices = paperData[vendor]?.retail;
                if (retailPrices) {
                    vendorsFound++;
                    const latestNormal = retailPrices.normal ? Object.values(retailPrices.normal)[0] : undefined;
                    const latestFoil = retailPrices.foil ? Object.values(retailPrices.foil)[0] : undefined;
                    
                    const tr = document.createElement('tr');
                    tr.innerHTML = `
                        <td>${capitalize(vendor)}</td>
                        <td>${formatPrice(latestNormal)}</td>
                        <td>${formatPrice(latestFoil)}</td>
                    `;
                    pricesTableBody.appendChild(tr);
                }
            });
             if (vendorsFound === 0) {
                pricesTableBody.innerHTML = '<tr><td colspan="3">No daily price data available.</td></tr>';
            }

            // --- Populate Price History Chart ---
            const tcgplayerHistory = paperData.tcgplayer?.retail?.normal;
            if (tcgplayerHistory && Object.keys(tcgplayerHistory).length > 1) {
                const priceHistory = Object.entries(tcgplayerHistory).sort((a, b) => new Date(a[0]) - new Date(b[0]));
                const chartLabels = priceHistory.map(entry => entry[0]);
                const chartDataPoints = priceHistory.map(entry => entry[1]);
                
                const ctx = document.getElementById('priceChart').getContext('2d');
                new Chart(ctx, { /* ... Chart.js configuration ... */ });
            }

        } catch (priceError) {
            console.error('Price fetch error:', priceError);
            document.getElementById('purchaseLinksTable').querySelector('tbody').innerHTML = `<tr><td colspan="2">${priceError.message}</td></tr>`;
            pricesTableBody.innerHTML = `<tr><td colspan="3">${priceError.message}</td></tr>`;
        }

    } catch (error) {
        console.error('Failed to load card page:', error);
        container.innerHTML = `<div class="error-message"><h1>Error</h1><p>${error.message}</p></div>`;
    }
});