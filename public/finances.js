const revenueValueEl = document.getElementById('kpi-revenue-value');
const revenueMetaEl = document.getElementById('kpi-revenue-meta');
const expenseValueEl = document.getElementById('kpi-expense-value');
const expenseMetaEl = document.getElementById('kpi-expense-meta');
const netValueEl = document.getElementById('kpi-net-value');
const netMetaEl = document.getElementById('kpi-net-meta');
const netInfoDot = document.getElementById('net-info-dot');
const feesValueEl = document.getElementById('kpi-fees-value');
const feesMetaEl = document.getElementById('kpi-fees-meta');
const cogsValueEl = document.getElementById('kpi-cogs-value');
const cogsMetaEl = document.getElementById('kpi-cogs-meta');
const inventoryValueEl = document.getElementById('kpi-inventory-value');
const inventoryMetaEl = document.getElementById('kpi-inventory-meta');
const snapshotListEl = document.getElementById('snapshot-list');
const categoryListEl = document.getElementById('category-list');
const recentExpenseListEl = document.getElementById('recent-expense-list');
const expenseTableBody = document.getElementById('expense-table-body');
const expenseFilterInput = document.getElementById('expense-filter');
const recordExpenseBtn = document.getElementById('record-expense-btn');
const refreshSummaryBtn = document.getElementById('refresh-summary-btn');
const refreshSnapshotsBtn = document.getElementById('refresh-snapshots-btn');
const refreshExpensesBtn = document.getElementById('refresh-expenses-btn');
const captureSnapshotBtn = document.getElementById('capture-snapshot-btn');
const expenseModal = document.getElementById('expense-modal');
const expenseForm = document.getElementById('expense-form');
const expenseIdInput = document.getElementById('expense-id');
const expenseDescriptionInput = document.getElementById('expense-description');
const expenseAmountInput = document.getElementById('expense-amount');
const expenseCategoryInput = document.getElementById('expense-category');
const expenseMethodInput = document.getElementById('expense-method');
const expenseDateInput = document.getElementById('expense-date');
const expenseNotesInput = document.getElementById('expense-notes');
const expenseModalTitle = document.getElementById('expense-modal-title');
const expenseModalCloseButtons = Array.from(document.querySelectorAll('[data-close-expense]'));
const toastEl = document.getElementById('toast');
const cardPurchaseBtn = document.getElementById('card-purchase-btn');
const cardPurchaseMenu = document.getElementById('card-purchase-menu');
const cardPurchaseTrigger = document.getElementById('card-purchase-trigger');
const cardLedgerBody = document.getElementById('card-ledger-body');
const refreshCardLedgerBtn = document.getElementById('refresh-card-ledger-btn');
const shippingLedgerBody = document.getElementById('shipping-ledger-body');
const refreshShippingLedgerBtn = document.getElementById('refresh-shipping-ledger-btn');

const currencyFormatter = new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 2,
});

const state = {
    expenses: [],
    snapshots: [],
    summary: null,
    expenseFilter: '',
};

const formatCurrency = (value = 0) => currencyFormatter.format(Number(value) || 0);

const escapeHtml = (value = '') => String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const formatDate = (value) => {
    if (!value) return '-';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '-';
    return date.toLocaleDateString();
};

const toDateInputValue = (value) => {
    if (!value) return '';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    return date.toISOString().slice(0, 10);
};

const showToast = (message, type = 'info') => {
    if (!toastEl) return;
    toastEl.textContent = message;
    toastEl.dataset.type = type;
    toastEl.classList.add('show');
    clearTimeout(showToast.timeout);
    showToast.timeout = setTimeout(() => {
        toastEl.classList.remove('show');
    }, 3500);
};

const fetchJson = async (url, options = {}) => {
    const response = await fetch(url, options);
    if (!response.ok) {
        let detail = response.statusText;
        try {
            const data = await response.json();
            detail = data?.error || data?.message || detail;
        } catch (error) {
            // ignore
        }
        throw new Error(detail || 'Request failed');
    }
    if (response.status === 204) return null;
    return response.json();
};
const buildNetTooltip = (summary) => {
    if (!summary) return '';
    const rows = [
        `Revenue: ${formatCurrency(summary.revenue || 0)}`,
        `Estimated fees: ${formatCurrency(summary.estimatedFees || 0)}`,
        `Cost of goods: ${formatCurrency(summary.costOfGoodsSold || 0)}`,
        `Manual expenses: ${formatCurrency(summary.expenses || 0)}`,
    ];
    return rows.join('\n');
};

const updateKpis = (summary) => {
    revenueValueEl.textContent = formatCurrency(summary?.revenue || 0);
    revenueMetaEl.textContent = `${summary?.salesCount || 0} sales recorded`;
    feesValueEl.textContent = formatCurrency(summary?.estimatedFees || 0);
    cogsValueEl.textContent = formatCurrency(summary?.costOfGoodsSold || 0);
    expenseValueEl.textContent = formatCurrency(summary?.expenses || 0);
    expenseMetaEl.textContent = `${summary?.expenseCount || 0} entries logged`;
    netValueEl.textContent = formatCurrency(summary?.netProfit || 0);
    netMetaEl.textContent = 'After fees & expenses';
    netInfoDot.title = buildNetTooltip(summary);
    inventoryValueEl.textContent = formatCurrency(summary?.inventoryValue || 0);
    inventoryMetaEl.textContent = `${summary?.inventoryUnits || 0} cards tracked`;
};

const renderSnapshots = (snapshots = []) => {
    state.snapshots = snapshots;
    if (!snapshotListEl) return;
    if (!snapshots.length) {
        snapshotListEl.innerHTML = '<p class="empty">No inventory snapshots yet.</p>';
        return;
    }
    snapshotListEl.innerHTML = snapshots.map((snapshot) => `
        <article class="snapshot-card">
            <div class="snapshot-item">
                <h3>${formatCurrency(snapshot.totalValue)}</h3>
                <div class="meta">${formatDate(snapshot.capturedAt)} &middot; ${snapshot.inventoryCount || 0} items</div>
            </div>
        </article>
    `).join('');
};

const renderCategories = (categories = []) => {
    if (!categoryListEl) return;
    if (!categories.length) {
        categoryListEl.innerHTML = '<li class="empty">No expenses logged.</li>';
        return;
    }
    categoryListEl.innerHTML = categories.map((category) => `
        <li>
            <div>
                <strong>${escapeHtml(category.category || 'Uncategorized')}</strong>
                <span class="muted">${category.count || 0} entries</span>
            </div>
            <span>${formatCurrency(category.total || 0)}</span>
        </li>
    `).join('');
};

