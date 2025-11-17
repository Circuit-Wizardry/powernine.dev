const statusConnectionEl = document.getElementById('status-connection');
const statusLocalCountEl = document.getElementById('status-local-count');
const statusRemoteCountEl = document.getElementById('status-remote-count');
const statusLastSyncEl = document.getElementById('status-last-sync');
const statusMessageEl = document.getElementById('status-message');
const discrepancyTableBody = document.getElementById('discrepancy-table-body');
const actionLogEl = document.getElementById('action-log');
const toastEl = document.getElementById('toast');
const automationForm = document.getElementById('automation-form');
const automationToggle = document.getElementById('automation-toggle');
const automationStrategySelect = document.getElementById('automation-strategy');
const automationIntervalInput = document.getElementById('automation-interval');
const automationStatusEl = document.getElementById('automation-status');
const automationAdvancedBtn = document.getElementById('automation-advanced-btn');
const automationSaveBtn = document.getElementById('automation-save-btn');
const automationModal = document.getElementById('automation-settings-modal');
const automationAdvancedForm = document.getElementById('automation-advanced-form');
const automationFloorTypeSelect = document.getElementById('automation-floor-type');
const automationFloorValueInput = document.getElementById('automation-floor-value');
const automationDiscordWebhookInput = document.getElementById('automation-discord-webhook');
const automationDropThresholdInput = document.getElementById('automation-drop-threshold');
const automationFloorOverridesInput = document.getElementById('automation-floor-overrides');
const automationExclusionsInput = document.getElementById('automation-exclusions');
const automationDebugBtn = document.getElementById('automation-debug-btn');
const automationDebugModal = document.getElementById('automation-debug-modal');
const automationDebugStatusEl = document.getElementById('automation-debug-status');
const automationDebugTableBody = document.getElementById('automation-debug-table-body');
const unmatchedModal = document.getElementById('unmatched-modal');
const unmatchedListEl = document.getElementById('unmatched-list');
const pushModal = document.getElementById('push-modal');
const pushTableBody = document.getElementById('push-inventory-table-body');
const pushAllConfirmBtn = document.getElementById('push-all-confirm-btn');
const priceOffsetInput = document.getElementById('price-offset');
const pushProgressContainer = document.getElementById('push-progress');
const pushProgressBarFill = document.getElementById('push-progress-bar-fill');
const pushProgressText = document.getElementById('push-progress-text');
const pushProgressStepsList = document.getElementById('push-progress-steps');
let pushModalInventory = [];
let isPushAllRunning = false;
let hasPulledOrdersThisSession = false;
const pushProgressEntries = new Map();

const STRATEGY_CONFIG = {
    manaPoolLowPercent: {
        label: '5% under ManaPool low',
        summary: 'Stay a modest percent under ManaPool low.'
    },
    manaPoolLowCents: {
        label: '25¢ under ManaPool low',
        summary: 'Undercut by a fixed dollar amount.'
    },
    tcgMarketMatch: {
        label: 'Match TCG Market',
        summary: 'Mirror the TCGplayer market price.'
    },
    undercutBest: {
        label: '1c under lowest listing',
        summary: 'Keep the top listing by shaving a single cent.'
    }
};

const DEFAULT_AUTOMATION_STATE = {
    enabled: false,
    intervalMinutes: 30,
    strategy: 'undercutBest',
    floorType: 'percent',
    floorValue: 5,
    discordWebhook: '',
    dropThresholdPercent: 15,
    floorOverrides: [],
    exclusions: [],
    lastRunAt: null,
    nextRunAt: null
};

let automationState = { ...DEFAULT_AUTOMATION_STATE };
let automationSettingsDirty = false;

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

const formatPercentValue = (value) => {
    if (!Number.isFinite(value)) return '0';
    return Number.isInteger(value) ? value.toFixed(0) : value.toFixed(1);
};

const formatCurrencyValue = (value) => {
    if (!Number.isFinite(value)) return '0.00';
    return value.toFixed(2);
};

