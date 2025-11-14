document.addEventListener('DOMContentLoaded', () => {
    // --- DOM ELEMENTS ---
    const container = document.getElementById('card-list-container');
    const switchViewBtn = document.getElementById('switch-view-btn');
    const searchBar = document.getElementById('search-bar'); // This is the MAIN list filter
    const saveListBtn = document.getElementById('save-list-btn');
    const sortButtons = document.querySelectorAll('.sort-button');
    const buylistAnalysisBtn = document.getElementById('buylist-analysis-btn');
    const listTitleEl = document.getElementById('list-title');
    const renameListBtn = document.getElementById('rename-list-btn');
    const addCardSearch = document.getElementById('add-card-search'); // This is for ADDING new cards
    const addCardResults = document.getElementById('add-card-results');
    const totalValueEl = document.getElementById('total-value-amount');
    const ckBuylistTotalEl = document.getElementById('ck-buylist-total');
    const ckReturnEl = document.getElementById('ck-return-percentage');
    const warningBanner = document.getElementById('save-warning');
    const previewer = document.getElementById('card-previewer');
    const previewImage = document.getElementById('card-preview-image');
    const progressLabel = document.getElementById('progressLabel');


    // --- CONSTANTS FOR FEE CALCULATION ---
    const TCGPLAYER_FEE_RATE = 0.1275;
    const MANAPOOL_FEE_RATE = 0.079;
    const FLAT_FEE = 0.30;
    const LARGE_CARD_IMAGE_PLACEHOLDER = 'https://placehold.co/245x342/1a1a1a/e0e0e0?text=N/A';
    const buildLargeTcgImageUrl = (tcgId) => (tcgId ? `https://tcgplayer-cdn.tcgplayer.com/product/${tcgId}_in_1000x1000.jpg` : null);

    // --- STATE ---
    let allCards = [];
    let currentSort = { key: 'price', order: 'desc' };
    let totalCollectionValue = 0;
    let totalCardKingdomBuylistValue = 0;
    let isListSaved = false;
    let listName = null;
    let listBuylistSnapshot = null;
    const pathParts = window.location.pathname.split('/');
    const listId = pathParts[pathParts.length - 1];

    // --- HELPER FUNCTIONS ---
    if (!window.cardUtils) {
        console.error('cardUtils utilities are not available.');
        return;
    }
    const { generateId, CardSearchWidget } = window.cardUtils;

    const calculateBreakevenPrice = (buyPrice, feeRate, flatFee) => {
        if (buyPrice <= 0) return 0;
        return (buyPrice + flatFee) / (1 - feeRate) + 1.25; // Adding $1.25 shipping buffer
    };

    const getLatestPrice = (priceHistory) => {
        if (!priceHistory || typeof priceHistory !== 'object' || Object.keys(priceHistory).length === 0) return 0;
        const latestDate = Object.keys(priceHistory).sort((a, b) => new Date(b) - new Date(a))[0];
        return priceHistory[latestDate] || 0;
    };

    const formatCurrency = (value) => {
        if (typeof value === 'number' && Number.isFinite(value)) {
            return `$${value.toFixed(2)}`;
        }
        return 'N/A';
    };

    const formatListName = (value) => {
        if (typeof value === 'string') {
            const trimmed = value.trim();
            if (trimmed.length > 0) return trimmed;
        }
        return '<unnamed list>';
    };

    const updateListTitle = () => {
        if (listTitleEl) {
            listTitleEl.textContent = formatListName(listName);
        }
        document.title = `${formatListName(listName)} - Imported Card Collection`;
    };

    const promptForListNameValue = (initialValue = '') => {
        const result = window.prompt('Name this list (leave blank for "<unnamed list>"):', initialValue);
        if (result === null) {
            return { cancelled: true, value: null };
        }
        return { cancelled: false, value: result.trim() };
    };

    const hasLiveTcgLow = (card) => typeof card?.tcgLow === 'number' && Number.isFinite(card.tcgLow);

    const updateCardMetrics = (card) => {
        const ckMetricValue = document.getElementById(`metric-ck-${card.id}`);
        if (ckMetricValue) {
            ckMetricValue.textContent = formatCurrency(card.ckBuylistPrice);
            const ckPill = ckMetricValue.closest('.metric-pill');
            if (ckPill) {
                ckPill.classList.remove('positive', 'negative');
                if (typeof card.ckBuylistPrice === 'number' && Number.isFinite(card.ckBuylistPrice) && typeof card.price === 'number' && Number.isFinite(card.price)) {
                    ckPill.classList.add(card.ckBuylistPrice >= card.price ? 'positive' : 'negative');
                }
            }
        }
        const tcgLabel = document.getElementById(`metric-tcg-label-${card.id}`);
        const tcgValue = document.getElementById(`metric-tcg-${card.id}`);
        const pill = tcgValue ? tcgValue.closest('.metric-pill') : null;

        if (tcgLabel) {
            tcgLabel.textContent = hasLiveTcgLow(card) ? 'TCG Low' : 'TCG Market';
        }
        if (tcgValue) {
            const metricNumber = hasLiveTcgLow(card) ? card.tcgLow : card.price;
            tcgValue.textContent = formatCurrency(metricNumber);
        }
        if (pill) {
            pill.classList.toggle('live', hasLiveTcgLow(card));
        }
    };

    const updateSummaryTotals = () => {
        if (totalValueEl) {
            totalValueEl.textContent = formatCurrency(totalCollectionValue);
        }
        if (ckBuylistTotalEl) {
            ckBuylistTotalEl.textContent = formatCurrency(totalCardKingdomBuylistValue);
        }
        if (ckReturnEl) {
            if (totalCollectionValue > 0) {
                const returnRatio = (totalCardKingdomBuylistValue / totalCollectionValue) - 1;
                const percentText = `${returnRatio >= 0 ? '+' : ''}${(returnRatio * 100).toFixed(1)}%`;
                ckReturnEl.textContent = percentText;
                ckReturnEl.classList.remove('positive', 'negative');
                ckReturnEl.classList.add(returnRatio >= 0 ? 'positive' : 'negative');
            } else {
                ckReturnEl.textContent = 'N/A';
                ckReturnEl.classList.remove('positive', 'negative');
            }
        }
    };

    updateSummaryTotals();

    if (switchViewBtn) {
        switchViewBtn.dataset.pending = 'true';
        switchViewBtn.setAttribute('aria-disabled', 'true');
        switchViewBtn.addEventListener('click', (event) => {
            if (switchViewBtn.dataset.pending === 'true') {
                event.preventDefault();
            }
        });
    }

    const buylistModal = window.createBuylistModal({
        modal: document.getElementById('buylist-modal'),
        formatCurrency,
        formatListName,
        getLatestPrice,
        saveSnapshot: async (payload) => {
            if (!listId) return;
            await fetch(`/api/list/${listId}/buylist-snapshot`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
        },
        onSnapshotChange: (snapshot) => {
            listBuylistSnapshot = snapshot;
        }
    });

    if (buylistAnalysisBtn) {
        buylistAnalysisBtn.addEventListener('click', (event) => {
            event.preventDefault();
            buylistModal.open();
        });
    }

    if (renameListBtn) {
        renameListBtn.addEventListener('click', async () => {
            if (!listId) return;
            const { cancelled, value } = promptForListNameValue(listName || '');
            if (cancelled) return;

            renameListBtn.disabled = true;
            const originalText = renameListBtn.textContent;
            renameListBtn.textContent = 'Renaming...';

            try {
                const response = await fetch(`/api/list/${listId}/name`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ name: value })
                });
                if (!response.ok) throw new Error('Rename failed');
                const payload = await response.json().catch(() => ({}));
                const nextName = typeof payload.name === 'string' ? payload.name : value;
                listName = nextName && nextName.length ? nextName : null;
                updateListTitle();
                buylistModal.setListNameResolver(() => listName);
                renameListBtn.textContent = 'Renamed';
                setTimeout(() => {
                    renameListBtn.disabled = false;
                    renameListBtn.textContent = 'Rename';
                }, 1200);
            } catch (error) {
                console.error(error);
                renameListBtn.textContent = originalText;
                renameListBtn.disabled = false;
                alert('Unable to rename this list right now.');
            }
        });
    }

    const formatFinishLabel = (finish) => {
        switch (finish) {
            case 'nonfoil':
                return 'Non-Foil';
            case 'foil':
                return 'Foil';
            case 'etched':
                return 'Etched';
            default:
                return finish;
        }
    };

    const createFoilIndicatorElement = (foilType) => {
        if (foilType !== 'foil' && foilType !== 'etched') {
            return null;
        }
        const span = document.createElement('span');
        span.className = 'foil-indicator';
        span.setAttribute('aria-label', foilType === 'foil' ? 'Foil printing' : 'Etched printing');
        span.textContent = foilType === 'foil' ? 'Foil' : 'Etched';
        return span;
    };
    const updateSaveStateUI = () => {
      if (isListSaved) {
          saveListBtn.style.display = 'none'; // Hide the save button
          warningBanner.style.display = 'none'; // Hide the warning
      } else {
          saveListBtn.style.display = 'inline-block'; // Show the save button
          warningBanner.style.display = 'block'; // Show the warning
      }
    };

    /**
     * Fetches and renders printings for a selected card name.
     * Fetches and renders printings for the selected card name.
     * @param {string} cardName - The exact card name selected from the search widget.
     */
    const searchForPrintingsByCardName = async (cardName) => {
        if (!cardName) {
            addCardResults.innerHTML = '';
            return;
        }
        addCardResults.innerHTML = '<div class="loader">Searching...</div>';
        try {
            const response = await fetch(`/api/printings/${encodeURIComponent(cardName)}`);
            if (!response.ok) throw new Error();
            const allPrintings = await response.json();

            // --- Data Restructuring (from example) ---
            // Combines printings that are duplicates (e.g., same card, different finish)
            // into one entry with a Set of all available finishes.
            const printingsMap = new Map();
            for (const printing of allPrintings) {
                if (!printingsMap.has(printing.id)) {
                    printingsMap.set(printing.id, {
                        ...printing,
                        available_finishes: new Set() // Use a Set to store finishes
                    });
                }
                // Add all finishes from this printing object to the Set
                printing.finishes.forEach(finish => {
                    printingsMap.get(printing.id).available_finishes.add(finish);
                });
            }
            // Get the unique, combined printings
            const combinedPrintings = Array.from(printingsMap.values());

            addCardResults.innerHTML = ''; // Clear loader
            
            let resultsFound = false;
            combinedPrintings.forEach(printing => {
                // Add a "guard clause" to skip any printing that doesn't have an image_uris object.
                if (!printing.image_uris) {
                    return; // Acts like 'continue' in a forEach loop
                }
                resultsFound = true; // We found at least one valid card

                const resultItem = document.createElement('div');
                resultItem.className = 'printing-result-item';

                const image = document.createElement('img');
                image.loading = 'lazy';
                image.className = 'printing-result-image';
                image.alt = `${printing.name} card art`;
                const primaryImage = printing.image_uris?.normal || printing.image_uris?.large || printing.image_uris?.small || '';
                image.src = primaryImage;
                image.dataset.fullArt = printing.image_uris?.png || printing.image_uris?.large || primaryImage;
                resultItem.appendChild(image);

                const info = document.createElement('div');
                info.className = 'printing-result-info';

                const nameEl = document.createElement('strong');
                nameEl.textContent = printing.name;
                info.appendChild(nameEl);

                const setSpan = document.createElement('span');
                setSpan.textContent = `(${printing.set_name})`;
                info.appendChild(setSpan);

                const collectorSpan = document.createElement('span');
                collectorSpan.className = 'collector-number';
                collectorSpan.textContent = `#${printing.collector_number}`;
                info.appendChild(collectorSpan);

                resultItem.appendChild(info);

                const finishesContainer = document.createElement('div');
                finishesContainer.className = 'finishes';

                printing.available_finishes.forEach(finish => {
                    const button = document.createElement('button');
                    button.type = 'button';
                    button.className = 'finish-btn';
                    button.dataset.finish = finish;
                    button.textContent = formatFinishLabel(finish);
                    button.addEventListener('click', () => {
                        const foilTypeForDB = finish === 'nonfoil' ? 'normal' : finish;
                        const cardToAdd = {
                            name: printing.name,
                            setCode: printing.set.toUpperCase(),
                            collectorNumber: printing.collector_number,
                            foilType: foilTypeForDB,
                            quantity: 1
                        };
                        addCardToList(cardToAdd);
                    });
                    finishesContainer.appendChild(button);
                });

                resultItem.appendChild(finishesContainer);
                addCardResults.appendChild(resultItem);
            });

            // Check if any results were actually added to the DOM
            if (!resultsFound) {
                throw new Error("No printings with valid images found.");
            }

        } catch (e) {
            addCardResults.innerHTML = '<p>No printings found.</p>';
        }
    };

    const getBreakevenTableHTML = (marketPrice, scrapedLow) => {
        const basePrice = scrapedLow || marketPrice; // Use scraped low if it exists
        if (!basePrice || basePrice <= 0) {
            return '<div class="no-price-data">No TCGPlayer price data for analysis.</div>';
        }

        let tableHTML = `
            <div class="analysis-header">Break-Even Point</div>
            <table class="breakeven-table">
                <thead>
                    <tr><th>Buy At</th><th>TCG Sell</th><th>ManaPool Sell</th></tr>
                </thead>
                <tbody>
        `;
        [0.90, 0.85, 0.80].forEach(percent => {
            const buyPrice = basePrice * percent;
            const tcgSell = calculateBreakevenPrice(buyPrice, TCGPLAYER_FEE_RATE, FLAT_FEE);
            const mpSell = calculateBreakevenPrice(buyPrice, MANAPOOL_FEE_RATE, FLAT_FEE);
            tableHTML += `
                <tr>
                    <td>${Math.round(percent * 100)}%<span>($${buyPrice.toFixed(2)})</span></td>
                    <td>$${tcgSell.toFixed(2)}</td>
                    <td>$${mpSell.toFixed(2)}</td>
                </tr>
            `;
        });
        tableHTML += `</tbody></table>`;
        return tableHTML;
    };

    const addCardToList = async (cardData) => {
        try {
            const response = await fetch(`/api/list/${listId}/add`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(cardData)
            });
            if (!response.ok) throw new Error("Failed to save card to the list.");

            const newCard = {
                ...cardData,
                id: generateId(),
                isLoaded: false,
                price: null,
                ckPrice: null,
                ckBuylistPrice: null,
                chPrice: null,
                tcgLow: null,
                tcgLowPlusShipping: null
            };

            allCards.push(newCard);
            // If this is the first card, clear the "empty" message
            if (allCards.length === 1) container.innerHTML = ''; 

            searchAndRender();
            await fetchSingleCardDetails(newCard);

            // Clear the search input and results after successfully adding a card
            addCardSearch.value = '';
            addCardResults.innerHTML = '';
        } catch (error) {
            console.error(error);
            alert('Could not add card to the list.');
        }
    };

    /**
     * Renders the entire list of cards to the DOM.
     */
    const renderCardList = (cardsToRender) => {
        container.textContent = '';
        if (cardsToRender.length === 0 && allCards.length > 0) {
            const message = document.createElement('p');
            message.textContent = 'No cards match your search.';
            container.appendChild(message);
            return;
        }
        for (const card of cardsToRender) {
            const cardElement = document.createElement('div');
            cardElement.className = 'card-item';
            cardElement.id = `card-${card.id}`;

            if (!card.isLoaded) {
                cardElement.classList.add('skeleton');
                cardElement.innerHTML = `
                    <div class="card-image"></div>
                    <div class="card-info"><h3></h3><p></p></div>
                    <div class="card-pricing"><div class="vendor-prices-skeleton"></div></div>
                    <div class="card-graph-skeleton"></div>
                `;
            } else {
                populateCardElement(cardElement, card);
            }
            container.appendChild(cardElement);
        }
    };

    const populateCardElement = (cardElement, card) => {
        cardElement.classList.remove('skeleton');
        cardElement.classList.remove('card-positive', 'card-negative');
        cardElement.innerHTML = '';

        const image = document.createElement('img');
        image.className = 'card-image';
        image.src = card.imageUrl || LARGE_CARD_IMAGE_PLACEHOLDER;
        image.alt = card.name;
        image.addEventListener('error', () => {
            image.onerror = null;
            image.src = LARGE_CARD_IMAGE_PLACEHOLDER;
        }, { once: true });
        cardElement.appendChild(image);

        const info = document.createElement('div');
        info.className = 'card-info';

        const title = document.createElement('h3');
        title.appendChild(document.createTextNode(`${card.name} (x${card.quantity}) `));
        const foilIndicatorElement = createFoilIndicatorElement(card.foilType);
        if (foilIndicatorElement) {
            title.appendChild(foilIndicatorElement);
        }
        info.appendChild(title);

        const setDetails = document.createElement('p');
        setDetails.className = 'card-meta';
        setDetails.textContent = `${card.setName} (#${card.collectorNumber})`;
        info.appendChild(setDetails);

        const metrics = document.createElement('div');
        metrics.className = 'card-metrics';
        metrics.innerHTML = `
            <div class="metric-pill" data-metric="ck">
                <span class="metric-label">CK Buylist</span>
                <strong class="metric-value" id="metric-ck-${card.id}">${formatCurrency(card.ckBuylistPrice)}</strong>
            </div>
            <div class="metric-pill" data-metric="tcg">
                <span class="metric-label" id="metric-tcg-label-${card.id}">${hasLiveTcgLow(card) ? 'TCG Low' : 'TCG Market'}</span>
                <strong class="metric-value" id="metric-tcg-${card.id}">${formatCurrency(hasLiveTcgLow(card) ? card.tcgLow : card.price)}</strong>
            </div>
        `;
        info.appendChild(metrics);

        const scrapeButton = document.createElement('button');
        scrapeButton.className = 'scrape-btn';
        scrapeButton.dataset.cardId = card.id;
        scrapeButton.textContent = 'Check Live Lows';
        if (!card.tcgplayerId) {
            scrapeButton.disabled = true;
        }
        info.appendChild(scrapeButton);

        cardElement.appendChild(info);

        const priceTable = document.createElement('table');
        priceTable.className = 'vendor-prices';
        const priceTbody = document.createElement('tbody');
        priceTable.appendChild(priceTbody);

        const appendPriceRow = (label, value, options = {}) => {
            const row = document.createElement('tr');
            const labelCell = document.createElement('td');
            labelCell.className = 'vendor-label';
            const valueCell = document.createElement('td');
            valueCell.className = 'vendor-value';

            if (options.href) {
                const link = document.createElement('a');
                link.href = options.href || '#';
                link.target = '_blank';
                link.rel = 'noopener noreferrer';
                link.textContent = label;
                labelCell.appendChild(link);
            } else {
                labelCell.textContent = label;
            }

            if (typeof value === 'number' && Number.isFinite(value)) {
                valueCell.textContent = formatCurrency(value);
            } else if (typeof value === 'string') {
                valueCell.textContent = value;
            } else {
                valueCell.textContent = 'N/A';
            }
            if (options.id) {
                valueCell.id = options.id;
            }

            row.appendChild(labelCell);
            row.appendChild(valueCell);
            priceTbody.appendChild(row);
        };

        appendPriceRow('TCG Market', card.price, { href: card.purchase_uris });
        appendPriceRow('Card Kingdom', card.ckPrice);
        appendPriceRow('CK Buylist', card.ckBuylistPrice, { id: `ck-buylist-${card.id}` });
        const initialLowValue = hasLiveTcgLow(card) ? card.tcgLow : 'Press "Check Live Lows"';
        const initialLowShipValue = (typeof card.tcgLowPlusShipping === 'number' && Number.isFinite(card.tcgLowPlusShipping))
            ? card.tcgLowPlusShipping
            : 'Press "Check Live Lows"';
        appendPriceRow('TCG Low', initialLowValue, { id: `tcg-low-${card.id}` });
        appendPriceRow('TCG Low + Ship', initialLowShipValue, { id: `tcg-low-ship-${card.id}` });

        const ckBuylistValue = Number(card.ckBuylistPrice);
        const marketValue = Number(card.price);
        if (Number.isFinite(ckBuylistValue) && Number.isFinite(marketValue)) {
            if (ckBuylistValue >= marketValue) {
                cardElement.classList.add('card-positive');
            } else {
                cardElement.classList.add('card-negative');
            }
        }

        cardElement.appendChild(priceTable);

        const analysis = document.createElement('div');
        analysis.className = 'card-analysis';
        analysis.id = `analysis-${card.id}`;
        analysis.innerHTML = getBreakevenTableHTML(card.price, card.tcgLow);
        cardElement.appendChild(analysis);

        const chartContainer = document.createElement('div');
        chartContainer.className = 'card-graph-container';
        const canvas = document.createElement('canvas');
        canvas.id = `chart-${card.id}`;
        chartContainer.appendChild(canvas);
        cardElement.appendChild(chartContainer);

        updateCardMetrics(card);
    };

    
    /**
     * Renders a multi-line price history chart for a single card.
     */
    const renderChart = (card) => {
        const canvas = document.getElementById(`chart-${card.id}`);
        if (!canvas) return;

        const vendorsToChart = [
            { name: 'TCGPlayer', data: card.tcgHistory, color: 'rgba(75, 192, 192, 1)' },
            { name: 'Card Kingdom', data: card.ckHistory, color: 'rgba(255, 99, 132, 1)' }
        ];

        const allDates = new Set();
        const validHistories = vendorsToChart.filter(v => v.data && Object.keys(v.data).length > 0);

        if (validHistories.length === 0) return;

        validHistories.forEach(vendor => Object.keys(vendor.data).forEach(date => allDates.add(date)));
        
        const chartLabels = Array.from(allDates).sort((a, b) => new Date(a) - new Date(b));
        
        const datasets = validHistories.map(vendor => {
            let lastKnownPrice = null;
            const pricePoints = chartLabels.map(date => {
                if (vendor.data[date] !== undefined) lastKnownPrice = vendor.data[date];
                return lastKnownPrice;
            });
            return {
                label: vendor.name,
                data: pricePoints,
                borderColor: vendor.color,
                fill: false,
                tension: 0.4,
                pointRadius: 0,
                spanGaps: true
            };
        });

        new Chart(canvas.getContext('2d'), {
            type: 'line',
            data: { labels: chartLabels, datasets: datasets },
            options: {
                responsive: true, maintainAspectRatio: false,
                interaction: { intersect: false, mode: 'index' },
                plugins: { legend: { labels: { color: '#aaa' } } },
                scales: {
                    x: { ticks: { display: false } },
                    y: { ticks: { color: '#aaa', callback: (value) => `$${value}` } }
                }
            }
        });
    };

    const fetchSingleCardDetails = async (card) => {
        const previousTcgContribution = card._tcgContribution || 0;
        const previousCkContribution = card._ckBuylistContribution || 0;

        totalCollectionValue -= previousTcgContribution;
        totalCardKingdomBuylistValue -= previousCkContribution;

        try {
            const rawCardData = await fetch(`/api/card/details/${card.setCode}/${card.collectorNumber}`);
            const cardData = rawCardData.ok ? await rawCardData.json() : null;

            const cardIdentifiersData = cardData?.identifiers || {};
            const cardInfo = cardData?.card || {};
            const setInfo = cardData?.set || {};
            const priceData = cardData?.prices || null;
            const purchaseUrls = cardData?.purchaseUrls || {};

            const tcgProductId = cardIdentifiersData?.tcgplayerProductId || cardIdentifiersData?.tcgplayerId;
            if (tcgProductId) {
                card.tcgplayerId = tcgProductId;
                card.imageUrl = buildLargeTcgImageUrl(tcgProductId) || card.imageUrl || LARGE_CARD_IMAGE_PLACEHOLDER;
            } else if (!card.imageUrl) {
                card.imageUrl = LARGE_CARD_IMAGE_PLACEHOLDER;
            }

            card.flavorName = cardInfo.flavorName;
            card.name = cardInfo.name;
            card.setName = setInfo.name;

            const paperPrices = priceData?.paper || {};
            const tcgRetailPrice = getLatestPrice(paperPrices?.tcgplayer?.retail?.[card.foilType]);
            const ckRetailPrice = getLatestPrice(paperPrices?.cardkingdom?.retail?.[card.foilType]);
            const ckBuylistPrice = getLatestPrice(paperPrices?.cardkingdom?.buylist?.[card.foilType]);

            card.price = tcgRetailPrice;
            card.ckPrice = ckRetailPrice;
            card.ckBuylistPrice = ckBuylistPrice;
            card.tcgHistory = paperPrices?.tcgplayer?.retail?.[card.foilType];
            card.ckHistory = paperPrices?.cardkingdom?.retail?.[card.foilType];
            card.purchase_uris = purchaseUrls.tcgplayer || '#';
            card.isLoaded = true;

            const quantity = Number(card.quantity) || 0;
            const tcgContribution = Number.isFinite(card.price) ? card.price * quantity : 0;
            const ckContribution = Number.isFinite(card.ckBuylistPrice) ? card.ckBuylistPrice * quantity : 0;

            card._tcgContribution = tcgContribution;
            card._ckBuylistContribution = ckContribution;

            totalCollectionValue += tcgContribution;
            totalCardKingdomBuylistValue += ckContribution;
            updateSummaryTotals();
            updateCardMetrics(card);

            const existingElement = document.getElementById(`card-${card.id}`);
            if (existingElement) {
                populateCardElement(existingElement, card);
                renderChart(card);
            }
        } catch (error) {
            console.error(`Failed to load details for ${card.name || card.collectorNumber}:`, error);
            card.isLoaded = true;
            card.price = 0;
            card.ckPrice = 0;
            card.ckBuylistPrice = 0;
            card._tcgContribution = 0;
            card._ckBuylistContribution = 0;
            updateSummaryTotals();
            updateCardMetrics(card);
        }
    };

    /**
     * Fetches detailed data for all cards and updates them in place.
     */
    const fetchAllCardDetails = async () => {
        totalCollectionValue = 0;
        totalCardKingdomBuylistValue = 0;
        updateSummaryTotals();
        // Loop through each card individually
        for (let index = 0; index < allCards.length; index += 1) {
            const card = allCards[index];
            card._tcgContribution = 0;
            card._ckBuylistContribution = 0;
            // Wait for the details of the current card to be fetched and processed
            await fetchSingleCardDetails(card);

            const progress = ((index + 1) / allCards.length) * 100;
            document.getElementById('myBar').style.width = `${progress}%`;
            progressLabel.textContent = `Loading card ${index + 1} of ${allCards.length}`;
        }
    };
    
    const sortAndRender = () => {
        allCards.sort((a, b) => {
            const valA = a[currentSort.key] || 0;
            const valB = b[currentSort.key] || 0;
            return currentSort.order === 'asc' ? valA - valB : valB - valA;
        });
        searchAndRender();
    };
    
    const searchAndRender = () => {
        const searchTerm = searchBar.value.toLowerCase();
        const filteredCards = searchTerm
            ? allCards.filter(card => card.name?.toLowerCase().includes(searchTerm))
            : allCards;
        renderCardList(filteredCards);
        
        filteredCards.forEach(card => {
            if (card.isLoaded) {
                renderChart(card);
            }
        });
    };

    /**
     * Main function to initialize the page.
     */
    const initializePage = async () => {
        if (!listId) {
            container.innerHTML = '<p>No list ID found. Please import a CSV file first.</p>';
            return;
        }

        // --- UPDATED UNLOAD LOGIC ---
        const handleUnload = (event) => {
            if (!isListSaved) {
                event.preventDefault();
                event.returnValue = '';
            }
        };
        window.addEventListener('beforeunload', handleUnload);

        try {
            const listResponse = await fetch(`/api/list/${listId}`);
            if (!listResponse.ok) throw new Error("Could not find this list.");
            const importedCards = await listResponse.json();

            isListSaved = importedCards.isPermanent; // Set state from server
            updateSaveStateUI(); // Update UI
            if (isListSaved) {
                window.removeEventListener('beforeunload', handleUnload);
            }

            listName = typeof importedCards.name === 'string' ? importedCards.name : null;
            listBuylistSnapshot = importedCards.buylistSnapshot || null;
            updateListTitle();
            buylistModal.setListNameResolver(() => listName);

            saveListBtn.onclick = async () => {
                if (isListSaved) return;
                const { cancelled, value } = promptForListNameValue(listName || '');
                if (cancelled) return;

                saveListBtn.disabled = true;
                saveListBtn.textContent = 'Saving...';

                try {
                    const response = await fetch(`/api/list/${listId}/save`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ name: value })
                    });
                    if (!response.ok) throw new Error('Save failed');
                    const payload = await response.json().catch(() => ({}));
                    const savedName = typeof payload.name === 'string' ? payload.name : value;
                    listName = savedName && savedName.length ? savedName : null;
                    isListSaved = true;
                    updateListTitle();
                    buylistModal.setListNameResolver(() => listName);
                    updateSaveStateUI();
                    saveListBtn.textContent = 'Saved!';
                    window.removeEventListener('beforeunload', handleUnload);
                } catch (error) {
                    console.error(error);
                    saveListBtn.textContent = 'Save List';
                    saveListBtn.disabled = false;
                    alert('Unable to save this list right now.');
                }
            };

            if (importedCards.content.length === 0) {
                document.getElementById('card-list-container').innerHTML = 
                    '<p class="empty-list-message">Your list is empty. Use the search bar above to add your first card.</p>';
                return; // Stop here, no cards to render
            }

            allCards = importedCards.content.map((card, index) => ({
                ...card,
                id: `${card.setCode}-${card.collectorNumber}-${card.foilType}-${index}`,
                isLoaded: false,
                price: Number.isFinite(Number(card.price)) ? Number(card.price) : null,
                ckPrice: Number.isFinite(Number(card.ckPrice)) ? Number(card.ckPrice) : null,
                ckBuylistPrice: Number.isFinite(Number(card.ckBuylistPrice)) ? Number(card.ckBuylistPrice) : null,
                chPrice: Number.isFinite(Number(card.chPrice)) ? Number(card.chPrice) : null,
                tcgLow: typeof card.tcgLow === 'number' ? card.tcgLow : null,
                tcgLowPlusShipping: typeof card.tcgLowPlusShipping === 'number' ? card.tcgLowPlusShipping : null
            }));
            
            switchViewBtn.href = `/binder/${listId}`;
            switchViewBtn.dataset.pending = 'false';
            switchViewBtn.removeAttribute('aria-disabled');

            buylistModal.init({
                contextId: listId,
                getCards: () => allCards.map((card) => ({
                    id: card.id,
                    name: card.name,
                    setCode: card.setCode,
                    collectorNumber: card.collectorNumber,
                    foilType: card.foilType,
                    quantity: card.quantity,
                    tcgplayerId: card.tcgplayerId,
                    imageUrl: card.imageUrl || null
                })),
                nameResolver: () => listName,
                initialSnapshot: listBuylistSnapshot
            });
            
            renderCardList(allCards);
            fetchAllCardDetails();

        } catch (error) {
            container.textContent = '';
            const errorMessage = document.createElement('p');
            errorMessage.style.color = '#ff8a80';
            errorMessage.textContent = error.message;
            container.appendChild(errorMessage);
        }
    };

    // --- EVENT LISTENERS ---

    new CardSearchWidget({
        input: addCardSearch,
        limit: 10,
        onSelect: (card) => {
            addCardSearch.value = card.name;
            searchForPrintingsByCardName(card.name);
        },
    });

    // --- NEW: Hover Preview for Add Card Search Results ---
    // Use event delegation on the results container
    addCardResults.addEventListener('mouseover', (event) => {
        // Check if the element being hovered is a printing image
        if (event.target.matches('.printing-result-image')) {
            // Get the full art URL from the data-attribute and show the previewer
            previewImage.src = event.target.dataset.fullArt;
            previewer.style.display = 'block';
        }
    });

    addCardResults.addEventListener('mouseout', (event) => {
        // Hide the previewer when the mouse leaves the image
        if (event.target.matches('.printing-result-image')) {
            previewer.style.display = 'none';
        }
    });

    addCardResults.addEventListener('mousemove', (event) => {
        // Move the previewer with the cursor
        if (previewer.style.display === 'block') {
            previewer.style.left = event.clientX + 'px';
            previewer.style.top = event.clientY + 'px';
        }
    });
    // --- END OF NEW ADD CARD LISTENERS ---


    // --- Main Card List Event Listeners ---
    container.addEventListener('click', async (event) => {
        if (!event.target.matches('.scrape-btn')) return;

        const button = event.target;
        const cardId = button.dataset.cardId;
        const card = allCards.find(c => c.id === cardId);

        if (!card) return;

        button.disabled = true;
        button.textContent = 'Scraping...';

        try {
            const response = await fetch('/api/scrape-lows', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    tcgplayerId: card.tcgplayerId,
                    cardName: card.name,
                    setCode: card.setCode,
                    collectorNumber: card.collectorNumber,
                    foilType: card.foilType,
                    store: 'tcgplayer'
                 })
            });

            if (!response.ok) throw new Error('Scrape failed on server.');

            const scrapedData = await response.json();
            
            card.tcgLow = (typeof scrapedData.tcgLow === 'number' && Number.isFinite(scrapedData.tcgLow)) ? scrapedData.tcgLow : null;
            card.tcgLowPlusShipping = (typeof scrapedData.tcgLowPlusShipping === 'number' && Number.isFinite(scrapedData.tcgLowPlusShipping)) ? scrapedData.tcgLowPlusShipping : null;

            const tcgLowCell = document.getElementById(`tcg-low-${card.id}`);
            if (tcgLowCell) {
                tcgLowCell.textContent = card.tcgLow ? formatCurrency(card.tcgLow) : 'N/A';
            }
            const tcgLowShipCell = document.getElementById(`tcg-low-ship-${card.id}`);
            if (tcgLowShipCell) {
                tcgLowShipCell.textContent = formatCurrency(card.tcgLowPlusShipping);
            }
            const ckBuylistCell = document.getElementById(`ck-buylist-${card.id}`);
            if (ckBuylistCell) {
                ckBuylistCell.textContent = formatCurrency(card.ckBuylistPrice);
            }

            const analysisContainer = document.getElementById(`analysis-${card.id}`);
            analysisContainer.innerHTML = getBreakevenTableHTML(card.price, card.tcgLow);

            updateCardMetrics(card);

            button.textContent = 'Updated';

        } catch (error) {
            console.error(error);
            button.textContent = 'Error!';
            setTimeout(() => {
                button.disabled = false;
                button.textContent = 'Check Live Lows';
            }, 2000);
        }
    });

    /* Note: The 'saveListBtn' click listener is now defined inside 
     initializePage() so it can be conditionally added only if 
     the list is not already permanent, and so it has access
     to the 'handleUnload' function to remove the 'beforeunload' listener.
    */
    
    // This listener is for filtering the MAIN card list
    searchBar.addEventListener('input', searchAndRender);

    sortButtons.forEach(button => {
        button.addEventListener('click', () => {
            const sortKey = button.dataset.sort;
            if (currentSort.key === sortKey) {
                currentSort.order = currentSort.order === 'asc' ? 'desc' : 'asc';
            } else {
                currentSort.key = sortKey;
                currentSort.order = 'desc';
            }
            sortButtons.forEach(btn => btn.classList.remove('active'));
            button.classList.add('active');
            sortAndRender();
        });
    });

    // Use event delegation on the main container for efficiency
    container.addEventListener('mouseover', (event) => {
        // Check if the element being hovered over is SPECIFICALLY the card image
        if (event.target.matches('.card-image')) {
            // Update the previewer's image source and show it
            previewImage.src = event.target.src;
            previewer.style.display = 'block';
        }
    });

    // Hide the previewer when the mouse leaves the image
    container.addEventListener('mouseout', (event) => {
        if (event.target.matches('.card-image')) {
            previewer.style.display = 'none';
        }
    });

    // Move the previewer with the cursor
    container.addEventListener('mousemove', (event) => {
        if (previewer.style.display === 'block') {
            previewer.style.left = event.clientX + 'px';
            previewer.style.top = event.clientY + 'px';
        }
    });


    initializePage();
});




