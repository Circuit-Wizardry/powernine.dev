const statusConnectionEl = document.getElementById('status-connection');
const statusLocalCountEl = document.getElementById('status-local-count');
const statusRemoteCountEl = document.getElementById('status-remote-count');
const statusLastSyncEl = document.getElementById('status-last-sync');
const statusMessageEl = document.getElementById('status-message');
const discrepancyTableBody = document.getElementById('discrepancy-table-body');
const actionLogEl = document.getElementById('action-log');
const toastEl = document.getElementById('toast');
const bulkForm = document.getElementById('bulk-price-form');
const bulkStrategySelect = document.getElementById('bulk-strategy');
const bulkAdjustmentWrapper = document.getElementById('bulk-adjustment-wrapper');
const bulkAdjustmentInput = document.getElementById('bulk-adjustment');
const unmatchedModal = document.getElementById('unmatched-modal');
const unmatchedListEl = document.getElementById('unmatched-list');
const pushModal = document.getElementById('push-modal');
const pushTableBody = document.getElementById('push-inventory-table-body');
const pushAllConfirmBtn = document.getElementById('push-all-confirm-btn');
const priceOffsetInput = document.getElementById('price-offset');
const pushProgressContainer = document.getElementById('push-progress');
const pushProgressBarFill = document.getElementById('push-progress-bar-fill');
const pushProgressText = document.getElementById('push-progress-text');
let pushModalInventory = [];
let isPushAllRunning = false;
let hasPulledOrdersThisSession = false;

const STRATEGY_CONFIG = {
    manaPoolLowPercent: {
        requiresValue: true,
        placeholder: '5',
        label: 'Percent under ManaPool low',
        formatter: (value) => `${value}% under ManaPool low`
    },
    manaPoolLowCents: {
        requiresValue: true,
        placeholder: '0.25',
        label: 'Cents under ManaPool low',
        formatter: (value) => `$${value} under ManaPool low`
    },
    tcgMarketMatch: {
        requiresValue: false,
        formatter: () => 'Match TCG Market'
    }
};

const escapeHtml = (value = '') => String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const setLoading = (button, isLoading) => {
    if (!button) return;
    button.disabled = isLoading;
    button.dataset.loading = isLoading ? 'true' : 'false';
    if (isLoading) {
        button.dataset.originalText = button.textContent;
        button.textContent = 'Working...';
    } else if (button.dataset.originalText) {
        button.textContent = button.dataset.originalText;
        delete button.dataset.originalText;
    }
};

const showToast = (message, type = 'info') => {
    if (!toastEl) return;
    toastEl.textContent = message;
    toastEl.dataset.type = type;
    toastEl.classList.add('show');
    clearTimeout(showToast.timeout);
    showToast.timeout = setTimeout(() => {
        toastEl.classList.remove('show');
    }, 4000);
};

const appendLog = (message, status = 'info') => {
    if (!actionLogEl) return;
    const entry = document.createElement('li');
    const time = document.createElement('time');
    time.textContent = new Date().toLocaleTimeString();
    entry.dataset.status = status;
    entry.innerHTML = `<span>${message}</span>`;
    entry.appendChild(time);
    actionLogEl.prepend(entry);
    const items = actionLogEl.querySelectorAll('li');
    if (items.length > 40) {
        items[items.length - 1].remove();
    }
};

const fetchJson = async (url, options = {}) => {
    const response = await fetch(url, options);
    if (!response.ok) {
        let detail = '';
        try {
            const data = await response.json();
            detail = data?.error || data?.message || response.statusText;
        } catch (_) {
            detail = response.statusText;
        }
        throw new Error(detail || 'Request failed.');
    }
    return response.json();
};

const setStatusLoadingState = () => {
    if (!statusConnectionEl) return;
    statusConnectionEl.textContent = 'Loading...';
    statusConnectionEl.classList.remove('loss');
    statusLocalCountEl.textContent = '--';
    statusRemoteCountEl.textContent = '--';
    statusLastSyncEl.textContent = '--';
    statusMessageEl.textContent = 'Fetching latest data...';
};

const updateStatusCard = (status) => {
    if (!status) return;
    statusConnectionEl.textContent = status.connected ? 'Connected' : 'Disconnected';
    statusConnectionEl.classList.toggle('loss', !status.connected);
    statusLocalCountEl.textContent = status.localInventoryCount ?? '--';
    statusRemoteCountEl.textContent = status.remoteInventoryCount ?? '--';
    statusLastSyncEl.textContent = status.lastSync
        ? new Date(status.lastSync).toLocaleString()
        : '--';
    statusMessageEl.textContent = status.message || status.error || '';
};

