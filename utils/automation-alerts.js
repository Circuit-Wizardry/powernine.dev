import { sendManaPoolWebhook } from '../discord.js';

const AUTOMATION_PING_USER_ID = process.env.DISCORD_AUTOMATION_USER_ID
    || process.env.DISCORD_OWNER_ID
    || process.env.DISCORD_USER_ID
    || '';

const AUTOMATION_STRATEGY_LABELS = {
    undercutBest: '1¢ under lowest listing',
    manaPoolLowPercent: '5% under ManaPool low',
    manaPoolLowCents: '$0.25 under ManaPool low',
    tcgMarketMatch: 'Match TCG Market'
};

const automationStrategyLabel = (key) => AUTOMATION_STRATEGY_LABELS[key] || key || 'custom';

const formatAutomationFloorSetting = (settings = {}) => {
    const value = Number(settings.floorValue);
    if (settings.floorType === 'absolute') {
        return Number.isFinite(value)
            ? `$${value.toFixed(2)} absolute floor`
            : '$0.00 absolute floor';
    }
    if (!Number.isFinite(value)) {
        return '0% floor';
    }
    const formatted = Number.isInteger(value) ? value.toFixed(0) : value.toFixed(1);
    return `${formatted}% floor`;
};

const formatAutomationFloorAnchor = (context = {}) => {
    if (!context || typeof context !== 'object') return null;
    if (Array.isArray(context.floorSummary) && context.floorSummary.length) {
        return context.floorSummary
            .map((entry) => `• ${entry.name || 'Unknown'}: $${entry.floor || '?'}`)
            .slice(0, 5)
            .join('\n');
    }
    if (Array.isArray(context.anchors) && context.anchors.length) {
        return context.anchors
            .map((entry) => `• ${entry.name || 'Unknown'}: ${entry.value || 'n/a'}`)
            .slice(0, 5)
            .join('\n');
    }
    if (context.baselineCount != null) {
        return `${context.baselineCount} cards snapped.`;
    }
    return null;
};

export const sendAutomationLifecycleWebhook = async (event, settings = {}, context = {}) => {
    if (!AUTOMATION_PING_USER_ID && !process.env.MANAPOOL_WEBHOOK_URL) {
        return;
    }
    const mention = AUTOMATION_PING_USER_ID ? `<@${AUTOMATION_PING_USER_ID}> ` : '';
    const baseFields = [
        { name: 'Strategy', value: automationStrategyLabel(settings.strategy), inline: true },
        { name: 'Floor', value: formatAutomationFloorSetting(settings), inline: true },
        { name: 'Interval', value: `${settings.intervalMinutes || 0} min`, inline: true }
    ];
    if (Number(settings.dropThresholdPercent) > 0) {
        baseFields.push({
            name: 'Drop alerts',
            value: `${settings.dropThresholdPercent}%`,
            inline: true
        });
    }
    const timestamp = new Date().toISOString();
    let title = 'ManaPool automation update';
    let description = '';
    let color = 0x5865f2;
    if (event === 'enabled') {
        title = 'ManaPool automation enabled';
        description = context?.baselineCount != null
            ? `Baseline cache primed for ${context.baselineCount} cards.`
            : 'Baseline cache initialized.';
        color = 0x2ecc71;
    } else if (event === 'disabled') {
        title = 'ManaPool automation disabled';
        description = context?.reason || 'Automatic repricing paused.';
        color = 0xe74c3c;
    }
    const floorAnchorSummary = formatAutomationFloorAnchor(context);
    if (floorAnchorSummary) {
        baseFields.push({
            name: 'Floor snapshot',
            value: floorAnchorSummary.slice(0, 1000)
        });
    }
    const summaryBase = event === 'enabled'
        ? 'Automation started and finished initialization'
        : (event === 'disabled' ? 'Automation stopped' : 'Automation status updated');
    const summary = context?.reason ? `${summaryBase}: ${context.reason}` : `${summaryBase}.`;
    try {
        await sendManaPoolWebhook({
            content: `${mention}${summary}`,
            embeds: [{
                title,
                description,
                color,
                timestamp,
                fields: baseFields
            }]
        });
    } catch (error) {
        console.error('[automation] Failed to send lifecycle webhook:', error.message || error);
    }
};