const formatDebugCurrency = (value) => {
    if (value === null || value === undefined) return '--';
    const number = Number(value);
    if (!Number.isFinite(number)) return '--';
    return `$${number.toFixed(2)}`;
};

const parseListField = (value = '') => value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

const formatListField = (items = []) => (Array.isArray(items) ? items.join('\n') : '');

const normalizeAutomationState = (state = {}) => {
    const normalized = {
        ...DEFAULT_AUTOMATION_STATE,
        ...state
    };
    normalized.enabled = Boolean(normalized.enabled);
    normalized.strategy = STRATEGY_CONFIG[normalized.strategy] ? normalized.strategy : DEFAULT_AUTOMATION_STATE.strategy;
    const interval = Number(normalized.intervalMinutes);
    normalized.intervalMinutes = Number.isFinite(interval) ? Math.max(5, Math.round(interval)) : DEFAULT_AUTOMATION_STATE.intervalMinutes;
    const floorValue = Number(normalized.floorValue);
    normalized.floorValue = Number.isFinite(floorValue) && floorValue >= 0 ? floorValue : DEFAULT_AUTOMATION_STATE.floorValue;
    const dropThreshold = Number(normalized.dropThresholdPercent);
    normalized.dropThresholdPercent = Number.isFinite(dropThreshold)
        ? Math.min(100, Math.max(1, Math.round(dropThreshold)))
        : DEFAULT_AUTOMATION_STATE.dropThresholdPercent;
    normalized.floorType = normalized.floorType === 'absolute' ? 'absolute' : 'percent';
    normalized.discordWebhook = normalized.discordWebhook || '';
    normalized.floorOverrides = Array.isArray(normalized.floorOverrides)
        ? normalized.floorOverrides
        : parseListField(normalized.floorOverrides || '');
    normalized.exclusions = Array.isArray(normalized.exclusions)
        ? normalized.exclusions
        : parseListField(normalized.exclusions || '');
    normalized.lastRunAt = normalized.lastRunAt || null;
    normalized.nextRunAt = normalized.nextRunAt || null;
    return normalized;
};

const applyAutomationStateToForm = () => {
    if (!automationForm) return;
    if (automationToggle) automationToggle.checked = Boolean(automationState.enabled);
};

const applyAutomationStateToAdvancedForm = () => {
    if (!automationAdvancedForm) return;
    if (automationStrategySelect) {
        automationStrategySelect.value = STRATEGY_CONFIG[automationState.strategy] ? automationState.strategy : DEFAULT_AUTOMATION_STATE.strategy;
    }
    if (automationIntervalInput) automationIntervalInput.value = automationState.intervalMinutes;
    if (automationFloorTypeSelect) automationFloorTypeSelect.value = automationState.floorType;
    if (automationFloorValueInput) automationFloorValueInput.value = automationState.floorValue;
    if (automationDiscordWebhookInput) automationDiscordWebhookInput.value = automationState.discordWebhook || '';
    if (automationDropThresholdInput) automationDropThresholdInput.value = automationState.dropThresholdPercent;
    if (automationFloorOverridesInput) automationFloorOverridesInput.value = formatListField(automationState.floorOverrides);
    if (automationExclusionsInput) automationExclusionsInput.value = formatListField(automationState.exclusions);
};

const formatFloorSummary = () => {
    const value = Number(automationState.floorValue);
    if (automationState.floorType === 'absolute') {
        return `Won't drop more than $${formatCurrencyValue(value)} below the starting price.`;
    }
    return `Won't drop more than ${formatPercentValue(value)}% below the starting price.`;
};

