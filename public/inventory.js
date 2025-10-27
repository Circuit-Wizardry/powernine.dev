document.addEventListener('DOMContentLoaded', () => {
    if (!window.cardUtils) {
        console.error('cardUtils utilities are not available.');
        return;
    }
    const { CardSearchWidget } = window.cardUtils;

    // --- Constants & Config ---
    const TCGPLAYER_FEE_RATE = 0.1275;
    const MANAPOOL_FEE_RATE = 0.079;
    const FLAT_FEE = 0.30;
    const RECOMMENDED_MARKUP = 1.10; // 10% markup over floor price

    // --- DOM Elements ---
    const inventoryContainer = document.getElementById('inventory-container');
    const addCardSearch = document.getElementById('add-card-search');
    const addCardResults = document.getElementById('add-card-results');
    const exportBtn = document.getElementById('export-inventory-btn');
    const exportModal = document.getElementById('export-modal');
    const exportModalText = document.getElementById('export-modal-text');
    const exportModalClose = document.getElementById('export-modal-close');

    // --- State ---
    let inventory = [];

    const RATE_LIMIT_MS = 5;
    const detailRequestQueue = [];
    let isDetailRequestProcessing = false;

    const formatPrice = (value) => {
      // Check if the value is of type 'number' and is not NaN
      if (typeof value === 'number' && !isNaN(value)) {
        return `$${value.toFixed(2)}`;
      }
      // Otherwise, just return the original value (e.g., "N/A")
      return "N/A";
    };

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
    
    const getBuylists = (pricesData, vendor, foilType) => {
        // Use optional chaining (?.) to safely navigate the nested object structure.
        // This prevents errors if any intermediate key (like 'paper' or 'buylist') doesn't exist.
        const priceHistory = pricesData?.paper?.[vendor]?.buylist?.[foilType];

        // Check if priceHistory is a valid, non-empty object.
        if (!priceHistory || typeof priceHistory !== 'object' || Object.keys(priceHistory).length === 0) {
            return 0; // Return 0 if no data is available
        }

        // Find the most recent date by sorting the date strings in descending order.
        const latestDate = Object.keys(priceHistory).sort((a, b) => new Date(b) - new Date(a))[0];

        // Return the price for the latest date, or 0 if it's somehow missing.
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

        // Create a copy of the inventory, sort it by name, and then iterate
        [...inventory]
            .sort((a, b) => a.name.localeCompare(b.name))
            .forEach(item => {
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
            const [rawCardData] = await Promise.all([
                fetch(`/api/card/details/${item.setCode}/${item.collectorNumber}`)
            ]);

            const cardData = rawCardData.ok ? await rawCardData.json() : null;

            const cardIdentifiersData = cardData?.identifiers || null;

            item.imageUrl = `https://tcgplayer-cdn.tcgplayer.com/product/${cardIdentifiersData.tcgplayerProductId}_in_1000x1000.jpg` || 'https://placehold.co/245x342/1a1a1a/e0e0e0?text=N/A';
            item.tcgplayerId = cardIdentifiersData.tcgplayerProductId;

            const itemElement = document.getElementById(`item-${item.id}`);

            const cardInfo = cardData?.card || {};
            const setInfo = cardData?.set || {};
            const priceData = cardData?.prices || null;
            const purchaseUrls = cardData?.purchaseUrls || {};

            // console.log(item)

            item.tcgMarketPrice = getLatestPrice(priceData?.paper?.tcgplayer?.retail?.[item.foilType]);
            const tcgLow = item.tcgLow;
            const tcgLowPlusShipping = item.tcgLowPlusShipping;

            const ckBuylist = (getBuylists(priceData, 'cardkingdom', item.foilType));
            
            const timeAgo = formatTimeAgo(item.pricesLastUpdatedAt);
                        
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
                        </div>

                        <div class="info-block actions">
                            <button class="scrape-btn" data-id="${item.id}" ${!item.tcgplayerId ? 'disabled' : ''}>Scrape Lows</button>
                            <button class="delete-btn" data-id="${item.id}">Delete</button>
                        </div>

                        <div class="price-table-container">
                            <table>
                                <thead>
                                    <tr>
                                        <th>TCG Market</th>
                                        <th>TCG Low</th>
                                        <th>TCG Low + Ship</th>
                                        <th>CK Buylist</th>
                                        <th>SCG Buylist</th>
                                        <th>CSI Buylist</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    <tr>
                                      <td data-price-type="tcgMarketPrice">${formatPrice(item.tcgMarketPrice)}</td>
                                      <td data-price-type="tcgLow">${formatPrice(tcgLow)}</td>
                                      <td data-price-type="tcgLowPlusShipping">${formatPrice(tcgLowPlusShipping)}</td>
                                      <td class="${formatPrice(ckBuylist) > formatPrice(tcgLowPlusShipping) ? "profitable" : ""}" data-price-type="ckBuylist">${formatPrice(ckBuylist)}</td>
                                      <td data-price-type="scgBuylist">${formatPrice(0)}</td>
                                      <td data-price-type="csiBuylist">${formatPrice(0)}</td>
                                    </tr>
                                </tbody>
                            </table>
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
                body: JSON.stringify(cardData)
            });
            if (!response.ok) throw new Error("Failed to save to inventory.");
            location.reload();
        } catch (error) {
            console.error(error);
            alert('Could not add card to inventory.');
        }
    };

    const closeExportModal = () => {
        if (!exportModal) return;
        exportModal.classList.remove('show');
        exportModalText.value = '';
    };

    const exportInventoryToTxt = () => {
        if (inventory.length === 0) {
            alert("Your inventory is empty. Nothing to export.");
            return;
        }

        const sortedInventory = [...inventory].sort((a, b) => a.name.localeCompare(b.name));

        const txtContent = sortedInventory.map(item => {
            const foilMarker = item.foilType !== 'normal' ? ' *F*' : '';
            return `${item.quantity} ${item.name} (${item.setCode}) ${item.collectorNumber}${foilMarker}`;
        }).join('\n');

        if (exportModal && exportModalText) {
            exportModalText.value = txtContent;
            exportModal.classList.add('show');
            requestAnimationFrame(() => {
                exportModalText.focus();
                exportModalText.select();
            });
        } else {
            console.log(txtContent);
            alert('Export modal is unavailable. The text has been logged to the console.');
        }
    };

    const searchForPrintings = async (cardName) => {
        if (!cardName) {
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
                    <img src="${printing.image_uris.normal || printing.image_uris.large || printing.image_uris.small}" loading="lazy">
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
                                name: printing.name,
                                setCode: printing.set.toUpperCase(),
                                collectorNumber: printing.collector_number,
                                foilType: button.dataset.finish === 'nonfoil' ? 'normal' : button.dataset.finish,
                                tcgplayerId: printing.tcgplayer_id,
                                scryfallId: printing.id,
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
    
    const updatePriceRow = (itemId, priceData) => {
        // Find the main container for the specific inventory item.
        const itemContainer = document.getElementById(`item-${itemId}`);
        if (!itemContainer) {
            console.error(`Could not find container for item ID: ${itemId}`);
            return;
        }

        // Loop through each key in the new price data (e.g., "tcgLow", "ckBuylist").
        for (const key in priceData) {
            // Find the specific table cell within this item's container.
            const cell = itemContainer.querySelector(`[data-price-type="${key}"]`);
            if (cell) {
                // Update the cell's text with the new, formatted price.
                cell.textContent = formatPrice(priceData[key]);
            }
        }
    };

    /**
     * Scrapes live pricing data for a given inventory item and updates the UI.
     * @param {string} itemId - The ID of the item to scrape.
     * @param {HTMLButtonElement} button - The button element that was clicked.
     */
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

            if (!response.ok) {
                const errorInfo = await response.json();
                throw new Error(errorInfo.error || 'Scrape failed from server.');
            }

            const scrapedData = await response.json();

            await fetch(`/api/inventory/${item.id}/prices`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(scrapedData)
            });


            // **THE MAGIC HAPPENS HERE**
            // Call the new, clean function to update the entire row.
            updatePriceRow(item.id, scrapedData);

            // (Optional) You can still update the local inventory object if needed for other calculations
            Object.assign(item, scrapedData);

            button.textContent = '✓ Scraped';



            setTimeout(() => {
                button.disabled = false;
                button.textContent = 'Scrape Lows';
            }, 2000);

        } catch (error) {
            console.error('Error in scrapeLiveLows:', error);
            button.textContent = 'Error!';
            // Reset the button after a delay so the user can try again.
            setTimeout(() => {
                button.disabled = false;
                button.textContent = 'Scrape Lows';
            }, 3000);
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
    new CardSearchWidget({
        input: addCardSearch,
        limit: 10,
        onSelect: (card) => {
            addCardSearch.value = card.name;
            searchForPrintings(card.name);
        },
    });

    exportBtn.addEventListener('click', exportInventoryToTxt);

    if (exportModalClose) {
        exportModalClose.addEventListener('click', closeExportModal);
    }

    if (exportModal) {
        exportModal.addEventListener('click', (event) => {
            if (event.target === exportModal) {
                closeExportModal();
            }
        });
    }

    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && exportModal?.classList.contains('show')) {
            closeExportModal();
        }
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