const renderRecentExpenses = (expenses = []) => {
    if (!recentExpenseListEl) return;
    if (!expenses.length) {
        recentExpenseListEl.innerHTML = '<li class="empty">No recent expenses.</li>';
        return;
    }
    recentExpenseListEl.innerHTML = expenses.map((expense) => `
        <li>
            <div>
                <strong>${escapeHtml(expense.description)}</strong>
                <div class="muted">${formatDate(expense.incurredOn)} &middot; ${escapeHtml(expense.category || 'Uncategorized')}</div>
            </div>
            <span>${formatCurrency(expense.amount)}</span>
        </li>
    `).join('');
};

const isCardPurchase = (expense) => (expense.category || '').toLowerCase() === 'card purchase';
const isShippingExpense = (expense) => (expense.category || '').toLowerCase().startsWith('shipping');

const renderCardLedger = () => {
    if (!cardLedgerBody) return;
    const cardExpenses = state.expenses.filter(isCardPurchase);
    if (!cardExpenses.length) {
        cardLedgerBody.innerHTML = '<tr><td colspan="5" class="empty">No card purchases logged.</td></tr>';
        return;
    }
    cardLedgerBody.innerHTML = cardExpenses.map((expense) => `
        <tr>
            <td>${formatDate(expense.incurredOn)}</td>
            <td>
                <strong>${escapeHtml(expense.description)}</strong>
                ${expense.notes ? `<div class="meta">${escapeHtml(expense.notes)}</div>` : ''}
            </td>
            <td>${escapeHtml(expense.paymentMethod || '-')}</td>
            <td>${formatCurrency(expense.amount)}</td>
            <td class="ledger-actions">
                <button type="button" class="ghost-btn danger" data-card-expense-id="${expense.id}">Delete</button>
            </td>
        </tr>
    `).join('');
};

const renderShippingLedger = () => {
    if (!shippingLedgerBody) return;
    const shippingExpenses = state.expenses.filter(isShippingExpense);
    if (!shippingExpenses.length) {
        shippingLedgerBody.innerHTML = '<tr><td colspan="5" class="empty">No shipping expenses logged.</td></tr>';
        return;
    }
    shippingLedgerBody.innerHTML = shippingExpenses.map((expense) => `
        <tr data-expense-id="${expense.id}">
            <td>
                <strong>${escapeHtml(expense.description)}</strong>
                ${expense.notes ? `<div class="meta">${escapeHtml(expense.notes)}</div>` : ''}
            </td>
            <td>${escapeHtml(expense.category || '-')}</td>
            <td>${formatCurrency(expense.amount)}</td>
            <td>${formatDate(expense.incurredOn)}</td>
            <td class="ledger-actions">
                <button type="button" class="ghost-btn" data-action="edit" data-expense-id="${expense.id}">Edit</button>
                <button type="button" class="ghost-btn danger" data-action="delete" data-expense-id="${expense.id}">Delete</button>
            </td>
        </tr>
    `).join('');
};

const renderExpenseTable = () => {
    if (!expenseTableBody) return;
    const regularExpenses = state.expenses.filter((expense) => !isCardPurchase(expense) && !isShippingExpense(expense));
    const filtered = regularExpenses.filter((expense) => {
        if (!state.expenseFilter) return true;
        const haystack = `${expense.description} ${expense.category}`.toLowerCase();
        return haystack.includes(state.expenseFilter.toLowerCase());
    });
    if (!filtered.length) {
        expenseTableBody.innerHTML = '<tr><td colspan="5" class="empty">No expenses match your search.</td></tr>';
        return;
    }
    expenseTableBody.innerHTML = filtered.map((expense) => `
        <tr data-expense-id="${expense.id}">
            <td>
                <strong>${escapeHtml(expense.description)}</strong>
                ${expense.notes ? `<div class="meta">${escapeHtml(expense.notes)}</div>` : ''}
            </td>
            <td>${escapeHtml(expense.category || 'Uncategorized')}</td>
            <td>${formatCurrency(expense.amount)}</td>
            <td>${formatDate(expense.incurredOn)}</td>
            <td class="ledger-actions">
                <button type="button" class="ghost-btn" data-action="edit" data-expense-id="${expense.id}">Edit</button>
                <button type="button" class="ghost-btn danger" data-action="delete" data-expense-id="${expense.id}">Delete</button>
            </td>
        </tr>
    `).join('');
};

const openExpenseModal = (expense = null) => {
    if (!expenseModal) return;
    expenseIdInput.value = expense?.id || '';
    expenseDescriptionInput.value = expense?.description || '';
    expenseAmountInput.value = expense?.amount != null ? Number(expense.amount).toFixed(2) : '';
    expenseCategoryInput.value = expense?.category || '';
    expenseMethodInput.value = expense?.paymentMethod || '';
    expenseDateInput.value = toDateInputValue(expense?.incurredOn || new Date().toISOString());
    expenseNotesInput.value = expense?.notes || '';
    expenseModalTitle.textContent = expense ? 'Edit Expense' : 'Log Expense';
    expenseModal.removeAttribute('hidden');
};

const closeExpenseModal = () => {
    if (!expenseModal) return;
    expenseModal.setAttribute('hidden', 'hidden');
    expenseForm.reset();
    expenseIdInput.value = '';
};

const handleExpenseSubmit = async (event) => {
    event.preventDefault();
    const payload = {
        description: expenseDescriptionInput.value,
        amount: expenseAmountInput.value,
        category: expenseCategoryInput.value,
        paymentMethod: expenseMethodInput.value,
        incurredOn: expenseDateInput.value,
        notes: expenseNotesInput.value,
    };
    const id = expenseIdInput.value;
    const options = {
        method: id ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
    };
    const endpoint = id ? `/api/finances/expenses/${id}` : '/api/finances/expenses';
    try {
        await fetchJson(endpoint, options);
        showToast(id ? 'Expense updated.' : 'Expense logged.', 'success');
        closeExpenseModal();
        await Promise.all([loadSummary(), loadExpenses()]);
    } catch (error) {
        showToast(error.message || 'Failed to save expense', 'error');
    }
};