const setDiscrepancyLoadingState = () => {
    if (!discrepancyTableBody) return;
    discrepancyTableBody.innerHTML = '<tr><td colspan="6" class="empty">Checking for discrepancies...</td></tr>';
};

const renderDiscrepancies = (rows) => {
    if (!discrepancyTableBody) return;
    if (!rows || rows.length === 0) {
        discrepancyTableBody.innerHTML = '<tr><td colspan="6" class="empty">No discrepancies detected.</td></tr>';
        return;
    }
    const sortedRows = [...rows].sort((a, b) => Number(b.isNew) - Number(a.isNew));
    discrepancyTableBody.innerHTML = sortedRows.map((row) => `
        <tr class="${row.isNew ? 'discrepancy-new' : ''}">
            <td>${row.name}</td>
            <td>${row.setCode}</td>
            <td>${row.localQuantity}</td>
            <td>${row.remoteQuantity}</td>
            <td>${row.localPrice ?? '--'}</td>
            <td>${row.remotePrice ?? '--'}</td>
        </tr>
    `).join('');
};

const handleAction = async (button, endpoint, options = {}, successMessage) => {
    try {
        setLoading(button, true);
        const result = await fetchJson(endpoint, { method: 'POST', ...options });
        if (successMessage) {
            showToast(successMessage, 'success');
        }
        appendLog(successMessage || 'Action completed', 'success');
        return result;
    } catch (error) {
        showToast(error.message || 'Request failed', 'error');
        appendLog(error.message || 'Request failed', 'error');
        throw error;
    } finally {
        setLoading(button, false);
    }
};

const refreshStatus = async () => {
    try {
        setStatusLoadingState();
        const status = await fetchJson('/api/manapool/status');
        updateStatusCard(status);
    } catch (error) {
        showToast(error.message || 'Failed to load status', 'error');
    }
};

const refreshDiscrepancies = async () => {
    try {
        setDiscrepancyLoadingState();
        const { discrepancies } = await fetchJson('/api/manapool/discrepancies');
        renderDiscrepancies(discrepancies || []);
    } catch (error) {
        showToast(error.message || 'Failed to load discrepancies', 'error');
    }
};

const renderUnmatchedOrders = (orders = []) => {
    if (!unmatchedListEl) return;
    if (!orders.length) {
        unmatchedListEl.innerHTML = '<p>All ManaPool orders matched existing inventory.</p>';
        return;
    }
    unmatchedListEl.innerHTML = orders.map((order) => {
        const items = (order.items || []).map(item => {
            const collectorLabel = item.collectorNumber ? `#${item.collectorNumber}` : null;
            const setLabel = item.setCode ? [item.setCode, collectorLabel].filter(Boolean).join(' ') : null;
            const labelPartsRaw = [
                item.condition,
                item.foilType && item.foilType !== 'normal' ? item.foilType : null,
                setLabel
            ].filter(Boolean);
            const labelParts = labelPartsRaw.length
                ? labelPartsRaw.map(part => escapeHtml(part)).join(' | ')
                : 'details unknown';
            return `<li>${escapeHtml(item.name)} (${labelParts}) - need ${item.missingQuantity} more (ordered ${item.requestedQuantity})</li>`;
        }).join('');
        const orderMeta = [
            order.buyer ? `Buyer: ${escapeHtml(order.buyer)}` : null,
            order.createdAt ? `Date: ${new Date(order.createdAt).toLocaleString()}` : null
        ].filter(Boolean).join(' | ');
        return `
            <div class="unmatched-order" data-order-id="${escapeHtml(order.orderId)}">
                <h3>Order ${escapeHtml(order.orderId)}</h3>
                ${orderMeta ? `<p>${orderMeta}</p>` : ''}
                <ul>${items}</ul>
                <button type="button" class="secondary-btn force-import-btn" data-force-order="${escapeHtml(order.orderId)}">
                    Reported to ManaPool, save anyway
                </button>
            </div>
        `;
    }).join('');
    bindForceImportButtons();
};

const openUnmatchedModal = (orders = []) => {
    if (!unmatchedModal) return;
    renderUnmatchedOrders(orders);
    unmatchedModal.removeAttribute('hidden');
};

const closeUnmatchedModal = () => {
    if (!unmatchedModal) return;
    unmatchedModal.setAttribute('hidden', 'hidden');
};

