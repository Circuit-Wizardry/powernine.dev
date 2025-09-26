document.addEventListener('DOMContentLoaded', () => {
    // --- State & DOM Elements ---
    let transactions = [];
    let inventory = [];
    let stagedItems = []; // Holds items for the current transaction before submission
    const TCGPLAYER_FEE_RATE = 0.1275;
    const MANAPOOL_FEE_RATE = 0.079;
    const FIXED_SHIPPING_EXPENSE = 1.25; // Estimated fixed cost per transaction
    const FLAT_FEE = 0.30;

    const transactionListContainer = document.getElementById('transaction-list-container');
    const modal = document.getElementById('transaction-modal');
    const modalContentBody = document.getElementById('modal-content-body');
    const addTransactionBtn = document.getElementById('add-transaction-btn');
    const closeModalBtn = modal.querySelector('.close-button');

    // --- Frontend rate-limiting queue for Scryfall detail fetches ---
    const RATE_LIMIT_MS = 125;
    const detailRequestQueue = [];
    let isDetailRequestProcessing = false;

    /**
     * Processes the queue of requests to fetch detailed inventory data.
     * Re-enables the "Add Transaction" button when all data is loaded.
     */
    const processDetailQueue = () => {
        if (detailRequestQueue.length === 0) {
            isDetailRequestProcessing = false;
            addTransactionBtn.disabled = false;
            addTransactionBtn.textContent = '＋ Add Transaction';
            console.log("All inventory details loaded.");
            return;
        }
        isDetailRequestProcessing = true;
        const task = detailRequestQueue.shift();
        task();
        setTimeout(processDetailQueue, RATE_LIMIT_MS);
    };

    const addToDetailQueue = (task) => {
        detailRequestQueue.push(task);
        if (!isDetailRequestProcessing) {
            processDetailQueue();
        }
    };

    // --- Helper Functions ---
    const calculateFees = (salePrice, platform) => {
        if (salePrice <= 0) return 0;
        const rate = platform === 'TCGPlayer' ? TCGPLAYER_FEE_RATE : MANAPOOL_FEE_RATE;
        return (salePrice * rate) + FLAT_FEE;
    };
    const formatDate = (dateString) => new Date(dateString).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
    const getLatestPrice = (priceHistory) => {
        if (!priceHistory || typeof priceHistory !== 'object' || Object.keys(priceHistory).length === 0) return 0;
        const latestDate = Object.keys(priceHistory).sort((a, b) => new Date(b) - new Date(a))[0];
        return priceHistory[latestDate] || 0;
    };

    // --- Core UI Functions ---
    const renderTransactionList = () => {
        if (transactions.length === 0) {
            transactionListContainer.innerHTML = '<p class="empty-list-message">No transactions yet. Click "Add Transaction" to log a sale.</p>';
            return;
        }
        transactionListContainer.innerHTML = transactions.map(t => {
            const profitClass = t.netProfit >= 0 ? 'profit' : 'loss';
            const profitSign = t.netProfit >= 0 ? '+' : '';
            return `
                <div class="transaction-item ${profitClass}" data-id="${t.id}">
                    <div class="transaction-info">
                        <strong>${t.items.length > 1 ? `Sale (${t.items.length} items)` : t.items[0].name}</strong>
                        <small>${t.items.length > 1 ? `Total Sale: $${t.totalSalePrice.toFixed(2)}` : `${t.items[0].condition} ${t.items[0].foilType !== 'normal' ? t.items[0].foilType : ''}`}</small>
                    </div>
                    <div class="transaction-platform">${t.platform}</div>
                    <div class="transaction-date">${formatDate(t.soldAt)}</div>
                    <div class="transaction-profit ${profitClass}">${profitSign}$${t.netProfit.toFixed(2)}</div>
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
        stagedItems = []; // Reset staged items for a new transaction
        modalContentBody.innerHTML = `
            <h2>Log a New Transaction</h2>
            <form id="add-transaction-form">
                <div class="card-selector-area">
                    <select id="inventory-select">
                        <option value="">-- Select a Card to Add to Sale --</option>
                        ${availableInventory.map(item => `<option value="${item.id}">${item.name} - ${item.condition} (${item.setCode}) Qty: ${item.quantity}</option>`).join('')}
                    </select>
                    <button type="button" id="add-item-to-sale-btn">Add to Sale</button>
                </div>
                <div id="staged-items-container"></div>
                <hr>
                <div class="form-grid">
                    <div class="form-group"><label for="shippingCost">Shipping Cost ($):</label><input type="number" name="shippingCost" id="shippingCost" step="0.01" value="0.00" required></div>
                    <div class="form-group"><label for="platform">Platform:</label><select name="platform" id="platform" required><option value="TCGPlayer">TCGPlayer</option><option value="ManaPool">ManaPool</option></select></div>
                </div>
                <div class="profit-preview" id="profit-preview"></div>
                <button type="submit" class="action-btn">Save Transaction</button>
            </form>
        `;
        modal.style.display = 'flex';
        document.getElementById('add-item-to-sale-btn').addEventListener('click', stageItemForSale);
        document.getElementById('add-transaction-form').addEventListener('submit', handleFormSubmit);
        document.getElementById('add-transaction-form').addEventListener('input', updateProfitPreview);
    };

    const stageItemForSale = () => {
        const select = document.getElementById('inventory-select');
        const inventoryId = select.value;
        if (!inventoryId) return;
        const itemInStage = stagedItems.find(i => i.inventoryId === inventoryId);
        if (itemInStage) { alert("This card is already in the sale."); return; }
        const item = inventory.find(i => i.id === inventoryId);
        stagedItems.push({
            inventoryId: item.id,
            name: item.name,
            pricePaid: item.pricePaid,
            salePrice: item.tcgMarketPrice || 0,
            quantity: 1, // Default quantity is always 1
            maxQuantity: item.quantity // Store max available quantity for validation
        });
        select.value = '';
        renderStagedItems();
        updateProfitPreview();
    };

    const renderStagedItems = () => {
        const container = document.getElementById('staged-items-container');
        container.innerHTML = stagedItems.map((item, index) => `
            <div class="staged-item">
                <span>${item.name} (Max: ${item.maxQuantity})</span>
                <div class="staged-item-inputs">
                    <input type="number" class="staged-quantity-input" data-index="${index}" value="${item.quantity}" min="1" max="${item.maxQuantity}" title="Quantity">
                    <span>x</span>
                    <input type="number" class="staged-price-input" data-index="${index}" step="0.01" value="${item.salePrice.toFixed(2)}" title="Price per item">
                </div>
            </div>
        `).join('');
    };

    const openViewModal = (transaction) => {
        const totalPurchasePrice = transaction.items.reduce((acc, item) => acc + item.pricePaid, 0);
        const fees = calculateFees(transaction.totalSalePrice, transaction.platform);
        modalContentBody.innerHTML = `
            <h2>Transaction Details</h2>
            <div class="details-grid">
                <div class="info-block">
                    <h3>Cost Breakdown</h3>
                    <div class="price-line"><span>Sold On:</span><span>${formatDate(transaction.soldAt)}</span></div>
                    <div class="price-line"><span>Platform:</span><span>${transaction.platform}</span></div>
                    <hr>
                    <div class="price-line"><span>Total Sale Price:</span><span class="profit">+ $${transaction.totalSalePrice.toFixed(2)}</span></div>
                    <div class="price-line"><span>Platform Fees:</span><span class="loss">- $${fees.toFixed(2)}</span></div>
                    <div class="price-line"><span>Shipping Cost:</span><span class="loss">- $${transaction.shippingCost.toFixed(2)}</span></div>
                    <div class="price-line"><span>Total Purchase Price:</span><span class="loss">- $${totalPurchasePrice.toFixed(2)}</span></div>
                    <hr>
                    <div class="price-line total">
                        <span>Net Profit:</span>
                        <span class="${transaction.netProfit >= 0 ? 'profit' : 'loss'}">$${transaction.netProfit.toFixed(2)}</span>
                    </div>
                    <button id="delete-transaction-btn" class="action-btn destructive" data-id="${transaction.id}">Delete Transaction</button>
                </div>
                <div class="info-block">
                    <h3>Items Sold (${transaction.items.length})</h3>
                    ${transaction.items.map(item => `<div class="price-line"><span>${item.name}</span><span>$${item.salePrice.toFixed(2)}</span></div>`).join('')}
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
        document.querySelectorAll('.staged-price-input').forEach(input => {
            const index = parseInt(input.dataset.index, 10);
            if (stagedItems[index]) {
                stagedItems[index].salePrice = parseFloat(input.value) || 0;
            }
        });
        const totalSalePrice = stagedItems.reduce((acc, item) => acc + (item.salePrice * item.quantity), 0);
        const totalPurchasePrice = stagedItems.reduce((acc, item) => acc + (item.pricePaid * item.quantity), 0);
        if (totalSalePrice === 0 && totalPurchasePrice === 0) {
            previewEl.innerHTML = '';
            return;
        }
        const customerPaidShipping = parseFloat(form.elements.shippingCost.value) || 0;
        const platform = form.elements.platform.value;
        const fees = calculateFees(totalSalePrice, platform);

        // New, more accurate profit calculation
        const grossRevenue = totalSalePrice + customerPaidShipping;
        const totalCost = totalPurchasePrice + fees + FIXED_SHIPPING_EXPENSE;
        const netProfit = grossRevenue - totalCost;
        const profitClass = netProfit >= 0 ? 'profit' : 'loss';
        previewEl.innerHTML = `
            <div class="price-line"><span>Total Sale Price:</span><span>$${totalSalePrice.toFixed(2)}</span></div>
            <div class="price-line"><span>Platform Fees:</span><span class="loss">- $${fees.toFixed(2)}</span></div>
            <div class="price-line"><span>Total Purchase Price:</span><span class="loss">- $${totalPurchasePrice.toFixed(2)}</span></div>
            <hr>
            <div class="price-line total"><span>Estimated Net Profit:</span><span class="${profitClass}">$${netProfit.toFixed(2)}</span></div>
        `;
    };

    const handleFormSubmit = async (event) => {
        event.preventDefault();
        const form = event.target;
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
        const transactionData = {
            items: stagedItems.map(i => ({
                inventoryId: i.inventoryId,
                salePrice: i.salePrice,
                quantity: i.quantity // <-- The quantity is now included here
            })),
            platform: form.elements.platform.value,
            shippingCost: parseFloat(form.elements.shippingCost.value) || 0,
        }
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
            transactions = await transRes.json();
            inventory = await invRes.json();
            renderTransactionList();
            if (inventory.length > 0) {
                inventory.forEach(item => {
                    addToDetailQueue(() => {
                        fetch(`/api/prices/${item.setCode}/${item.collectorNumber}`)
                            .then(res => res.ok ? res.json() : null)
                            .then(priceData => {
                                item.tcgMarketPrice = getLatestPrice(priceData?.paper?.tcgplayer?.retail?.[item.foilType]) || 0;
                            });
                    });
                });
            } else {
                addTransactionBtn.disabled = false;
                addTransactionBtn.textContent = '＋ Add Transaction';
            }
        } catch (error) {
            console.error("Failed to initialize page:", error);
            transactionListContainer.innerHTML = '<p class="error">Could not load transaction data.</p>';
            addTransactionBtn.textContent = 'Error Loading';
        }
    };

    // --- Event Listeners ---
    addTransactionBtn.addEventListener('click', openAddModal);
    closeModalBtn.addEventListener('click', () => modal.style.display = 'none');
    window.addEventListener('click', (event) => {
        if (event.target === modal) modal.style.display = 'none';
    });
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
