const inventoryManagementBtn = document.getElementById('inventory-management-btn');
if (inventoryManagementBtn) {
    inventoryManagementBtn.addEventListener('click', () => {
        window.location.href = '/inventory.html';
    });
}

const manapoolBtn = document.getElementById('manapool-btn');
if (manapoolBtn) {
    manapoolBtn.addEventListener('click', () => {
        window.location.href = '/manapool.html';
    });
}

const manageFinancesBtn = document.getElementById('manage-finances-btn');
if (manageFinancesBtn) {
    manageFinancesBtn.addEventListener('click', () => {
        window.location.href = '/finances.html';
    });
}

const shippingAlert = document.getElementById('shipping-alert');
const shippingAlertText = document.getElementById('shipping-alert-text');
const refreshShippingAlertBtn = document.getElementById('refresh-shipping-alert');
let shippingAlertTimer = null;

const hideShippingAlert = () => {
    if (shippingAlert) shippingAlert.setAttribute('hidden', 'hidden');
};

const showShippingAlert = (count, orders = []) => {
    if (!shippingAlert || !shippingAlertText) return;
    const orderLabels = orders
        .map((order) => order.manapoolOrderId || order.id)
        .filter(Boolean);
    const labelPreview = orderLabels.slice(0, 3).join(', ');
    const extraCount = orderLabels.length - Math.min(orderLabels.length, 3);
    const detail = orderLabels.length
        ? `${labelPreview}${extraCount > 0 ? `, +${extraCount} more` : ''}`
        : '';
    shippingAlertText.textContent = count === 1
        ? `ManaPool order${detail ? ` ${detail}` : ''} needs to be shipped.`
        : `${count} ManaPool orders require shipment${detail ? ` (${detail})` : ''}.`;
    shippingAlert.removeAttribute('hidden');
};

const refreshShippingAlert = async () => {
    if (!shippingAlert) return;
    try {
        const response = await fetch('/api/transactions/unshipped');
        if (!response.ok) throw new Error('Failed loading shipment status.');
        const data = await response.json();
        if (data.count > 0) {
            showShippingAlert(data.count, data.orders || []);
        } else {
            hideShippingAlert();
        }
    } catch (error) {
        console.error('Failed loading unshipped orders:', error);
        hideShippingAlert();
    } finally {
        if (shippingAlertTimer) clearTimeout(shippingAlertTimer);
        shippingAlertTimer = setTimeout(refreshShippingAlert, 180000);
    }
};

refreshShippingAlertBtn?.addEventListener('click', () => {
    refreshShippingAlert();
});

const recentOpenBtn = document.getElementById('recent-lists-btn');
const recentModal = document.getElementById('recent-modal');
const recentBackdrop = recentModal ? recentModal.querySelector('.recent-modal-backdrop') : null;
const recentCloseBtn = document.getElementById('recent-close-btn');
const recentSection = document.getElementById('recent-lists');
const recentList = document.getElementById('recent-list-items');
const recentEmpty = document.getElementById('recent-empty');
const recentSearchInput = document.getElementById('recent-search');
const recentSortSelect = document.getElementById('recent-sort');

let recentSearchTimeout;
let recentModalActive = false;

const formatListName = (value) => {
    if (typeof value === 'string') {
        const trimmed = value.trim();
        if (trimmed.length > 0) return trimmed;
    }
    return '<unnamed list>';
};

const formatRelativeTime = (isoString) => {
    if (!isoString) return '';
    const date = new Date(isoString);
    if (Number.isNaN(date.getTime())) return '';

    const diffMs = Date.now() - date.getTime();
    const minute = 60 * 1000;
    if (diffMs < minute) return 'moments ago';
    const minutes = Math.round(diffMs / minute);
    if (minutes < 60) {
        return minutes === 1 ? '1 minute ago' : `${minutes} minutes ago`;
    }
    const hours = Math.round(minutes / 60);
    if (hours < 24) {
        return hours === 1 ? '1 hour ago' : `${hours} hours ago`;
    }
    const days = Math.round(hours / 24);
    if (days < 7) {
        return days === 1 ? '1 day ago' : `${days} days ago`;
    }
    return date.toLocaleDateString();
};