const bindForceImportButtons = () => {
    if (!unmatchedListEl) return;
    unmatchedListEl.querySelectorAll('[data-force-order]').forEach((btn) => {
        if (btn.dataset.bound === 'true') return;
        btn.dataset.bound = 'true';
        btn.addEventListener('click', async () => {
            const orderId = btn.dataset.forceOrder;
            if (!orderId) return;
            try {
                await handleAction(
                    btn,
                    '/api/manapool/orders/force-import',
                    {
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ orderId })
                    },
                    'Order saved without missing cards'
                );
                const wrapper = btn.closest('.unmatched-order');
                if (wrapper) wrapper.remove();
                appendLog(`Forced import completed for order ${orderId}`, 'success');
                if (!unmatchedListEl.querySelector('.unmatched-order')) {
                    unmatchedListEl.innerHTML = '<p>All ManaPool orders matched existing inventory.</p>';
                    closeUnmatchedModal();
                }
                refreshStatus();
                refreshDiscrepancies();
            } catch (error) {
                // handleAction already surfaced the error
            }
        });
    });
};

const renderPushInventoryRows = (rows = []) => {
    if (!pushTableBody) return;
    if (!rows.length) {
        pushTableBody.innerHTML = '<tr><td colspan="5" class="empty">No inventory items with quantity greater than zero.</td></tr>';
        return;
    }
    pushTableBody.innerHTML = rows.map(item => {
        const priceBasis = Number(item.tcgMarketPrice ?? item.pricePaid ?? 0);
        const priceLabel = priceBasis > 0 ? `$${priceBasis.toFixed(2)}` : 'Unknown';
        const setLabel = [item.setCode?.toUpperCase(), item.collectorNumber].filter(Boolean).join(' #');
        const scryfallId = item.scryfallId || '';
        return `
            <tr>
                <td>${escapeHtml(item.name || 'Unknown')}</td>
                <td>${escapeHtml(setLabel || 'N/A')}</td>
                <td>${item.quantity}</td>
                <td>${priceLabel}</td>
                <td class="scryfall-id-cell">
                    <span>${escapeHtml(scryfallId)}</span>
                    ${scryfallId ? `<button type="button" class="ghost-btn copy-id-btn" data-scryfall="${escapeHtml(scryfallId)}">Copy</button>` : ''}
                </td>
                <td>
                    <button type="button" class="secondary-btn" data-push-id="${escapeHtml(item.id)}" data-scryfall="${escapeHtml(scryfallId)}">
                        Push Card
                    </button>
                </td>
            </tr>
        `;
    }).join('');
};

const loadPushModalInventory = async () => {
    if (!pushTableBody) return;
    pushTableBody.innerHTML = '<tr><td colspan="5" class="empty">Loading inventory...</td></tr>';
    try {
        const response = await fetch('/api/inventory');
        if (!response.ok) {
            const err = await response.json().catch(() => ({}));
            throw new Error(err.error || `Failed to load inventory (status ${response.status}).`);
        }
        const data = await response.json();
        pushModalInventory = Array.isArray(data)
            ? data.filter(item => Number(item.quantity) > 0).sort((a, b) => (a.name || '').localeCompare(b.name || ''))
            : [];
        renderPushInventoryRows(pushModalInventory);
    } catch (error) {
        pushTableBody.innerHTML = '<tr><td colspan="5" class="empty">Failed to load inventory.</td></tr>';
        showToast(error.message || 'Failed to load inventory', 'error');
    }
};

const openPushModal = async () => {
    if (!pushModal) return;
    pushModal.removeAttribute('hidden');
    await loadPushModalInventory();
};

const closePushModal = () => {
    if (!pushModal) return;
    pushModal.setAttribute('hidden', 'hidden');
};

const pushInventoryItemRequest = async ({ inventoryId, scryfallId = 'unknown', offsetCents, button = null, refresh = true }) => {
    if (!inventoryId) return false;
    try {
        if (button) setLoading(button, true);
        const result = await fetchJson('/api/manapool/inventory/push-item', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                inventoryId,
                priceOffsetCents: Number.isFinite(offsetCents) ? offsetCents : 1
            })
        });
        const message = summarizeApiResult(result, `Card ${scryfallId || 'unknown'} synced to ManaPool.`);
        showToast(message, 'info');
        appendLog(message, 'success');
        if (refresh) {
            refreshStatus();
            refreshDiscrepancies();
        }
        return true;
    } catch (error) {
        showToast(error.message || 'Failed to push card.', 'error');
        appendLog(error.message || 'Failed to push card.', 'error');
        return false;
    } finally {
        if (button) setLoading(button, false);
    }
};

