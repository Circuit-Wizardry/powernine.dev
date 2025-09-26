document.addEventListener('DOMContentLoaded', () => {
    // --- Constants & Config ---
    const TCGPLAYER_FEE_RATE = 0.1275;
    const MANAPOOL_FEE_RATE = 0.079;
    const FLAT_FEE = 0.30;
    const RECOMMENDED_MARKUP = 1.10; // 10% markup over floor price

    // --- DOM Elements ---
    const inventoryContainer = document.getElementById('inventory-container');
    const addCardSearch = document.getElementById('add-card-search');
    const addCardResults = document.getElementById('add-card-results');

    // --- State ---
    let inventory = [];

    // --- Frontend rate-limiting queue for Scryfall detail fetches ---
    const RATE_LIMIT_MS = 125; // 1000ms / 8 requests per second
    const detailRequestQueue = [];
    let isDetailRequestProcessing = false;

    const processDetailQueue = () => {
        if (detailRequestQueue.length === 0) {
            isDetailRequestProcessing = false;
            return;
        }
        isDetailRequestProcessing = true;
        const task = detailRequestQueue.shift();
        task(); // Execute the fetch task
        setTimeout(processDetailQueue, RATE_LIMIT_MS);
    };

    const addToDetailQueue = (task) => {
        detailRequestQueue.push(task);
        if (!isDetailRequestProcessing) {
            processDetailQueue();
        }
    };

    // --- Helper Functions ---
    const calculateBreakevenPrice = (buyPrice, feeRate) => (buyPrice + FLAT_FEE - 1.30) / (1 - feeRate) + 1.25; // Adding $1.25 shipping buffer
    const calculateRecommendedPrice = (scrapedLow, breakevenPrice) => Math.max(scrapedLow || 0, breakevenPrice) * RECOMMENDED_MARKUP;
    const getLatestPrice = (priceHistory) => {
        if (!priceHistory || typeof priceHistory !== 'object' || Object.keys(priceHistory).length === 0) return 0;
        const latestDate = Object.keys(priceHistory).sort((a, b) => new Date(b) - new Date(a))[0];
        return priceHistory[latestDate] || 0;
    };
    const formatTimeAgo = (dateString) => {
        if (!dateString) return null;
        const date = new Date(dateString);
        const seconds = Math.floor((new Date() - date) / 1000);
        let interval = Math.floor(seconds / 3600);
        if (interval > 24) return new Intl.DateTimeFormat().format(date);
        if (interval >= 1) return `${interval} hour${interval > 1 ? 's' : ''} ago`;
        interval = Math.floor(seconds / 60);
        if (interval >= 1) return `${interval} minute${interval > 1 ? 's' : ''} ago`;
        return "Just now";
    };

    // --- Core Functions ---
    const renderInventory = () => {
        if (inventory.length === 0) {
            inventoryContainer.innerHTML = '<p class="empty-list-message">Your inventory is empty. Add a card to get started.</p>';
            return;
        }
        inventoryContainer.innerHTML = '';
        inventory.forEach(item => {
            const itemElement = document.createElement('div');
            itemElement.className = 'inventory-item skeleton';
            itemElement.id = `item-${item.id}`;
            inventoryContainer.appendChild(itemElement);
            addToDetailQueue(() => fetchSingleCardDetails(item));
        });
    };

    const updateQuantity = async (itemId, action) => {
        const item = inventory.find(i => i.id === itemId);
        if (!item) return;

        const originalQuantity = item.quantity;
        const newQuantity = action === 'increase' ? item.quantity + 1 : item.quantity - 1;

        if (newQuantity < 0) return;

        // Optimistic UI update
        item.quantity = newQuantity;
        document.getElementById(`quantity-${item.id}`).textContent = `x${newQuantity}`;
        
        try {
            const response = await fetch(`/api/inventory/${itemId}/quantity`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ quantity: newQuantity })
            });
            if (!response.ok) throw new Error('Failed to update quantity.');
            // If the item is deleted (quantity is 0), remove it from the view
            if (newQuantity === 0) {
                 document.getElementById(`item-${item.id}`).remove();
            }
        } catch (error) {
            console.error(error);
            // Revert UI on failure
            item.quantity = originalQuantity;
            document.getElementById(`quantity-${item.id}`).textContent = `x${originalQuantity}`;
            alert('Failed to update quantity on the server.');
        }
    };


    const fetchSingleCardDetails = async (item) => {
        try {
            const [scryfallResponse, priceResponse] = await Promise.all([
                fetch(`https://api.scryfall.com/cards/${item.setCode.toLowerCase()}/${item.collectorNumber}`),
                fetch(`/api/prices/${item.setCode}/${item.collectorNumber}`)
            ]);
            if (!scryfallResponse.ok) throw new Error('Scryfall API fail');

            const scryfallData = await scryfallResponse.json();
            const priceData = priceResponse.ok ? await priceResponse.json() : null;

            item.imageUrl = scryfallData.image_uris?.normal || 'https://placehold.co/245x342/1a1a1a/e0e0e0?text=N/A';
            item.tcgplayerId = scryfallData.tcgplayer_id;
            item.tcgMarketPrice = getLatestPrice(priceData?.paper?.tcgplayer?.retail?.[item.foilType]);

            const tcgBreakeven = calculateBreakevenPrice(item.pricePaid, TCGPLAYER_FEE_RATE);
            const mpBreakeven = calculateBreakevenPrice(item.pricePaid, MANAPOOL_FEE_RATE);
            
            const tcgRecPrice = calculateRecommendedPrice(item.tcgLow || item.tcgMarketPrice, tcgBreakeven);
            const mpRecPrice = calculateRecommendedPrice(item.manaPoolLow, mpBreakeven);

            const timeAgo = formatTimeAgo(item.pricesLastUpdatedAt);
            const itemElement = document.getElementById(`item-${item.id}`);
            
            if (itemElement) {
                itemElement.classList.remove('skeleton');
                itemElement.innerHTML = `
                    <img src="${item.imageUrl}" alt="${item.name}" class="inventory-image">
                    <div class="inventory-item-main">
                        <div class="info-block">
                            <h3>
                                <a class="link" target="_blank" rel="noopener noreferrer" href="https://tcgplayer.com/product/${item.tcgplayerId}">${item.name}</a>
                                <div class="quantity-display">
                                    <button class="quantity-btn" data-id="${item.id}" data-action="decrease">−</button>
                                    <span id="quantity-${item.id}">x${item.quantity}</span>
                                    <button class="quantity-btn" data-id="${item.id}" data-action="increase">+</button>
                                </div>

                                <span class="set-code">(${item.setCode})</span>
                                <span class="condition-badge condition-${item.condition.toLowerCase()}">${item.condition}</span>
                                <span class="foil-badge foil-${item.foilType}">${item.foilType === 'normal' ? '' : item.foilType}</span>
                            </h3>
                            <div class="price-line"><span>Price Paid:</span><span class="price-paid">$${item.pricePaid.toFixed(2)}</span></div>
                            <div class="price-line"><span>TCG Market:</span><span class="price-market" id="market-${item.id}">$${item.tcgMarketPrice.toFixed(2)}</span></div>
                            <div class="price-line"><span>TCG Low:</span><span class="price-scraped" id="tcg-low-${item.id}">${item.tcgLow ? '$' + item.tcgLow.toFixed(2) : '-'}</span></div>
                            <div class="price-line"><span>MP Low:</span><span class="price-scraped" id="mp-low-${item.id}">${item.manaPoolLow ? '$' + item.manaPoolLow.toFixed(2) : '-'}</span></div>
                            <div class="last-updated" id="updated-${item.id}">${timeAgo ? `Updated: ${timeAgo}` : ''}</div>
                        </div>
                        <div class="info-block" id="analysis-${item.id}">
                            <h3><abbr title="Includes est. shipping costs and 1.49 shipping charge on customer">Break-Even</abbr></h3>
                            <div class="price-line"><span>TCGPlayer:</span><span style="${tcgBreakeven < (item.tcgLow ?? item.tcgMarketPrice) ? 'color: #28a745; font-weight: bold;' : ''}">$${tcgBreakeven.toFixed(2)}</span></div>
                            <div class="price-line"><span>ManaPool:</span><span style="${item.manaPoolLow && (mpBreakeven < item.manaPoolLow) ? 'color: #28a745; font-weight: bold;' : ''}">$${mpBreakeven.toFixed(2)}</span></div>
                        </div>
                        <div class="info-block" id="rec-price-${item.id}">
                            <h3>Recommended Price</h3>
                            <div class="price-line"><span>TCGPlayer:</span><span class="price-rec" id="rec-tcg-${item.id}">$${tcgRecPrice.toFixed(2)}</span></div>
                            <div class="price-line"><span>ManaPool:</span><span class="price-rec" id="rec-mp-${item.id}">$${mpRecPrice.toFixed(2)}</span></div>
                        </div>
                        <div class="info-block actions">
                            <button class="scrape-btn" data-id="${item.id}" ${!item.tcgplayerId ? 'disabled' : ''}>Scrape Lows</button>
                            <button class="delete-btn" data-id="${item.id}">Delete</button>
                        </div>
                    </div>
                `;
            }
        } catch (error) {
            console.error(`Failed to load details for ${item.name}:`, error);
            const itemElement = document.getElementById(`item-${item.id}`);
            if (itemElement) itemElement.innerHTML = '<p class="error">Could not load card data.</p>';
        }
    };

    const addCardToInventory = async (cardData) => {
        try {
            const response = await fetch('/api/inventory', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(cardData) // cardData now contains quantity
            });
            if (!response.ok) throw new Error("Failed to save to inventory.");
            location.reload();
        } catch (error) {
            console.error(error);
            alert('Could not add card to inventory.');
        }
    };

    const searchForPrintings = async (cardName) => {
        if (!cardName || cardName.length < 3) {
            addCardResults.innerHTML = ''; return;
        }
        addCardResults.innerHTML = '<div class="loader">Searching...</div>';
        try {
            const response = await fetch(`/api/printings/${encodeURIComponent(cardName)}`);
            if (!response.ok) throw new Error('No printings found.');
            const printings = await response.json();
            addCardResults.innerHTML = '';
            printings.forEach(printing => {
                if (!printing.image_uris) return;
                const resultItem = document.createElement('div');
                resultItem.className = 'printing-result-item';
                let finishesHTML = printing.finishes.map(f => `<button class="finish-btn" data-finish="${f}">${f}</button>`).join('');
                resultItem.innerHTML = `
                    <img src="${printing.image_uris.art_crop}" loading="lazy">
                    <div><strong>${printing.name}</strong> <span>(${printing.set_name})</span></div>
                    <div class="finishes">${finishesHTML}</div>
                    <div class="add-form-container"></div>`;
                addCardResults.appendChild(resultItem);
resultItem.querySelectorAll('.finish-btn').forEach(button => {
                    button.addEventListener('click', () => {
                        const formContainer = resultItem.querySelector('.add-form-container');
                        formContainer.innerHTML = `
                            <div class="condition-selector">
                                ${['NM', 'LP', 'MP', 'HP', 'DMG'].map(cond => `<button data-condition="${cond}">${cond}</button>`).join('')}
                            </div>
                            <input type="number" class="price-input" placeholder="Price Paid">
                            <input type="number" class="quantity-input" value="1" min="1">
                            <button class="add-btn">Add</button>
                        `;

                        formContainer.querySelector('.add-btn').addEventListener('click', () => {
                            const price = parseFloat(formContainer.querySelector('.price-input').value);
                            const quantity = parseInt(formContainer.querySelector('.quantity-input').value, 10);
                            const condition = formContainer.querySelector('button.selected')?.dataset.condition;

                            if (isNaN(price) || isNaN(quantity) || quantity < 1 || !condition) {
                                alert("Please select a condition and enter a valid price and quantity.");
                                return;
                            }
                            const cardToAdd = {
                                // ... (other properties)
                                pricePaid: price,
                                condition: condition,
                                quantity: quantity
                            };
                            addCardToInventory(cardToAdd);
                        });
                        formContainer.querySelectorAll('.condition-selector button').forEach(condBtn => {
                            condBtn.addEventListener('click', () => {
                                formContainer.querySelectorAll('.condition-selector button').forEach(btn => btn.classList.remove('selected'));
                                condBtn.classList.add('selected');
                            });
                        });
                    });
                });
            });
        } catch (e) {
            addCardResults.innerHTML = '<p>No printings found.</p>';
        }
    };
    
    const scrapeLiveLows = async (itemId, button) => {
        const item = inventory.find(i => i.id === itemId);
        if (!item) return;
        button.disabled = true;
        button.textContent = 'Scraping...';
        try {
            const response = await fetch('/api/scrape-lows', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    tcgplayerId: item.tcgplayerId,
                    cardName: item.name,
                    setCode: item.setCode,
                    collectorNumber: item.collectorNumber,
                    foilType: item.foilType,
                    condition: item.condition
                })
            });
            if (!response.ok) throw new Error('Scrape failed.');
            const scrapedData = await response.json();
            await fetch(`/api/inventory/${item.id}/prices`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(scrapedData)
            });
            item.tcgLow = scrapedData.tcgLow;
            item.manaPoolLow = scrapedData.manaPoolLow;
            document.getElementById(`tcg-low-${item.id}`).textContent = item.tcgLow ? `$${item.tcgLow.toFixed(2)}` : 'N/A';
            document.getElementById(`mp-low-${item.id}`).textContent = item.manaPoolLow ? `$${item.manaPoolLow.toFixed(2)}` : 'N/A';
            document.getElementById(`updated-${item.id}`).textContent = 'Updated: Just now';
            const tcgBreakeven = calculateBreakevenPrice(item.pricePaid, TCGPLAYER_FEE_RATE);
            const mpBreakeven = calculateBreakevenPrice(item.pricePaid, MANAPOOL_FEE_RATE);
            const newTcgRec = calculateRecommendedPrice(item.tcgLow, tcgBreakeven);
            const newMpRec = calculateRecommendedPrice(item.manaPoolLow, mpBreakeven);
            document.getElementById(`rec-tcg-${item.id}`).textContent = `$${newTcgRec.toFixed(2)}`;
            document.getElementById(`rec-mp-${item.id}`).textContent = `$${newMpRec.toFixed(2)}`;
            button.textContent = '✓ Updated';
        } catch (error) {
            console.error(error);
            button.textContent = 'Error!';
            setTimeout(() => {
                button.disabled = false;
                button.textContent = 'Scrape Lows';
            }, 2000);
        }
    };

    const deleteInventoryItem = async (itemId) => {
        if (!confirm("Are you sure you want to delete this item?")) return;
        try {
            const response = await fetch(`/api/inventory/${itemId}`, { method: 'DELETE' });
            if (!response.ok) throw new Error("Failed to delete.");
            document.getElementById(`item-${itemId}`).remove();
            inventory = inventory.filter(item => item.id !== itemId);
        } catch (error) {
            console.error(error);
            alert("Could not delete item.");
        }
    };

    const initializePage = async () => {
        try {
            const response = await fetch('/api/inventory');
            if (!response.ok) throw new Error("Could not fetch inventory from server.");
            inventory = await response.json();
            renderInventory();
        } catch (error) {
            console.error(error);
            inventoryContainer.innerHTML = '<p class="error">Could not load inventory.</p>';
        }
    };
    
    // --- Event Listeners ---
    let debounceTimer;
    addCardSearch.addEventListener('input', () => {
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => searchForPrintings(addCardSearch.value), 300);
    });

    inventoryContainer.addEventListener('click', (event) => {
        const button = event.target;
        const itemId = button.dataset.id;
        if (button.matches('.scrape-btn')) {
            scrapeLiveLows(itemId, button);
        } else if (button.matches('.delete-btn')) {
            deleteInventoryItem(itemId);
        } else if (button.matches('.quantity-btn')) {
            const action = button.dataset.action;
            updateQuantity(itemId, action);
        }
    });


    initializePage();
});