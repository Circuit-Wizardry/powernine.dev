// card-info.js
document.addEventListener('DOMContentLoaded', async () => {
    const container = document.querySelector('.container');

    // --- Helper Functions ---
    const formatPrice = (price) => price ? `$${price.toFixed(2)}` : 'N/A';
    const capitalize = (s) => s ? s.charAt(0).toUpperCase() + s.slice(1) : '';
    const formatManaCost = (cost) => cost ? cost.replace(/\{/g, '').replace(/\}/g, '') : '';
    const formatOracleText = (text) => text ? text.replace(/\n/g, '<br>') : 'This card has no oracle text.';
    
    /**
     * Finds the most recent price from a price history object.
     * @param {Object} priceHistory - An object like {"2025-09-21": 5.00, "2025-09-22": 5.05}
     * @returns {number|undefined} The latest price value.
     */
    const getLatestPriceEntry = (priceHistory) => {
        if (!priceHistory || typeof priceHistory !== 'object' || Object.keys(priceHistory).length === 0) {
            return undefined;
        }
        const latestDate = Object.keys(priceHistory).sort((a, b) => new Date(b) - new Date(a))[0];
        return priceHistory[latestDate];
    };

    try {
        // 1. Get card identifiers from the URL path
        const pathParts = window.location.pathname.split('/').filter(p => p);
        if (pathParts.length < 3 || pathParts[0] !== 'cards') {
            throw new Error('Invalid URL. Expected /cards/[set_code]/[collector_number]');
        }
        const [setCode, collectorNumber] = [pathParts[1], pathParts[2]];

        // 2. Fetch primary card data from Scryfall
        const scryfallResponse = await fetch(`https://api.scryfall.com/cards/${setCode}/${collectorNumber}`);
        if (!scryfallResponse.ok) throw new Error('Card not found on Scryfall.');
        const cardData = await scryfallResponse.json();

        // 3. Inject the main HTML structure
        // MODIFIED: Added a new table for buylist prices with the id "buylistPricesTable"
        container.innerHTML = `
            <div class="left-panel">
                <img src="${cardData.image_uris?.large || ''}" alt="Card Image" class="card-image">
                <div class="oracle-text">${formatOracleText(cardData.oracle_text)}</div>
            </div>
            <div class="right-panel">
                <h2 class="card-name">${cardData.name}</h2>
                <p class="card-type">${cardData.type_line} <span class="mana-cost">${formatManaCost(cardData.mana_cost)}</span></p>
                

                <h3 class="table-header">today's market prices</h3>
                <table class="prices-table" id="pricesTable">
                    <thead><tr><th>vendor</th><th>normal</th><th>foil</th></tr></thead>
                    <tbody></tbody>
                </table>

                <h3 class="table-header">buylist prices</h3>
                <table class="prices-table" id="buylistPricesTable">
                    <thead><tr><th>vendor</th><th>normal</th><th>foil</th></tr></thead>
                    <tbody></tbody>
                </table>
                
                <h3 class="table-header">price history</h3>
                <canvas id="priceChart"></canvas>
            </div>
        `;
        document.title = `${cardData.name} - Card Info`;

        // 4. Fetch all price data from YOUR server's unified API
        try {
            const apiResponse = await fetch(`/api/prices/${setCode}/${collectorNumber}`);
            if (!apiResponse.ok) throw new Error('price data not found on server.');
            
            const priceData = await apiResponse.json();

            // Find elements AFTER they have been created by innerHTML
            const pricesTableBody = document.getElementById('pricesTable').querySelector('tbody');
            const buylistPricesTableBody = document.getElementById('buylistPricesTable').querySelector('tbody'); // NEW: Get the new table's body

            // --- Populate Today's Vendor Price Table ---
            const paperPrices = priceData?.paper;
            let vendorsFound = 0;
            if(paperPrices) {
                const vendors = ['tcgplayer', 'cardkingdom', 'cardmarket'];
                vendors.forEach(vendor => {
                    const retailPrices = paperPrices[vendor]?.retail;
                    if (retailPrices) {
                        vendorsFound++;
                        const latestNormal = getLatestPriceEntry(retailPrices.normal);
                        const latestFoil = getLatestPriceEntry(retailPrices.foil);
                        
                        const tr = document.createElement('tr');
                        tr.innerHTML = `
                            <td>${vendor}</td>
                            <td>${formatPrice(latestNormal)}</td>
                            <td>${formatPrice(latestFoil)}</td>
                        `;
                        pricesTableBody.appendChild(tr);
                    }
                });
            }
             if (vendorsFound === 0) {
                pricesTableBody.innerHTML = '<tr><td colspan="3">no daily price data available.</td></tr>';
            }

            // NEW: Section to populate the buylist table
            // --- Populate Today's Buylist Price Table ---
            let buylistVendorsFound = 0;
            if(paperPrices) {
                const vendors = ['tcgplayer', 'cardkingdom', 'cardmarket']; // Can re-use or define a new list if needed
                vendors.forEach(vendor => {
                    const buylistPrices = paperPrices[vendor]?.buylist; // Check for 'buylist' data
                    // We only add a row if the vendor has a buylist section with actual price data
                    if (buylistPrices && (Object.keys(buylistPrices.normal || {}).length > 0 || Object.keys(buylistPrices.foil || {}).length > 0)) {
                        buylistVendorsFound++;
                        const latestNormal = getLatestPriceEntry(buylistPrices.normal);
                        const latestFoil = getLatestPriceEntry(buylistPrices.foil);
                        
                        const tr = document.createElement('tr');
                        tr.innerHTML = `
                            <td>${vendor}</td>
                            <td>${formatPrice(latestNormal)}</td>
                            <td>${formatPrice(latestFoil)}</td>
                        `;
                        buylistPricesTableBody.appendChild(tr);
                    }
                });
            }
             if (buylistVendorsFound === 0) {
                buylistPricesTableBody.innerHTML = '<tr><td colspan="3">no buylist price data available.</td></tr>';
            }


            // --- Populate Multi-Vendor Price History Chart ---
            const vendorsToChart = [
                { name: 'TCGPlayer', path: priceData?.paper?.tcgplayer?.retail?.normal, color: 'rgba(75, 192, 192, 1)' },
                { name: 'Card Kingdom', path: priceData?.paper?.cardkingdom?.retail?.normal, color: 'rgba(255, 99, 132, 1)' },
                { name: 'Cardmarket', path: priceData?.paper?.cardmarket?.retail?.normal, color: 'rgba(54, 162, 235, 1)' }
            ];
            
            const allDates = new Set();
            const validVendorHistories = [];

            vendorsToChart.forEach(vendor => {
                const history = vendor.path;
                if (history && Object.keys(history).length > 0) {
                    validVendorHistories.push({ ...vendor, data: history });
                    Object.keys(history).forEach(date => allDates.add(date));
                }
            });

            if (validVendorHistories.length > 0) {
                const chartLabels = Array.from(allDates).sort((a, b) => new Date(a) - new Date(b));
                const datasets = [];

                validVendorHistories.forEach(vendor => {
                    const pricePoints = [];
                    let lastKnownPrice = null;
                    chartLabels.forEach(date => {
                        if (vendor.data[date] !== undefined) {
                            lastKnownPrice = vendor.data[date];
                        }
                        pricePoints.push(lastKnownPrice);
                    });

                    datasets.push({
                        label: `${vendor.name} Price`,
                        data: pricePoints,
                        borderColor: vendor.color,
                        backgroundColor: vendor.color.replace('1)', '0.2)'),
                        tension: 0.1,
                        fill: false,
                        spanGaps: true,
                    });
                });
                
                const ctx = document.getElementById('priceChart').getContext('2d');
                new Chart(ctx, {
                    type: 'line',
                    data: { labels: chartLabels, datasets: datasets },
                    options: {
                        scales: {
                            y: {
                                beginAtZero: false,
                                ticks: { callback: (value) => '$' + value.toFixed(2) }
                            }
                        },
                        interaction: { intersect: false, mode: 'index' },
                        plugins: {
                            tooltip: {
                                callbacks: {
                                    label: (context) => `${context.dataset.label}: ${new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(context.parsed.y)}`
                                }
                            }
                        }
                    }
                });
            } else {
                document.getElementById('priceChart').style.display = 'none';
            }

        } catch (priceError) {
            console.error('Price fetch error:', priceError);
            const purchaseTable = document.getElementById('purchaseLinksTable');
            if (purchaseTable) purchaseTable.querySelector('tbody').innerHTML = `<tr><td colspan="2">Could not load purchase data.</td></tr>`;
            const pricesTable = document.getElementById('pricesTable');
            if (pricesTable) pricesTable.querySelector('tbody').innerHTML = `<tr><td colspan="3">${priceError.message}</td></tr>`;
        }

    } catch (error) {
        console.error('Failed to load card page:', error);
        container.innerHTML = `<div class="error-message"><h1>Error</h1><p>${error.message}</p></div>`;
    }
});