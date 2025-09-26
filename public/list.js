document.addEventListener('DOMContentLoaded', () => {
    // --- DOM ELEMENTS ---
    const container = document.getElementById('card-list-container');
    const switchViewBtn = document.getElementById('switch-view-btn');
    const searchBar = document.getElementById('search-bar');
    const saveListBtn = document.getElementById('save-list-btn');
    const sortButtons = document.querySelectorAll('.sort-button');
    const addCardSearch = document.getElementById('add-card-search');
    const addCardResults = document.getElementById('add-card-results');
    const totalValueEl = document.getElementById('total-value-amount');
    const warningBanner = document.getElementById('save-warning'); // New element
    const previewer = document.getElementById('card-previewer');
    const previewImage = document.getElementById('card-preview-image');


    // --- CONSTANTS FOR FEE CALCULATION ---
    const TCGPLAYER_FEE_RATE = 0.1275;
    const MANAPOOL_FEE_RATE = 0.079;
    const FLAT_FEE = 0.30;

    // --- STATE ---
    let allCards = [];
    let currentSort = { key: 'price', order: 'desc' };
    let totalCollectionValue = 0;
    let isListSaved = false;
    const pathParts = window.location.pathname.split('/');
    const listId = pathParts[pathParts.length - 1];

    // --- HELPER FUNCTIONS ---
    const generateUUID = () => {
        return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
            const r = Math.random() * 16 | 0, v = c === 'x' ? r : (r & 0x3 | 0x8);
            return v.toString(16);
        });
    };
    const calculateBreakevenPrice = (buyPrice, feeRate, flatFee) => {
        if (buyPrice <= 0) return 0;
        return (buyPrice + flatFee) / (1 - feeRate) + 1.25; // Adding $1.25 shipping buffer
    };

    const getLatestPrice = (priceHistory) => {
        if (!priceHistory || typeof priceHistory !== 'object' || Object.keys(priceHistory).length === 0) return 0;
        const latestDate = Object.keys(priceHistory).sort((a, b) => new Date(b) - new Date(a))[0];
        return priceHistory[latestDate] || 0;
    };
    const createFoilIndicator = (foilType) => {
        if (foilType === 'foil') return '<span class="foil-indicator">✨ Foil</span>';
        if (foilType === 'etched') return '<span class="foil-indicator">💎 Etched</span>';
        return '';
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
    const searchForPrintings = async (cardName) => {
        if (!cardName || cardName.length < 3) {
            addCardResults.innerHTML = '';
            return;
        }
        addCardResults.innerHTML = '<div class="loader">Searching...</div>';
        try {
            const response = await fetch(`/api/printings/${encodeURIComponent(cardName)}`);
            if (!response.ok) throw new Error();
            const printings = await response.json();

            addCardResults.innerHTML = '';
            printings.forEach(printing => {
                // --- THIS IS THE FIX ---
                // Add a "guard clause" to skip any printing that doesn't have an image_uris object.
                if (!printing.image_uris) {
                    return; // Acts like 'continue' in a forEach loop
                }

                const resultItem = document.createElement('div');
                resultItem.className = 'printing-result-item';
                
                let finishesHTML = printing.finishes.map(f => 
                    `<button class="finish-btn" data-finish="${f}">${f}</button>`
                ).join('');

                // Now this line is safe because we've already checked for image_uris
                resultItem.innerHTML = `
                    <img src="${printing.image_uris.art_crop}" loading="lazy" alt="${printing.name} art crop">
                    <div>
                        <strong>${printing.name}</strong>
                        <span>(${printing.set_name})</span>
                    </div>
                    <div class="finishes">${finishesHTML}</div>
                `;
                addCardResults.appendChild(resultItem);

                // Add event listeners to the new finish buttons
                resultItem.querySelectorAll('.finish-btn').forEach(button => {
                    button.addEventListener('click', () => {
                        const selectedFinish = button.dataset.finish;
                        const foilTypeForDB = selectedFinish === 'nonfoil' ? 'normal' : selectedFinish;

                        const cardToAdd = {
                            name: printing.name,
                            setCode: printing.set.toUpperCase(),
                            collectorNumber: printing.collector_number,
                            foilType: foilTypeForDB,
                            quantity: 1
                        };
                        addCardToList(cardToAdd);
                    });
                });
            });

            // Check if any results were actually added to the DOM
            if (addCardResults.childElementCount === 0) {
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
                id: generateUUID(),
                isLoaded: false,
                price: 0, ckPrice: 0, chPrice: 0
            };
            
            allCards.push(newCard);
            // If this is the first card, clear the "empty" message
            if (allCards.length === 1) container.innerHTML = ''; 

            searchAndRender();
            await fetchSingleCardDetails(newCard);

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
        container.innerHTML = '';
        if (cardsToRender.length === 0 && allCards.length > 0) {
            container.innerHTML = '<p>No cards match your search.</p>';
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
                cardElement.innerHTML = getCardHTML(card);
            }
            container.appendChild(cardElement);
        }
    };
    
    const getCardHTML = (card) => {
        return `
            <img src="${card.imageUrl}" alt="${card.name}" class="card-image">
                <div class="card-info">
                    <h3>${card.name} (x${card.quantity}) ${createFoilIndicator(card.foilType)}</h3>
                    <p>${card.setName} (#${card.collectorNumber})</p>
                    <button class="scrape-btn" data-card-id="${card.id}" ${card.tcgplayerId ? '' : 'disabled'}>
                        Check Live Lows
                    </button>
                </div>
                    <table class="vendor-prices">
                        <tbody>
                            <tr><td><a target="_blank" rel="noopener noreferrer" href=${card.purchase_uris}>TCG Market</a></td><td>$${card.price.toFixed(2)}</td></tr>
                            <tr><td>Card Kingdom</td><td>$${card.ckPrice.toFixed(2)}</td></tr>
                            <tr><td>TCG Low</td><td id="tcg-low-${card.id}">-</td></tr>
                            <tr><td>ManaPool Low</td><td id="mp-low-${card.id}">-</td></tr>
                        </tbody>
                    </table>
                <div class="card-analysis" id="analysis-${card.id}">
                    ${getBreakevenTableHTML(card.price, card.tcgLow)}
                </div>
                <div class="card-graph-container">
                    <canvas id="chart-${card.id}"></canvas>
            </div>
        `;
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
                label: vendor.name, data: pricePoints, borderColor: vendor.color,
                fill: false, tension: 0.4, pointRadius: 0, spanGaps: true
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
        try {
            const [scryfallResponse, priceResponse] = await Promise.all([
                fetch(`https://api.scryfall.com/cards/${card.setCode.toLowerCase()}/${card.collectorNumber}`),
                fetch(`/api/prices/${card.setCode}/${card.collectorNumber}`)
            ]);

            if (!scryfallResponse.ok) throw new Error('Scryfall API failed');

            const scryfallData = await scryfallResponse.json();
            const priceData = priceResponse.ok ? await priceResponse.json() : null;
            
            card.name = scryfallData.name;
            card.setName = scryfallData.set_name;
            card.imageUrl = scryfallData.image_uris?.small || 'https://placehold.co/63x88/2c2c2c/e0e0e0?text=N/A';
            card.tcgplayerId = scryfallData.tcgplayer_id;

            const paperPrices = priceData?.paper;

            card.price = getLatestPrice(paperPrices?.tcgplayer?.retail?.[card.foilType]);
            card.ckPrice = getLatestPrice(paperPrices?.cardkingdom?.retail?.[card.foilType]);
            card.tcgHistory = paperPrices?.tcgplayer?.retail?.[card.foilType];
            card.ckHistory = paperPrices?.cardkingdom?.retail?.[card.foilType];
            card.purchase_uris = scryfallData.purchase_uris?.tcgplayer || '#';
            card.isLoaded = true;

            totalCollectionValue += card.price * card.quantity;
            if (totalValueEl) totalValueEl.textContent = `$${totalCollectionValue.toFixed(2)}`;

            const existingElement = document.getElementById(`card-${card.id}`);
            if (existingElement) {
                existingElement.classList.remove('skeleton');
                // --- THIS IS THE FIX ---
                // Use the single, unified function to update the HTML
                existingElement.innerHTML = getCardHTML(card);
                renderChart(card);
            }
        } catch (error) {
            console.error(`Failed to load details for ${card.name || card.collectorNumber}:`, error);
            card.isLoaded = true;
            card.price = 0; card.ckPrice = 0; card.chPrice = 0;
        }
    };

    /**
     * Fetches detailed data for all cards and updates them in place.
     */
    /**
     * REFACTORED: Loops through all cards and fetches their details individually.
     */
    const fetchAllCardDetails = async () => {
        totalCollectionValue = 0;
        const delayBetweenRequests = 200;

        // Loop through each card individually
        for (const card of allCards) {
            // Wait for the details of the current card to be fetched and processed
            await fetchSingleCardDetails(card);

            document.getElementById('myBar').style.width = `${((allCards.indexOf(card) + 1) / allCards.length) * 100}%`;
            // After the request is done, pause for 125ms before the next loop iteration
            await new Promise(resolve => setTimeout(resolve, delayBetweenRequests));
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
        // --- THIS IS THE UPDATED UNLOAD LOGIC ---
        const handleUnload = (event) => {
            if (!isListSaved) {
                // This triggers the browser's "Leave site?" confirmation dialog.
                event.preventDefault();
                // This is required for some older browsers.
                event.returnValue = '';
            }
        };
        window.addEventListener('beforeunload', handleUnload);

        try {
            const listResponse = await fetch(`/api/list/${listId}`);
            if (!listResponse.ok) throw new Error("Could not find this list.");
            const importedCards = await listResponse.json();

            isListSaved = importedCards.isPermanent; // Set our state from the server's response
            updateSaveStateUI(); // Update the UI immediately

            // Only add the "leave page" warning if the list is NOT already saved
            if (!isListSaved) {
                const handleUnload = (event) => {
                    if (!isListSaved) {
                        event.preventDefault();
                        event.returnValue = '';
                    }
                };
                window.addEventListener('beforeunload', handleUnload);

                // When the list is successfully saved, remove the listener
                saveListBtn.addEventListener('click', async () => {
                    // ... fetch logic to save the list ...
                    const response = await fetch(`/api/list/${listId}/save`, { method: 'POST' });
                    if (response.ok) {
                        isListSaved = true;
                        updateSaveStateUI(); // Hide the button and warning
                        window.removeEventListener('beforeunload', handleUnload); // IMPORTANT
                    } else {
                        saveListBtn.textContent = 'Save Failed';
                    }
                });
            }

            if (importedCards.content.length === 0) {
                document.getElementById('card-list-container').innerHTML = 
                    '<p class="empty-list-message">Your list is empty. Use the search bar above to add your first card.</p>';
                // Hide the loader if it's there
                // Hide the toolbar if it's not needed for an empty list
                return; // Stop here, no cards to render
            }


            allCards = importedCards.content.map((card, index) => ({
                ...card,
                id: `${card.setCode}-${card.collectorNumber}-${card.foilType}-${index}`,
                isLoaded: false, price: 0, ckPrice: 0, chPrice: 0
            }));
            
            // Set the "Switch to Binder" link correctly
            switchViewBtn.href = `/binder/${listId}`;
            
            renderCardList(allCards);
            fetchAllCardDetails();

        } catch (error) {
            container.innerHTML = `<p style="color: #ff8a80;">${error.message}</p>`;
        }
    };

    // --- EVENT LISTENERS ---
    // --- ADD: Event listener for the new search bar ---
    let debounceTimer;
    addCardSearch.addEventListener('input', () => {
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
            searchForPrintings(addCardSearch.value);
        }, 300); // Debounce to avoid excessive API calls
    });

    container.addEventListener('click', async (event) => {
        if (!event.target.matches('.scrape-btn')) return;

        const button = event.target;
        const cardId = button.dataset.cardId;
        const card = allCards.find(c => c.id === cardId);

        if (!card) return;

        button.disabled = true;
        button.textContent = 'Scraping...';

        try {
            // --- UPDATED: The body of the request now includes setCode and collectorNumber ---
            const response = await fetch('/api/scrape-lows', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    tcgplayerId: card.tcgplayerId,
                    cardName: card.name,
                    setCode: card.setCode,
                    collectorNumber: card.collectorNumber,
                    foilType: card.foilType
                })
            });


            if (!response.ok) throw new Error('Scrape failed on server.');

            const scrapedData = await response.json();
            
            // Update the card object with new data
            card.tcgLow = scrapedData.tcgLow;
            card.manaPoolLow = scrapedData.manaPoolLow;

            // Update the UI with the new data
            document.getElementById(`tcg-low-${card.id}`).textContent = card.tcgLow ? `$${card.tcgLow.toFixed(2)}` : 'N/A';
            document.getElementById(`mp-low-${card.id}`).textContent = card.manaPoolLow ? `$${card.manaPoolLow.toFixed(2)}` : 'N/A';

            // Recalculate and re-render the break-even table with the new TCG Low price
            const analysisContainer = document.getElementById(`analysis-${card.id}`);
            analysisContainer.innerHTML = getBreakevenTableHTML(card.price, card.tcgLow);

            button.textContent = '✓ Updated';

        } catch (error) {
            console.error(error);
            button.textContent = 'Error!';
            setTimeout(() => {
                button.disabled = false;
                button.textContent = 'Check Live Lows';
            }, 2000);
        }
    });


    saveListBtn.addEventListener('click', async () => {
        try {
            saveListBtn.disabled = true;
            saveListBtn.textContent = 'Saving...';
            const response = await fetch(`/api/list/${listId}/save`, {
                method: 'POST'
            });
            if (!response.ok) throw new Error('Failed to save the list.');
            
            isListSaved = true;
            saveListBtn.textContent = '✓ Saved!';

            const handleUnload = (event) => {
                if (!isListSaved) {
                    event.preventDefault();
                    event.returnValue = '';
                }
            };
            window.removeEventListener('beforeunload', handleUnload);
            
        } catch (error) {
            console.error(error);
            saveListBtn.textContent = 'Save Failed';
            saveListBtn.disabled = false; // Re-enable button on failure
        }
    });
    
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

    // Move the previewer with the cursor (this listener remains the same)
    container.addEventListener('mousemove', (event) => {
        if (previewer.style.display === 'block') {
            previewer.style.left = event.clientX + 'px';
            previewer.style.top = event.clientY + 'px';
        }
    });


    initializePage();
});