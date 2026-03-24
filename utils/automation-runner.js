import {
    getAutomationSettings,
    saveAutomationSettings,
    pushInventoryToManaPool,
    getLocalInventoryRows,
    fetchVariantFloorsForInventory,
    getAutomationBaselines,
    snapshotAutomationBaselines,
    syncOrdersBeforePricing,
    getInventoryLockState,
    restockBelowMaxQuantity
} from './manapool-service.js';
import { notifyLifecycle, notifyRun } from './discord-notify.js';

const MINUTE_MS = 60 * 1000;
const MIN_INTERVAL_MINUTES = 5;
const IMMEDIATE_DELAY_MS = 10 * 1000;

const STRATEGY_MODES = {
    undercutBest: { type: 'undercutBest', value: 1 },
    manaPoolLowPercent: { type: 'manaPoolLowPercent', value: 5 },
    manaPoolLowCents: { type: 'manaPoolLowCents', value: 0.25 },
    tcgMarketMatch: { type: 'tcgMarketMatch' }
};

let automationDb = null;
let automationTimer = null;
let currentSettings = null;
let isAutomationRunning = false;
let pendingSettings = null;
let hasPrimedBaselinesThisSession = false;

const broadcastAutomationStatus = () => {};

const minutesToMs = (value) => {
    const minutes = Number(value);
    return Math.max(MIN_INTERVAL_MINUTES, Number.isFinite(minutes) ? minutes : MIN_INTERVAL_MINUTES) * MINUTE_MS;
};

const clearAutomationTimer = () => {
    if (automationTimer) {
        clearTimeout(automationTimer);
        automationTimer = null;
    }
};

const updateNextRunTimestamp = async (isoString) => {
    if (!automationDb) return;
    try {
        await saveAutomationSettings({ nextRunAt: isoString || null }, automationDb);
    } catch (error) {
        console.error('[automation] Failed updating next run timestamp:', error.message || error);
    }
};

const scheduleNextRun = (immediate = false) => {
    clearAutomationTimer();
    if (!automationDb || !currentSettings?.enabled) {
        updateNextRunTimestamp(null);
        broadcastAutomationStatus();
        return;
    }
    const delay = immediate ? IMMEDIATE_DELAY_MS : minutesToMs(currentSettings.intervalMinutes);
    const nextRunAt = new Date(Date.now() + delay).toISOString();
    currentSettings.nextRunAt = nextRunAt;
    updateNextRunTimestamp(nextRunAt);
    broadcastAutomationStatus();
    automationTimer = setTimeout(runAutomationCycle, delay);
};

const primeAutomationFloorCache = async (reason = 'startup') => {
    if (!automationDb || !currentSettings?.enabled) return;
    if (hasPrimedBaselinesThisSession) return;
    try {
        const snapshotCount = await snapshotAutomationBaselines(automationDb);
        hasPrimedBaselinesThisSession = true;
        console.log(`[automation] Primed floor cache (${reason}): ${snapshotCount} entries.`);
    } catch (error) {
        hasPrimedBaselinesThisSession = false;
        console.warn(`[automation] Failed to prime automation floor cache (${reason}):`, error.message || error);
    }
};

const runAutomationCycle = async () => {
    if (isAutomationRunning || !automationDb || !currentSettings?.enabled) {
        scheduleNextRun(false);
        return;
    }
    isAutomationRunning = true;
    broadcastAutomationStatus();
    try {
        const startedAtMs = Date.now();
        const startedAt = new Date(startedAtMs).toISOString();
        currentSettings.lastRunAt = startedAt;
        await saveAutomationSettings({ lastRunAt: startedAt }, automationDb);
        try {
            const syncResult = await syncOrdersBeforePricing(automationDb);
            if (syncResult?.imported) {
                console.log(`[automation] Imported ${syncResult.imported} ManaPool orders before pricing.`);
            }
            if (syncResult?.shipmentUpdates) {
                console.log(`[automation] Updated shipment status for ${syncResult.shipmentUpdates} orders.`);
            }
        } catch (syncError) {
            console.warn('[automation] Unable to synchronize ManaPool orders before pricing:', syncError.message || syncError);
        }
        const automationPayload = await buildAutomationPayload(currentSettings, { concurrency: 5 });
        const result = await pushInventoryToManaPool(automationDb, {
            priceOffsetCents: 1,
            deleteMissing: false,
            notifyAutomation: true,
            automation: automationPayload
        });
        if (result?.automationSummary) {
            notifyRun({
                ...result.automationSummary,
                runAt: startedAt,
                durationMs: Date.now() - startedAtMs
            }).catch(() => {});
        }
        // Restock cards that dropped below max quantity threshold
        try {
            const restockResult = await restockBelowMaxQuantity(automationDb);
            if (restockResult?.restocked > 0) {
                console.log(`[automation] Restocked ${restockResult.restocked} cards back to max quantity.`);
            }
        } catch (restockError) {
            console.warn('[automation] Restock check failed:', restockError.message || restockError);
        }
    } catch (error) {
        console.error('[automation] ManaPool automation run failed:', error);
    } finally {
        isAutomationRunning = false;
        broadcastAutomationStatus();
        scheduleNextRun(false);
    }
};

