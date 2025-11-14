document.addEventListener('DOMContentLoaded', () => {
    if (!window.cardUtils) {
        console.error('cardUtils utilities are not available.');
        return;
    }

    const { CardSearchWidget } = window.cardUtils;
    const printingsContainer = document.getElementById('printings-container');
    const searchBar = document.getElementById('search-bar');

    if (!searchBar) {
        return;
    }

    const showStatus = (message, state = 'error') => {
        if (!printingsContainer) return;
        printingsContainer.textContent = message;
        printingsContainer.dataset.state = state;
        printingsContainer.style.display = 'block';
    };

    const clearStatus = () => {
        if (!printingsContainer) return;
        printingsContainer.textContent = '';
        printingsContainer.removeAttribute('data-state');
        printingsContainer.style.display = 'none';
    };
    clearStatus();

    const selectLatestPrinting = (printings = []) => {
        const filtered = printings.filter(printing =>
            printing &&
            printing.set &&
            printing.collector_number &&
            printing.digital !== true
        );
        if (filtered.length === 0) return null;
        filtered.sort((a, b) => {
            const dateA = new Date(a.released_at || a.releaseDate || 0);
            const dateB = new Date(b.released_at || b.releaseDate || 0);
            return dateB - dateA;
        });
        return filtered[0];
    };

    let navigationAbort = null;
    const navigateToCard = async (cardName) => {
        if (!cardName) return;
        if (navigationAbort) {
            navigationAbort.abort();
        }
        navigationAbort = new AbortController();
        clearStatus();
        try {
            const response = await fetch(`/api/printings/${encodeURIComponent(cardName)}`, {
                signal: navigationAbort.signal,
            });
            if (!response.ok) {
                throw new Error('Unable to find that card. Try another search?');
            }
            const printings = await response.json();
            const latest = selectLatestPrinting(printings);
            if (!latest) {
                throw new Error('No printings available for that selection.');
            }
            window.location.href = `/cards/${latest.set}/${latest.collector_number}`;
        } catch (error) {
            if (error.name === 'AbortError') {
                return;
            }
            console.error('Failed to navigate to card:', error);
            showStatus(error.message || 'Something went wrong loading that card.', 'error');
        }
    };

    new CardSearchWidget({
        input: searchBar,
        limit: 10,
        showSetInfo: false,
        onSelect: (card) => {
            searchBar.value = card.name;
            navigateToCard(card.name);
        },
    });

    searchBar.addEventListener('input', () => {
        if (!searchBar.value.trim()) {
            clearStatus();
        }
    });
});