const buildMetaText = (list) => {
    const lastSeen = list.lastAccessedAt || list.updatedAt || list.createdAt;
    const relative = formatRelativeTime(lastSeen);
    if (relative) return `Viewed ${relative}`;
    if (list.createdAt) {
        const created = new Date(list.createdAt);
        if (!Number.isNaN(created.getTime())) {
            return `Created ${created.toLocaleDateString()}`;
        }
    }
    return '';
};

const renderRecentLists = (lists) => {
    if (!recentSection || !recentList || !recentEmpty) return;
    recentList.innerHTML = '';

    if (!lists.length) {
        recentEmpty.textContent = 'No saved lists yet. Import or create a list to get started.';
        recentEmpty.classList.remove('hidden');
        return;
    }

    recentEmpty.classList.add('hidden');
    const fragment = document.createDocumentFragment();

    lists.forEach((list) => {
        const item = document.createElement('li');
        item.dataset.listId = list.id;

        const info = document.createElement('div');
        info.className = 'recent-list-info';

        const link = document.createElement('a');
        link.href = `/list/${list.id}`;
        link.textContent = formatListName(list.name);
        info.appendChild(link);

        const metaText = buildMetaText(list);
        if (metaText) {
            const meta = document.createElement('div');
            meta.className = 'recent-list-meta';
            meta.textContent = metaText;
            info.appendChild(meta);
        }

        const actions = document.createElement('div');
        actions.className = 'recent-list-actions';

        const renameBtn = document.createElement('button');
        renameBtn.type = 'button';
        renameBtn.className = 'recent-action recent-rename';
        renameBtn.dataset.id = list.id;
        renameBtn.dataset.name = list.name || '';
        renameBtn.textContent = 'Rename';

        const deleteBtn = document.createElement('button');
        deleteBtn.type = 'button';
        deleteBtn.className = 'recent-action danger recent-delete';
        deleteBtn.dataset.id = list.id;
        deleteBtn.dataset.name = list.name || '';
        deleteBtn.textContent = 'Delete';

        actions.appendChild(renameBtn);
        actions.appendChild(deleteBtn);

        item.appendChild(info);
        item.appendChild(actions);
        fragment.appendChild(item);
    });

    recentList.appendChild(fragment);
};

const loadRecentLists = async () => {
    if (!recentList || !recentSection) return;
    recentList.innerHTML = '';
    if (recentEmpty) {
        recentEmpty.textContent = 'Loading...';
        recentEmpty.classList.remove('hidden');
    }

    const params = new URLSearchParams({
        sort: recentSortSelect ? recentSortSelect.value : 'recent',
        limit: '8'
    });
    const searchTerm = recentSearchInput ? recentSearchInput.value.trim() : '';
    if (searchTerm) params.set('search', searchTerm);

    try {
        const response = await fetch(`/api/lists?${params.toString()}`);
        if (!response.ok) throw new Error('Request failed');
        const payload = await response.json();
        const lists = Array.isArray(payload.lists) ? payload.lists : [];
        renderRecentLists(lists);
    } catch (error) {
        console.error(error);
        recentEmpty.textContent = 'Unable to load lists right now.';
        recentEmpty.classList.remove('hidden');
    }
};

const promptListName = (currentName = '') => {
    const result = window.prompt('Name this list (leave blank for "<unnamed list>"):', currentName);
    if (result === null) return null;
    return result.trim();
};

const handleRename = async (listId, currentName) => {
    const value = promptListName(currentName);
    if (value === null) return;
    try {
        const response = await fetch(`/api/list/${listId}/name`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: value })
        });
        if (!response.ok) throw new Error('Rename failed');
        await loadRecentLists();
    } catch (error) {
        console.error(error);
        window.alert('Failed to rename list. Please try again.');
    }
};

const handleDelete = async (listId, rawName) => {
    const displayName = formatListName(rawName);
    const confirmed = window.confirm(`Delete ${displayName}? This action cannot be undone.`);
    if (!confirmed) return;
    try {
        const response = await fetch(`/api/list/${listId}`, { method: 'DELETE' });
        if (!response.ok) throw new Error('Delete failed');
        await loadRecentLists();
    } catch (error) {
        console.error(error);
        window.alert('Failed to delete list. Please try again.');
    }
};