const updateAutomationStatus = () => {
    if (!automationStatusEl) return;
    if (automationSettingsDirty) {
        automationStatusEl.textContent = 'Unsaved automation changes. Save to apply.';
        return;
    }
    if (!automationState.enabled) {
        automationStatusEl.textContent = 'Automation is currently off.';
        return;
    }
    const strategyLabel = STRATEGY_CONFIG[automationState.strategy]?.label || 'custom strategy';
    const exclusionsNote = automationState.exclusions.length
        ? ` ${automationState.exclusions.length} cards excluded.`
        : '';
    const nextRunNote = automationState.nextRunAt
        ? ` Next run around ${new Date(automationState.nextRunAt).toLocaleTimeString()}.`
        : '';
    automationStatusEl.textContent = `Runs every ${automationState.intervalMinutes} minutes using "${strategyLabel}". ${formatFloorSummary()}${exclusionsNote}${nextRunNote}`;
};

const renderAutomationDebugTable = (entries = []) => {
    if (!automationDebugTableBody) return;
    if (!Array.isArray(entries) || !entries.length) {
        automationDebugTableBody.innerHTML = '<tr><td colspan="5" class="empty">No automation data to display.</td></tr>';
        return;
    }
    automationDebugTableBody.innerHTML = entries.map((entry) => {
        const meta = [
            entry.setCode || '',
            entry.collectorNumber || '',
            `${entry.foilType || 'normal'}/${entry.condition || 'NM'}`
        ].filter(Boolean).join(' ');
        const baselineText = entry.baselinePrice !== null && entry.baselinePrice !== undefined
            ? `<div class="muted">Baseline ${formatDebugCurrency(entry.baselinePrice)}</div>`
            : '';
        const actionLabel = entry.action || 'hold';
        const reasonText = entry.reason ? `<div class="muted">${escapeHtml(entry.reason)}</div>` : '';
        const sellerText = entry.competitorSeller
            ? `${escapeHtml(entry.competitorSeller)}${entry.competitorIsSelf ? ' (you)' : ''}`
            : '--';
        const competitorPriceText = entry.competitorPrice !== null && entry.competitorPrice !== undefined
            ? formatDebugCurrency(entry.competitorPrice)
            : '--';
        return `
            <tr>
                <td>
                    <strong>${escapeHtml(entry.name || 'Unknown')}</strong>
                    ${meta ? `<div class="muted">${escapeHtml(meta)}</div>` : ''}
                </td>
                <td>${formatDebugCurrency(entry.ourPrice)}${baselineText}</td>
                <td>${competitorPriceText}</td>
                <td>${sellerText}</td>
                <td>${escapeHtml(actionLabel)}${reasonText}</td>
            </tr>
        `;
    }).join('');
};

const loadAutomationDebugData = async () => {
    if (!automationDebugStatusEl || !automationDebugTableBody) return;
    automationDebugStatusEl.textContent = 'Loading automation snapshot...';
    automationDebugTableBody.innerHTML = '<tr><td colspan="5" class="empty">Loading...</td></tr>';
    try {
        const response = await fetch('/api/manapool/prices/automation/debug');
        if (!response.ok) {
            let message = response.statusText || 'Failed to load automation debug data.';
            try {
                const errorData = await response.json();
                message = errorData?.error || message;
            } catch (_) {
                // ignore parsing error
            }
            throw new Error(message);
        }
        const data = await response.json();
        const entries = Array.isArray(data.entries) ? data.entries : [];
        renderAutomationDebugTable(entries);
        automationDebugStatusEl.textContent = data?.inspected
            ? `Showing ${entries.length} of ${data.inspected} inspected listings.`
            : `Showing ${entries.length} listings.`;
    } catch (error) {
        automationDebugStatusEl.textContent = error.message || 'Failed to load automation debug data.';
        automationDebugTableBody.innerHTML = '<tr><td colspan="5" class="empty">Unable to load automation debug data.</td></tr>';
    }
};

const openAutomationDebugModal = () => {
    if (!automationDebugModal) return;
    automationDebugModal.removeAttribute('hidden');
    loadAutomationDebugData();
};

const closeAutomationDebugModal = () => {
    automationDebugModal?.setAttribute('hidden', 'hidden');
};