const handleExpenseTableClick = (event) => {
    const button = event.target.closest('button[data-expense-id]');
    if (!button) return;
    const { expenseId, action } = button.dataset;
    if (!expenseId) return;
    const expense = state.expenses.find((entry) => entry.id === expenseId);
    if (!expense) return;
    if (action === 'edit') {
        openExpenseModal(expense);
        return;
    }
    if (action === 'delete') {
        if (!window.confirm('Delete this expense entry?')) return;
        fetchJson(`/api/finances/expenses/${expenseId}`, { method: 'DELETE' })
            .then(async () => {
                showToast('Expense deleted.', 'success');
                await Promise.all([loadSummary(), loadExpenses()]);
            })
            .catch((error) => showToast(error.message || 'Failed to delete expense', 'error'));
    }
};

const describeInventoryDeleteResult = (result = {}) => {
    if (result.inventoryDeleted) {
        return ' Linked inventory removed.';
    }
    if (result.inventoryReason === 'inventory_in_use') {
        return ' Linked inventory kept because it has recorded sales.';
    }
    if (result.inventoryReason === 'inventory_not_found') {
        return ' Linked inventory entry was already removed.';
    }
    return '';
};

const handleCardLedgerClick = (event) => {
    const button = event.target.closest('button[data-card-expense-id]');
    if (!button) return;
    const expenseId = button.dataset.cardExpenseId;
    if (!expenseId) return;
    const expense = state.expenses.find((entry) => entry.id === expenseId);
    if (!expense) return;
    const confirmationText = expense.linkedInventoryId
        ? 'Delete this card purchase and remove the linked inventory item?'
        : 'Delete this card purchase entry?';
    if (!window.confirm(confirmationText)) return;
    fetchJson(`/api/finances/expenses/${expenseId}`, { method: 'DELETE' })
        .then(async (result) => {
            const suffix = describeInventoryDeleteResult(result);
            showToast(`${result?.message || 'Card purchase deleted.'}${suffix}`, 'success');
            await Promise.all([loadSummary(), loadExpenses()]);
        })
        .catch((error) => showToast(error.message || 'Failed to delete card purchase', 'error'));
};

const loadSummary = async () => {
    try {
        const summary = await fetchJson('/api/finances/summary');
        state.summary = summary;
        updateKpis(summary);
        renderSnapshots(summary.snapshots || []);
        renderCategories(summary.expenseCategories || []);
        renderRecentExpenses(summary.recentExpenses || []);
    } catch (error) {
        showToast(error.message || 'Failed to load summary', 'error');
    }
};

const loadSnapshots = async () => {
    try {
        const { snapshots } = await fetchJson('/api/finances/snapshots');
        renderSnapshots(snapshots || []);
    } catch (error) {
        showToast(error.message || 'Failed to load snapshots', 'error');
    }
};

const loadExpenses = async () => {
    try {
        const { expenses } = await fetchJson('/api/finances/expenses?limit=300');
        state.expenses = expenses || [];
        renderCardLedger();
        renderShippingLedger();
        renderExpenseTable();
    } catch (error) {
        showToast(error.message || 'Failed to load expenses', 'error');
    }
};

const captureSnapshot = async () => {
    try {
        const snapshot = await fetchJson('/api/finances/snapshots', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({}),
        });
        showToast('Inventory snapshot captured.', 'success');
        renderSnapshots([snapshot, ...state.snapshots]);
        await loadSummary();
    } catch (error) {
        showToast(error.message || 'Failed to capture snapshot', 'error');
    }
};

const attachModalListeners = () => {
    document.querySelectorAll('[data-close-expense]').forEach((btn) => btn.addEventListener('click', closeExpenseModal));
    expenseModal?.addEventListener('click', (event) => {
        if (event.target === expenseModal) {
            closeExpenseModal();
        }
    });
};
const FINISH_LABELS = {
    normal: 'Nonfoil',
    foil: 'Foil',
    etched: 'Etched',
};

const CONDITION_OPTIONS = ['NM', 'LP', 'MP', 'HP', 'DMG'];
const CONDITION_LABELS = {
    NM: 'Near Mint',
    LP: 'Lightly Played',
    MP: 'Moderately Played',
    HP: 'Heavily Played',
    DMG: 'Damaged',
};

const normalizeFinishList = (finishes = []) => {
    const mapped = finishes.map((finish) => {
        const lower = String(finish || '').toLowerCase();
        if (lower === 'nonfoil' || lower === 'normal') return 'normal';
        if (lower === 'etched') return 'etched';
        if (lower === 'foil') return 'foil';
        return lower || 'normal';
    });
    const unique = Array.from(new Set(mapped));
    return unique.length ? unique : ['normal'];
};

const buildFinishOptions = (finishes = [], selected) => {
    const normalized = selected && finishes.includes(selected) ? selected : finishes[0];
    return finishes
        .map((finish) => `
            <option value="${finish}" ${finish === normalized ? 'selected' : ''}>${FINISH_LABELS[finish] || finish}</option>
        `)
        .join('');
};

const buildConditionOptions = (selected = 'NM') => {
    const normalized = CONDITION_OPTIONS.includes(selected) ? selected : 'NM';
    return CONDITION_OPTIONS
        .map((code) => `
            <option value="${code}" ${code === normalized ? 'selected' : ''}>${CONDITION_LABELS[code] || code}</option>
        `)
        .join('');
};

const preparePrintingResults = (rawPrintings = []) => {
    const map = new Map();
    rawPrintings.forEach((printing) => {
        const printingId = printing?.id || printing?.uuid;
        if (!printingId) return;
        if (!map.has(printingId)) {
            map.set(printingId, {
                id: printingId,
                name: printing.name,
                setCode: (printing.set || '').toUpperCase(),
                setName: printing.set_name || '',
                collectorNumber: printing.collector_number || '',
                finishes: new Set(),
                tcgplayerId: printing.tcgplayer_id || null,
                image:
                    printing.image_uris?.normal
                    || printing.image_uris?.large
                    || printing.image_uris?.small
                    || null,
            });
        }
        const entry = map.get(printingId);
        (printing.finishes || []).forEach((finish) => entry.finishes.add(finish));
        if (!entry.image && Array.isArray(printing.card_faces)) {
            for (const face of printing.card_faces) {
                if (face.image_uris) {
                    entry.image = face.image_uris.normal || face.image_uris.large || face.image_uris.small;
                    break;
                }
            }
        }
    });
    return Array.from(map.values())
        .map((entry) => ({
            id: entry.id,
            scryfallId: entry.id,
            name: entry.name,
            setCode: entry.setCode,
            setName: entry.setName,
            collectorNumber: entry.collectorNumber,
            tcgplayerId: entry.tcgplayerId,
            finishes: normalizeFinishList(Array.from(entry.finishes)),
            image: entry.image || 'https://placehold.co/90x126/1a1a1a/e0e0e0?text=MTG',
        }))
        .filter((entry) => entry.id && entry.finishes.length);
};