const handleEscapeKey = (event) => {
    if (event.key === 'Escape') {
        closeRecentModal();
    }
};

function openRecentModal() {
    if (!recentModal) return;
    recentModal.classList.add('open');
    recentModal.setAttribute('aria-hidden', 'false');
    document.body.classList.add('modal-open');
    recentModalActive = true;
    loadRecentLists();
    document.addEventListener('keydown', handleEscapeKey);
}

function closeRecentModal() {
    if (!recentModal) return;
    recentModal.classList.remove('open');
    recentModal.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('modal-open');
    recentModalActive = false;
    document.removeEventListener('keydown', handleEscapeKey);
}

if (recentSearchInput) {
    recentSearchInput.addEventListener('input', () => {
        if (!recentModalActive) return;
        clearTimeout(recentSearchTimeout);
        recentSearchTimeout = setTimeout(loadRecentLists, 250);
    });
}

if (recentSortSelect) {
    recentSortSelect.addEventListener('change', () => {
        if (!recentModalActive) return;
        loadRecentLists();
    });
}

if (recentList) {
    recentList.addEventListener('click', (event) => {
        const target = event.target;
        if (!(target instanceof HTMLElement)) return;
        if (target.classList.contains('recent-rename')) {
            event.preventDefault();
            event.stopPropagation();
            const listId = target.dataset.id;
            if (!listId) return;
            handleRename(listId, target.dataset.name || '');
        } else if (target.classList.contains('recent-delete')) {
            event.preventDefault();
            event.stopPropagation();
            const listId = target.dataset.id;
            if (!listId) return;
            handleDelete(listId, target.dataset.name || '');
        }
    });
}

if (recentOpenBtn) {
    recentOpenBtn.addEventListener('click', () => {
        openRecentModal();
    });
}

if (recentCloseBtn) {
    recentCloseBtn.addEventListener('click', () => {
        closeRecentModal();
    });
}

if (recentBackdrop) {
    recentBackdrop.addEventListener('click', () => {
        closeRecentModal();
    });
}

if (recentModal) {
    recentModal.addEventListener('click', (event) => {
        const target = event.target;
        if (!(target instanceof HTMLElement)) return;
        if (target.dataset.close === 'recent-modal') {
            closeRecentModal();
        }
    });
}

refreshShippingAlert();