const markAutomationSettingsDirty = () => {
    automationSettingsDirty = true;
    updateAutomationStatus();
};

const closeAutomationModal = () => {
    automationModal?.setAttribute('hidden', 'hidden');
};

const openAutomationModal = () => {
    applyAutomationStateToAdvancedForm();
    automationModal?.removeAttribute('hidden');
};

const loadAutomationSettings = async () => {
    try {
        const response = await fetchJson('/api/manapool/prices/automation');
        automationState = normalizeAutomationState(response?.settings || response || {});
    } catch (error) {
        showToast(error.message || 'Unable to load automation settings. Using defaults.', 'error');
        automationState = { ...DEFAULT_AUTOMATION_STATE };
    } finally {
        automationSettingsDirty = false;
        applyAutomationStateToForm();
        applyAutomationStateToAdvancedForm();
        updateAutomationStatus();
    }
};

const persistAutomationSettings = async (overrides = {}, button = null, successMessage = 'Automation settings updated.') => {
    const payload = normalizeAutomationState({
        ...automationState,
        ...overrides
    });
    try {
        const result = await handleAction(button, '/api/manapool/prices/automation', {
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                enabled: payload.enabled,
                intervalMinutes: payload.intervalMinutes,
                strategy: payload.strategy,
                floorType: payload.floorType,
                floorValue: payload.floorValue,
                discordWebhook: payload.discordWebhook,
                dropThresholdPercent: payload.dropThresholdPercent,
                floorOverrides: payload.floorOverrides,
                exclusions: payload.exclusions
            })
        }, successMessage);
        automationState = normalizeAutomationState(result?.settings || payload);
        automationSettingsDirty = false;
        applyAutomationStateToForm();
        applyAutomationStateToAdvancedForm();
        updateAutomationStatus();
        return automationState;
    } catch (error) {
        automationSettingsDirty = true;
        updateAutomationStatus();
        throw error;
    }
};

const summarizeApiResult = (result, fallback) => {
    if (!result || typeof result !== 'object') return fallback;
    const parts = [];
    if (result.message) parts.push(result.message);
    if (typeof result.updated === 'number') parts.push(`Updated: ${result.updated}`);
    if (typeof result.deleted === 'number' && result.deleted > 0) parts.push(`Deleted: ${result.deleted}`);
    if (Array.isArray(result.invalidIds) && result.invalidIds.length) {
        parts.push(`Invalid IDs: ${result.invalidIds.length}`);
    }
    if (Array.isArray(result.skipped) && result.skipped.length) {
        parts.push(`Skipped: ${result.skipped.length}`);
    }
    if (!parts.length) {
        try {
            return JSON.stringify(result);
        } catch {
            return fallback;
        }
    }
    return parts.join(' | ');
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
    discrepancyTableBody.innerHTML = '<tr><td colspan="7" class="empty">Checking for discrepancies...</td></tr>';
};