const applySettings = (settings) => {
    currentSettings = settings ? { ...settings } : null;
};

export const getAutomationRuntimeState = () => ({
    enabled: Boolean(currentSettings?.enabled),
    isRunning: Boolean(isAutomationRunning),
    lastRunAt: currentSettings?.lastRunAt || null,
    nextRunAt: currentSettings?.nextRunAt || null,
    strategy: currentSettings?.strategy || '',
    intervalMinutes: currentSettings?.intervalMinutes ?? null,
    floorType: currentSettings?.floorType || '',
    floorValue: currentSettings?.floorValue ?? null,
    dropThresholdPercent: currentSettings?.dropThresholdPercent ?? null,
    exclusionsCount: Array.isArray(currentSettings?.exclusions)
        ? currentSettings.exclusions.length
        : (typeof currentSettings?.exclusions === 'string' && currentSettings.exclusions.trim() ? currentSettings.exclusions.split(/\r?\n/).filter(Boolean).length : 0),
    overridesCount: Array.isArray(currentSettings?.floorOverrides)
        ? currentSettings.floorOverrides.length
        : (typeof currentSettings?.floorOverrides === 'string' && currentSettings.floorOverrides.trim() ? currentSettings.floorOverrides.split(/\r?\n/).filter(Boolean).length : 0)
});

export async function initAutomationScheduler(db) {
    automationDb = db;
    if (!automationDb) return;
    if (pendingSettings) {
        const { settings, immediate } = pendingSettings;
        pendingSettings = null;
        applySettings(settings);
        await primeAutomationFloorCache('pending-settings');
        scheduleNextRun(immediate);
        broadcastAutomationStatus();
        return;
    }
    try {
        let settings = await getAutomationSettings(automationDb);
        if (settings?.enabled) {
            settings = await saveAutomationSettings({ enabled: false, nextRunAt: null }, automationDb);
            notifyLifecycle('disabled', settings, { reason: 'Server restarted; automation paused until you re-enable it.' }).catch(() => {});
        }
        applySettings(settings);
        if (settings?.enabled) {
            await primeAutomationFloorCache('startup');
        } else {
            hasPrimedBaselinesThisSession = false;
        }
        scheduleNextRun(false);
        broadcastAutomationStatus();
    } catch (error) {
        console.error('[automation] Unable to initialize scheduler:', error);
    }
}

export function updateAutomationScheduler(settings, { immediate } = {}) {
    if (!automationDb) {
        pendingSettings = { settings, immediate };
        return;
    }
    const wasEnabled = Boolean(currentSettings?.enabled);
    applySettings(settings);
    const shouldImmediate = typeof immediate === 'boolean'
        ? immediate
        : (!wasEnabled && Boolean(settings?.enabled));
    scheduleNextRun(shouldImmediate);
}

const normalizeStrategy = (strategy) => {
    if (strategy && STRATEGY_MODES[strategy]) {
        return { ...STRATEGY_MODES[strategy] };
    }
    return { ...STRATEGY_MODES.undercutBest };
};

const normalizeGlobalFloor = (settings = {}) => {
    const type = settings.floorType === 'absolute' ? 'absolute' : 'percent';
    const value = Number(settings.floorValue);
    if (!Number.isFinite(value) || value < 0) return null;
    return { type, value };
};

const coerceStringList = (value) => {
    if (Array.isArray(value)) return value;
    if (typeof value === 'string') {
        return value
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter(Boolean);
    }
    return [];
};

const parseFloorOverrides = (lines = []) => {
    const map = new Map();
    const normalizedLines = coerceStringList(lines);
    normalizedLines.forEach((line) => {
        if (!line) return;
        const parts = line.split('|').map((part) => part.trim()).filter(Boolean);
        if (parts.length < 2) return;
        const name = parts[0].toLowerCase();
        let setCode = '';
        let valueToken;
        if (parts.length === 2) {
            valueToken = parts[1];
        } else {
            setCode = parts[1].toLowerCase();
            valueToken = parts[2];
        }
        if (!valueToken) return;
        let type = 'absolute';
        let parsedValue;
        if (valueToken.endsWith('%')) {
            type = 'percent';
            parsedValue = parseFloat(valueToken.slice(0, -1));
        } else {
            parsedValue = parseFloat(valueToken.replace(/^\$/, ''));
        }
        if (!Number.isFinite(parsedValue)) return;
        map.set(`${name}|${setCode}`, { type, value: parsedValue });
    });
    return map;
};

