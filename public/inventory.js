document.addEventListener('DOMContentLoaded', () => {
    if (!window.cardUtils) {
        console.error('cardUtils utilities are not available.');
        return;
    }
    const { CardSearchWidget, generateId } = window.cardUtils;

    // --- Constants & Config ---
    const TCGPLAYER_FEE_RATE = 0.1275;
    const MANAPOOL_FEE_RATE = 0.079;
    const FLAT_FEE = 0.30;
    const RECOMMENDED_MARKUP = 1.10; // 10% markup over floor price

    // --- DOM Elements ---
    const inventoryContainer = document.getElementById('inventory-container');
    const exportBtn = document.getElementById('export-inventory-btn');
    const exportModal = document.getElementById('export-modal');
    const exportModalText = document.getElementById('export-modal-text');
    const exportModalClose = document.getElementById('export-modal-close');
    const filterInput = document.getElementById('inventory-filter');
    const filterMessage = document.getElementById('inventory-filter-empty');
    const openBuylistModalBtn = document.getElementById('open-buylist-modal');
    const openAddInventoryBtn = document.getElementById('open-add-inventory-btn');
    const addInventoryModal = document.getElementById('add-inventory-modal');
    const addInventoryCloseBtn = document.getElementById('add-inventory-close-btn');
    const addInventoryBackdrop = addInventoryModal ? addInventoryModal.querySelector('.inventory-modal-backdrop') : null;
    const manapoolExportBtn = document.getElementById('export-manapool-btn');
    const manapoolModal = document.getElementById('manapool-export-modal');
    const manapoolModalClose = document.getElementById('manapool-modal-close');
    const manapoolTableBody = document.getElementById('manapool-table-body');
    const manapoolDownloadBtn = document.getElementById('manapool-download-btn');
    const modalSearchInput = document.getElementById('modal-card-search');
    const modalCardDetails = document.getElementById('modal-card-details');
    const modalCardImage = document.getElementById('modal-card-image');
    const modalCardName = document.getElementById('modal-card-name');
    const modalCardSet = document.getElementById('modal-card-set');
    const modalPrintingSelect = document.getElementById('modal-printing-select');
    const modalFinishSelect = document.getElementById('modal-finish-select');
    const modalConditionSelect = document.getElementById('modal-condition');
    const modalQuantityInput = document.getElementById('modal-quantity');
    const modalPriceInput = document.getElementById('modal-price');
    const modalPriceUnknown = document.getElementById('modal-price-unknown');
    const modalAddItemBtn = document.getElementById('modal-add-item-btn');
    const modalStagedList = document.getElementById('modal-staged-list');
    const modalStagedEmpty = document.getElementById('modal-staged-empty');
    const modalClearStagedBtn = document.getElementById('modal-clear-staged-btn');
    const modalSaveItemsBtn = document.getElementById('modal-save-items-btn');
    const modalSaveStatus = document.getElementById('modal-save-status');
    const editInventoryModal = document.getElementById('edit-inventory-modal');
    const editInventoryBackdrop = editInventoryModal ? editInventoryModal.querySelector('.inventory-modal-backdrop') : null;
    const editModalCloseBtn = document.getElementById('edit-inventory-close-btn');
    const editInventoryForm = document.getElementById('edit-inventory-form');
    const editConditionSelect = document.getElementById('edit-condition');
    const editFoilSelect = document.getElementById('edit-foil');
    const editPriceInput = document.getElementById('edit-price');
    const editCancelBtn = document.getElementById('edit-cancel-btn');
    const editModalError = document.getElementById('edit-modal-error');

    // --- State ---
    let inventory = [];
    let inventoryFilterTerm = '';
    let inventoryBuylistSnapshot = null;
    let editingInventoryItem = null;
    let manapoolExportRows = [];
    const LARGE_CARD_IMAGE_PLACEHOLDER = 'https://placehold.co/245x342/1a1a1a/e0e0e0?text=N/A';

    const formatCurrency = (value) => {
        if (typeof value === 'number' && Number.isFinite(value)) {
            return `$${value.toFixed(2)}`;
        }
        return 'N/A';
    };

    const escapeHtml = (value = '') => String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');

    const csvEscape = (value = '') => {
        const str = String(value ?? '');
        return `"${str.replace(/"/g, '""')}"`;
    };

    const getLatestPrice = (priceHistory) => {
        if (!priceHistory || typeof priceHistory !== 'object' || Object.keys(priceHistory).length === 0) return 0;
        const latestDate = Object.keys(priceHistory).sort((a, b) => new Date(b) - new Date(a))[0];
        return priceHistory[latestDate] || 0;
    };

    const inventoryBuylistModal = window.createBuylistModal({
        modal: document.getElementById('buylist-modal'),
        formatCurrency,
        formatListName: () => 'Inventory',
        getLatestPrice,
        saveSnapshot: async (payload) => {
            const response = await fetch('/api/inventory/buylist-snapshot', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
            if (!response.ok) {
                const message = await response.text();
                throw new Error(message || 'Failed to save inventory buylist snapshot.');
            }
        },
        onSnapshotChange: (snapshot) => {
            inventoryBuylistSnapshot = snapshot;
        }
    });

    const normalizeFilterTerm = (value = '') => value.toLowerCase().trim();

    inventoryFilterTerm = normalizeFilterTerm(filterInput?.value || '');

    const matchesFilter = (item) => {
        if (!inventoryFilterTerm) return true;
        const haystack = item._searchIndex || '';
        const tokens = inventoryFilterTerm.split(/\s+/).filter(Boolean);
        return tokens.every(token => haystack.includes(token));
    };

    const fetchInventoryBuylistSnapshot = async () => {
        try {
            const response = await fetch('/api/inventory/buylist-snapshot');
            if (!response.ok) return null;
            const payload = await response.json();
            return payload?.snapshot || null;
        } catch (error) {
            console.error('Failed to fetch inventory buylist snapshot:', error);
            return null;
        }
    };

    const MANABOX_CONDITION_MAP = {
        NM: 'mint',
        M: 'mint',
        LP: 'near_mint',
        MP: 'good',
        HP: 'played',
        DMG: 'poor'
    };

    const toManaBoxCondition = (condition = 'NM') => {
        const key = String(condition).toUpperCase();
        return MANABOX_CONDITION_MAP[key] || 'mint';
    };

    const getManaPoolPurchasePrice = (item) => {
        let base = Number.isFinite(item.tcgMarketPrice) && item.tcgMarketPrice > 0
            ? item.tcgMarketPrice
            : (Number(item.pricePaid) || 0);
        if (!base || base <= 0) {
            base = 100;
        }
        const price = base * RECOMMENDED_MARKUP;
        return price > 0 ? price.toFixed(2) : '0.00';
    };

    const buildManaPoolRows = () => {
        if (!Array.isArray(inventory)) return [];
        return inventory
            .filter(item => item.quantity > 0)
            .map(item => {
                const foil = item.foilType && item.foilType !== 'normal' ? 'foil' : 'normal';
                return {
                    foil,
                    quantity: Number(item.quantity) || 0,
                    scryfallId: item.scryfallId || '',
                    purchasePrice: getManaPoolPurchasePrice(item),
                    condition: toManaBoxCondition(item.condition || 'NM'),
                    language: 'en'
                };
            })
            .filter(row => row.quantity > 0);
    };

    const setEditModalError = (message = '') => {
        if (!editModalError) return;
        if (message) {
            editModalError.textContent = message;
            editModalError.hidden = false;
        } else {
            editModalError.textContent = '';
            editModalError.hidden = true;
        }
    };

    const openEditInventoryModal = (itemId) => {
        if (!editInventoryModal) return;
        const item = inventory.find(entry => entry.id === itemId);
        if (!item) return;
        editingInventoryItem = item;
        const conditionValue = String(item.condition || 'NM').toUpperCase();
        const allowedFoils = ['normal', 'foil', 'etched'];
        const foilValue = allowedFoils.includes(item.foilType) ? item.foilType : 'normal';
        if (editConditionSelect) {
            editConditionSelect.value = conditionValue;
        }
        if (editFoilSelect) {
            editFoilSelect.value = foilValue;
        }
        if (editPriceInput) {
            const price = Number.isFinite(item.pricePaid) ? item.pricePaid : '';
            editPriceInput.value = price === '' ? '' : price.toFixed(2);
        }
        setEditModalError('');
        editInventoryModal.classList.remove('hidden');
        editInventoryModal.setAttribute('aria-hidden', 'false');
        editPriceInput?.focus();
        editPriceInput?.select();
    };

    const closeEditInventoryModal = () => {
        if (!editInventoryModal) return;
        editInventoryModal.classList.add('hidden');
        editInventoryModal.setAttribute('aria-hidden', 'true');
        editingInventoryItem = null;
        setEditModalError('');
    };

    const handleEditFormSubmit = async (event) => {
        event.preventDefault();
        if (!editingInventoryItem) return;
        const condition = editConditionSelect?.value?.toUpperCase() || 'NM';
        const foilType = editFoilSelect?.value || 'normal';
        let pricePaid = Number.parseFloat(editPriceInput?.value);
        if (!Number.isFinite(pricePaid) || pricePaid < 0) {
            pricePaid = 0;
        }
        setEditModalError('');
        try {
        const response = await fetch(`/api/inventory/${editingInventoryItem.id}/details`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ condition, foilType, pricePaid })
            });
            if (!response.ok) {
                const errorData = await response.json().catch(() => ({}));
                throw new Error(errorData.error || 'Failed to update item.');
            }
            editingInventoryItem.condition = condition;
            editingInventoryItem.foilType = foilType;
            editingInventoryItem.pricePaid = pricePaid;
            closeEditInventoryModal();
            fetchSingleCardDetails(editingInventoryItem);
        } catch (error) {
            console.error(error);
            setEditModalError(error.message || 'Something went wrong.');
        }
    };

    const renderManaPoolPreview = () => {
        if (!manapoolTableBody) return;
        if (manapoolExportRows.length === 0) {
            manapoolTableBody.innerHTML = '<tr><td colspan="6" class="empty">No inventory rows available.</td></tr>';
            return;
        }
        manapoolTableBody.innerHTML = manapoolExportRows.map(row => `
            <tr>
                <td>${escapeHtml(row.foil)}</td>
                <td>${escapeHtml(row.quantity)}</td>
                <td>${escapeHtml(row.scryfallId)}</td>
                <td>$${escapeHtml(row.purchasePrice)}</td>
                <td>${escapeHtml(row.condition)}</td>
                <td>${escapeHtml(row.language)}</td>
            </tr>
        `).join('');
    };

    const openManaPoolModal = () => {
        if (!manapoolModal) return;
        if (!inventory.length) {
            alert('Your inventory is empty. Nothing to export.');
            return;
        }
        manapoolExportRows = buildManaPoolRows();
        renderManaPoolPreview();
        manapoolModal.classList.add('show');
    };

    const closeManaPoolModal = () => {
        if (!manapoolModal) return;
        manapoolModal.classList.remove('show');
    };

    const downloadManaPoolCsv = () => {
        if (!manapoolExportRows.length) {
            alert('No rows available to export.');
            return;
        }
        const headers = ['Foil', 'Quantity', 'Scryfall ID', 'Purchase price', 'Condition', 'Language'];
        const rows = manapoolExportRows.map(row => [
            row.foil,
            row.quantity,
            row.scryfallId,
            row.purchasePrice,
            row.condition,
            row.language
        ]);
        const csvLines = [
            headers.map(csvEscape).join(','),
            ...rows.map(cols => cols.map(csvEscape).join(','))
        ];
        const csvContent = csvLines.join('\r\n');
        const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const tempLink = document.createElement('a');
        tempLink.href = url;
        tempLink.download = `manapool-export-${new Date().toISOString().slice(0, 10)}.csv`;
        document.body.appendChild(tempLink);
        tempLink.click();
        tempLink.remove();
        URL.revokeObjectURL(url);
    };
    const applyInventoryFilter = () => {
        if (!inventoryContainer) return;
        const hasInventory = inventory.length > 0;
        let visibleCount = 0;

        inventory.forEach(item => {
            const element = document.getElementById(`item-${item.id}`);
            if (!element) return;
            const show = matchesFilter(item);
            element.style.display = show ? '' : 'none';
            if (show) visibleCount += 1;
        });

        if (filterMessage) {
            if (!hasInventory) {
                filterMessage.hidden = true;
            } else {
                filterMessage.hidden = visibleCount !== 0;
            }
        }
    };

    const RATE_LIMIT_MS = 50;
    const detailRequestQueue = [];
    let isDetailRequestProcessing = false;

    const formatPrice = (value) => {
      if (typeof value === 'number' && !isNaN(value)) {
        return `$${value.toFixed(2)}`;
      }
      return "N/A";
    };

    const processDetailQueue = async () => {
        if (detailRequestQueue.length === 0) {
            isDetailRequestProcessing = false;
            return;
        }
        isDetailRequestProcessing = true;
        const task = detailRequestQueue.shift();
        try {
            await task();
        } catch (error) {
            console.error('Detail request failed:', error);
        }
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
            if (filterMessage) filterMessage.hidden = true;
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

        applyInventoryFilter();
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
                 inventory = inventory.filter(entry => entry.id !== itemId);
                 applyInventoryFilter();
                 return;
            }
            applyInventoryFilter();
        } catch (error) {
            console.error(error);
            // Revert UI on failure
            item.quantity = originalQuantity;
            document.getElementById(`quantity-${item.id}`).textContent = `x${originalQuantity}`;
            alert('Failed to update quantity on the server.');
            applyInventoryFilter();
        }
    };


    const fetchSingleCardDetails = async (item) => {
        try {
            const response = await fetch(`/api/card/details/${item.setCode}/${item.collectorNumber}`);
            const cardData = response.ok ? await response.json() : null;
            const cardIdentifiersData = cardData?.identifiers || null;
            const tcgProductId = cardIdentifiersData?.tcgplayerProductId || cardIdentifiersData?.tcgplayerId || null;

            if (tcgProductId) {
                item.tcgplayerId = tcgProductId;
                item.imageUrl = `https://tcgplayer-cdn.tcgplayer.com/product/${tcgProductId}_in_1000x1000.jpg`;
            } else {
                item.imageUrl = item.imageUrl || LARGE_CARD_IMAGE_PLACEHOLDER;
            }

            const itemElement = document.getElementById(`item-${item.id}`);
            const cardInfo = cardData?.card || {};
            const setInfo = cardData?.set || {};
            const priceData = cardData?.prices || null;

            item.tcgMarketPrice = getLatestPrice(priceData?.paper?.tcgplayer?.retail?.[item.foilType]);
            const tcgLow = item.tcgLow;
            const tcgLowPlusShipping = item.tcgLowPlusShipping;
            const ckBuylist = getBuylists(priceData, 'cardkingdom', item.foilType);
            const timeAgo = formatTimeAgo(item.pricesLastUpdatedAt);

            item._searchIndex = [
                item.name,
                setInfo?.name,
                item.setCode,
                item.collectorNumber,
                item.condition,
                item.foilType,
                item.tcgplayerId
            ].filter(Boolean).join(' ').toLowerCase();

            if (itemElement) {
                const safeName = escapeHtml(item.name || 'Unknown card');
                const safeSetCode = escapeHtml(item.setCode || '');
                const safeCondition = escapeHtml(item.condition || 'NM');
                const foilClass = (item.foilType || 'normal').toLowerCase();
                const safeFoil = escapeHtml(item.foilType || 'normal');
                const foilLabel = safeFoil === 'normal' ? '' : safeFoil;
                const safeImage = escapeHtml(item.imageUrl || LARGE_CARD_IMAGE_PLACEHOLDER);
                const pricePaidText = Number.isFinite(item.pricePaid) ? `$${item.pricePaid.toFixed(2)}` : 'N/A';
                const updatedLine = timeAgo
                    ? `<div class="price-line"><span>Prices Updated:</span><span>${escapeHtml(timeAgo)}</span></div>`
                    : '';
                const tcgLink = item.tcgplayerId
                    ? `<a class="link" target="_blank" rel="noopener noreferrer" href="https://tcgplayer.com/product/${encodeURIComponent(item.tcgplayerId)}">${safeName}</a>`
                    : `<span class="link disabled-link">${safeName}</span>`;
                const quantityLabel = escapeHtml(String(item.quantity));
                const ckProfitable = Number.isFinite(ckBuylist) && Number.isFinite(tcgLowPlusShipping) && ckBuylist > tcgLowPlusShipping;

                itemElement.classList.remove('skeleton');
                itemElement.innerHTML = `
                    <img src="${safeImage}" alt="${safeName}" class="inventory-image">
                    <div class="inventory-item-main">
                        <div class="info-block">
                            <h3>
                                ${tcgLink}
                                <div class="quantity-display">
                                    <button class="quantity-btn" data-id="${item.id}" data-action="decrease" aria-label="Decrease quantity for ${safeName}">&minus;</button>
                                    <span id="quantity-${item.id}">x${quantityLabel}</span>
                                    <button class="quantity-btn" data-id="${item.id}" data-action="increase" aria-label="Increase quantity for ${safeName}">+</button>
                                </div>
                                <span class="set-code">(${safeSetCode})</span>
                                <span class="condition-badge condition-${safeCondition.toLowerCase()}">${safeCondition}</span>
                                <span class="foil-badge foil-${foilClass}">${foilLabel}</span>
                            </h3>
                            <div class="price-line"><span>Price Paid:</span><button type="button" class="price-paid-btn" data-id="${item.id}">${pricePaidText}</button></div>
                            ${updatedLine}
                        </div>

                        <div class="info-block actions">
                            <button class="edit-btn" type="button" data-id="${item.id}">Edit Item</button>
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
                                      <td class="${ckProfitable ? 'profitable' : ''}" data-price-type="ckBuylist">${formatPrice(ckBuylist)}</td>
                                      <td data-price-type="scgBuylist">${formatPrice(0)}</td>
                                      <td data-price-type="csiBuylist">${formatPrice(0)}</td>
                                    </tr>
                                </tbody>
                            </table>
                        </div>                
                       `;
                applyInventoryFilter();
            }
        } catch (error) {
            console.error(`Failed to load details for ${item.name}:`, error);
            const itemElement = document.getElementById(`item-${item.id}`);
            if (itemElement) itemElement.innerHTML = '<p class="error">Could not load card data.</p>';
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

    // --- Add Inventory Modal Logic ---
    const stagedInventoryItems = [];
    let addInventorySearchWidget = null;
    let modalPrintings = [];
    let selectedPrinting = null;

    const mapFinishToFoilType = (finish = 'nonfoil') => finish === 'nonfoil' ? 'normal' : finish;
    const describeFoilType = (foilType = 'normal') => {
        switch (foilType) {
            case 'foil': return 'Foil';
            case 'etched': return 'Etched';
            default: return 'Non-Foil';
        }
    };

    const resetAddInventoryModal = () => {
        if (!modalSearchInput) return;
        modalSearchInput.value = '';
        if (modalCardDetails) modalCardDetails.classList.add('hidden');
        if (modalCardName) modalCardName.textContent = '';
        if (modalCardSet) modalCardSet.textContent = '';
        if (modalCardImage) modalCardImage.src = '';
        if (modalPrintingSelect) modalPrintingSelect.innerHTML = '<option value="">Select a printing</option>';
        if (modalFinishSelect) modalFinishSelect.innerHTML = '';
        if (modalConditionSelect) modalConditionSelect.value = 'NM';
        if (modalQuantityInput) modalQuantityInput.value = '1';
        if (modalPriceInput) {
            modalPriceInput.value = '';
            modalPriceInput.disabled = false;
            modalPriceInput.placeholder = '0.00';
        }
        if (modalPriceUnknown) modalPriceUnknown.checked = false;
        if (modalSaveStatus) modalSaveStatus.textContent = '';
        stagedInventoryItems.length = 0;
        modalPrintings = [];
        selectedPrinting = null;
        if (modalSaveItemsBtn) modalSaveItemsBtn.disabled = true;
        if (modalAddItemBtn) modalAddItemBtn.disabled = false;
        if (modalClearStagedBtn) modalClearStagedBtn.disabled = false;
        renderStagedInventoryItems();
    };

    const handlePriceUnknownToggle = () => {
        if (!modalPriceInput) return;
        if (modalPriceUnknown.checked) {
            modalPriceInput.value = '';
            modalPriceInput.disabled = true;
            modalPriceInput.placeholder = 'Will be saved as $0.00';
        } else {
            modalPriceInput.disabled = false;
            modalPriceInput.placeholder = '0.00';
            modalPriceInput.focus();
        }
    };

    const initAddInventorySearchWidget = () => {
        if (!modalSearchInput) return;
        addInventorySearchWidget = new CardSearchWidget({
            input: modalSearchInput,
            limit: 12,
            onSelect: (card) => {
                modalSearchInput.value = card.name;
                loadPrintingsForCard(card.name);
            },
        });
    };

    const destroyAddInventorySearchWidget = () => {
        if (addInventorySearchWidget) {
            addInventorySearchWidget.destroy();
            addInventorySearchWidget = null;
        }
    };

    const openAddInventoryModal = () => {
        if (!addInventoryModal || !modalSearchInput) return;
        resetAddInventoryModal();
        initAddInventorySearchWidget();
        addInventoryModal.classList.remove('hidden');
        addInventoryModal.setAttribute('aria-hidden', 'false');
        modalSearchInput?.focus();
    };

    const closeAddInventoryModal = () => {
        if (!addInventoryModal) return;
        destroyAddInventorySearchWidget();
        resetAddInventoryModal();
        addInventoryModal.classList.add('hidden');
        addInventoryModal.setAttribute('aria-hidden', 'true');
    };

    const loadPrintingsForCard = async (cardName) => {
        if (!cardName || !modalCardDetails || !modalCardName || !modalCardSet) return;
        modalCardDetails.classList.add('hidden');
        if (modalCardSet) modalCardSet.textContent = 'Loading printings...';
        try {
            const response = await fetch(`/api/printings/${encodeURIComponent(cardName)}`);
            if (!response.ok) throw new Error('Unable to load printings.');
            const printings = await response.json();
            modalPrintings = Array.isArray(printings) ? printings : [];
            if (modalPrintings.length === 0) {
                throw new Error('No printings found for that card.');
            }
            populatePrintingSelect(modalPrintings);
            if (modalCardName) modalCardName.textContent = cardName;
            const firstPrinting = modalPrintings[0];
            if (modalCardSet) modalCardSet.textContent = `${firstPrinting.set_name} (${firstPrinting.set.toUpperCase()})`;
            const artUrl = firstPrinting.image_uris?.normal || firstPrinting.image_uris?.large || firstPrinting.image_uris?.small || LARGE_CARD_IMAGE_PLACEHOLDER;
            if (modalCardImage) modalCardImage.src = artUrl;
            modalCardDetails.classList.remove('hidden');
        } catch (error) {
            if (modalCardName) modalCardName.textContent = cardName;
            if (modalCardSet) modalCardSet.textContent = error.message;
            modalCardDetails.classList.remove('hidden');
            modalPrintingSelect.innerHTML = '<option value="">No printings available</option>';
            modalFinishSelect.innerHTML = '';
            selectedPrinting = null;
        }
    };

    const populatePrintingSelect = (printings) => {
        if (!modalPrintingSelect) return;
        modalPrintingSelect.innerHTML = '';
        printings.forEach((printing, index) => {
            const option = document.createElement('option');
            option.value = printing.id;
            option.textContent = `[${printing.set.toUpperCase()}] #${printing.collector_number} • ${printing.set_name}`;
            if (index === 0) option.selected = true;
            modalPrintingSelect.appendChild(option);
        });
        handlePrintingSelectionChange();
    };

    const handlePrintingSelectionChange = () => {
        const selectedId = modalPrintingSelect.value;
        selectedPrinting = modalPrintings.find(printing => printing.id === selectedId) || null;
        if (!selectedPrinting) {
            modalFinishSelect.innerHTML = '';
            return;
        }
        const artUrl = selectedPrinting.image_uris?.normal || selectedPrinting.image_uris?.large || selectedPrinting.image_uris?.small || LARGE_CARD_IMAGE_PLACEHOLDER;
        if (modalCardImage) modalCardImage.src = artUrl;
        if (modalCardSet) modalCardSet.textContent = `${selectedPrinting.set_name} (${selectedPrinting.set.toUpperCase()})`;
        renderFinishOptions(selectedPrinting);
    };

    const renderFinishOptions = (printing) => {
        if (!modalFinishSelect) return;
        modalFinishSelect.innerHTML = '';
        const finishes = Array.isArray(printing.finishes) ? printing.finishes : ['nonfoil'];
        finishes.forEach((finish, index) => {
            const option = document.createElement('option');
            option.value = finish;
            option.textContent = describeFoilType(mapFinishToFoilType(finish));
            if (index === 0) option.selected = true;
            modalFinishSelect.appendChild(option);
        });
    };

    const stageInventoryItem = () => {
        if (!selectedPrinting || !modalFinishSelect || !modalConditionSelect || !modalQuantityInput || !modalPriceInput) {
            alert('Select a printing before adding.');
            return;
        }
        const quantity = parseInt(modalQuantityInput.value, 10);
        if (!Number.isInteger(quantity) || quantity < 1) {
            alert('Quantity must be 1 or greater.');
            return;
        }
        const priceUnknown = modalPriceUnknown.checked;
        let pricePaid = 0;
        if (!priceUnknown) {
            pricePaid = parseFloat(modalPriceInput.value);
            if (!Number.isFinite(pricePaid) || pricePaid < 0) {
                alert('Enter a valid price or mark it as unknown.');
                return;
            }
        }
        const finish = modalFinishSelect.value || 'nonfoil';
        const stagedItem = {
            id: generateId(),
            name: selectedPrinting.name,
            setName: selectedPrinting.set_name,
            setCode: selectedPrinting.set.toUpperCase(),
            collectorNumber: selectedPrinting.collector_number,
            foilType: mapFinishToFoilType(finish),
            condition: modalConditionSelect.value,
            quantity,
            pricePaid,
            priceUnknown,
            tcgplayerId: selectedPrinting.tcgplayer_id || null,
            scryfallId: selectedPrinting.id
        };
        stagedInventoryItems.push(stagedItem);
        renderStagedInventoryItems();
        modalQuantityInput.value = '1';
        if (!priceUnknown) {
            modalPriceInput.value = '';
        }
    };

    const renderStagedInventoryItems = () => {
        if (!modalStagedList || !modalStagedEmpty || !modalSaveItemsBtn) return;
        modalStagedList.innerHTML = '';
        if (stagedInventoryItems.length === 0) {
            modalStagedEmpty.classList.remove('hidden');
            modalSaveItemsBtn.disabled = true;
            return;
        }
        modalStagedEmpty.classList.add('hidden');
        stagedInventoryItems.forEach(item => {
            const li = document.createElement('li');
            li.className = 'staged-item';
            li.innerHTML = `
                <div class="staged-item-info">
                    <strong>${item.quantity}x ${escapeHtml(item.name)}</strong>
                    <span>${item.setCode} • ${item.condition} • ${describeFoilType(item.foilType)}</span>
                    <span>${item.priceUnknown ? 'Price: Unknown' : `Price: $${item.pricePaid.toFixed(2)}`}</span>
                </div>
                <div class="staged-item-actions">
                    <button type="button" data-id="${item.id}">Remove</button>
                </div>
            `;
            li.querySelector('button').addEventListener('click', () => {
                const index = stagedInventoryItems.findIndex(entry => entry.id === item.id);
                if (index >= 0) {
                    stagedInventoryItems.splice(index, 1);
                    renderStagedInventoryItems();
                }
            });
            modalStagedList.appendChild(li);
        });
        modalSaveItemsBtn.disabled = false;
    };

    const clearStagedItems = () => {
        stagedInventoryItems.length = 0;
        renderStagedInventoryItems();
    };

    const saveInventoryItem = async (item) => {
        const payload = {
            name: item.name,
            setCode: item.setCode,
            collectorNumber: item.collectorNumber,
            foilType: item.foilType,
            pricePaid: item.pricePaid,
            quantity: item.quantity,
            tcgplayerId: item.tcgplayerId,
            condition: item.condition,
            scryfallId: item.scryfallId
        };
        const response = await fetch('/api/inventory', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        if (!response.ok) {
            const message = await response.text();
            throw new Error(message || 'Failed to save inventory item.');
        }
    };

    const saveStagedInventoryItems = async () => {
        if (stagedInventoryItems.length === 0) return;
        modalSaveItemsBtn.disabled = true;
        if (modalAddItemBtn) modalAddItemBtn.disabled = true;
        if (modalClearStagedBtn) modalClearStagedBtn.disabled = true;
        modalSaveStatus.textContent = 'Saving items...';
        try {
            for (let index = 0; index < stagedInventoryItems.length; index += 1) {
                modalSaveStatus.textContent = `Saving ${index + 1} of ${stagedInventoryItems.length}...`;
                await saveInventoryItem(stagedInventoryItems[index]);
            }
            modalSaveStatus.textContent = 'All items added!';
            closeAddInventoryModal();
            await initializePage();
        } catch (error) {
            console.error(error);
            modalSaveStatus.textContent = error.message;
            modalSaveItemsBtn.disabled = false;
            if (modalAddItemBtn) modalAddItemBtn.disabled = false;
            if (modalClearStagedBtn) modalClearStagedBtn.disabled = false;
            return;
        }
        stagedInventoryItems.length = 0;
        renderStagedInventoryItems();
        if (modalAddItemBtn) modalAddItemBtn.disabled = false;
        if (modalClearStagedBtn) modalClearStagedBtn.disabled = false;
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
            applyInventoryFilter();
        } catch (error) {
            console.error(error);
            alert("Could not delete item.");
        }
    };

    const initializePage = async () => {
        try {
            const [inventoryResponse, snapshot] = await Promise.all([
                fetch('/api/inventory'),
                fetchInventoryBuylistSnapshot()
            ]);

            if (!inventoryResponse.ok) throw new Error("Could not fetch inventory from server.");
            inventory = (await inventoryResponse.json()).map(item => ({
                ...item,
                _searchIndex: [
                    item.name,
                    item.setCode,
                    item.collectorNumber,
                    item.condition,
                    item.foilType,
                    item.tcgplayerId
                ].filter(Boolean).join(' ').toLowerCase(),
            }));

            inventoryBuylistModal.init({
                contextId: 'inventory',
                getCards: () => inventory.map((item) => ({
                    id: item.id,
                    name: item.name,
                    setCode: item.setCode,
                    collectorNumber: item.collectorNumber,
                    foilType: item.foilType,
                    quantity: item.quantity,
                    tcgplayerId: item.tcgplayerId,
                    imageUrl: item.imageUrl || null
                })),
                nameResolver: () => 'Inventory',
                initialSnapshot: snapshot
            });

            renderInventory();
        } catch (error) {
            console.error(error);
            inventoryContainer.innerHTML = '<p class="error">Could not load inventory.</p>';
        }
    };
    
    // --- Event Listeners ---
    if (exportBtn) {
        exportBtn.addEventListener('click', exportInventoryToTxt);
    }

    if (openBuylistModalBtn) {
        openBuylistModalBtn.addEventListener('click', () => {
            inventoryBuylistModal.open();
        });
    }

    if (openAddInventoryBtn) {
        openAddInventoryBtn.addEventListener('click', openAddInventoryModal);
    }

    if (addInventoryCloseBtn) {
        addInventoryCloseBtn.addEventListener('click', closeAddInventoryModal);
    }

    if (addInventoryBackdrop) {
        addInventoryBackdrop.addEventListener('click', () => closeAddInventoryModal());
    }

    if (modalPriceUnknown) {
        modalPriceUnknown.addEventListener('change', handlePriceUnknownToggle);
    }

    if (modalPrintingSelect) {
        modalPrintingSelect.addEventListener('change', handlePrintingSelectionChange);
    }

    if (modalAddItemBtn) {
        modalAddItemBtn.addEventListener('click', stageInventoryItem);
    }

    if (modalClearStagedBtn) {
        modalClearStagedBtn.addEventListener('click', clearStagedItems);
    }

    if (modalSaveItemsBtn) {
        modalSaveItemsBtn.addEventListener('click', saveStagedInventoryItems);
    }

    if (filterInput) {
        filterInput.addEventListener('input', (event) => {
            inventoryFilterTerm = normalizeFilterTerm(event.target.value);
            applyInventoryFilter();
        });
    }

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

    if (manapoolExportBtn) {
        manapoolExportBtn.addEventListener('click', openManaPoolModal);
    }

    if (manapoolModalClose) {
        manapoolModalClose.addEventListener('click', closeManaPoolModal);
    }

    if (manapoolModal) {
        manapoolModal.addEventListener('click', (event) => {
            if (event.target === manapoolModal) {
                closeManaPoolModal();
            }
        });
    }

    if (manapoolDownloadBtn) {
        manapoolDownloadBtn.addEventListener('click', downloadManaPoolCsv);
    }

    if (editInventoryBackdrop) {
        editInventoryBackdrop.addEventListener('click', closeEditInventoryModal);
    }

    if (editModalCloseBtn) {
        editModalCloseBtn.addEventListener('click', closeEditInventoryModal);
    }

    if (editCancelBtn) {
        editCancelBtn.addEventListener('click', (event) => {
            event.preventDefault();
            closeEditInventoryModal();
        });
    }

    if (editInventoryForm) {
        editInventoryForm.addEventListener('submit', handleEditFormSubmit);
    }

    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') {
            if (exportModal?.classList.contains('show')) {
                closeExportModal();
            }
            if (manapoolModal?.classList.contains('show')) {
                closeManaPoolModal();
            }
            if (!editInventoryModal?.classList.contains('hidden')) {
                closeEditInventoryModal();
            }
            if (!addInventoryModal?.classList.contains('hidden')) {
                closeAddInventoryModal();
            }
        }
    });

    inventoryContainer.addEventListener('click', (event) => {
        const target = event.target;
        if (!(target instanceof HTMLElement)) return;
        const button = target.closest('button');
        if (!button) return;
        const itemId = button.dataset.id;
        if (!itemId) return;
        if (button.matches('.scrape-btn')) {
            scrapeLiveLows(itemId, button);
        } else if (button.matches('.delete-btn')) {
            deleteInventoryItem(itemId);
        } else if (button.matches('.quantity-btn')) {
            const action = button.dataset.action;
            if (action) {
                updateQuantity(itemId, action);
            }
        } else if (button.matches('.edit-btn') || button.matches('.price-paid-btn')) {
            openEditInventoryModal(itemId);
        }
    });


    initializePage();
});



