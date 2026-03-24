const WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL || null;

const STRATEGY_LABELS = {
    undercutBest: '1¢ under lowest listing',
    manaPoolLowPercent: '5% under ManaPool low',
    manaPoolLowCents: '$0.25 under ManaPool low',
    tcgMarketMatch: 'Match TCG Market'
};

const post = (payload) => {
    if (!WEBHOOK_URL) return Promise.resolve();
    return fetch(WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    }).catch((err) => console.warn('[discord] Webhook post failed:', err.message));
};

const formatDelta = (cents = 0) => {
    const dollars = (cents || 0) / 100;
    const abs = Math.abs(dollars).toFixed(2);
    const sign = dollars === 0 ? '' : (dollars > 0 ? '+' : '-');
    return `${sign}$${abs}`;
};

const formatTimestamp = (iso) => {
    if (!iso) return 'n/a';
    const date = new Date(iso);
    return Number.isNaN(date.getTime()) ? 'n/a' : `<t:${Math.floor(date.getTime() / 1000)}:f>`;
};

const formatFloor = (settings = {}) => {
    const value = Number(settings.floorValue);
    if (settings.floorType === 'absolute') {
        return Number.isFinite(value) ? `$${value.toFixed(2)} absolute floor` : '$0.00 absolute floor';
    }
    if (!Number.isFinite(value)) return '0% floor';
    const formatted = Number.isInteger(value) ? value.toFixed(0) : value.toFixed(1);
    return `${formatted}% floor`;
};

export const notifyLifecycle = (event, settings = {}, context = {}) => {
    const isEnabled = event === 'enabled';
    const isDisabled = event === 'disabled';
    const color = isEnabled ? 0x2ecc71 : isDisabled ? 0xe74c3c : 0x5865f2;
    const title = isEnabled
        ? 'Auto-pricer enabled'
        : isDisabled ? 'Auto-pricer disabled' : 'Auto-pricer updated';
    const description = isEnabled
        ? (context?.baselineCount != null ? `Baseline primed for ${context.baselineCount} cards.` : 'Baseline initialized.')
        : (context?.reason || 'Automatic repricing paused.');

    const fields = [
        { name: 'Strategy', value: STRATEGY_LABELS[settings.strategy] || settings.strategy || 'custom', inline: true },
        { name: 'Floor', value: formatFloor(settings), inline: true },
        { name: 'Interval', value: `${settings.intervalMinutes || 0} min`, inline: true }
    ];
    if (Number(settings.dropThresholdPercent) > 0) {
        fields.push({ name: 'Drop alerts', value: `${settings.dropThresholdPercent}%`, inline: true });
    }

    return post({ embeds: [{ title, description, color, fields, timestamp: new Date().toISOString() }] });
};

export const notifyRun = (summary = {}) => {
    const fields = [
        { name: 'Cards Updated', value: String(summary.cardsUpdated || 0), inline: true },
        { name: 'Value Delta', value: formatDelta(summary.valueDeltaCents), inline: true },
        { name: 'Run At', value: formatTimestamp(summary.runAt), inline: true }
    ];
    if (summary.durationMs) {
        fields.push({ name: 'Duration', value: `${(summary.durationMs / 1000).toFixed(1)}s`, inline: true });
    }
    const drops = Array.isArray(summary.priceDrops) ? summary.priceDrops : [];
    if (drops.length) {
        fields.push({
            name: 'Top Drops',
            value: drops.slice(0, 5)
                .map((e) => {
                    const label = e.setCode ? `${e.name} (${e.setCode})` : e.name;
                    return `${label}: ${formatDelta(e.delta)} (${formatDelta(e.previous)} → ${formatDelta(e.current)})`;
                })
                .join('\n')
                .slice(0, 1024)
        });
    }
    return post({ embeds: [{ title: 'Automation run complete', color: 0x5865f2, fields, timestamp: new Date().toISOString() }] });
};

export const notifyError = (context, message) => {
    const content = `**[${context}] Error:** ${message}`.slice(0, 2000);
    return post({ embeds: [{ title: 'Server error', description: content, color: 0xe74c3c, timestamp: new Date().toISOString() }] });
};
