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

const transactionHistoryBtn = document.getElementById('transaction-history-btn');
if (transactionHistoryBtn) {
    transactionHistoryBtn.addEventListener('click', () => {
        window.location.href = '/transactions.html';
    });
}

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