const renderDiscrepancies = (rows) => {
    if (!discrepancyTableBody) return;
    if (!rows || rows.length === 0) {
        discrepancyTableBody.innerHTML = '<tr><td colspan="7" class="empty">No discrepancies detected.</td></tr>';
        return;
    }
    const sortedRows = [...rows].sort((a, b) => {
        const aFlag = a.isNew || a.remoteOnly ? 1 : 0;
        const bFlag = b.isNew || b.remoteOnly ? 1 : 0;
        return bFlag - aFlag;
    });
    discrepancyTableBody.innerHTML = sortedRows.map((row) => {
        const printingLabel = [row.setCode?.toUpperCase(), row.collectorNumber ? `#${row.collectorNumber}` : null]
            .filter(Boolean)
            .join(' ');
        const finishLabel = [
            row.foilType && row.foilType !== 'normal' ? row.foilType : 'Nonfoil',
            row.condition || 'NM'
        ].filter(Boolean).join(' · ');
        const rowClasses = [];
        if (row.isNew || row.remoteOnly) rowClasses.push('discrepancy-new');
        if (row.remoteOnly) rowClasses.push('remote-only');
        return `
        <tr class="${rowClasses.join(' ')}">
            <td>
                <div class="printing-meta">
                    <strong>${escapeHtml(row.name || 'Unknown')}</strong>
                    ${(row.isNew || row.remoteOnly) ? `<small>${row.remoteOnly ? 'Only on ManaPool' : 'Local only'}</small>` : ''}
                </div>
            </td>
            <td>
                <div class="printing-meta">
                    <span>${escapeHtml(printingLabel || 'N/A')}</span>
                </div>
            </td>
            <td><span class="finish-chip">${escapeHtml(finishLabel || 'NM')}</span></td>
            <td>${row.localQuantity}</td>
            <td>${row.remoteQuantity}</td>
            <td>${row.localPrice ?? '--'}</td>
            <td>${row.remotePrice ?? '--'}</td>
        </tr>
    `;
    }).join('');
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
        pushTableBody.innerHTML = '<tr><td colspan="7" class="empty">No inventory items with quantity greater than zero.</td></tr>';
        return;
    }
    const offset = getPriceOffsetValue();
    const targetDescriptor = offset > 0
        ? `${offset}c under ManaPool low`
        : 'Match ManaPool low';
    pushTableBody.innerHTML = rows.map(item => {
        const localMarket = Number(item.tcgMarketPrice ?? item.pricePaid ?? 0);
        const marketLabel = localMarket > 0 ? `$${localMarket.toFixed(2)}` : 'Unknown';
        const setLabel = [item.setCode?.toUpperCase(), item.collectorNumber].filter(Boolean).join(' #');
        const scryfallId = item.scryfallId || '';
        const tcgplayerId = item.tcgplayerId || item.tcgPlayerId || '';
        const identifiers = [];
        if (scryfallId) {
            identifiers.push(`
                <div class="id-row">
                    <span>Scryfall</span>
                    <code>${escapeHtml(scryfallId)}</code>
                    <button type="button" class="ghost-btn copy-id-btn" data-copy-value="${escapeHtml(scryfallId)}" data-copy-label="Scryfall ID">Copy</button>
                </div>
            `);
        }
        if (tcgplayerId) {
            identifiers.push(`
                <div class="id-row">
                    <span>TCGplayer</span>
                    <code>${escapeHtml(tcgplayerId)}</code>
                    <button type="button" class="ghost-btn copy-id-btn" data-copy-value="${escapeHtml(tcgplayerId)}" data-copy-label="TCGplayer ID">Copy</button>
                </div>
            `);
        }
        const identifierCell = identifiers.length ? identifiers.join('') : '<span class="muted">No identifiers</span>';
        return `
            <tr>
                <td>${escapeHtml(item.name || 'Unknown')}</td>
                <td>${escapeHtml(setLabel || 'N/A')}</td>
                <td>${item.quantity}</td>
                <td>
                    <div class="price-meta">
                        <strong>${marketLabel}</strong>
                        <small>TCG Market</small>
                    </div>
                </td>
                <td>
                    <div class="price-meta">
                        <strong>${escapeHtml(targetDescriptor)}</strong>
                        <small>Target price</small>
                    </div>
                </td>
                <td class="scryfall-id-cell">
                    ${identifierCell}
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
    pushTableBody.innerHTML = '<tr><td colspan="7" class="empty">Loading inventory...</td></tr>';
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
        pushTableBody.innerHTML = '<tr><td colspan="7" class="empty">Failed to load inventory.</td></tr>';
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
    const variantStepId = addPushProgressStep('variant-feed', 'Downloading latest prices...', 'Contacting ManaPool...', 'running');
    let variantStepCompleted = false;
    try {
        for (let i = 0; i < total; i += 1) {
            const item = pushModalInventory[i];
            updatePushProgress(i, total, `Pushing ${item.name} (${i + 1}/${total})...`);
            const stepId = addPushProgressStep(item.id || `item-${i}`, item.name, 'Queued...', 'pending') || `item-${i}`;
            updatePushProgressStep(stepId, 'Sending to ManaPool...', 'running');
            const pushed = await pushInventoryItemRequest({
                inventoryId: item.id,
                scryfallId: item.scryfallId || 'unknown',
                offsetCents: offset,
                refresh: false
            });
            if (!variantStepCompleted && variantStepId) {
                updatePushProgressStep(variantStepId, 'Latest prices downloaded', 'success');
                variantStepCompleted = true;
            }
            if (pushed) {
                successCount += 1;
                updatePushProgressStep(stepId, 'Pushed successfully', 'success');
            } else {
                updatePushProgressStep(stepId, 'Skipped or failed to push', 'skipped');
            }
            updatePushProgress(i + 1, total, `Processed ${i + 1} of ${total}`);
        }
        updatePushProgress(total, total, 'Cleaning up remote discrepancies...');
        await cleanupRemoteInventoryClient();
        addPushProgressStep(`cleanup-${Date.now()}`, 'Cleanup', 'Removed remote discrepancies', 'success');
        showToast(`Pushed ${successCount} of ${total} cards.`, 'info');
    } catch (error) {
        showToast(error.message || 'Bulk push failed.', 'error');
        appendLog(error.message || 'Bulk push failed.', 'error');
        addPushProgressStep(`error-${Date.now()}`, 'Bulk push', error.message || 'Bulk push failed.', 'error');
        if (!variantStepCompleted && variantStepId) {
            updatePushProgressStep(variantStepId, error.message || 'Failed to download prices.', 'error');
            variantStepCompleted = true;
        }
    } finally {
        hidePushProgress();
        setLoading(pushAllConfirmBtn, false);
        isPushAllRunning = false;
        await Promise.all([refreshStatus(), refreshDiscrepancies()]);
        await loadPushModalInventory();
    }
};

const initAutomationForm = () => {
    if (automationForm) {
        automationToggle?.addEventListener('change', markAutomationSettingsDirty);
        automationForm.addEventListener('submit', async (event) => {
            event.preventDefault();
            const overrides = {
                enabled: Boolean(automationToggle?.checked)
            };
            try {
                await persistAutomationSettings(overrides, automationSaveBtn, overrides.enabled ? 'Automatic pricing scheduled.' : 'Automatic pricing disabled.');
            } catch (error) {
                // persistAutomationSettings already surfaced the toast/log
            }
        });
    }
    automationAdvancedForm?.addEventListener('input', markAutomationSettingsDirty);
    automationAdvancedForm?.addEventListener('change', markAutomationSettingsDirty);
    automationAdvancedBtn?.addEventListener('click', () => {
        openAutomationModal();
    });
    document.querySelectorAll('[data-close-automation]').forEach((btn) => {
        btn.addEventListener('click', closeAutomationModal);
    });
    automationModal?.addEventListener('click', (event) => {
        if (event.target === automationModal) {
            closeAutomationModal();
        }
    });
    automationAdvancedForm?.addEventListener('submit', async (event) => {
        event.preventDefault();
        const submitter = event.submitter || automationAdvancedForm.querySelector('[type="submit"]');
        const interval = Number(automationIntervalInput?.value);
        if (!Number.isFinite(interval) || interval < 5) {
            showToast('Interval must be at least 5 minutes.', 'error');
            return;
        }
        const strategyValue = automationStrategySelect?.value;
        const strategy = STRATEGY_CONFIG[strategyValue] ? strategyValue : DEFAULT_AUTOMATION_STATE.strategy;
        const floorValue = Number(automationFloorValueInput?.value);
        if (!Number.isFinite(floorValue) || floorValue < 0) {
            showToast('Minimum value has to be zero or higher.', 'error');
            return;
        }
        const dropPercent = Number(automationDropThresholdInput?.value);
        if (!Number.isFinite(dropPercent) || dropPercent < 1) {
            showToast('Drop threshold needs to be at least 1%.', 'error');
            return;
        }
        const overrides = {
            intervalMinutes: Math.round(interval),
            strategy,
            floorType: automationFloorTypeSelect?.value === 'absolute' ? 'absolute' : 'percent',
            floorValue,
            discordWebhook: automationDiscordWebhookInput?.value?.trim() || '',
            dropThresholdPercent: dropPercent,
            floorOverrides: parseListField(automationFloorOverridesInput?.value),
            exclusions: parseListField(automationExclusionsInput?.value)
        };
        try {
            await persistAutomationSettings(overrides, submitter, 'Advanced automation settings saved.');
            closeAutomationModal();
        } catch (error) {
            // toast already shown
        }
    });
    loadAutomationSettings();

    automationDebugBtn?.addEventListener('click', () => {
        openAutomationDebugModal();
    });
    document.querySelectorAll('[data-close-automation-debug]').forEach((btn) => {
        btn.addEventListener('click', closeAutomationDebugModal);
    });
    automationDebugModal?.addEventListener('click', (event) => {
        if (event.target === automationDebugModal) {
            closeAutomationDebugModal();
        }
    });
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
            const summaryParts = [
                `Imported ${result.imported ?? 0} orders`,
                `skipped ${result.skipped?.length ?? 0}`
            ];
            if (result.shipmentUpdates) {
                summaryParts.push(`${result.shipmentUpdates} shipment updates`);
            }
            if (result.errors?.length) {
                summaryParts.push(`${result.errors.length} errors`);
            }
            const summary = `${summaryParts.join(', ')}.`;
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
        const copyBtn = event.target.closest('[data-copy-value]');
        if (!copyBtn) return;
        const value = copyBtn.dataset.copyValue;
        if (!value) {
            showToast('Nothing to copy for this card.', 'error');
            return;
        }
        navigator.clipboard?.writeText(value).then(() => {
            const label = copyBtn.dataset.copyLabel || 'value';
            showToast(`Copied ${label}.`, 'info');
        }).catch(() => {
            showToast('Failed to copy value.', 'error');
        });
    });
    pushAllConfirmBtn?.addEventListener('click', () => {
        pushAllInventory();
    });
    priceOffsetInput?.addEventListener('input', () => {
        if (!pushModalInventory.length) return;
        renderPushInventoryRows(pushModalInventory);
    });
};

const initializeManapoolPage = () => {
    initEventListeners();
    initAutomationForm();
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
    resetPushProgressSteps();
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

const resetPushProgressSteps = () => {
    pushProgressEntries.clear();
    if (pushProgressStepsList) {
        pushProgressStepsList.innerHTML = '';
    }
};

const addPushProgressStep = (id, title, detail, status = 'pending') => {
    if (!pushProgressStepsList || !title) return null;
    const entryId = id || `step-${Date.now()}-${Math.random()}`;
    const li = document.createElement('li');
    li.dataset.status = status;
    li.innerHTML = `
        <div>
            <div class="step-title">${escapeHtml(title)}</div>
            ${detail ? `<div class="step-detail">${escapeHtml(detail)}</div>` : ''}
        </div>
    `;
    pushProgressStepsList.prepend(li);
    const items = pushProgressStepsList.querySelectorAll('li');
    if (items.length > 10) {
        items[items.length - 1].remove();
    }
    pushProgressEntries.set(entryId, li);
    return entryId;
};

const updatePushProgressStep = (id, detail, status) => {
    const li = pushProgressEntries.get(id);
    if (!li) return;
    if (status) {
        li.dataset.status = status;
    }
    if (detail) {
        const detailEl = li.querySelector('.step-detail');
        if (detailEl) {
            detailEl.textContent = detail;
        } else {
            const div = document.createElement('div');
            div.className = 'step-detail';
            div.textContent = detail;
            const titleEl = li.querySelector('.step-title');
            if (titleEl) {
                titleEl.after(div);
            } else {
                li.prepend(div);
            }
        }
    }
};
