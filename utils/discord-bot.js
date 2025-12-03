import {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    ChannelType,
    Client,
    EmbedBuilder,
    Events,
    GatewayIntentBits
} from 'discord.js';

const {
    DISCORD_BOT_TOKEN,
    DISCORD_DASHBOARD_CHANNEL_ID,
    DISCORD_LOG_CHANNEL_ID,
    DISCORD_CONTROL_ROLE_ID
} = process.env;

const DEFAULT_STATE = {
    automationEnabled: false,
    automationRunning: false,
    lastRunAt: null,
    nextRunAt: null,
    inventoryLocked: false,
    inventoryLockReason: '',
    inventoryLockActor: '',
    lastRunSummary: null
};

const noop = async () => ({});

let client = null;
let dashboardChannel = null;
let logChannel = null;
let dashboardMessageId = null;
let state = { ...DEFAULT_STATE };
let controls = {
    startAutomation: noop,
    stopAutomation: noop,
    runAutomation: noop,
    lockInventory: noop,
    unlockInventory: noop,
    fetchStatus: noop
};
let refreshInFlight = false;
let pendingRefresh = false;

const botConfigured = () => Boolean(DISCORD_BOT_TOKEN && DISCORD_DASHBOARD_CHANNEL_ID && DISCORD_LOG_CHANNEL_ID);

const formatBool = (value, truthy = 'Yes', falsy = 'No') => (value ? truthy : falsy);

const formatTimestamp = (iso) => {
    if (!iso) return 'n/a';
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return 'n/a';
    return `<t:${Math.floor(date.getTime() / 1000)}:f>`;
};

const formatDelta = (cents = 0) => {
    const dollars = (cents || 0) / 100;
    const abs = Math.abs(dollars).toFixed(2);
    const sign = dollars === 0 ? '' : (dollars > 0 ? '+' : '-');
    return `${sign}$${abs}`;
};

const applyStatusSnapshot = (snapshot = {}) => {
    if (snapshot.automation) {
        state.automationEnabled = Boolean(snapshot.automation.enabled ?? state.automationEnabled);
        state.automationRunning = Boolean(snapshot.automation.isRunning ?? state.automationRunning);
        state.lastRunAt = snapshot.automation.lastRunAt ?? state.lastRunAt;
        state.nextRunAt = snapshot.automation.nextRunAt ?? state.nextRunAt;
    }
    if (snapshot.inventoryLock) {
        if (typeof snapshot.inventoryLock.locked === 'boolean') {
            state.inventoryLocked = snapshot.inventoryLock.locked;
        }
        if (snapshot.inventoryLock.reason !== undefined) {
            state.inventoryLockReason = snapshot.inventoryLock.reason || '';
        }
        if (snapshot.inventoryLock.actor !== undefined) {
            state.inventoryLockActor = snapshot.inventoryLock.actor || '';
        }
    }
};

const buildTopChangesValue = (summary) => {
    if (!summary || !Array.isArray(summary.priceDrops) || !summary.priceDrops.length) {
        return 'No recent price changes.';
    }
    return summary.priceDrops
        .slice(0, 5)
        .map((entry) => {
            const label = entry.setCode ? `${entry.name} (${entry.setCode})` : entry.name;
            const before = formatDelta(entry.previous);
            const after = formatDelta(entry.current);
            return `- ${label}: ${before} -> ${after}${entry.reason ? ` -- ${entry.reason}` : ''}`;
        })
        .join('\n')
        .slice(0, 1024) || 'No recent price changes.';
};

const buildDashboardEmbed = () => {
    const statusLine = state.automationRunning
        ? 'Running now (active)'
        : formatBool(state.automationEnabled, 'Active', 'Paused');
    const runSummary = state.lastRunSummary;
    const dropSummary = runSummary
        ? `${formatDelta(runSummary.valueDeltaCents)} across ${runSummary.cardsUpdated} cards`
        : 'No automation runs yet.';
    const inventoryStatus = state.inventoryLocked
        ? `LOCKED ${state.inventoryLockReason || ''}`.trim()
        : 'Enabled';

    const embed = new EmbedBuilder()
        .setTitle('ManaPool Auto-Pricer Dashboard')
        .setColor(state.inventoryLocked ? 0xe67e22 : (state.automationEnabled ? 0x2ecc71 : 0xe74c3c))
        .addFields(
            {
                name: 'Pricer',
                value: [
                    statusLine,
                    `Next: ${formatTimestamp(state.nextRunAt)}`,
                    `Last: ${formatTimestamp(state.lastRunAt)}`
                ].join('\n'),
                inline: true
            },
            {
                name: 'Last Run',
                value: [
                    dropSummary,
                    runSummary?.runAt ? `Ran at ${formatTimestamp(runSummary.runAt)}` : null,
                    runSummary?.durationMs ? `Duration: ${(runSummary.durationMs / 1000).toFixed(1)}s` : null
                ].filter(Boolean).join('\n') || 'No automation data.',
                inline: true
            },
            {
                name: 'Inventory Sync',
                value: inventoryStatus,
                inline: true
            },
            {
                name: 'Top Movers',
                value: buildTopChangesValue(runSummary)
            }
        )
        .setTimestamp(new Date());

    return embed;
};