// --- Keyboard command console (toggle with the ` key) ---
(function initCommandConsole() {
    const COMMANDS = {
        DAILY_UPDATE: {
            description: 'Run the daily data refresh pipeline immediately.',
            handler: async (args, ctx) => {
                ctx.write('Starting DAILY_UPDATE...');
                const response = await fetch('/api/admin/command', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ command: 'DAILY_UPDATE', args })
                });
                const payload = await response.json().catch(() => ({}));
                if (!response.ok) {
                    throw new Error(payload.error || `Request failed (${response.status})`);
                }
                const pidInfo = payload.pid ? ` (pid ${payload.pid})` : '';
                ctx.write(`DAILY_UPDATE ${payload.status || 'started'}${pidInfo}. Progress will appear in Discord #console.`);
                if (payload.startedAt) {
                    ctx.write(`Started at ${payload.startedAt}.`);
                }
            }
        },

        BACKUPS: {
            description: 'List available backups.',
            handler: async (args, ctx) => {
                ctx.write('Fetching backups...');
                const res = await fetch('/api/backups');
                const backups = await res.json();
                if (backups.length === 0) {
                    ctx.write('No backups found.');
                    return;
                }
                ctx.write(`Found ${backups.length} backup(s):`);
                for (const b of backups) {
                    const sizeMB = (b.size / 1024 / 1024).toFixed(1);
                    const date = new Date(b.created).toLocaleString();
                    ctx.write(`  ${b.name}  (${sizeMB} MB, ${date})`);
                }
                ctx.write('');
                ctx.write('To restore: RESTORE <filename>');
            }
        },

        RESTORE: {
            description: 'Restore a backup. Usage: RESTORE <backup-filename>',
            handler: async (args, ctx) => {
                if (!args[0]) {
                    ctx.write('Usage: RESTORE <backup-filename>');
                    ctx.write('Run BACKUPS to see available files.');
                    return;
                }
                const name = args[0];
                ctx.write(`Restoring from ${name}...`);
                const res = await fetch('/api/backups/restore', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ name })
                });
                const payload = await res.json().catch(() => ({}));
                if (!res.ok) {
                    throw new Error(payload.error || `Restore failed (${res.status})`);
                }
                ctx.write(`Restored ${payload.restored.length} table(s): ${payload.restored.join(', ')}`);
                if (payload.errors && payload.errors.length > 0) {
                    for (const e of payload.errors) {
                        ctx.write(`  Error on ${e.table}: ${e.error}`);
                    }
                }
            }
        },

        HELP: {
            description: 'Show available commands.',
            handler: async (args, ctx) => {
                for (const [name, cmd] of Object.entries(COMMANDS)) {
                    ctx.write(`  ${name} - ${cmd.description}`);
                }
            }
        }
    };

    const consoleEl = document.createElement('div');
    consoleEl.className = 'cmd-console';
    consoleEl.setAttribute('role', 'region');
    consoleEl.setAttribute('aria-label', 'Powernine command console');

    const header = document.createElement('div');
    header.className = 'cmd-console__header';
    header.innerHTML = '<span class="cmd-console__badge">`</span><span>Powernine Console</span>';
    consoleEl.appendChild(header);

    const logEl = document.createElement('div');
    logEl.className = 'cmd-console__log';
    consoleEl.appendChild(logEl);

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'cmd-console__input';
    input.placeholder = 'Type a command (e.g. DAILY_UPDATE) and press Enter...';
    consoleEl.appendChild(input);

    const hint = document.createElement('div');
    hint.className = 'cmd-console__hint';
    hint.textContent = 'Press ` (grave) to toggle • Up/Down for history • Type HELP for commands';
    consoleEl.appendChild(hint);

    document.body.appendChild(consoleEl);

    const state = {
        open: false,
        history: [],
        historyIndex: -1
    };

    const writeLine = (text) => {
        const line = document.createElement('div');
        line.className = 'cmd-console__line';
        line.textContent = text;
        logEl.appendChild(line);
        logEl.scrollTop = logEl.scrollHeight;
    };

    const setOpen = (nextOpen) => {
        state.open = nextOpen;
        consoleEl.classList.toggle('open', nextOpen);
        if (nextOpen) {
            input.focus();
        }
    };

    const toggle = () => setOpen(!state.open);

    const executeCommand = async (rawInput) => {
        const trimmed = (rawInput || '').trim();
        if (!trimmed) return;

        state.history.push(trimmed);
        state.historyIndex = state.history.length;

        const [cmd, ...args] = trimmed.split(/\s+/);
        const upper = cmd.toUpperCase();

        writeLine(`> ${trimmed}`);

        const entry = COMMANDS[upper];
        if (!entry) {
            writeLine(`Unknown command: ${upper}`);
            return;
        }

        try {
            await entry.handler(args, { write: writeLine });
        } catch (err) {
            writeLine(`Error: ${err.message || err}`);
        }
    };

    input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
            event.preventDefault();
            executeCommand(input.value);
            input.value = '';
            return;
        }

        if (event.key === 'ArrowUp') {
            event.preventDefault();
            if (state.historyIndex > 0) {
                state.historyIndex -= 1;
                input.value = state.history[state.historyIndex] || '';
            }
            return;
        }

        if (event.key === 'ArrowDown') {
            event.preventDefault();
            if (state.historyIndex < state.history.length - 1) {
                state.historyIndex += 1;
                input.value = state.history[state.historyIndex] || '';
            } else {
                state.historyIndex = state.history.length;
                input.value = '';
            }
        }
    });

    const shouldIgnoreToggle = (target) => {
        if (!target) return false;
        const tag = target.tagName;
        if (!tag) return false;
        if (['INPUT', 'TEXTAREA', 'SELECT'].includes(tag)) return true;
        if (target.isContentEditable) return true;
        return false;
    };

    document.addEventListener('keydown', (event) => {
        if (event.code === 'Backquote' && !event.ctrlKey && !event.metaKey && !event.altKey) {
            if (shouldIgnoreToggle(event.target)) return;
            event.preventDefault();
            toggle();
        }
        if (event.key === 'Escape' && state.open) {
            setOpen(false);
        }
    });

    writeLine('Powernine console ready. Type HELP for available commands.');
})();