const pushInventoryItem = async (button, inventoryId) => {
    const offset = getPriceOffsetValue();
    await pushInventoryItemRequest({
        inventoryId,
        scryfallId: button?.dataset.scryfall || 'unknown',
        offsetCents: offset,
        button,
        refresh: true
    });
};

const cleanupRemoteInventoryClient = async () => {
    try {
        const result = await fetchJson('/api/manapool/inventory/cleanup', { method: 'POST' });
        const message = result?.deleted
            ? `Removed ${result.deleted} ManaPool listings no longer in inventory.`
            : 'Cleanup complete.';
        appendLog(message, 'info');
        showToast(message, 'info');
    } catch (error) {
        showToast(error.message || 'Failed to cleanup remote inventory.', 'error');
        appendLog(error.message || 'Failed to cleanup remote inventory.', 'error');
    }
};

const pushAllInventory = async () => {
    if (!pushAllConfirmBtn || isPushAllRunning) return;
    if (!pushModalInventory.length) {
        showToast('No inventory entries available to push.', 'error');
        return;
    }
    isPushAllRunning = true;
    setLoading(pushAllConfirmBtn, true);
    showPushProgress('Starting bulk push...');
    const total = pushModalInventory.length;
    const offset = getPriceOffsetValue();
    let successCount = 0;
    try {
        for (let i = 0; i < total; i += 1) {
            const item = pushModalInventory[i];
            updatePushProgress(i, total, `Pushing ${item.name} (${i + 1}/${total})...`);
            const pushed = await pushInventoryItemRequest({
                inventoryId: item.id,
                scryfallId: item.scryfallId || 'unknown',
                offsetCents: offset,
                refresh: false
            });
            if (pushed) successCount += 1;
            updatePushProgress(i + 1, total, `Processed ${i + 1} of ${total}`);
        }
        updatePushProgress(total, total, 'Cleaning up remote discrepancies...');
        await cleanupRemoteInventoryClient();
        showToast(`Pushed ${successCount} of ${total} cards.`, 'info');
    } catch (error) {
        showToast(error.message || 'Bulk push failed.', 'error');
        appendLog(error.message || 'Bulk push failed.', 'error');
    } finally {
        hidePushProgress();
        setLoading(pushAllConfirmBtn, false);
        isPushAllRunning = false;
        await Promise.all([refreshStatus(), refreshDiscrepancies()]);
        await loadPushModalInventory();
    }
};

const initBulkForm = () => {
    const updateFieldVisibility = () => {
        const strategy = bulkStrategySelect.value;
        const config = STRATEGY_CONFIG[strategy];
        if (!config) return;
        if (config.requiresValue) {
            bulkAdjustmentWrapper.style.display = 'flex';
            bulkAdjustmentInput.placeholder = config.placeholder || '';
        } else {
            bulkAdjustmentWrapper.style.display = 'none';
            bulkAdjustmentInput.value = '';
        }
    };

    updateFieldVisibility();
    bulkStrategySelect.addEventListener('change', updateFieldVisibility);
};