const buildActionRows = () => {
    const rows = [];
    const startStop = new ButtonBuilder()
        .setCustomId(state.automationEnabled ? 'stop-autopricer' : 'start-autopricer')
        .setLabel(state.automationEnabled ? 'Stop Auto-Pricer' : 'Start Auto-Pricer')
        .setStyle(state.automationEnabled ? ButtonStyle.Danger : ButtonStyle.Success)
        .setDisabled(state.automationRunning);
    const runNow = new ButtonBuilder()
        .setCustomId('run-now')
        .setLabel('Run Now')
        .setStyle(ButtonStyle.Primary)
        .setDisabled(!state.automationEnabled || state.automationRunning || state.inventoryLocked);
    const refresh = new ButtonBuilder()
        .setCustomId('refresh-dashboard')
        .setLabel('Refresh')
        .setStyle(ButtonStyle.Secondary);
    rows.push(new ActionRowBuilder().addComponents(startStop, runNow, refresh));

    const lockToggle = new ButtonBuilder()
        .setCustomId(state.inventoryLocked ? 'unlock-inventory' : 'lock-inventory')
        .setLabel(state.inventoryLocked ? 'Enable Inventory' : 'Disable Inventory (EMERGENCY)')
        .setStyle(state.inventoryLocked ? ButtonStyle.Success : ButtonStyle.Danger);
    rows.push(new ActionRowBuilder().addComponents(lockToggle));
    return rows;
};

const findExistingDashboardMessage = async () => {
    if (!dashboardChannel || !dashboardChannel.isTextBased()) return null;
    if (dashboardMessageId) {
        try {
            return await dashboardChannel.messages.fetch(dashboardMessageId);
        } catch {
            dashboardMessageId = null;
        }
    }
    try {
        const messages = await dashboardChannel.messages.fetch({ limit: 20 });
        const existing = messages.find((msg) => msg.author.id === client.user.id && msg.embeds?.length);
        if (existing) {
            dashboardMessageId = existing.id;
            return existing;
        }
    } catch (error) {
        console.warn('[discord-bot] Failed to search dashboard messages:', error.message || error);
    }
    return null;
};

const ensureDashboardMessage = async () => {
    if (!client?.isReady() || !dashboardChannel) return null;
    const existing = await findExistingDashboardMessage();
    if (existing) return existing;
    const message = await dashboardChannel.send({
        embeds: [buildDashboardEmbed()],
        components: buildActionRows()
    });
    dashboardMessageId = message.id;
    return message;
};

const renderDashboard = async () => {
    if (!client?.isReady()) {
        pendingRefresh = true;
        return;
    }
    if (refreshInFlight) {
        pendingRefresh = true;
        return;
    }
    refreshInFlight = true;
    try {
        const message = await ensureDashboardMessage();
        if (message) {
            await message.edit({
                embeds: [buildDashboardEmbed()],
                components: buildActionRows()
            });
        }
    } catch (error) {
        console.error('[discord-bot] Failed to update dashboard:', error.message || error);
    } finally {
        refreshInFlight = false;
        if (pendingRefresh) {
            pendingRefresh = false;
            renderDashboard();
        }
    }
};

