document.addEventListener('DOMContentLoaded', () => {
    // --- DOM ELEMENTS ---
    const container = document.getElementById('card-list-container');
    const switchViewBtn = document.getElementById('switch-view-btn');
    const searchBar = document.getElementById('search-bar');
    const sortButtons = document.querySelectorAll('.sort-button');
    const totalValueEl = document.getElementById('total-value-amount');

    // --- STATE ---
    let allCards = [];
    let currentSort = { key: 'price', order: 'desc' };
    let totalCollectionValue = 0;

    // --- HELPER FUNCTIONS ---
    const getLatestPrice = (priceHistory) => {
        if (!priceHistory || typeof priceHistory !== 'object' || Object.keys(priceHistory).length === 0) return 0;
        const latestDate = Object.keys(priceHistory).sort((a, b) => new Date(b) - new Date(a))[0];
        return priceHistory[latestDate] || 0;
    };
    const createFoilIndicator = (foilType) => {
        if (foilType === 'foil') return '<span class="foil-indicator">✨ Foil</span>';
        if (foilType === 'etched') return '<span class="foil-indicator">💎 Etched</span>';
        return '';
    };

    /**
     * Renders the entire list of cards to the DOM, showing skeletons for unloaded cards.
     */
    const renderCardList = (cardsToRender) => {
        container.innerHTML = '';
        if (cardsToRender.length === 0) {
            container.innerHTML = '<p>No cards match your search.</p>';
            return;
        }
        for (const card of cardsToRender) {
            const cardElement = document.createElement('div');
            cardElement.className = 'card-item';
            cardElement.id = `card-${card.id}`;

            if (!card.isLoaded) {
                cardElement.classList.add('skeleton');
                cardElement.innerHTML = `
                    <div class="card-image"></div>
                    <div class="card-info">
                        <h3></h3><p></p>
                    </div>
                    <div class="card-pricing">
                        <div class="vendor-prices-skeleton"></div>
                    </div>
                    <div class="card-graph-skeleton"></div>
                `;
            } else {
                cardElement.innerHTML = `
                    <img src="${card.imageUrl}" alt="${card.name}" class="card-image">
                    <div class="card-info">
                        <h3>${card.name} (x${card.quantity}) ${createFoilIndicator(card.foilType)}</h3>
                        <p>${card.setName} (#${card.collectorNumber})</p>
                    </div>
                    <div class="card-pricing">
                        <table class="vendor-prices">
                            <tbody>
                                <tr><td><h4>tcgplayer</h4></td><td style="color: green;"><h3>$${card.price.toFixed(2)}</h3></td></tr>
                                <tr><td><h4>c.kingdom</h4></td><td style="color: green;"><h3>$${card.ckPrice.toFixed(2)}</h3></td></tr>
                                <tr><td><h4>cardhoarder</h4></td><td style="color: green;"><h3>$${card.chPrice.toFixed(2)}</h3></td></tr>                            </tbody>
                        </table>
                    </div>
                    <div class="card-graph-container">
                        <canvas id="chart-${card.id}"></canvas>
                    </div>
                `;
            }
            container.appendChild(cardElement);
        }
    };

    /**
     * Renders a multi-line price history chart for a single card.
     */
    const renderChart = (card) => {
        const canvas = document.getElementById(`chart-${card.id}`);
        if (!canvas) return;

        const vendorsToChart = [
            { name: 'TCGPlayer', data: card.tcgHistory, color: 'rgba(75, 192, 192, 1)' },
            { name: 'Card Kingdom', data: card.ckHistory, color: 'rgba(255, 99, 132, 1)' }
        ];

        const allDates = new Set();
        const validHistories = vendorsToChart.filter(v => v.data && Object.keys(v.data).length > 0);
        if (validHistories.length === 0) return;

        validHistories.forEach(vendor => Object.keys(vendor.data).forEach(date => allDates.add(date)));
        const chartLabels = Array.from(allDates).sort((a, b) => new Date(a) - new Date(b));
        
        const datasets = validHistories.map(vendor => {
            let lastKnownPrice = null;
            const pricePoints = chartLabels.map(date => {
                if (vendor.data[date] !== undefined) lastKnownPrice = vendor.data[date];
                return lastKnownPrice;
            });
            return {
                label: vendor.name, data: pricePoints, borderColor: vendor.color,
                fill: false, tension: 0.4, pointRadius: 0, spanGaps: true
            };
        });

        new Chart(canvas.getContext('2d'), {
            type: 'line',
            data: { labels: chartLabels, datasets: datasets },
            options: {
                responsive: true, maintainAspectRatio: false,
                interaction: { intersect: false, mode: 'index' },
                plugins: { legend: { display: false, labels: { color: '#aaa' } } },
                scales: {
                    x: { ticks: { display: false } },
                    y: { ticks: { color: '#aaa', callback: (value) => `$${value}` } }
                }
            }
        });
    };

    /**
     * Fetches detailed data for all cards and updates them in place.
     */
    const fetchAllCardDetails = async () => {
        totalCollectionValue = 0;
        for (const card of allCards) {
            try {
                const [scryfallResponse, priceResponse] = await Promise.all([
                    fetch(`https://api.scryfall.com/cards/${card.setCode.toLowerCase()}/${card.collectorNumber}`),
                    fetch(`/api/prices/${card.setCode}/${card.collectorNumber}`)
                ]);

                if (!scryfallResponse.ok) continue;

                const scryfallData = await scryfallResponse.json();
                const priceData = priceResponse.ok ? await priceResponse.json() : null;
                
                card.name = scryfallData.name;
                card.setName = scryfallData.set_name;
                card.imageUrl = scryfallData.image_uris?.small || 'https://placehold.co/63x88/2c2c2c/e0e0e0?text=N/A';
                
                const paperPrices = priceData?.paper;
                const mtgoPrices = priceData?.mtgo;

                card.price = getLatestPrice(paperPrices?.tcgplayer?.retail?.[card.foilType]);
                card.ckPrice = getLatestPrice(paperPrices?.cardkingdom?.retail?.[card.foilType]);
                card.chPrice = getLatestPrice(mtgoPrices?.cardhoarder?.retail?.[card.foilType]);
                card.tcgHistory = paperPrices?.tcgplayer?.retail?.[card.foilType];
                card.ckHistory = paperPrices?.cardkingdom?.retail?.[card.foilType];
                card.isLoaded = true;

                totalCollectionValue += card.price * card.quantity;
                if (totalValueEl) totalValueEl.textContent = `$${totalCollectionValue.toFixed(2)}`;

                const existingElement = document.getElementById(`card-${card.id}`);
                if (existingElement) {
                    existingElement.classList.remove('skeleton');
                    existingElement.innerHTML = `
                        <img src="${card.imageUrl}" alt="${card.name}" class="card-image">
                        <div class="card-info">
                            <h3>${card.name} (x${card.quantity}) ${createFoilIndicator(card.foilType)}</h3>
                            <p>${card.setName} (#${card.collectorNumber})</p>
                        </div>
                        <div class="card-pricing">
                            <table class="vendor-prices">
                                <tbody>
                                <tr><td><h4>tcgplayer</h4></td><td style="color: green;"><h3>$${card.price.toFixed(2)}</h3></td></tr>
                                <tr><td><h4>c.kingdom</h4></td><td style="color: green;"><h3>$${card.ckPrice.toFixed(2)}</h3></td></tr>
                                <tr><td><h4>cardhoarder</h4></td><td style="color: green;"><h3>$${card.chPrice.toFixed(2)}</h3></td></tr>
                                </tbody>
                            </table>
                        </div>
                        <div class="card-graph-container">
                            <canvas id="chart-${card.id}"></canvas>
                        </div>
                    `;
                    renderChart(card);
                }
            } catch (error) {
                console.error(`Failed to load details for ${card.name} (${card.collectorNumber}):`, error);
                card.isLoaded = true;
                card.price = 0; card.ckPrice = 0; card.chPrice = 0;
            }
        }
    };

    const sortAndRender = () => {
        allCards.sort((a, b) => {
            const valA = a[currentSort.key] || 0;
            const valB = b[currentSort.key] || 0;
            return currentSort.order === 'asc' ? valA - valB : valB - valA;
        });
        searchAndRender();
    };
    
    const searchAndRender = () => {
        const searchTerm = searchBar.value.toLowerCase();
        const filteredCards = searchTerm
            ? allCards.filter(card => card.name?.toLowerCase().includes(searchTerm))
            : allCards;
        renderCardList(filteredCards);
        
        filteredCards.forEach(card => {
            if (card.isLoaded) {
                renderChart(card);
            }
        });
    };

    const initializePage = async () => {
        const pathParts = window.location.pathname.split('/');
        const listId = pathParts[pathParts.length - 1];
        if (!listId) {
            container.innerHTML = '<p>No list ID found. Please import a CSV file first.</p>';
            return;
        }
        switchViewBtn.href = `/binder/${listId}`;
        try {
            const listResponse = await fetch(`/api/list/${listId}`);
            if (!listResponse.ok) throw new Error("Could not find this list.");
            const importedCards = await listResponse.json();
            allCards = importedCards.map((card, index) => ({
                ...card,
                id: `${card.setCode}-${card.collectorNumber}-${card.foilType}-${index}`,
                isLoaded: false, price: 0, ckPrice: 0, chPrice: 0
            }));
            renderCardList(allCards);
            fetchAllCardDetails();
        } catch (error) {
            container.innerHTML = `<p style="color: #ff8a80;">${error.message}</p>`;
        }
    };

    searchBar.addEventListener('input', searchAndRender);
    sortButtons.forEach(button => {
        button.addEventListener('click', () => {
            const sortKey = button.dataset.sort;
            if (currentSort.key === sortKey) {
                currentSort.order = currentSort.order === 'asc' ? 'desc' : 'asc';
            } else {
                currentSort.key = sortKey;
                currentSort.order = 'desc';
            }
            sortButtons.forEach(btn => btn.classList.remove('active'));
            button.classList.add('active');
            sortAndRender();
        });
    });

    initializePage();
});