const initEventListeners = () => {
    const pullInventoryBtn = document.getElementById('pull-inventory-btn');
    const pushInventoryBtn = document.getElementById('push-inventory-btn');
    const pullOrdersBtn = document.getElementById('pull-orders-btn');
    const refreshStatusBtn = document.getElementById('refresh-status-btn');
    const refreshDiscrepanciesBtn = document.getElementById('refresh-discrepancies-btn');
    const clearLogBtn = document.getElementById('clear-log-btn');

    pullInventoryBtn?.addEventListener('click', async () => {
        if (!hasPulledOrdersThisSession) {
            const proceed = window.confirm('Warning: Pulling inventory from ManaPool before pulling recent orders is dangerous and may cause desync. Continue anyway?');
            if (!proceed) {
                return;
            }
        }
        await handleAction(pullInventoryBtn, '/api/manapool/inventory/pull', {}, 'Pulled inventory from ManaPool');
        refreshDiscrepancies();
        refreshStatus();
    });

    pushInventoryBtn?.addEventListener('click', () => {
        openPushModal();
    });

    pullOrdersBtn?.addEventListener('click', async () => {
        const result = await handleAction(pullOrdersBtn, '/api/manapool/orders/pull');
        if (result) {
            hasPulledOrdersThisSession = true;
            const summary = `Imported ${result.imported ?? 0} orders, skipped ${result.skipped?.length ?? 0}${result.errors?.length ? `, ${result.errors.length} errors` : ''}.`;
            showToast(summary, result.errors?.length ? 'warning' : 'success');
            appendLog(summary, result.errors?.length ? 'warning' : 'success');
            if (Array.isArray(result.unmatchedOrders) && result.unmatchedOrders.length) {
                openUnmatchedModal(result.unmatchedOrders);
                showToast('Some orders need inventory entries before they can import.', 'warning');
            }
        }
    });

    refreshStatusBtn?.addEventListener('click', refreshStatus);
    refreshDiscrepanciesBtn?.addEventListener('click', refreshDiscrepancies);

    clearLogBtn?.addEventListener('click', () => {
        if (actionLogEl) actionLogEl.innerHTML = '';
    });

    document.querySelectorAll('[data-close-unmatched]').forEach((btn) => {
        btn.addEventListener('click', closeUnmatchedModal);
    });

    unmatchedModal?.addEventListener('click', (event) => {
        if (event.target === unmatchedModal) {
            closeUnmatchedModal();
        }
    });

    bulkForm?.addEventListener('submit', async (event) => {
        event.preventDefault();
        const strategy = bulkStrategySelect.value;
        const config = STRATEGY_CONFIG[strategy];
        const value = parseFloat(bulkAdjustmentInput.value);

        if (config?.requiresValue && (!Number.isFinite(value) || value <= 0)) {
            showToast('Enter an adjustment value greater than zero.', 'error');
            return;
        }

        const body = {
            strategy: {
                type: strategy,
                value: config?.requiresValue ? value : null
            }
        };

        try {
            const result = await handleAction(null, '/api/manapool/prices/bulk', {
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body)
            }, 'Generated bulk pricing preview');

            if (result?.preview?.length) {
                const rows = result.preview.slice(0, 30).map(entry => `
                    <tr>
                        <td>${entry.name}</td>
                        <td>${entry.setCode}</td>
                        <td>${entry.currentPrice}</td>
                        <td>${entry.suggestedPrice}</td>
                    </tr>
                `).join('');
                discrepancyTableBody.innerHTML = rows;
            }
        } catch (error) {
            // errors handled in handleAction
        }
    });
};

const setupPushModalBindings = () => {
    document.querySelectorAll('[data-close-push]').forEach(btn => {
        btn.addEventListener('click', closePushModal);
    });
    pushModal?.addEventListener('click', (event) => {
        if (event.target === pushModal) {
            closePushModal();
        }
    });
    pushTableBody?.addEventListener('click', (event) => {
        const btn = event.target.closest('[data-push-id]');
        if (!btn) return;
        pushInventoryItem(btn, btn.dataset.pushId);
    });
    pushTableBody?.addEventListener('click', (event) => {
        const copyBtn = event.target.closest('.copy-id-btn');
        if (!copyBtn) return;
        const id = copyBtn.dataset.scryfall;
        if (!id) {
            showToast('No Scryfall ID available to copy.', 'error');
            return;
        }
        navigator.clipboard?.writeText(id).then(() => {
            showToast(`Copied ${id} to clipboard.`, 'info');
        }).catch(() => {
            showToast('Failed to copy ID.', 'error');
        });
    });
    pushAllConfirmBtn?.addEventListener('click', () => {
        pushAllInventory();
    });
};

const initializeManapoolPage = () => {
    initEventListeners();
    initBulkForm();
    setupPushModalBindings();
    refreshStatus();
    refreshDiscrepancies();
};

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initializeManapoolPage);
} else {
    initializeManapoolPage();
}

const getPriceOffsetValue = () => {
    const value = parseInt(priceOffsetInput?.value, 10);
    return Number.isFinite(value) && value >= 0 ? value : 1;
};

const showPushProgress = (message = 'Starting push...') => {
    if (!pushProgressContainer || !pushProgressBarFill || !pushProgressText) return;
    pushProgressContainer.removeAttribute('hidden');
    pushProgressBarFill.style.width = '0%';
    pushProgressText.textContent = message;
};

const updatePushProgress = (current, total, message) => {
    if (!pushProgressContainer || !pushProgressBarFill || !pushProgressText) return;
    const percent = total > 0 ? Math.round((current / total) * 100) : 0;
    pushProgressBarFill.style.width = `${Math.min(100, percent)}%`;
    if (message) {
        pushProgressText.textContent = message;
    }
};

const hidePushProgress = () => {
    if (!pushProgressContainer) return;
    pushProgressContainer.setAttribute('hidden', 'hidden');
};