const buildExclusionMatcher = (entries = []) => {
    const combos = new Set();
    const names = new Set();
    const setCodes = new Set();
    const ids = new Set();
    const tcgIds = new Set();
    coerceStringList(entries).forEach((entry) => {
        const trimmed = (entry || '').trim();
        if (!trimmed) return;
        const lower = trimmed.toLowerCase();
        if (lower.includes('|')) {
            const [name, setCode] = lower.split('|').map(part => part.trim());
            if (name) combos.add(`${name}|${setCode || ''}`);
            return;
        }
        if (/^[0-9]+$/.test(lower)) {
            tcgIds.add(lower);
            return;
        }
        if (/^[a-z0-9]{2,6}$/.test(lower)) {
            setCodes.add(lower);
            return;
        }
        ids.add(lower);
        names.add(lower);
    });
    return (item = {}) => {
        const name = (item.name || '').toLowerCase();
        const setCode = (item.setCode || '').toLowerCase();
        const tcgId = String(item.tcgplayerId || '').toLowerCase();
        const inventoryId = (item.id || '').toLowerCase();
        const comboKey = `${name}|${setCode}`;
        return combos.has(comboKey)
            || names.has(name)
            || setCodes.has(setCode)
            || ids.has(inventoryId)
            || (tcgId && tcgIds.has(tcgId));
    };
};

export const buildAutomationPayload = async (settings = {}, options = {}) => {
    if (!automationDb) return null;
    const concurrency = options?.concurrency;
    const floorOverrideEntries = coerceStringList(settings.floorOverrides);
    const exclusionEntries = coerceStringList(settings.exclusions);
    try {
        const [inventoryRows, baselineMap] = await Promise.all([
            getLocalInventoryRows(automationDb),
            getAutomationBaselines(automationDb)
        ]);
        const activeRows = inventoryRows.filter(row => Number(row.quantity) > 0);
        const variantPriceMap = await fetchVariantFloorsForInventory(activeRows, { concurrency });
        return {
            strategy: normalizeStrategy(settings.strategy),
            variantPriceMap,
            floorRules: {
                global: normalizeGlobalFloor(settings),
                overrides: parseFloorOverrides(floorOverrideEntries)
            },
            exclusionMatcher: buildExclusionMatcher(exclusionEntries),
            dropThresholdPercent: Number(settings.dropThresholdPercent) || 0,
            baselineMap
        };
    } catch (error) {
        console.error('[automation] Failed to prepare automation payload:', error);
        let baselineMap = new Map();
        try {
            baselineMap = await getAutomationBaselines(automationDb);
        } catch {
            baselineMap = new Map();
        }
        return {
            strategy: normalizeStrategy(settings.strategy),
            variantPriceMap: new Map(),
            floorRules: {
                global: normalizeGlobalFloor(settings),
                overrides: parseFloorOverrides(floorOverrideEntries)
            },
            exclusionMatcher: buildExclusionMatcher(exclusionEntries),
            dropThresholdPercent: Number(settings.dropThresholdPercent) || 0,
            baselineMap
        };
    }
};

export async function applyAutomationSettingsUpdate(update = {}, options = {}) {
    const db = options.db || automationDb;
    if (!db) {
        throw new Error('Automation database not ready.');
    }
    const previous = await getAutomationSettings(db);
    const previousEnabled = Boolean(previous?.enabled);
    const effectivePayload = { ...update };
    const requestedEnabled = Boolean(effectivePayload.enabled);
    if (previousEnabled && requestedEnabled) {
        effectivePayload.enabled = false;
    }
    const settings = await saveAutomationSettings(effectivePayload, db);
    let baselineCount = null;
    if (!previousEnabled && settings.enabled) {
        baselineCount = await snapshotAutomationBaselines(db);
    }
    updateAutomationScheduler(settings, { immediate: !previousEnabled && settings.enabled });
    broadcastAutomationStatus();
    if (!previousEnabled && settings.enabled) {
        notifyLifecycle('enabled', settings, { baselineCount }).catch(() => {});
    } else if (previousEnabled && !settings.enabled) {
        notifyLifecycle('disabled', settings, { reason: options.reason }).catch(() => {});
    } else if (previousEnabled && settings.enabled === false) {
        notifyLifecycle('disabled', settings, { reason: options.reason || 'Automation reset.' }).catch(() => {});
    }
    return { settings, previous, baselineCount };
}

export async function setAutomationEnabled(enabled, options = {}) {
    const result = await applyAutomationSettingsUpdate({ enabled }, options);
    return result.settings;
}

export async function triggerAutomationRun() {
    if (!automationDb) throw new Error('Automation scheduler not ready.');
    if (!currentSettings?.enabled) throw new Error('Automation is disabled.');
    if (isAutomationRunning) throw new Error('Automation already running.');
    await runAutomationCycle();
    return getAutomationRuntimeState();
}