const fetchPrintingsForCard = async (cardName) => {
    if (!cardName) return [];
    const response = await fetch(`/api/printings/${encodeURIComponent(cardName)}`);
    if (!response.ok) {
        throw new Error('Failed to load card printings.');
    }
    const printings = await response.json();
    return preparePrintingResults(printings || []);
};

const generatePurchaseId = () => {
    if (window.crypto?.randomUUID) return window.crypto.randomUUID();
    return `purchase-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
};

const scrollQueueIntoView = (tableBody) => {
    if (!tableBody) return;
    const wrapper = tableBody.closest('.card-purchase-table');
    const dialog = tableBody.closest('.fin-modal-dialog');
    if (!wrapper || !dialog) return;
    const wrapperRect = wrapper.getBoundingClientRect();
    const dialogRect = dialog.getBoundingClientRect();
    const isFullyVisible = wrapperRect.top >= dialogRect.top && wrapperRect.bottom <= dialogRect.bottom;
    if (isFullyVisible) return;
    const delta = wrapperRect.top < dialogRect.top
        ? wrapperRect.top - dialogRect.top - 16
        : wrapperRect.bottom - dialogRect.bottom + 16;
    const targetScroll = dialog.scrollTop + delta;
    if (typeof dialog.scrollTo === 'function') {
        dialog.scrollTo({ top: targetScroll, behavior: 'smooth' });
    } else {
        dialog.scrollTop = targetScroll;
    }
};

const finishToFoilType = (finish) => {
    const normalized = normalizeFinishList([finish || 'normal'])[0] || 'normal';
    if (normalized === 'foil') return 'foil';
    if (normalized === 'etched') return 'etched';
    return 'normal';
};

const buildCardPurchaseNotes = (item) => {
    const parts = [
        `Finish: ${FINISH_LABELS[item.finish] || item.finish || 'normal'}`,
        `Condition: ${CONDITION_LABELS[String(item.condition || 'NM').toUpperCase()] || item.condition || 'NM'}`,
    ];
    if (Number.isFinite(item.tcgLow) && item.tcgLow > 0) {
        parts.push(`TCG low ${formatCurrency(item.tcgLow)}`);
    }
    return parts.join(' | ');
};

const createInventoryEntryForPurchase = async (item) => {
    const quantity = Number.isFinite(item.quantity) ? item.quantity : Number.parseInt(item.quantity, 10) || 1;
    const payload = {
        name: item.name,
        setCode: (item.setCode || '').toUpperCase(),
        collectorNumber: item.collectorNumber,
        foilType: finishToFoilType(item.finish),
        pricePaid: Number(item.perUnitCost.toFixed(2)),
        quantity: quantity < 1 ? 1 : quantity,
        tcgplayerId: item.tcgplayerId ? String(item.tcgplayerId) : null,
        condition: String(item.condition || 'NM').toUpperCase(),
        scryfallId: item.scryfallId,
    };
    const response = await fetchJson('/api/inventory', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
    });
    if (!response?.id) {
        throw new Error('Failed to add card to inventory.');
    }
    return response.id;
};

const logCardPurchaseEntry = async (item, { paymentMethod = null, purchaseDate } = {}) => {
    const inventoryId = await createInventoryEntryForPurchase(item);
    const amount = Number((item.perUnitCost * item.quantity).toFixed(2));
    const incurredOn = purchaseDate || new Date().toISOString().slice(0, 10);
    const payload = {
        description: `${item.name} (${item.setCode || ''} #${item.collectorNumber || ''}) x${item.quantity}`,
        amount,
        category: 'Card Purchase',
        paymentMethod,
        incurredOn,
        notes: buildCardPurchaseNotes(item),
        linkedInventoryId: inventoryId,
    };
    await fetchJson('/api/finances/expenses', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
    });
};
const createDiscretePurchaseFlow = () => {
    const elements = {
        modal: document.getElementById('discrete-purchase-modal'),
        searchInput: document.getElementById('discrete-purchase-search'),
        printingDropdown: document.getElementById('discrete-printing-dropdown'),
        searchWrapper: document.querySelector('[data-search-wrapper="discrete"]'),
        queueBody: document.getElementById('discrete-queue-body'),
        queueCount: document.getElementById('discrete-queue-count'),
        paymentMethodInput: document.getElementById('discrete-payment-method'),
        dateInput: document.getElementById('discrete-purchase-date'),
        saveBtn: document.getElementById('discrete-save-btn'),
        closeButtons: Array.from(document.querySelectorAll('[data-close-discrete]')),
    };

    if (!elements.modal) return null;

    const state = {
        items: [],
        printings: [],
        printingLoading: false,
        printingError: null,
        searchWidget: null,
    };

    const hidePrintingDropdown = () => {
        if (!elements.printingDropdown) return;
        elements.printingDropdown.innerHTML = '';
        elements.printingDropdown.setAttribute('hidden', 'hidden');
    };

    const showPrintingDropdown = () => {
        elements.printingDropdown?.removeAttribute('hidden');
    };

    const renderPrintingPicker = () => {
        if (!elements.printingDropdown) return;
        if (state.printingLoading) {
            elements.printingDropdown.innerHTML = '<p class="dropdown-status">Loading printings...</p>';
            showPrintingDropdown();
            return;
        }
        if (state.printingError) {
            elements.printingDropdown.innerHTML = `<p class="dropdown-status error">${escapeHtml(state.printingError)}</p>`;
            showPrintingDropdown();
            return;
        }
        if (!state.printings.length) {
            hidePrintingDropdown();
            return;
        }
        const options = state.printings.map((printing) => {
            const finishes = printing.finishes && printing.finishes.length ? printing.finishes : ['normal'];
            const finishLabel = finishes.map((finish) => FINISH_LABELS[finish] || finish).join(', ');
            return `
                <button type="button" class="printing-option" data-printing-id="${printing.id}">
                    <div class="printing-option__info">
                        <strong>${escapeHtml(printing.name)}</strong>
                        <span class="printing-option__meta">${escapeHtml(printing.setCode || '')} #${escapeHtml(printing.collectorNumber || '')}</span>
                    </div>
                    <span class="printing-option__finish">${escapeHtml(finishLabel)}</span>
                </button>
            `;
        }).join('');
        elements.printingDropdown.innerHTML = options;
        showPrintingDropdown();
    };
    const renderQueue = () => {
        if (!elements.queueBody) return;
        if (elements.queueCount) {
            const label = state.items.length === 1 ? 'card' : 'cards';
            elements.queueCount.textContent = `${state.items.length} ${label}`;
        }
        if (!state.items.length) {
            elements.queueBody.innerHTML = '<tr><td colspan="7" class="empty">No cards queued yet.</td></tr>';
            return;
        }
        elements.queueBody.innerHTML = state.items.map((item) => {
            const finishOptions = buildFinishOptions(item.finishes || ['normal'], item.finish);
            const conditionOptions = buildConditionOptions(item.condition || 'NM');
            const priceValue = Number.isFinite(item.perUnitCost) ? item.perUnitCost.toFixed(2) : '';
            const totalLabel = Number.isFinite(item.totalCost) ? formatCurrency(item.totalCost) : '-';
            return `
                <tr data-id="${item.id}">
                    <td>
                        <div class="card-name">${escapeHtml(item.name || 'Unknown')}</div>
                        <div class="meta">${escapeHtml(item.setCode || '')} #${escapeHtml(item.collectorNumber || '')}</div>
                    </td>
                    <td data-label="Finish">
                        <select class="finish-select">${finishOptions}</select>
                    </td>
                    <td data-label="Condition">
                        <select class="condition-select">${conditionOptions}</select>
                    </td>
                    <td data-label="Qty">
                        <input type="number" class="qty-input" min="1" value="${item.quantity}">
                    </td>
                    <td data-label="Price">
                        <input type="number" class="per-price-input" min="0" step="0.01" value="${priceValue}">
                    </td>
                    <td data-label="Total"><span class="total-cell">${totalLabel}</span></td>
                    <td data-label="Actions">
                        <button type="button" class="remove-btn" data-action="remove" data-id="${item.id}">Remove</button>
                    </td>
                </tr>
            `;
        }).join('');
    };

    const resetState = () => {
        state.items = [];
        state.printings = [];
        state.printingLoading = false;
        state.printingError = null;
        if (elements.paymentMethodInput) elements.paymentMethodInput.value = '';
        if (elements.dateInput) elements.dateInput.value = '';
        if (elements.searchInput) elements.searchInput.value = '';
        renderQueue();
        hidePrintingDropdown();
    };

    const loadPrintings = async (selection) => {
        const cardName = selection?.name || selection;
        if (!cardName) return;
        state.printingLoading = true;
        state.printingError = null;
        renderPrintingPicker();
        try {
            const results = await fetchPrintingsForCard(cardName);
            state.printings = results;
            if (!results.length) {
                state.printingError = 'No printings found for that selection.';
            }
        } catch (error) {
            state.printingError = error.message || 'Failed to load printings.';
        } finally {
            state.printingLoading = false;
            renderPrintingPicker();
        }
    };

    const initSearch = () => {
        if (state.searchWidget || !elements.searchInput || typeof window.cardUtils?.CardSearchWidget !== 'function') return;
        state.searchWidget = new window.cardUtils.CardSearchWidget({
            input: elements.searchInput,
            minLength: 2,
            limit: 12,
            showSetInfo: true,
            onSelect: (card) => {
                if (card?.name) {
                    elements.searchInput.value = card.name;
                    loadPrintings(card);
                }
            },
        });
        elements.searchInput?.addEventListener('focus', () => {
            if (state.printings.length) {
                renderPrintingPicker();
            }
        });
        elements.searchInput?.addEventListener('input', (event) => {
            if (!event.target.value.trim()) {
                state.printings = [];
                hidePrintingDropdown();
            }
        });
    };

    const addItem = (payload) => {
        const item = {
            id: generatePurchaseId(),
            finishes: payload.finishes || ['normal'],
            ...payload,
        };
        let quantity = Number(item.quantity);
        if (!Number.isFinite(quantity) || quantity < 1) quantity = 1;
        if (quantity > 999) quantity = 999;
        item.quantity = quantity;
        const perUnit = Number(item.perUnitCost);
        if (Number.isFinite(perUnit) && perUnit >= 0) {
            item.perUnitCost = Number(perUnit.toFixed(2));
            item.totalCost = Number((item.perUnitCost * item.quantity).toFixed(2));
        } else {
            item.perUnitCost = null;
            item.totalCost = null;
        }
        state.items.push(item);
        renderQueue();
        scrollQueueIntoView(elements.queueBody);
    };

    const handlePrintingDropdownClick = (event) => {
        const option = event.target.closest('.printing-option');
        if (!option) return;
        const printing = state.printings.find((entry) => entry.id === option.dataset.printingId);
        if (!printing) return;
        const finishes = printing.finishes && printing.finishes.length ? printing.finishes : ['normal'];
        addItem({
            scryfallId: printing.id,
            name: printing.name,
            setCode: printing.setCode,
            collectorNumber: printing.collectorNumber,
            tcgplayerId: printing.tcgplayerId,
            finish: finishes[0],
            condition: 'NM',
            finishes,
            quantity: 1,
            perUnitCost: null,
        });
        hidePrintingDropdown();
    };

    const handleDropdownOutsideClick = (event) => {
        if (!elements.modal || elements.modal.hasAttribute('hidden')) return;
        const inSearch = elements.searchWrapper?.contains(event.target);
        const inDropdown = elements.printingDropdown?.contains(event.target);
        if (!inSearch && !inDropdown) {
            hidePrintingDropdown();
        }
    };

    const handleQueueInput = (event) => {
        const row = event.target.closest('tr[data-id]');
        if (!row) return;
        const item = state.items.find((entry) => entry.id === row.dataset.id);
        if (!item) return;
        if (event.target.classList.contains('qty-input')) {
            let qty = parseInt(event.target.value, 10);
            if (!Number.isFinite(qty) || qty < 1) qty = 1;
            if (qty > 999) qty = 999;
            item.quantity = qty;
        } else if (event.target.classList.contains('per-price-input')) {
            const value = parseFloat(event.target.value);
            item.perUnitCost = Number.isFinite(value) && value >= 0 ? Number(value.toFixed(2)) : null;
        } else if (event.target.classList.contains('finish-select')) {
            item.finish = event.target.value;
        } else if (event.target.classList.contains('condition-select')) {
            item.condition = event.target.value;
        }
        if (Number.isFinite(item.perUnitCost)) {
            item.totalCost = Number((item.perUnitCost * item.quantity).toFixed(2));
        } else {
            item.totalCost = null;
        }
        renderQueue();
    };

    const handleQueueClick = (event) => {
        const button = event.target.closest('[data-action="remove"]');
        if (!button) return;
        state.items = state.items.filter((entry) => entry.id !== button.dataset.id);
        renderQueue();
    };

    const save = async () => {
        if (!state.items.length) {
            showToast('Add at least one card to the queue.', 'error');
            return;
        }
        const missingPrice = state.items.find((item) => !(Number(item.perUnitCost) > 0));
        if (missingPrice) {
            showToast('Each card needs a purchase price.', 'error');
            return;
        }
        const paymentMethod = elements.paymentMethodInput?.value || null;
        const purchaseDate = elements.dateInput?.value || new Date().toISOString().slice(0, 10);
        const button = elements.saveBtn;
        if (button) {
            button.disabled = true;
            button.dataset.originalText = button.dataset.originalText || button.textContent;
            button.textContent = 'Saving...';
        }
        try {
            for (const item of state.items) {
                await logCardPurchaseEntry(item, { paymentMethod, purchaseDate });
            }
            showToast('Card purchases logged and inventory updated.', 'success');
            close();
            await Promise.all([loadSummary(), loadExpenses()]);
        } catch (error) {
            showToast(error.message || 'Failed to log card purchases', 'error');
        } finally {
            if (button) {
                button.disabled = false;
                button.textContent = button.dataset.originalText || 'Log Card Purchases';
            }
        }
    };
    const open = () => {
        resetState();
        if (elements.dateInput) {
            elements.dateInput.value = toDateInputValue(new Date());
        }
        elements.modal.removeAttribute('hidden');
        initSearch();
        elements.searchInput?.focus();
    };

    const close = () => {
        elements.modal.setAttribute('hidden', 'hidden');
        resetState();
    };

    elements.printingDropdown?.addEventListener('click', handlePrintingDropdownClick);
    document.addEventListener('click', handleDropdownOutsideClick);
    elements.queueBody?.addEventListener('input', handleQueueInput);
    elements.queueBody?.addEventListener('click', handleQueueClick);
    elements.saveBtn?.addEventListener('click', save);
    elements.modal?.addEventListener('click', (event) => {
        if (event.target === elements.modal) {
            close();
        }
    });
    elements.closeButtons.forEach((btn) => btn.addEventListener('click', close));

    return { open, close };
};

