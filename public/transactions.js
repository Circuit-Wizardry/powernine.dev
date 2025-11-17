document.addEventListener('DOMContentLoaded', () => {
    if (!window.cardUtils) {
        console.error('cardUtils utilities are not available.');
        return;
    }
    // --- State & DOM Elements ---
    let transactions = [];
    let inventory = [];
    let stagedItems = []; // Holds items for the current transaction before submission
    const TCGPLAYER_FEE_RATE = 0.1275;
    const MANAPOOL_FEE_RATE = 0.079;
    const FLAT_FEE = 0.30;

    const transactionListContainer = document.getElementById('transaction-list-container');
    const modal = document.getElementById('transaction-modal');
    const modalContentBody = document.getElementById('modal-content-body');
    const addTransactionBtn = document.getElementById('add-transaction-btn');
    const closeModalBtn = modal.querySelector('.close-button');

    let inventorySearchWidget = null;

    // --- Frontend rate-limiting queue for Scryfall detail fetches ---
    const RATE_LIMIT_MS = 75;
    const detailRequestQueue = [];
    let isDetailRequestProcessing = false;

    /**
     * Processes the queue of requests to fetch detailed inventory data.
     * Re-enables the "Add Transaction" button when all data is loaded.
     */
    const processDetailQueue = async () => {
        if (detailRequestQueue.length === 0) {
            isDetailRequestProcessing = false;
            addTransactionBtn.disabled = false;
            addTransactionBtn.textContent = '+ Add Transaction';
            console.log("All inventory details loaded.");
            return;
        }
        isDetailRequestProcessing = true;
        const task = detailRequestQueue.shift();
        try {
            await task();
        } catch (error) {
            console.error('Inventory detail fetch failed:', error);
        }
        setTimeout(processDetailQueue, RATE_LIMIT_MS);
    };

    const addToDetailQueue = (task) => {
        detailRequestQueue.push(task);
        if (!isDetailRequestProcessing) {
            processDetailQueue();
        }
    };

    const escapeHtml = (value = '') => String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');

    const disposeInventorySearchWidget = () => {
        if (inventorySearchWidget) {
            inventorySearchWidget.destroy();
            inventorySearchWidget = null;
        }
    };

    const closeModal = () => {
        disposeInventorySearchWidget();
        modal.style.display = 'none';
        modalContentBody.innerHTML = '';
    };

    // --- Helper Functions ---
    const calculateFees = (salePrice, platform) => {
        if (salePrice <= 0) return 0;
        const rate = platform === 'TCGPlayer' ? TCGPLAYER_FEE_RATE : (platform === 'ManaPool' ? MANAPOOL_FEE_RATE : 0);
        if (rate === 0) return 0; // No fees for independent sales
        return (salePrice * rate) + FLAT_FEE;
    };

    const formatDate = (dateString) => new Date(dateString).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
    const getLatestPrice = (priceHistory) => {
        if (!priceHistory || typeof priceHistory !== 'object' || Object.keys(priceHistory).length === 0) return 0;
        const latestDate = Object.keys(priceHistory).sort((a, b) => new Date(b) - new Date(a))[0];
        return priceHistory[latestDate] || 0;
    };

    const formatCurrency = (value = 0) => {
        const amount = Number(value);
        if (!Number.isFinite(amount)) return '$0.00';
        const sign = amount < 0 ? '-' : '';
        return `${sign}$${Math.abs(amount).toFixed(2)}`;
    };

    const computeTransactionNet = (transaction) => {
        const revenue = Number(transaction.totalSalePrice || 0);
        const fees = calculateFees(revenue, transaction.platform);
        const net = Number((revenue - fees).toFixed(2));
        return { net, fees };
    };

    // --- Core UI Functions ---
    const renderTransactionList = () => {
        if (transactions.length === 0) {
            transactionListContainer.innerHTML = '<p class="empty-list-message">No transactions yet. Click "Add Transaction" to log a sale.</p>';
            return;
        }
        transactionListContainer.innerHTML = transactions.map(t => {
            const summary = computeTransactionNet(t);
            const primaryItem = t.items[0] || {};
            const title = t.items.length > 1
                ? `Sale (${t.items.length} items)`
                : escapeHtml(primaryItem.name || 'Unknown card');
            const subtitle = t.items.length > 1
                ? `Total Sale: ${formatCurrency(t.totalSalePrice)}`
                : escapeHtml(`${primaryItem.condition || ''} ${primaryItem.foilType && primaryItem.foilType !== 'normal' ? primaryItem.foilType : ''}`.trim());
            const subtitleText = subtitle || 'N/A';
            const platformLabel = escapeHtml(t.platform || 'Unknown');
            const dateLabel = formatDate(t.soldAt);
            const isManaPoolOrder = Boolean(t.manapoolOrderId);
            const awaitingShipment = isManaPoolOrder && !t.isShipped;
            const rowClasses = ['transaction-item'];
            if (isManaPoolOrder) rowClasses.push('manapool-import');
            if (awaitingShipment) rowClasses.push('awaiting-shipment');
            const badges = [];

            if (isManaPoolOrder) {
                badges.push('<span class="transaction-badge manapool-badge">ManaPool Order</span>');
            }
            if (awaitingShipment) {
                badges.push('<span class="transaction-badge shipping-badge">Needs Shipment</span>');
            }
            const platformDisplay = isManaPoolOrder
                ? `${platformLabel} (Imported${awaitingShipment ? ', unshipped' : ''})`
                : platformLabel;
            return `
                <div class="${rowClasses.join(' ')}" data-id="${escapeHtml(t.id)}">
                    <div class="transaction-info">
                        <div class="transaction-title-row">
                            <strong>${title}</strong>
                            ${badges.join('')}
                        </div>
                        <small>${subtitleText}</small>
                    </div>
                    <div class="transaction-platform">${platformDisplay}</div>
                    <div class="transaction-date">${dateLabel}</div>
                    <div class="transaction-profit">${formatCurrency(summary.net)}</div>
                </div>
            `;
        }).join('');
    };

    const openAddModal = () => {
        const availableInventory = inventory.filter(item => item.quantity > 0);
        if (availableInventory.length === 0) {
            alert("You have no items in your inventory with a quantity greater than zero.");
            return;
        }
        stagedItems = [];
        disposeInventorySearchWidget();
        modalContentBody.innerHTML = `
            <h2>Log a New Transaction</h2>
            <form id="add-transaction-form">
                <div class="card-selector-area">
                    <label for="inventory-search">Search Inventory</label>
                    <input type="text" id="inventory-search" class="search-input" placeholder="Start typing to find cards in your inventory..." autocomplete="off">
                    <small class="helper-text">Selecting a result adds it to the sale. Only items with quantity remaining appear in the list.</small>
                </div>
                <div id="staged-items-container" class="staged-items"></div>
                <hr>
                <div class="form-grid">
                    <div class="form-group">
                        <label for="platform">Platform:</label>
                        <select name="platform" id="platform" required>
                            <option value="TCGPlayer">TCGPlayer</option>
                            <option value="ManaPool">ManaPool</option>
                            <option value="independent">Independent</option>
                        </select>
                    </div>
                    <div class="form-group">
                        <label for="shipping-materials-cost">Shipping label / postage cost:</label>
                        <input type="number" name="shippingMaterialsCost" id="shipping-materials-cost" min="0" step="0.01" value="0" placeholder="0.00">
                        <small class="helper-text">Enter what you paid for the label. We'll log it as a shipping expense. ManaPool sales over $45 still add $5 postage automatically.</small>
                    </div>
                </div>
                <div class="profit-preview" id="profit-preview"></div>
                <button type="submit" class="action-btn">Save Transaction</button>
            </form>
        `;
        modal.style.display = 'flex';
        modalContentBody.parentElement.scrollTop = 0;

        const searchInput = document.getElementById('inventory-search');
        const form = document.getElementById('add-transaction-form');

        inventorySearchWidget = new window.cardUtils.CardSearchWidget({
            input: searchInput,
            minLength: 1,
            limit: 12,
            debounceMs: 150,
            fetchCards: async (query, options = {}) => {
                const normalizedQuery = query.trim().toLowerCase();
                if (!normalizedQuery) {
                    return [];
                }
                const tokens = normalizedQuery.split(/\s+/).filter(Boolean);
                const results = availableInventory
                    .filter(item => tokens.every(token => item._searchString?.includes(token)))
                    .slice(0, options.limit ?? 12)
                    .map(item => ({
                        id: item.id,
                        name: item.name,
                        set_name: `${item.setCode?.toUpperCase() || ''} | ${item.condition}`.trim(),
                        collector_number: `Qty: ${item.quantity}`,
                        image_small: item.imageUrl || null,
                    }));
                return results;
            },
            onSelect: (card) => {
                const selectedItem = availableInventory.find(inv => inv.id === card.id);
                if (selectedItem) {
                    stageInventoryItem(selectedItem);
                }
                searchInput.value = '';
                searchInput.focus();
            }
        });

        form.addEventListener('submit', handleFormSubmit);
        form.addEventListener('input', updateProfitPreview);
        renderStagedItems();
        updateProfitPreview();
        searchInput.focus();
    };

    const stageInventoryItem = (item) => {
        if (!item) return;
        if (item.quantity <= 0) {
            alert('This card has no remaining quantity in inventory.');
            return;
        }
        const existing = stagedItems.find(i => i.inventoryId === item.id);
        if (existing) {
            if (existing.quantity >= existing.maxQuantity) {
                alert('You have already staged the maximum available quantity for this card.');
                return;
            }
            existing.quantity = Math.min(existing.quantity + 1, existing.maxQuantity);
            renderStagedItems();
            updateProfitPreview();
            return;
        }
        stagedItems.push({
            inventoryId: item.id,
            name: item.name,
            condition: item.condition,
            foilType: item.foilType,
            pricePaid: item.pricePaid,
            salePrice: Number.isFinite(item.tcgMarketPrice) && item.tcgMarketPrice > 0 ? item.tcgMarketPrice : item.pricePaid,
            quantity: 1,
            maxQuantity: item.quantity
        });
        renderStagedItems();
        updateProfitPreview();
    };

    const renderStagedItems = () => {
        const container = document.getElementById('staged-items-container');
        if (!container) return;

        if (stagedItems.length === 0) {
            container.innerHTML = '<p class="staged-items-empty">Search for a card above and select it to add it to this sale.</p>';
            return;
        }

        container.innerHTML = stagedItems.map((item, index) => {
            const safeName = escapeHtml(item.name);
            const safeCondition = escapeHtml(item.condition || 'NM');
            const foilLabel = item.foilType && item.foilType !== 'normal' ? ` ? ${escapeHtml(item.foilType)}` : '';
            const maxQuantity = escapeHtml(String(item.maxQuantity));
            return `
            <div class="staged-item">
                <div class="staged-item-header">
                    <span class="staged-item-name">${safeName}</span>
                    <small class="staged-item-meta">${safeCondition}${foilLabel} ? Max ${maxQuantity}</small>
                </div>
                <div class="staged-item-inputs">
                    <label>
                        Qty
                        <input type="number" class="staged-quantity-input" data-index="${index}" value="${item.quantity}" min="1" max="${item.maxQuantity}" title="Quantity available">
                    </label>
                    <span>x</span>
                    <label>
                        Sale Price
                        <input type="number" class="staged-price-input" data-index="${index}" step="0.01" value="${item.salePrice.toFixed(2)}" title="Price per item">
                    </label>
                </div>
            </div>
        `;
        }).join('');

        container.querySelectorAll('.staged-quantity-input').forEach(input => {
            input.addEventListener('input', (event) => {
                const idx = parseInt(event.target.dataset.index, 10);
                if (!Number.isInteger(idx) || !stagedItems[idx]) return;
                const max = stagedItems[idx].maxQuantity;
                let nextValue = parseInt(event.target.value, 10);
                if (!Number.isFinite(nextValue) || nextValue < 1) nextValue = 1;
                if (nextValue > max) nextValue = max;
                event.target.value = nextValue;
                stagedItems[idx].quantity = nextValue;
                updateProfitPreview();
            });
        });

        container.querySelectorAll('.staged-price-input').forEach(input => {
            input.addEventListener('input', (event) => {
                const idx = parseInt(event.target.dataset.index, 10);
                if (!Number.isInteger(idx) || !stagedItems[idx]) return;
                const value = parseFloat(event.target.value);
                stagedItems[idx].salePrice = Number.isFinite(value) ? value : 0;
                updateProfitPreview();
            });
        });
    };

    const openViewModal = (transaction) => {
        disposeInventorySearchWidget();
        const summary = computeTransactionNet(transaction);
        const fees = summary.fees;
        const netAfterFees = summary.net;
        const netClass = netAfterFees >= 0 ? 'profit' : 'loss';
        const platformLabel = escapeHtml(transaction.platform || 'Unknown');
        const awaitingShipment = transaction.platform === 'ManaPool' && !transaction.isShipped;
        const manaPoolBanner = transaction.manapoolOrderId
            ? `<div class="info-banner manapool-banner">Imported from ManaPool order #${escapeHtml(transaction.manapoolOrderId)}</div>`
            : '';
        const shippingBanner = awaitingShipment
            ? `<div class="info-banner shipping-banner">Awaiting shipment � ship the order on ManaPool to clear this state.</div>`
            : '';
        const itemsHtml = transaction.items.map(item => {
            const qty = Number(item.quantity) || 1;
            const unitPrice = Number(item.salePrice) || 0;
            const totalPrice = unitPrice * qty;
            const descriptors = [
                item.condition,
                item.foilType && item.foilType !== 'normal' ? item.foilType : null
            ].filter(Boolean).join(' | ');
            const meta = [descriptors, `Qty ${qty}`].filter(Boolean).join(' | ');
            const totalLabel = `$${totalPrice.toFixed(2)}${qty > 1 ? ` (${qty} x $${unitPrice.toFixed(2)})` : ''}`;
            return `
                <div class="price-line item-line">
                    <span>
                        ${escapeHtml(item.name)}
                        <small>${meta}</small>
                    </span>
                    <span>${totalLabel}</span>
                </div>
            `;
        }).join('');
        modalContentBody.innerHTML = `
            <h2>Transaction Details</h2>
            ${manaPoolBanner}${shippingBanner}
            <div class="details-grid">
                <div class="info-block">
                    <h3>Cost Breakdown</h3>
                    <div class="price-line"><span>Sold On:</span><span>${formatDate(transaction.soldAt)}</span></div>
                    <div class="price-line"><span>Platform:</span><span>${platformLabel}</span></div>
                    <hr>
                    <div class="price-line"><span>Total Sale Price:</span><span class="profit">+ $${transaction.totalSalePrice.toFixed(2)}</span></div>
                    <div class="price-line"><span>Platform Fees:</span><span class="loss">- $${fees.toFixed(2)}</span></div>
                    <hr>
                    <div class="price-line total">
                        <span>Revenue After Fees:</span>
                        <span class="${netClass}">$${netAfterFees.toFixed(2)}</span>
                    </div>
                    <button id="delete-transaction-btn" class="action-btn destructive" data-id="${transaction.id}">Delete Transaction</button>
                </div>
                <div class="info-block">
                    <h3>Items Sold (${transaction.items.length})</h3>
                    ${itemsHtml}
                    <hr>
                </div>
            </div>
        `;
        modal.style.display = 'flex';
        document.getElementById('delete-transaction-btn').addEventListener('click', handleDeleteTransaction);
    };

    const updateProfitPreview = () => {
        const form = document.getElementById('add-transaction-form');
        const previewEl = document.getElementById('profit-preview');
        if (!form) return;
        document.querySelectorAll('.staged-quantity-input').forEach(input => {
            const index = parseInt(input.dataset.index, 10);
            if (stagedItems[index]) {
                let nextValue = parseInt(input.value, 10);
                if (!Number.isFinite(nextValue) || nextValue < 1) nextValue = 1;
                if (nextValue > stagedItems[index].maxQuantity) nextValue = stagedItems[index].maxQuantity;
                input.value = nextValue;
                stagedItems[index].quantity = nextValue;
            }
        });
        document.querySelectorAll('.staged-price-input').forEach(input => {
            const index = parseInt(input.dataset.index, 10);
            if (stagedItems[index]) {
                stagedItems[index].salePrice = parseFloat(input.value) || 0;
            }
        });
        const totalSalePrice = stagedItems.reduce((acc, item) => acc + (item.salePrice * item.quantity), 0);
        if (totalSalePrice === 0) {
            previewEl.innerHTML = '';
            return;
        }
        const platform = form.elements.platform.value;
        const fees = calculateFees(totalSalePrice, platform);
        const materialsCost = Number(form.elements.shippingMaterialsCost?.value) || 0;

        const netProfit = totalSalePrice - fees - materialsCost;
        const profitClass = netProfit >= 0 ? 'profit' : 'loss';
        previewEl.innerHTML = `
            <div class="price-line"><span>Total Sale Price:</span><span>$${totalSalePrice.toFixed(2)}</span></div>
            <div class="price-line"><span>Platform Fees:</span><span class="loss">- $${fees.toFixed(2)}</span></div>
            ${materialsCost > 0 ? `<div class="price-line"><span>Shipping Label/Postage:</span><span class="loss">- $${materialsCost.toFixed(2)}</span></div>` : ''}
            <hr>
            <div class="price-line total"><span>Estimated Revenue After Fees:</span><span class="${profitClass}">$${netProfit.toFixed(2)}</span></div>
        `;
    };

    const handleFormSubmit = async (event) => {
        event.preventDefault();
        const form = event.target;
        document.querySelectorAll('.staged-quantity-input').forEach(input => {
            const index = parseInt(input.dataset.index, 10);
            if (stagedItems[index]) {
                let nextValue = parseInt(input.value, 10);
                if (!Number.isFinite(nextValue) || nextValue < 1) nextValue = 1;
                if (nextValue > stagedItems[index].maxQuantity) nextValue = stagedItems[index].maxQuantity;
                stagedItems[index].quantity = nextValue;
            }
        });
        document.querySelectorAll('.staged-price-input').forEach(input => {
            const index = parseInt(input.dataset.index, 10);
            if (stagedItems[index]) {
                stagedItems[index].salePrice = parseFloat(input.value) || 0;
            }
        });
        if (stagedItems.length === 0) {
            alert("Please add at least one card to the sale.");
            return;
        }
        const shippingMaterialsCost = Number(form.elements.shippingMaterialsCost?.value) || 0;
        const transactionData = {
            items: stagedItems.map(i => ({
                inventoryId: i.inventoryId,
                salePrice: i.salePrice,
                quantity: i.quantity // <-- The quantity is now included here
            })),
            platform: form.elements.platform.value,
            shippingMaterialsCost
        };
        try {
            const transactionResponse = await fetch('/api/transactions', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(transactionData)
            });
            if (!transactionResponse.ok) {
                const errorData = await transactionResponse.json();
                throw new Error(errorData.error || 'Failed to save transaction data.');
            }
            const newTransaction = await transactionResponse.json();
            // const newTransactionId = newTransaction.id;
            // const packingSlipFile = form.elements.packingSlip.files[0];
            // if (packingSlipFile) {
            //     const formData = new FormData();
            //     formData.append('packingSlip', packingSlipFile);
            //     const slipResponse = await fetch(`/api/transactions/${newTransactionId}/packing-slip`, {
            //         method: 'POST',
            //         body: formData
            //     });
            //     if (!slipResponse.ok) {
            //         throw new Error('Transaction saved, but failed to upload packing slip.');
            //     }
            // }
            location.reload();
        } catch (error) {
            console.error(error);
            alert(`Error: ${error.message}`);
        }
    };

    const handleDeleteTransaction = async (event) => {
        const transactionId = event.target.dataset.id;
        if (!confirm("Are you sure you want to delete this transaction? This action will restore the items to your inventory and cannot be undone.")) {
            return;
        }
        try {
            const response = await fetch(`/api/transactions/${transactionId}`, { method: 'DELETE' });
            if (!response.ok) {
                const errorData = await response.json();
                throw new Error(errorData.message || 'Failed to delete transaction.');
            }
            location.reload();
        } catch (error) {
            console.error(error);
            alert(`Error: ${error.message}`);
        }
    };

    const initializePage = async () => {
        try {
            addTransactionBtn.disabled = true;
            addTransactionBtn.textContent = 'Loading Prices...';
            const [transRes, invRes] = await Promise.all([
                fetch('/api/transactions'),
                fetch('/api/inventory')
            ]);

            if (!transRes.ok) {
                const errorData = await transRes.json().catch(() => ({}));
                throw new Error(errorData.error || `Failed to load transactions (status ${transRes.status}).`);
            }
            if (!invRes.ok) {
                const errorData = await invRes.json().catch(() => ({}));
                throw new Error(errorData.error || `Failed to load inventory (status ${invRes.status}).`);
            }

            const transactionsData = await transRes.json();
            const inventoryData = await invRes.json();

            transactions = Array.isArray(transactionsData) ? transactionsData : [];
            inventory = Array.isArray(inventoryData) ? inventoryData.map(item => ({
                ...item,
                _searchString: [
                    item.name,
                    item.setCode,
                    item.collectorNumber,
                    item.condition,
                    item.foilType,
                ].filter(Boolean).join(' ').toLowerCase(),
            })) : [];
            renderTransactionList();
            if (inventory.length > 0) {
                inventory.forEach(item => {
                    addToDetailQueue(() => {
                        fetch(`/api/card/details/${item.setCode}/${item.collectorNumber}`)
                            .then(res => res.ok ? res.json() : null)
                            .then(priceData => {
                                item.tcgMarketPrice = getLatestPrice(priceData?.prices?.paper?.tcgplayer?.retail?.[item.foilType]) || 0;
                            });
                    });
                });
            } else {
                addTransactionBtn.disabled = false;
                addTransactionBtn.textContent = '+ Add Transaction';
            }
        } catch (error) {
            console.error("Failed to initialize page:", error);
            transactionListContainer.innerHTML = '<p class="error">Could not load transaction data.</p>';
            addTransactionBtn.textContent = 'Error Loading';
        }
    };

    // --- Event Listeners ---
    addTransactionBtn.addEventListener('click', openAddModal);
    closeModalBtn.addEventListener('click', closeModal);
    transactionListContainer.addEventListener('click', (event) => {
        const itemEl = event.target.closest('.transaction-item');
        if (itemEl) {
            const transactionId = itemEl.dataset.id;
            const transaction = transactions.find(t => t.id === transactionId);
            if (transaction) openViewModal(transaction);
        }
    });

    initializePage();
});








