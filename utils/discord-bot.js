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
    DISCORD_PRICE_LOG_CHANNEL_ID,
    DISCORD_LOG_CHANNEL_ID, // legacy fallback
    DISCORD_CONSOLE_CHANNEL_ID,
    DISCORD_BUYLIST_CHANNEL_ID,
    DISCORD_HELP_CHANNEL_ID,
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
    lastRunSummary: null,
    strategy: '',
    intervalMinutes: null,
    floorType: '',
    floorValue: null,
    dropThresholdPercent: null,
    exclusionsCount: 0,
    overridesCount: 0
};

const noop = async () => ({});

let client = null;
let dashboardChannel = null;
let logChannel = null; // price log
let consoleChannel = null;
let helpChannel = null;
let dashboardMessageId = null;
let helpMessageId = null;
let buylistChannel = null;
let buylistMessageId = null;
let state = { ...DEFAULT_STATE };
let controls = {
    startAutomation: noop,
    stopAutomation: noop,
    runAutomation: noop,
    lockInventory: noop,
    unlockInventory: noop,
    applySetting: noop,
    fetchStatus: noop
};
let refreshInFlight = false;
let pendingRefresh = false;

const botConfigured = () => Boolean(DISCORD_BOT_TOKEN && DISCORD_DASHBOARD_CHANNEL_ID && (DISCORD_PRICE_LOG_CHANNEL_ID || DISCORD_LOG_CHANNEL_ID));

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
        state.strategy = snapshot.automation.strategy || state.strategy;
        state.intervalMinutes = snapshot.automation.intervalMinutes ?? state.intervalMinutes;
        state.floorType = snapshot.automation.floorType || state.floorType;
        state.floorValue = snapshot.automation.floorValue ?? state.floorValue;
        state.dropThresholdPercent = snapshot.automation.dropThresholdPercent ?? state.dropThresholdPercent;
        state.exclusionsCount = snapshot.automation.exclusionsCount ?? state.exclusionsCount;
        state.overridesCount = snapshot.automation.overridesCount ?? state.overridesCount;
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
    const settingsLines = [
        `Strategy: ${state.strategy || 'undercutBest'}`,
        `Interval: ${state.intervalMinutes || '?'} min`,
        `Floor: ${state.floorType || 'percent'} ${state.floorValue ?? '?'}`,
        `Drop alerts: ${state.dropThresholdPercent || 0}%`,
        `Exclusions: ${state.exclusionsCount || 0}`,
        `Overrides: ${state.overridesCount || 0}`
    ];

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
            },
            {
                name: 'Advanced Settings',
                value: settingsLines.join('\n')
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

const findExistingBuylistMessage = async () => {
    if (!buylistChannel || !buylistChannel.isTextBased()) return null;
    if (buylistMessageId) {
        try {
            return await buylistChannel.messages.fetch(buylistMessageId);
        } catch {
            buylistMessageId = null;
        }
    }
    try {
        const messages = await buylistChannel.messages.fetch({ limit: 20 });
        const existing = messages.find((msg) => msg.author.id === client.user.id && msg.embeds?.length);
        if (existing) {
            buylistMessageId = existing.id;
            return existing;
        }
    } catch (error) {
        console.warn('[discord-bot] Failed to search buylist messages:', error.message || error);
    }
    return null;
};

const ensureBuylistMessage = async (payload) => {
    if (!client?.isReady() || !buylistChannel) return null;
    const existing = await findExistingBuylistMessage();
    const messagePayload = buildBuylistEmbed(payload || {});
    if (existing) {
        await existing.edit(messagePayload);
        return existing;
    }
    const message = await buylistChannel.send(messagePayload);
    buylistMessageId = message.id;
    return message;
};

const HELP_EMBED_TITLE = 'PowerNine Bot Commands';

const getCommandDefinitions = () => ([
    {
        name: 'autopricer',
        description: 'Update or control the auto-pricer',
        usage: '/autopricer <setting> [value]',
        subcommands: [
            { name: 'enable', value: 'enable', detail: 'Enable the auto-pricer (schedules future runs).' },
            { name: 'disable', value: 'disable', detail: 'Disable the auto-pricer (cancels next runs).' },
            { name: 'run-now', value: 'run', detail: 'Run automation immediately once.' },
            { name: 'lock', value: 'lock', detail: 'Emergency: disable inventory pushes.' },
            { name: 'unlock', value: 'unlock', detail: 'Re-enable inventory pushes.' },
            { name: 'interval-minutes', value: 'interval', detail: 'Set run interval in minutes (>=5). Example: /autopricer interval-minutes 15' },
            { name: 'strategy', value: 'strategy', detail: 'Set strategy: undercutBest | manaPoolLowPercent | manaPoolLowCents | tcgMarketMatch' },
            { name: 'floor-type', value: 'floorType', detail: 'Set floor type: percent | absolute' },
            { name: 'floor-value', value: 'floorValue', detail: 'Set floor value (number, respects floor type).' },
            { name: 'drop-threshold', value: 'dropThreshold', detail: 'Set alert threshold percent (number >=0).' },
            { name: 'exclusions', value: 'exclusions', detail: 'Set exclusions (comma or newline separated list).' },
            { name: 'floor-overrides', value: 'floorOverrides', detail: 'Set floor overrides (comma/newline; format name|set|value or name|value).' }
        ],
        options: [
            {
                name: 'setting',
                description: 'Setting or action',
                type: 3,
                required: true,
                choices: [
                    { name: 'enable', value: 'enable' },
                    { name: 'disable', value: 'disable' },
                    { name: 'run-now', value: 'run' },
                    { name: 'lock', value: 'lock' },
                    { name: 'unlock', value: 'unlock' },
                    { name: 'interval-minutes', value: 'interval' },
                    { name: 'strategy', value: 'strategy' },
                    { name: 'floor-type', value: 'floorType' },
                    { name: 'floor-value', value: 'floorValue' },
                    { name: 'drop-threshold', value: 'dropThreshold' },
                    { name: 'exclusions', value: 'exclusions' },
                    { name: 'floor-overrides', value: 'floorOverrides' }
                ]
            },
            {
                name: 'value',
                description: 'Value for the setting (if applicable)',
                type: 3,
                required: false
            }
        ]
    }
]);

const buildHelpEmbed = () => {
    const defs = getCommandDefinitions();
    const embed = new EmbedBuilder()
        .setTitle(HELP_EMBED_TITLE)
        .setDescription('Reference for bot commands and subcommands.')
        .setColor(0x3498db);
    defs.forEach((cmd) => {
        const subLines = (cmd.subcommands || []).map((sub) => `- ${sub.name}: ${sub.detail}`).join('\n');
        embed.addFields({
            name: `${cmd.name} — ${cmd.usage}`,
            value: `${cmd.description}\n${subLines}`.trim().slice(0, 1024)
        });
    });
    embed.setTimestamp(new Date());
    return embed;
};

const ensureHelpMessage = async () => {
    if (!client?.isReady() || !helpChannel) return null;
    if (helpMessageId) {
        try {
            return await helpChannel.messages.fetch(helpMessageId);
        } catch {
            helpMessageId = null;
        }
    }
    try {
        const messages = await helpChannel.messages.fetch({ limit: 20 });
        const existing = messages.find((msg) => msg.author.id === client.user.id && msg.embeds?.length && msg.embeds[0]?.title === HELP_EMBED_TITLE);
        if (existing) {
            helpMessageId = existing.id;
            return existing;
        }
    } catch (error) {
        console.warn('[discord-bot] Failed to search help messages:', error.message || error);
    }
    const message = await helpChannel.send({ embeds: [buildHelpEmbed()] });
    helpMessageId = message.id;
    return message;
};

const renderHelp = async () => {
    if (!client?.isReady() || !helpChannel) return;
    try {
        const message = await ensureHelpMessage();
        if (message) {
            await message.edit({ embeds: [buildHelpEmbed()] });
        }
    } catch (error) {
        console.warn('[discord-bot] Failed to render help embed:', error.message || error);
    }
};

const renderBuylist = async (report) => {
    if (!client?.isReady() || !buylistChannel) return;
    try {
        await ensureBuylistMessage(report);
    } catch (error) {
        console.warn('[discord-bot] Failed to render buylist embed:', error.message || error);
    }
};

const buildBuylistEmbed = (report = {}) => {
    const embed = new EmbedBuilder()
        .setTitle('Buylist Opportunities')
        .setDescription('Top positive spreads vs buylists')
        .setColor(0xf1c40f)
        .setTimestamp(report.generatedAt ? new Date(report.generatedAt) : new Date());

    const deals = Array.isArray(report.topDeals) ? report.topDeals.slice(0, 15) : [];
    const fields = deals.map((deal, idx) => ({
        name: `${idx + 1}. ${deal.name} (${deal.setCode})`,
        value: [
            `Best: ${deal.bestVendor} @ $${(deal.bestPrice || 0).toFixed(2)}`,
            `TCG Low+Ship: $${(deal.tcgLowPlusShipping || 0).toFixed(2)}`,
            `Spread: $${(deal.marginDollar || 0).toFixed(2)} (${(deal.marginPercent || 0).toFixed(1)}%)`,
            deal.foilType && deal.foilType !== 'normal' ? `Finish: ${deal.foilType}` : null,
            deal.condition ? `Cond: ${deal.condition}` : null
        ].filter(Boolean).join(' | ')
    })).slice(0, 15);

    if (fields.length) {
        embed.addFields(fields);
    } else {
        embed.setDescription('No positive buylist spreads found. Generate a new snapshot to populate this feed.');
    }

    embed.addFields({
        name: 'View full report',
        value: `[Open buylist page](http://powernine.dyndns.org:3000/buylist.html)`
    });

    return { embeds: [embed] };
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
            const logChannelId = DISCORD_PRICE_LOG_CHANNEL_ID || DISCORD_LOG_CHANNEL_ID;
            logChannel = await client.channels.fetch(logChannelId);
            if (!logChannel || logChannel.type !== ChannelType.GuildText) {
                throw new Error('Price log channel is not a text channel.');
            }
            if (DISCORD_CONSOLE_CHANNEL_ID) {
                try {
                    consoleChannel = await client.channels.fetch(DISCORD_CONSOLE_CHANNEL_ID);
                    if (!consoleChannel || consoleChannel.type !== ChannelType.GuildText) {
                        consoleChannel = null;
                        console.warn('[discord-bot] Console channel is not a text channel; falling back to log channel.');
                    }
                } catch (error) {
                    console.warn('[discord-bot] Failed to fetch console channel; falling back to log channel.', error.message || error);
                    consoleChannel = null;
                }
            }
            if (!consoleChannel) {
                consoleChannel = logChannel;
            }
            if (DISCORD_HELP_CHANNEL_ID) {
                try {
                    helpChannel = await client.channels.fetch(DISCORD_HELP_CHANNEL_ID);
                    if (!helpChannel || helpChannel.type !== ChannelType.GuildText) {
                        helpChannel = null;
                        console.warn('[discord-bot] Help channel is not a text channel; help embed disabled.');
                    }
                } catch (error) {
                    console.warn('[discord-bot] Failed to fetch help channel; help embed disabled.', error.message || error);
                    helpChannel = null;
                }
            }
            if (DISCORD_BUYLIST_CHANNEL_ID) {
                try {
                    buylistChannel = await client.channels.fetch(DISCORD_BUYLIST_CHANNEL_ID);
                    if (!buylistChannel || buylistChannel.type !== ChannelType.GuildText) {
                        buylistChannel = null;
                        console.warn('[discord-bot] Buylist channel is not a text channel; buylist feed disabled.');
                    }
                } catch (error) {
                    console.warn('[discord-bot] Failed to fetch buylist channel; buylist feed disabled.', error.message || error);
                    buylistChannel = null;
                }
            }
            console.log(`[discord-bot] Connected as ${client.user.tag}`);
            try {
                const defs = getCommandDefinitions();
                const payload = defs.map((cmd) => ({
                    name: cmd.name,
                    description: cmd.description,
                    options: (cmd.options || [])
                }));
                await client.application?.commands.set(payload);
            } catch (cmdErr) {
                console.warn('[discord-bot] Failed to register slash commands:', cmdErr?.message || cmdErr);
            }
            await controls.fetchStatus().then(applyStatusSnapshot).catch(() => {});
            await renderDashboard();
            await logDiscordConsole('Dashboard bot connected and ready.');
            await renderHelp();
            if (buylistChannel) {
                await renderBuylist(); // will no-op if no report yet
            }
        } catch (error) {
            console.error('[discord-bot] Failed to initialize channels:', error.message || error);
        }
    });

    client.on(Events.InteractionCreate, async (interaction) => {
        if (interaction.isButton()) {
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
                    await logDiscordConsole(`Auto-pricer stopped by ${interaction.user.tag}.`);
                } else if (customId === 'start-autopricer') {
                    await interaction.deferReply({ ephemeral: true });
                    await controls.startAutomation();
                    await controls.fetchStatus().then(applyStatusSnapshot);
                    await interaction.editReply('Auto-pricer started.');
                    await logDiscordConsole(`Auto-pricer started by ${interaction.user.tag}.`);
                } else if (customId === 'run-now') {
                    await interaction.deferReply({ ephemeral: true });
                    await controls.runAutomation();
                    await controls.fetchStatus().then(applyStatusSnapshot);
                    await interaction.editReply('Automation run triggered.');
                    await logDiscordConsole(`Manual automation run triggered by ${interaction.user.tag}.`);
                } else if (customId === 'lock-inventory') {
                    await interaction.deferReply({ ephemeral: true });
                    await controls.lockInventory();
                    await controls.fetchStatus().then(applyStatusSnapshot);
                    await interaction.editReply('Inventory sync disabled.');
                    await logDiscordConsole(`Inventory sync disabled by ${interaction.user.tag}.`);
                } else if (customId === 'unlock-inventory') {
                    await interaction.deferReply({ ephemeral: true });
                    await controls.unlockInventory();
                    await controls.fetchStatus().then(applyStatusSnapshot);
                    await interaction.editReply('Inventory sync enabled.');
                    await logDiscordConsole(`Inventory sync enabled by ${interaction.user.tag}.`);
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
            return;
        }

        if (interaction.isChatInputCommand() && interaction.commandName === 'autopricer') {
            if (DISCORD_CONTROL_ROLE_ID) {
                const hasRole = interaction.member?.roles?.cache?.has(DISCORD_CONTROL_ROLE_ID);
                if (!hasRole) {
                    await interaction.reply({ content: 'You do not have permission to control the bot.', ephemeral: true });
                    return;
                }
            }
            const setting = interaction.options.getString('setting');
            const value = interaction.options.getString('value');
            try {
                await interaction.deferReply({ ephemeral: true });
                const response = await handleAutopricerCommand(setting, value);
                await controls.fetchStatus().then(applyStatusSnapshot);
                renderDashboard();
                await interaction.editReply(response || 'Updated.');
            } catch (error) {
                console.error('[discord-bot] Slash handler failed:', error);
                await interaction.editReply(`Failed: ${error.message || error}`);
            }
        }
    });

    client.on(Events.Error, (err) => {
        console.warn('[discord-bot] Client error:', err.message || err);
        logDiscordConsole(`[discord-bot] Client error: ${err?.message || err}`).catch(() => {});
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

const sendToChannel = async (channel, payload, label = '[discord-bot] message') => {
    if (!channel || !client?.isReady()) {
        if (typeof payload === 'string') {
            console.log(`${label}:`, payload);
        } else {
            try {
                console.log(`${label} payload:`, JSON.stringify(payload));
            } catch {
                console.log(`${label} payload:`, payload);
            }
        }
        return;
    }
    try {
        if (typeof payload === 'string') {
            await channel.send({ content: payload });
        } else {
            await channel.send(payload);
        }
    } catch (error) {
        console.warn(`${label} failed:`, error.message || error);
    }
};

export const logDiscordConsole = async (payload) => {
    await sendToChannel(consoleChannel || logChannel, payload, '[discord-bot] console');
};

export const logDiscordEvent = async (payload) => {
    const targets = Array.from(new Set([logChannel, consoleChannel].filter(Boolean)));
    const channel = targets.length ? targets[0] : null;
    await sendToChannel(channel, payload, '[discord-bot] log');
};

export const getDashboardState = () => ({ ...state });
export const updateBuylistEmbed = async (report) => {
    if (!buylistChannel) return;
    await ensureBuylistMessage(report);
};

const normalizeListInput = (input) => {
    if (!input) return [];
    return input
        .split(/\r?\n|,/)
        .map((entry) => entry.trim())
        .filter(Boolean);
};

const handleAutopricerCommand = async (setting, value) => {
    const key = (setting || '').toLowerCase();
    if (!key) {
        throw new Error('Setting is required.');
    }
    if (key === 'enable') {
        await controls.startAutomation();
        await logDiscordConsole('Auto-pricer enabled via slash command.');
        return 'Auto-pricer enabled.';
    }
    if (key === 'disable') {
        await controls.stopAutomation();
        await logDiscordConsole('Auto-pricer disabled via slash command.');
        return 'Auto-pricer disabled.';
    }
    if (key === 'run') {
        await controls.runAutomation();
        await logDiscordConsole('Manual automation run triggered via slash command.');
        return 'Automation run triggered.';
    }
    if (key === 'lock') {
        await controls.lockInventory();
        await logDiscordConsole('Inventory sync locked via slash command.');
        return 'Inventory sync locked.';
    }
    if (key === 'unlock') {
        await controls.unlockInventory();
        await logDiscordConsole('Inventory sync unlocked via slash command.');
        return 'Inventory sync unlocked.';
    }
    if (key === 'interval') {
        const minutes = Number(value);
        if (!Number.isFinite(minutes) || minutes < 5) throw new Error('Interval must be a number >= 5.');
        await controls.applySetting({ intervalMinutes: Math.round(minutes) });
        return `Interval set to ${Math.round(minutes)} minutes.`;
    }
    if (key === 'strategy') {
        const allowed = ['undercutBest', 'manaPoolLowPercent', 'manaPoolLowCents', 'tcgMarketMatch'];
        if (!value) throw new Error('Strategy value required.');
        if (!allowed.includes(value)) throw new Error(`Strategy must be one of: ${allowed.join(', ')}`);
        await controls.applySetting({ strategy: value });
        return `Strategy set to ${value}.`;
    }
    if (key === 'floortype' || key === 'floorType'.toLowerCase()) {
        const normalized = (value || '').toLowerCase();
        if (!['percent', 'absolute'].includes(normalized)) throw new Error('floorType must be percent or absolute.');
        await controls.applySetting({ floorType: normalized });
        return `Floor type set to ${normalized}.`;
    }
    if (key === 'floorvalue') {
        if (value == null) throw new Error('floorValue is required.');
        const number = Number(value);
        if (!Number.isFinite(number) || number < 0) throw new Error('floorValue must be a non-negative number.');
        await controls.applySetting({ floorValue: number });
        return `Floor value set to ${number}.`;
    }
    if (key === 'dropthreshold') {
        if (value == null) throw new Error('dropThreshold value is required.');
        const number = Number(value);
        if (!Number.isFinite(number) || number < 0) throw new Error('dropThreshold must be a non-negative number.');
        await controls.applySetting({ dropThresholdPercent: Math.round(number) });
        return `Drop threshold set to ${Math.round(number)}%.`;
    }
    if (key === 'exclusions') {
        const list = normalizeListInput(value);
        await controls.applySetting({ exclusions: list });
        return `Exclusions updated (${list.length} entries).`;
    }
    if (key === 'flooroverrides') {
        const list = normalizeListInput(value);
        await controls.applySetting({ floorOverrides: list });
        return `Floor overrides updated (${list.length} entries).`;
    }
    throw new Error(`Unknown setting: ${setting}`);
};