const createSplitPurchaseFlow = () => {
    const elements = {
        modal: document.getElementById('split-purchase-modal'),
        searchInput: document.getElementById('split-purchase-search'),
        printingDropdown: document.getElementById('split-printing-dropdown'),
        searchWrapper: document.querySelector('[data-search-wrapper="split"]'),
        queueBody: document.getElementById('split-queue-body'),
        queueCount: document.getElementById('split-queue-count'),
        totalInput: document.getElementById('split-total-input'),
        paymentMethodInput: document.getElementById('split-payment-method'),
        allocateBtn: document.getElementById('split-allocate-btn'),
        saveBtn: document.getElementById('split-save-btn'),
        closeButtons: Array.from(document.querySelectorAll('[data-close-split]')),
    };

    if (!elements.modal) return null;

    const state = {
        items: [],
        printings: [],
        printingLoading: false,
        printingError: null,
        searchWidget: null,
    };

    const hidePrintingDropdown = () => {
        if (!elements.printingDropdown) return;
        elements.printingDropdown.innerHTML = '';
        elements.printingDropdown.setAttribute('hidden', 'hidden');
    };

    const showPrintingDropdown = () => {
        elements.printingDropdown?.removeAttribute('hidden');
    };

    const renderPrintingPicker = () => {
        if (!elements.printingDropdown) return;
        if (state.printingLoading) {
            elements.printingDropdown.innerHTML = '<p class="dropdown-status">Loading printings...</p>';
            showPrintingDropdown();
            return;
        }
        if (state.printingError) {
            elements.printingDropdown.innerHTML = `<p class="dropdown-status error">${escapeHtml(state.printingError)}</p>`;
            showPrintingDropdown();
            return;
        }
        if (!state.printings.length) {
            hidePrintingDropdown();
            return;
        }
        const options = state.printings.map((printing) => {
            const finishes = printing.finishes && printing.finishes.length ? printing.finishes : ['normal'];
            const finishLabel = finishes.map((finish) => FINISH_LABELS[finish] || finish).join(', ');
            return `
                <button type="button" class="printing-option" data-printing-id="${printing.id}">
                    <div class="printing-option__info">
                        <strong>${escapeHtml(printing.name)}</strong>
                        <span class="printing-option__meta">${escapeHtml(printing.setCode || '')} #${escapeHtml(printing.collectorNumber || '')}</span>
                    </div>
                    <span class="printing-option__finish">${escapeHtml(finishLabel)}</span>
                </button>
            `;
        }).join('');
        elements.printingDropdown.innerHTML = options;
        showPrintingDropdown();
    };
    const renderQueue = () => {
        if (!elements.queueBody) return;
        if (elements.queueCount) {
            const label = state.items.length === 1 ? 'card' : 'cards';
            elements.queueCount.textContent = `${state.items.length} ${label}`;
        }
        if (!state.items.length) {
            elements.queueBody.innerHTML = '<tr><td colspan="8" class="empty">No cards queued yet.</td></tr>';
            return;
        }
        elements.queueBody.innerHTML = state.items.map((item) => {
            const finishOptions = buildFinishOptions(item.finishes || ['normal'], item.finish);
            const conditionOptions = buildConditionOptions(item.condition || 'NM');
            const referenceLabel = item.loading
                ? 'Loading…'
                : Number.isFinite(item.tcgLow)
                    ? formatCurrency(item.tcgLow)
                    : '—';
            const perUnitValue = Number.isFinite(item.perUnitCost) ? item.perUnitCost.toFixed(2) : '';
            const totalLabel = Number.isFinite(item.totalCost) ? formatCurrency(item.totalCost) : '-';
            return `
                <tr data-id="${item.id}">
                    <td>
                        <div class="card-name">${escapeHtml(item.name || 'Unknown')}</div>
                        <div class="meta">${escapeHtml(item.setCode || '')} #${escapeHtml(item.collectorNumber || '')}</div>
                    </td>
                    <td data-label="Finish">
                        <select class="finish-select">${finishOptions}</select>
                    </td>
                    <td data-label="Condition">
                        <select class="condition-select">${conditionOptions}</select>
                    </td>
                    <td data-label="Qty">
                        <input type="number" class="qty-input" min="1" value="${item.quantity}">
                    </td>
                    <td data-label="TCG Low"><span class="reference-value">${referenceLabel}</span></td>
                    <td data-label="Allocated">
                        <input type="number" class="per-unit-input" min="0" step="0.01" value="${perUnitValue}">
                    </td>
                    <td data-label="Total"><span class="total-cell">${totalLabel}</span></td>
                    <td data-label="Actions">
                        <button type="button" class="remove-btn" data-action="remove" data-id="${item.id}">Remove</button>
                    </td>
                </tr>
            `;
        }).join('');
    };

    const resetState = () => {
        state.items = [];
        state.printings = [];
        state.printingLoading = false;
        state.printingError = null;
        if (elements.totalInput) elements.totalInput.value = '';
        if (elements.paymentMethodInput) elements.paymentMethodInput.value = '';
        if (elements.searchInput) elements.searchInput.value = '';
        renderQueue();
        hidePrintingDropdown();
    };

    const loadPrintings = async (selection) => {
        const cardName = selection?.name || selection;
        if (!cardName) return;
        state.printingLoading = true;
        state.printingError = null;
        renderPrintingPicker();
        try {
            const results = await fetchPrintingsForCard(cardName);
            state.printings = results;
            if (!results.length) {
                state.printingError = 'No printings found for that selection.';
            }
        } catch (error) {
            state.printingError = error.message || 'Failed to load printings.';
        } finally {
            state.printingLoading = false;
            renderPrintingPicker();
        }
    };

    const initSearch = () => {
        if (state.searchWidget || !elements.searchInput || typeof window.cardUtils?.CardSearchWidget !== 'function') return;
        state.searchWidget = new window.cardUtils.CardSearchWidget({
            input: elements.searchInput,
            minLength: 2,
            limit: 12,
            showSetInfo: true,
            onSelect: (card) => {
                if (card?.name) {
                    elements.searchInput.value = card.name;
                    loadPrintings(card);
                }
            },
        });
        elements.searchInput?.addEventListener('focus', () => {
            if (state.printings.length) {
                renderPrintingPicker();
            }
        });
        elements.searchInput?.addEventListener('input', (event) => {
            if (!event.target.value.trim()) {
                state.printings = [];
                hidePrintingDropdown();
            }
        });
    };

    const addItem = (payload) => {
        const item = {
            id: generatePurchaseId(),
            finishes: payload.finishes || ['normal'],
            ...payload,
            tcgLow: null,
            perUnitCost: null,
            totalCost: null,
            loading: true,
        };
        state.items.push(item);
        renderQueue();
        scrollQueueIntoView(elements.queueBody);
        loadPriceForItem(item);
    };

    const loadPriceForItem = async (item) => {
        if (!item?.scryfallId) return;
        item.loading = true;
        renderQueue();
        try {
            const data = await fetchJson(`/api/cards/price-basis?scryfallId=${encodeURIComponent(item.scryfallId)}&finish=${encodeURIComponent(item.finish)}`);
            if (Number.isFinite(data?.tcgLow) && data.tcgLow > 0) {
                item.tcgLow = Number(data.tcgLow);
            } else {
                item.tcgLow = null;
            }
        } catch (error) {
            console.warn('[splitPurchase] price lookup failed:', error.message);
            item.tcgLow = null;
        } finally {
            item.loading = false;
            renderQueue();
        }
    };

    const handlePrintingDropdownClick = (event) => {
        const option = event.target.closest('.printing-option');
        if (!option) return;
        const printing = state.printings.find((entry) => entry.id === option.dataset.printingId);
        if (!printing) return;
        const finishes = printing.finishes && printing.finishes.length ? printing.finishes : ['normal'];
        addItem({
            scryfallId: printing.id,
            name: printing.name,
            setCode: printing.setCode,
            collectorNumber: printing.collectorNumber,
            tcgplayerId: printing.tcgplayerId,
            finish: finishes[0],
            condition: 'NM',
            finishes,
            quantity: 1,
        });
        hidePrintingDropdown();
    };

    const handleDropdownOutsideClick = (event) => {
        if (!elements.modal || elements.modal.hasAttribute('hidden')) return;
        const inSearch = elements.searchWrapper?.contains(event.target);
        const inDropdown = elements.printingDropdown?.contains(event.target);
        if (!inSearch && !inDropdown) {
            hidePrintingDropdown();
        }
    };

    const handleQueueInput = (event) => {
        const row = event.target.closest('tr[data-id]');
        if (!row) return;
        const item = state.items.find((entry) => entry.id === row.dataset.id);
        if (!item) return;
        if (event.target.classList.contains('qty-input')) {
            let qty = parseInt(event.target.value, 10);
            if (!Number.isFinite(qty) || qty < 1) qty = 1;
            if (qty > 999) qty = 999;
            item.quantity = qty;
        } else if (event.target.classList.contains('per-unit-input')) {
            const value = parseFloat(event.target.value);
            item.perUnitCost = Number.isFinite(value) && value >= 0 ? Number(value.toFixed(2)) : null;
        } else if (event.target.classList.contains('finish-select')) {
            item.finish = event.target.value;
            loadPriceForItem(item);
            return;
        } else if (event.target.classList.contains('condition-select')) {
            item.condition = event.target.value;
            return;
        }
        if (Number.isFinite(item.perUnitCost)) {
            item.totalCost = Number((item.perUnitCost * item.quantity).toFixed(2));
        } else {
            item.totalCost = null;
        }
        renderQueue();
    };

    const handleQueueClick = (event) => {
        const button = event.target.closest('[data-action="remove"]');
        if (!button) return;
        state.items = state.items.filter((entry) => entry.id !== button.dataset.id);
        renderQueue();
    };

    const allocateByTcgLow = () => {
        const total = parseFloat(elements.totalInput?.value || '');
        if (!Number.isFinite(total) || total <= 0) {
            showToast('Enter a total purchase amount before allocating.', 'error');
            return;
        }
        if (!state.items.length) {
            showToast('Add cards before allocating.', 'error');
            return;
        }
        const weights = state.items.map((item) => {
            const basis = Number(item.tcgLow);
            return Number.isFinite(basis) && basis > 0 ? basis * item.quantity : 0;
        });
        if (weights.some((weight) => weight <= 0)) {
            showToast('Wait for TCG low data before allocating.', 'error');
            return;
        }
        const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
        if (!totalWeight) {
            showToast('Invalid allocation weights.', 'error');
            return;
        }
        let allocated = 0;
        state.items.forEach((item, index) => {
            const weight = weights[index];
            let share = (total * weight) / totalWeight;
            if (index === state.items.length - 1) {
                share = total - allocated;
            }
            share = Number(share.toFixed(2));
            allocated += share;
            const perUnit = share / item.quantity;
            item.perUnitCost = Number(perUnit.toFixed(2));
            item.totalCost = Number((item.perUnitCost * item.quantity).toFixed(2));
        });
        renderQueue();
        showToast('Purchase total allocated across cards.', 'success');
    };

    const save = async () => {
        if (!state.items.length) {
            showToast('Add at least one card to the queue.', 'error');
            return;
        }
        const missingAllocation = state.items.find((item) => !(Number(item.perUnitCost) > 0));
        if (missingAllocation) {
            showToast('Allocate or enter a price for each card.', 'error');
            return;
        }
        const paymentMethod = elements.paymentMethodInput?.value || null;
        const purchaseDate = new Date().toISOString().slice(0, 10);
        const button = elements.saveBtn;
        if (button) {
            button.disabled = true;
            button.dataset.originalText = button.dataset.originalText || button.textContent;
            button.textContent = 'Saving...';
        }
        try {
            for (const item of state.items) {
                await logCardPurchaseEntry(item, { paymentMethod, purchaseDate });
            }
            showToast('Card purchases logged and inventory updated.', 'success');
            close();
            await Promise.all([loadSummary(), loadExpenses()]);
        } catch (error) {
            showToast(error.message || 'Failed to log card purchases', 'error');
        } finally {
            if (button) {
                button.disabled = false;
                button.textContent = button.dataset.originalText || 'Log Card Purchases';
            }
        }
    };

    const open = () => {
        resetState();
        elements.modal.removeAttribute('hidden');
        initSearch();
        elements.searchInput?.focus();
    };

    const close = () => {
        elements.modal.setAttribute('hidden', 'hidden');
        resetState();
    };

    elements.printingDropdown?.addEventListener('click', handlePrintingDropdownClick);
    document.addEventListener('click', handleDropdownOutsideClick);
    elements.queueBody?.addEventListener('input', handleQueueInput);
    elements.queueBody?.addEventListener('click', handleQueueClick);
    elements.allocateBtn?.addEventListener('click', allocateByTcgLow);
    elements.saveBtn?.addEventListener('click', save);
    elements.modal?.addEventListener('click', (event) => {
        if (event.target === elements.modal) {
            close();
        }
    });
    elements.closeButtons.forEach((btn) => btn.addEventListener('click', close));

    return { open, close };
};