export const startDiscordBot = async (controlFns = {}) => {
    if (!botConfigured()) {
        console.warn('[discord-bot] Bot not configured (missing token or channel IDs). Discord control is disabled.');
        return false;
    }
    if (client) return true;
    controls = { ...controls, ...controlFns };
    client = new Client({
        intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages]
    });
    client.once(Events.ClientReady, async () => {
        try {
            dashboardChannel = await client.channels.fetch(DISCORD_DASHBOARD_CHANNEL_ID);
            if (!dashboardChannel || dashboardChannel.type !== ChannelType.GuildText) {
                throw new Error('Dashboard channel is not a text channel.');
            }
            logChannel = await client.channels.fetch(DISCORD_LOG_CHANNEL_ID);
            if (!logChannel || logChannel.type !== ChannelType.GuildText) {
                throw new Error('Log channel is not a text channel.');
            }
            console.log(`[discord-bot] Connected as ${client.user.tag}`);
            await controls.fetchStatus().then(applyStatusSnapshot).catch(() => {});
            await renderDashboard();
            await logDiscordEvent('Dashboard bot connected and ready.');
        } catch (error) {
            console.error('[discord-bot] Failed to initialize channels:', error.message || error);
        }
    });

    client.on(Events.InteractionCreate, async (interaction) => {
        if (!interaction.isButton()) return;
        if (DISCORD_CONTROL_ROLE_ID) {
            const hasRole = interaction.member?.roles?.cache?.has(DISCORD_CONTROL_ROLE_ID);
            if (!hasRole) {
                await interaction.reply({ content: 'You do not have permission to control the bot.', ephemeral: true });
                return;
            }
        }
        const customId = interaction.customId;
        try {
            if (customId === 'stop-autopricer') {
                await interaction.deferReply({ ephemeral: true });
                await controls.stopAutomation();
                await controls.fetchStatus().then(applyStatusSnapshot);
                await interaction.editReply('Auto-pricer stopped.');
                await logDiscordEvent(`Auto-pricer stopped by ${interaction.user.tag}.`);
            } else if (customId === 'start-autopricer') {
                await interaction.deferReply({ ephemeral: true });
                await controls.startAutomation();
                await controls.fetchStatus().then(applyStatusSnapshot);
                await interaction.editReply('Auto-pricer started.');
                await logDiscordEvent(`Auto-pricer started by ${interaction.user.tag}.`);
            } else if (customId === 'run-now') {
                await interaction.deferReply({ ephemeral: true });
                await controls.runAutomation();
                await controls.fetchStatus().then(applyStatusSnapshot);
                await interaction.editReply('Automation run triggered.');
                await logDiscordEvent(`Manual automation run triggered by ${interaction.user.tag}.`);
            } else if (customId === 'lock-inventory') {
                await interaction.deferReply({ ephemeral: true });
                await controls.lockInventory();
                await controls.fetchStatus().then(applyStatusSnapshot);
                await interaction.editReply('Inventory sync disabled.');
                await logDiscordEvent(`Inventory sync disabled by ${interaction.user.tag}.`);
            } else if (customId === 'unlock-inventory') {
                await interaction.deferReply({ ephemeral: true });
                await controls.unlockInventory();
                await controls.fetchStatus().then(applyStatusSnapshot);
                await interaction.editReply('Inventory sync enabled.');
                await logDiscordEvent(`Inventory sync enabled by ${interaction.user.tag}.`);
            } else if (customId === 'refresh-dashboard') {
                await interaction.deferReply({ ephemeral: true });
                await controls.fetchStatus().then(applyStatusSnapshot);
                await interaction.editReply('Dashboard refreshed.');
            }
            renderDashboard();
        } catch (error) {
            console.error('[discord-bot] Control handler failed:', error);
            try {
                await interaction.reply({
                    content: `Failed to perform action: ${error.message || error}`,
                    ephemeral: true
                });
            } catch {
                // ignore
            }
        }
    });

    client.on(Events.Error, (err) => {
        console.warn('[discord-bot] Client error:', err.message || err);
    });

    try {
        await client.login(DISCORD_BOT_TOKEN);
        return true;
    } catch (error) {
        console.error('[discord-bot] Failed to login:', error.message || error);
        return false;
    }
};

export const updateAutomationBotState = (partial = {}) => {
    state = { ...state, ...partial };
    renderDashboard();
};

export const publishAutomationRunSummary = async (summary = {}) => {
    const normalized = {
        runAt: summary.runAt || new Date().toISOString(),
        cardsUpdated: summary.cardsUpdated || 0,
        valueDeltaCents: summary.valueDeltaCents || 0,
        priceDrops: Array.isArray(summary.priceDrops) ? summary.priceDrops : [],
        alerts: Array.isArray(summary.alerts) ? summary.alerts : [],
        durationMs: summary.durationMs || null,
        message: summary.message || ''
    };
    state.lastRunSummary = normalized;
    state.lastRunAt = normalized.runAt;
    await renderDashboard();
    const fields = [
        { name: 'Cards Updated', value: String(normalized.cardsUpdated || 0), inline: true },
        { name: 'Value Delta', value: formatDelta(normalized.valueDeltaCents), inline: true },
        { name: 'Run At', value: formatTimestamp(normalized.runAt), inline: true }
    ];
    if (normalized.priceDrops.length) {
        fields.push({
            name: 'Top Drops',
            value: normalized.priceDrops
                .slice(0, 5)
                .map((entry) => {
                    const label = entry.setCode ? `${entry.name} (${entry.setCode})` : entry.name;
                    return `${label}: ${formatDelta(entry.delta)} (${formatDelta(entry.previous)} -> ${formatDelta(entry.current)})`;
                })
                .join('\n')
                .slice(0, 1024)
        });
    }
    await logDiscordEvent({
        embeds: [
            new EmbedBuilder()
                .setTitle('Automation run completed')
                .setColor(0x5865f2)
                .addFields(fields)
                .setTimestamp(new Date())
        ]
    });
};

export const logDiscordEvent = async (payload) => {
    if (!logChannel || !client?.isReady()) {
        if (typeof payload === 'string') {
            console.log('[discord-bot] log:', payload);
        } else {
            console.log('[discord-bot] log payload:', JSON.stringify(payload));
        }
        return;
    }
    try {
        if (typeof payload === 'string') {
            await logChannel.send({ content: payload });
        } else {
            await logChannel.send(payload);
        }
    } catch (error) {
        console.warn('[discord-bot] Failed to send log message:', error.message || error);
    }
};

export const getDashboardState = () => ({ ...state });
