// card-info.js
document.addEventListener('DOMContentLoaded', async () => {
    const container = document.querySelector('.container');
    let scryfallCardData; // Variable to hold card data for event listeners

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

    // --- Scraper Event Handlers ---
    async function handleScrapeLows() {
        const btn = document.getElementById('scrape-lows-btn');
        btn.disabled = true;
        btn.textContent = 'Scraping...';

        try {
            const tcgplayerId = scryfallCardData.tcgplayer_id;
            if (!tcgplayerId) {
                throw new Error('TCGPlayer ID not found for this card.');
            }

            const basePayload = {
                cardName: scryfallCardData.name,
                setCode: scryfallCardData.set,
                collectorNumber: scryfallCardData.collector_number,
                tcgplayerId: tcgplayerId,
            };

            // Scrape for both normal and foil prices in parallel
            const [normalResponse, foilResponse] = await Promise.all([
                fetch('/api/scrape-lows', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ ...basePayload, foilType: 'normal' }),
                }),
                fetch('/api/scrape-lows', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ ...basePayload, foilType: 'foil' }),
                })
            ]);

            if (!normalResponse.ok || !foilResponse.ok) {
                const errorText = await (normalResponse.ok ? foilResponse.text() : normalResponse.text());
                throw new Error(`Failed to fetch scraped prices. Server says: ${errorText}`);
            }

            const normalData = await normalResponse.json();
            const foilData = await foilResponse.json();

            const pricesTableBody = document.getElementById('pricesTable').querySelector('tbody');

            // Upsert TCGPlayer Live Row
            let tcgLiveRow = document.getElementById('tcg-live-row');
            if (!tcgLiveRow) {
                tcgLiveRow = document.createElement('tr');
                tcgLiveRow.id = 'tcg-live-row';
                pricesTableBody.appendChild(tcgLiveRow);
            }
            tcgLiveRow.innerHTML = `
                <td>tcgplayer (live)</td>
                <td>${formatPrice(normalData.tcgLowPlusShipping)}</td>
                <td>${formatPrice(foilData.tcgLowPlusShipping)}</td>
            `;

            // Upsert ManaPool Live Row
            let mpLiveRow = document.getElementById('mp-live-row');
            if (!mpLiveRow) {
                mpLiveRow = document.createElement('tr');
                mpLiveRow.id = 'mp-live-row';
                pricesTableBody.appendChild(mpLiveRow);
            }
            mpLiveRow.innerHTML = `
                <td>manapool (live)</td>
                <td>${formatPrice(normalData.manaPoolLow)}</td>
                <td>${formatPrice(foilData.manaPoolLow)}</td>
            `;

        } catch (error) {
            console.error('Error scraping lows:', error);
            // In a real app, you'd show this in a UI element, not an alert.
            alert(`Scraping failed: ${error.message}`);
        } finally {
            btn.disabled = false;
            btn.textContent = 'Scrape Lows';
        }
    }

    async function handleScrapeBuylists() {
        const btn = document.getElementById('scrape-buylists-btn');
        btn.disabled = true;
        btn.textContent = 'Scraping...';
        
        try {
            const basePayload = {
                cardName: scryfallCardData.name,
                setCode: scryfallCardData.set,
                collectorNumber: scryfallCardData.collector_number,
            };
            
            const [normalResponse, foilResponse] = await Promise.all([
                fetch('/api/scrape-buylists', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ ...basePayload, foilType: 'normal' }),
                }),
                fetch('/api/scrape-buylists', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ ...basePayload, foilType: 'foil' }),
                })
            ]);

            if (!normalResponse.ok || !foilResponse.ok) {
                 const errorText = await (normalResponse.ok ? foilResponse.text() : normalResponse.text());
                throw new Error(`Failed to fetch scraped buylist prices. Server says: ${errorText}`);
            }

            const normalData = await normalResponse.json();
            const foilData = await foilResponse.json();

            const buylistTableBody = document.getElementById('buylistPricesTable').querySelector('tbody');

            let scgLiveRow = document.getElementById('scg-live-row');
            if (!scgLiveRow) {
                scgLiveRow = document.createElement('tr');
                scgLiveRow.id = 'scg-live-row';
                buylistTableBody.appendChild(scgLiveRow);
            }
            scgLiveRow.innerHTML = `
                <td>starcitygames (live)</td>
                <td>${formatPrice(normalData.scgBuylist)}</td>
                <td>${formatPrice(foilData.scgBuylist)}</td>
            `;

        } catch (error) {
            console.error('Error scraping buylists:', error);
            alert(`Scraping failed: ${error.message}`);
        } finally {
            btn.disabled = false;
            btn.textContent = 'Scrape Buylists';
        }
    }


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
        scryfallCardData = await scryfallResponse.json();

        // 3. Inject the main HTML structure
        container.innerHTML = `
            <div class="left-panel">
                <img src="${scryfallCardData.image_uris?.large || ''}" alt="Card Image" class="card-image">
                <div class="oracle-text">${formatOracleText(scryfallCardData.oracle_text)}</div>
            </div>
            <div class="right-panel">
                <h2 class="card-name">${scryfallCardData.name}</h2>
                <p class="card-type">${scryfallCardData.type_line} <span class="mana-cost">${formatManaCost(scryfallCardData.mana_cost)}</span></p>
                
                <div class="table-header-container">
                    <h3 class="table-header">today's market prices</h3>
                    <button id="scrape-lows-btn" class="scrape-btn">Scrape Lows</button>
                </div>
                <table class="prices-table" id="pricesTable">
                    <thead><tr><th>vendor</th><th>normal</th><th>foil</th></tr></thead>
                    <tbody></tbody>
                </table>

                <div class="table-header-container">
                    <h3 class="table-header">buylist prices</h3>
                    <button id="scrape-buylists-btn" class="scrape-btn">Scrape Buylists</button>
                </div>
                <table class="prices-table" id="buylistPricesTable">
                    <thead><tr><th>vendor</th><th>normal</th><th>foil</th></tr></thead>
                    <tbody></tbody>
                </table>
                
                <h3 class="table-header">price history</h3>
                <canvas id="priceChart"></canvas>
            </div>
        `;
        document.title = `${scryfallCardData.name} - Card Info`;
        
        // 4. Attach event listeners now that the buttons exist in the DOM
        document.getElementById('scrape-lows-btn').addEventListener('click', handleScrapeLows);
        document.getElementById('scrape-buylists-btn').addEventListener('click', handleScrapeBuylists);

        // 5. Fetch all price data from YOUR server's unified API
        try {
            const apiResponse = await fetch(`/api/card/details/${setCode}/${collectorNumber}`);
            if (!apiResponse.ok) throw new Error('price data not found on server.');
            
            const data = await apiResponse.json();
            const priceData = data.prices;

            console.log('Fetched price data:', priceData);

            // Find elements AFTER they have been created by innerHTML
            const pricesTableBody = document.getElementById('pricesTable').querySelector('tbody');
            const buylistPricesTableBody = document.getElementById('buylistPricesTable').querySelector('tbody');

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

            // --- Populate Today's Buylist Price Table ---
            let buylistVendorsFound = 0;
            if(paperPrices) {
                const vendors = ['tcgplayer', 'cardkingdom', 'cardmarket'];
                vendors.forEach(vendor => {
                    const buylistPrices = paperPrices[vendor]?.buylist; 
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
            const pricesTable = document.getElementById('pricesTable');
            if (pricesTable) pricesTable.querySelector('tbody').innerHTML = `<tr><td colspan="3">${priceError.message}</td></tr>`;
             const buylistPricesTable = document.getElementById('buylistPricesTable');
            if (buylistPricesTable) buylistPricesTable.querySelector('tbody').innerHTML = `<tr><td colspan="3">${priceError.message}</td></tr>`;
        }

    } catch (error) {
        console.error('Failed to load card page:', error);
        container.innerHTML = `<div class="error-message"><h1>Error</h1><p>${error.message}</p></div>`;
    }
});