const discretePurchaseFlow = createDiscretePurchaseFlow();
const splitPurchaseFlow = createSplitPurchaseFlow();
const cardPurchaseFlows = {
    discrete: discretePurchaseFlow,
    split: splitPurchaseFlow,
};

const hideCardPurchaseMenu = () => {
    if (!cardPurchaseMenu) return;
    cardPurchaseMenu.setAttribute('hidden', 'hidden');
};

const showCardPurchaseMenu = () => {
    if (!cardPurchaseMenu) return;
    cardPurchaseMenu.removeAttribute('hidden');
};

const toggleCardPurchaseMenu = () => {
    if (!cardPurchaseMenu) return;
    const isHidden = cardPurchaseMenu.hasAttribute('hidden');
    if (isHidden) {
        showCardPurchaseMenu();
    } else {
        hideCardPurchaseMenu();
    }
};

const openCardPurchaseFlow = (mode) => {
    const flow = cardPurchaseFlows[mode];
    if (flow && typeof flow.open === 'function') {
        flow.open();
    } else {
        showToast('Card purchase flow unavailable.', 'error');
    }
};

const handleCardPurchaseMenuClick = (event) => {
    const button = event.target.closest('button[data-mode]');
    if (!button) return;
    event.stopPropagation();
    hideCardPurchaseMenu();
    openCardPurchaseFlow(button.dataset.mode);
};

