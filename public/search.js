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

    const renderPrintingsForCard = async (cardName) => {
        if (!cardName) return;

        const searchDiv = document.getElementById('search-div');
        if (searchDiv) {
            searchDiv.style.position = 'fixed';
            searchDiv.style.top = '2%';
        }

        printingsContainer.style.display = 'flex';
        printingsContainer.textContent = 'Loading printings...';

        try {
            const response = await fetch(`/api/printings/${encodeURIComponent(cardName)}`);
            if (!response.ok) throw new Error('Card not found');
            const allPrintings = await response.json();

            const printingsMap = new Map();
            for (const printing of allPrintings) {
                if (!printingsMap.has(printing.id)) {
                    printingsMap.set(printing.id, {
                        ...printing,
                        available_finishes: new Set()
                    });
                }
                printing.finishes.forEach(finish => {
                    printingsMap.get(printing.id).available_finishes.add(finish);
                });
            }

            const combinedPrintings = Array.from(printingsMap.values());
            printingsContainer.innerHTML = '';

            if (combinedPrintings.length === 0) {
                throw new Error('No valid printings found');
            }

            combinedPrintings.forEach(printing => {
                if (!printing.image_uris) return;

                const itemDiv = document.createElement('div');
                itemDiv.className = 'printing-item';

                const img = document.createElement('img');
                img.src = printing.image_uris.small;
                img.title = `${printing.name} - ${printing.set_name} (${printing.set.toUpperCase()}) #${printing.collector_number}`;
                img.alt = img.title;
                itemDiv.appendChild(img);

                const infoDiv = document.createElement('div');
                infoDiv.className = 'printing-info';
                infoDiv.textContent = `[${printing.set.toUpperCase()}] #${printing.collector_number}`;
                itemDiv.appendChild(infoDiv);

                const finishesContainer = document.createElement('div');
                finishesContainer.className = 'finishes-container';

                if (printing.available_finishes.has('nonfoil')) {
                    const badge = document.createElement('span');
                    badge.className = 'finish-badge nonfoil';
                    badge.style.color = 'white';
                    badge.textContent = 'Non-Foil';
                    finishesContainer.appendChild(badge);
                }
                if (printing.available_finishes.has('foil')) {
                    const badge = document.createElement('span');
                    badge.className = 'finish-badge foil';
                    badge.style.color = 'gold';
                    badge.textContent = 'Foil';
                    finishesContainer.appendChild(badge);
                }
                if (printing.available_finishes.has('etched')) {
                    const badge = document.createElement('span');
                    badge.className = 'finish-badge etched';
                    badge.style.color = 'deepskyblue';
                    badge.textContent = 'Etched';
                    finishesContainer.appendChild(badge);
                }

                itemDiv.appendChild(finishesContainer);

                const expandButton = document.createElement('a');
                expandButton.className = 'expand-button';
                expandButton.textContent = 'View Details';
                expandButton.href = `/cards/${printing.set}/${printing.collector_number}`;
                itemDiv.appendChild(expandButton);

                itemDiv.addEventListener('click', () => {
                    document.querySelectorAll('.printing-item.selected').forEach(el => el.classList.remove('selected'));
                    itemDiv.classList.add('selected');
                });

                printingsContainer.appendChild(itemDiv);
            });
        } catch (error) {
            printingsContainer.innerHTML = `<p class="error">Could not find any printings for "${cardName}".</p>`;
        }
    };

    new CardSearchWidget({
        input: searchBar,
        limit: 10,
        onSelect: (card) => {
            searchBar.value = card.name;
            renderPrintingsForCard(card.name);
        },
    });
});
