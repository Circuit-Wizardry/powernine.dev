// card-info.js
document.addEventListener('DOMContentLoaded', async () => {
    const container = document.querySelector('.container');
    let scryfallCardData; // Variable to hold card data for event listeners

    // --- Helper Functions ---
    const formatPrice = (price) => (typeof price === 'number' && Number.isFinite(price)) ? `$${price.toFixed(2)}` : 'N/A';
    const formatUsdString = (value) => {
        if (typeof value === 'number') return formatPrice(value);
        const parsed = Number.parseFloat(value);
        return Number.isFinite(parsed) ? formatPrice(parsed) : 'N/A';
    };
    const capitalize = (s) => s ? s.charAt(0).toUpperCase() + s.slice(1) : '';
    const formatManaCost = (cost) => cost ? cost.replace(/\{/g, '').replace(/\}/g, '') : '';
    const formatOracleText = (text) => text ? text.replace(/\n/g, '<br>') : 'This card has no oracle text.';
    const formatReleaseDate = (dateString) => {
        if (!dateString) return 'Date unknown';
        const date = new Date(dateString);
        if (Number.isNaN(date.getTime())) return 'Date unknown';
        return date.toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
    };
    const getPrintingImage = (printing = {}) => {
        if (printing.image_uris?.small) return printing.image_uris.small;
        if (Array.isArray(printing.card_faces) && printing.card_faces[0]?.image_uris?.small) {
            return printing.card_faces[0].image_uris.small;
        }
        return null;
    };

    // --- Hover Preview Setup ---
    const previewEl = document.createElement('div');
    previewEl.id = 'printing-preview';
    previewEl.innerHTML = '<img alt="Card preview">';
    document.body.appendChild(previewEl);
    const previewImg = previewEl.querySelector('img');

    const updatePreviewPosition = (event) => {
        const offset = 18;
        const x = event.clientX + offset;
        const y = event.clientY + offset;
        previewEl.style.left = `${x}px`;
        previewEl.style.top = `${y}px`;
    };

    const showPrintingPreview = (event, src) => {
        if (!src) return;
        previewImg.src = src;
        updatePreviewPosition(event);
        previewEl.classList.add('visible');
    };

    const hidePrintingPreview = () => {
        previewEl.classList.remove('visible');
    };
    
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


    let homeLink = document.querySelector('.global-home-link');
    if (!homeLink) {
        homeLink = document.createElement('a');
        homeLink.href = '/';
        homeLink.className = 'global-home-link';
        homeLink.textContent = '← Back to Home';
        document.body.appendChild(homeLink);
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
                <div class="printings-table-wrapper">
                    <div class="table-header-container">
                        <h3 class="table-header">printings</h3>
                    </div>
                    <table class="printings-table" id="printings-table">
                        <thead>
                            <tr>
                                <th>printing</th>
                                <th>release</th>
                                <th>non-foil</th>
                                <th>foil</th>
                            </tr>
                        </thead>
                        <tbody>
                            <tr><td colspan="4">Loading printings…</td></tr>
                        </tbody>
                    </table>
                </div>
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

                <div class="table-header-container">
                    <h3 class="table-header">price history</h3>
                </div>
                <canvas id="priceChart"></canvas>
            </div>
        `;
        document.title = `${scryfallCardData.name} - Card Info`;
        
        // 4. Attach event listeners now that the buttons exist in the DOM
        document.getElementById('scrape-lows-btn').addEventListener('click', handleScrapeLows);
        document.getElementById('scrape-buylists-btn').addEventListener('click', handleScrapeBuylists);
        const printingsTableBody = document.getElementById('printings-table')?.querySelector('tbody');

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

            const priceChartCanvas = document.getElementById('priceChart');
            if (priceChartCanvas && window.Chart) {
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
                            label: `${vendor.name}`,
                            data: pricePoints,
                            borderColor: vendor.color,
                            backgroundColor: vendor.color.replace('1)', '0.15)'),
                            tension: 0.2,
                            fill: false,
                            spanGaps: true,
                        });
                    });

                    new Chart(priceChartCanvas.getContext('2d'), {
                        type: 'line',
                        data: { labels: chartLabels, datasets },
                        options: {
                            scales: {
                                y: {
                                    beginAtZero: false,
                                    ticks: { callback: (value) => `$${Number(value).toFixed(2)}` }
                                },
                                x: {
                                    ticks: { color: '#d1d5db' }
                                }
                            },
                            interaction: { intersect: false, mode: 'index' },
                            plugins: {
                                tooltip: {
                                    callbacks: {
                                        label: (context) => `${context.dataset.label}: ${formatPrice(context.parsed.y)}`
                                    }
                                },
                                legend: {
                                    labels: { color: '#e2e8f0' }
                                }
                            }
                        }
                    });
                } else {
                    priceChartCanvas.style.display = 'none';
                }
            } else if (priceChartCanvas) {
                priceChartCanvas.style.display = 'none';
            }


        } catch (priceError) {
            console.error('Price fetch error:', priceError);
            const pricesTable = document.getElementById('pricesTable');
            if (pricesTable) pricesTable.querySelector('tbody').innerHTML = `<tr><td colspan="3">${priceError.message}</td></tr>`;
             const buylistPricesTable = document.getElementById('buylistPricesTable');
            if (buylistPricesTable) buylistPricesTable.querySelector('tbody').innerHTML = `<tr><td colspan="3">${priceError.message}</td></tr>`;
        }

        const renderPrintingsTable = (printings) => {
            if (!printingsTableBody) return;
            if (!Array.isArray(printings) || printings.length === 0) {
                printingsTableBody.innerHTML = '<tr><td colspan="4">No additional printings available.</td></tr>';
                return;
            }

            const currentSetCode = setCode.toLowerCase();
            const currentNumber = String(collectorNumber).toLowerCase();

            const sorted = [...printings]
                .filter(printing => printing && printing.set && printing.collector_number)
                .sort((a, b) => {
                    const dateA = new Date(a.released_at || a.releaseDate || 0);
                    const dateB = new Date(b.released_at || b.releaseDate || 0);
                    return dateB - dateA;
                });

            if (sorted.length === 0) {
                printingsTableBody.innerHTML = '<tr><td colspan="4">No additional printings available.</td></tr>';
                return;
            }

            printingsTableBody.innerHTML = '';

            sorted.forEach(printing => {
                const isCurrent = printing.set?.toLowerCase() === currentSetCode &&
                    String(printing.collector_number).toLowerCase() === currentNumber;
                const foilPrice = printing.prices?.usd_foil ?? printing.prices?.usd_etched ?? null;
                const codeLabel = `[${printing.set?.toUpperCase() || '???'}] #${printing.collector_number}`;
                const imageSrc = getPrintingImage(printing) || scryfallCardData.image_uris?.small || scryfallCardData.image_uris?.normal || '';

                const row = document.createElement('tr');
                row.className = `printing-row${isCurrent ? ' current-printing' : ''}`;
                row.dataset.set = printing.set || '';
                row.dataset.number = printing.collector_number || '';
                if (imageSrc) {
                    row.dataset.image = imageSrc;
                }

                row.innerHTML = `
                    <td>
                        <strong class="printing-code">${codeLabel}</strong>
                        ${isCurrent ? '<span class="printing-pill">Viewing</span>' : ''}
                    </td>
                    <td>${formatReleaseDate(printing.released_at || printing.releaseDate)}</td>
                    <td class="price-cell">${formatUsdString(printing.prices?.usd)}</td>
                    <td class="price-cell">${formatUsdString(foilPrice)}</td>
                `;

                if (!isCurrent) {
                    row.addEventListener('click', () => {
                        const targetSet = row.dataset.set;
                        const targetNumber = row.dataset.number;
                        if (targetSet && targetNumber) {
                            window.location.href = `/cards/${targetSet}/${targetNumber}`;
                        }
                    });
                }

                row.addEventListener('mouseenter', (event) => {
                    const image = row.dataset.image;
                    if (image) {
                        showPrintingPreview(event, image);
                    }
                });

                row.addEventListener('mousemove', (event) => {
                    updatePreviewPosition(event);
                });

                row.addEventListener('mouseleave', hidePrintingPreview);

                printingsTableBody.appendChild(row);
            });
        };

        const loadPrintingsTable = async () => {
            if (!printingsTableBody || !scryfallCardData?.name) return;
            printingsTableBody.innerHTML = '<tr><td colspan="4">Loading printings…</td></tr>';
            try {
                const response = await fetch(`/api/printings/${encodeURIComponent(scryfallCardData.name)}`);
                if (!response.ok) throw new Error('Could not load printings for this card.');
                const printings = await response.json();
                renderPrintingsTable(printings);
            } catch (printingError) {
                console.error('Printings fetch error:', printingError);
                printingsTableBody.innerHTML = `<tr><td colspan="4">${printingError.message}</td></tr>`;
            }
        };

        loadPrintingsTable();

    } catch (error) {
        console.error('Failed to load card page:', error);
        container.innerHTML = `<div class="error-message"><h1>Error</h1><p>${error.message}</p></div>`;
    }
});