const handleDocumentClickForMenu = (event) => {
    if (!cardPurchaseTrigger) return;
    if (!cardPurchaseTrigger.contains(event.target)) {
        hideCardPurchaseMenu();
    }
};

const initFinancesPage = () => {
    loadSummary();
    loadExpenses();

    refreshSummaryBtn?.addEventListener('click', loadSummary);
    refreshSnapshotsBtn?.addEventListener('click', loadSnapshots);
    refreshExpensesBtn?.addEventListener('click', loadExpenses);
    refreshCardLedgerBtn?.addEventListener('click', loadExpenses);
    refreshShippingLedgerBtn?.addEventListener('click', loadExpenses);
    captureSnapshotBtn?.addEventListener('click', captureSnapshot);

    recordExpenseBtn?.addEventListener('click', () => openExpenseModal());
    expenseForm?.addEventListener('submit', handleExpenseSubmit);
    expenseModal?.addEventListener('click', (event) => {
        if (event.target === expenseModal) {
            closeExpenseModal();
        }
    });
    expenseModalCloseButtons.forEach((button) => button.addEventListener('click', closeExpenseModal));

    expenseFilterInput?.addEventListener('input', (event) => {
        state.expenseFilter = event.target.value.trim();
        renderExpenseTable();
    });
    expenseTableBody?.addEventListener('click', handleExpenseTableClick);
    shippingLedgerBody?.addEventListener('click', handleExpenseTableClick);
    cardLedgerBody?.addEventListener('click', handleCardLedgerClick);

    cardPurchaseBtn?.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        toggleCardPurchaseMenu();
    });
    cardPurchaseMenu?.addEventListener('click', handleCardPurchaseMenuClick);
    document.addEventListener('click', handleDocumentClickForMenu);
};

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initFinancesPage);
} else {
    initFinancesPage();
}


