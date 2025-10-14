document.addEventListener('DOMContentLoaded', () => {
    // --- DOM Elements ---
    const analysisContainer = document.getElementById('analysis-container');
    const scrapeAllBtn = document.getElementById('scrape-all-btn');
    const progressContainer = document.getElementById('progress-container');
    const progressBar = document.getElementById('progress-bar');
    const progressText = document.getElementById('progress-text');
    const listNameHeader = document.getElementById('list-name-header');

    // --- State ---
    let cardList = [];
    const pathParts = window.location.pathname.split('/');
    const listId = pathParts[pathParts.length - 1];

    // --- Helper Functions ---
    const formatPrice = (value) => {
        if (typeof value === 'number' && !isNaN(value)) {
            return `$${value.toFixed(2)}`;
        }
        return 'N/A';
    };

    const getLatestPrice = (priceHistory) => {
        if (!priceHistory || typeof priceHistory !== 'object' || Object.keys(priceHistory).length === 0) return null;
        const latestDate = Object.keys(priceHistory).sort((a, b) => new Date(b) - new Date(a))[0];
        return priceHistory[latestDate] || 0;
    };

    const getBuylists = (pricesData, vendor, foilType) => {
        const priceHistory = pricesData?.paper?.[vendor]?.buylist?.[foilType];
        if (!priceHistory || typeof priceHistory !== 'object' || Object.keys(priceHistory).length === 0) {
            return null;
        }
        const latestDate = Object.keys(priceHistory).sort((a, b) => new Date(b) - new Date(a))[0];
        return priceHistory[latestDate] || 0;
    };

    const updatePriceRow = (cardId, data, isLiveScrape = false) => {
        const itemContainer = document.getElementById(`analysis-item-${cardId}`);
        if (!itemContainer) return;

        const card = cardList.find(c => c.id === cardId);
        if (!card) return;

        if (isLiveScrape) {
            for (const key in data) {
                const cell = itemContainer.querySelector(`[data-price-type="${key}"]`);
                if (cell) {
                    cell.textContent = formatPrice(data[key]);
                }
            }
            const newReferencePrice = data.tcgLowPlusShipping;
            ['ckBuylist', 'scgBuylist', 'csiBuylist'].forEach(buylistKey => {
                const buylistCell = itemContainer.querySelector(`[data-price-type="${buylistKey}"]`);
                if (buylistCell) {
                    const buylistPrice = parseFloat(buylistCell.textContent.replace('$', ''));
                    if (!isNaN(buylistPrice) && typeof newReferencePrice === 'number' && buylistPrice > newReferencePrice) {
                        buylistCell.classList.add('profitable');
                    } else {
                        buylistCell.classList.remove('profitable');
                    }
                }
            });
        } else {
            const referencePrice = card.tcgLowPlusShipping;
            const foilType = card.foilType;

            const pricesToUpdate = {
                tcgMarketPrice: getLatestPrice(data?.paper?.tcgplayer?.retail?.[foilType]),
                ckBuylist: getBuylists(data, 'cardkingdom', foilType),
                scgBuylist: getBuylists(data, 'starcitygames', foilType),
                csiBuylist: getBuylists(data, 'coolstuffinc', foilType)
            };

            for (const key in pricesToUpdate) {
                const cell = itemContainer.querySelector(`[data-price-type="${key}"]`);
                if (cell) {
                    const value = pricesToUpdate[key];
                    cell.textContent = formatPrice(value);
                    if (key.includes('Buylist')) {
                        if (typeof value === 'number' && typeof referencePrice === 'number' && value > referencePrice) {
                            cell.classList.add('profitable');
                        } else {
                            cell.classList.remove('profitable');
                        }
                    }
                }
            }
        }
    };
    
    const renderAndFetchDetails = async (card) => {
        const itemElement = document.createElement('div');
        itemElement.className = 'analysis-item';
        // Use a unique ID based on the card's properties
        card.id = `${card.setCode}-${card.collectorNumber}-${card.foilType}`;
        itemElement.id = `analysis-item-${card.id}`;

        console.log(card)

        const imageUrl = `https://tcgplayer-cdn.tcgplayer.com/product/${card.tcgplayerId}_in_200x200.jpg`
            

        itemElement.innerHTML = `
            <img src="${imageUrl}" alt="${card.name}" class="item-image" style="width: 50px; height: 70px;">
            <div class="item-details">
                <div class="item-header">${card.name} (x${card.quantity}) (${card.setCode}) - ${card.foilType}</div>
                <div class="price-table-container">
                    <table>
                        <thead> <tr> <th>TCG Market</th> <th>TCG Low</th> <th>TCG Low + Ship</th> <th>CK Buylist</th> <th>SCG Buylist</th> <th>CSI Buylist</th> </tr> </thead>
                        <tbody>
                            <tr>
                                <td data-price-type="tcgMarketPrice">...</td>
                                <td data-price-type="tcgLow">N/A</td>
                                <td data-price-type="tcgLowPlusShipping">N/A</td>
                                <td data-price-type="ckBuylist">...</td>
                                <td data-price-type="scgBuylist">...</td>
                                <td data-price-type="csiBuylist">...</td>
                            </tr>
                        </tbody>
                    </table>
                </div>
            </div>`;
        analysisContainer.appendChild(itemElement);

        try {
            const response = await fetch(`/api/card/details/${card.setCode}/${card.collectorNumber}`);
            if (!response.ok) throw new Error('Details fetch failed');
            const cardDetails = await response.json();
            
            // Passively store tcgplayerId if it wasn't in the list data
            if (cardDetails.identifiers && !card.tcgplayerId) {
                card.tcgplayerId = cardDetails.identifiers.tcgplayerProductId;
            }

            if (cardDetails && cardDetails.prices) {
                updatePriceRow(card.id, cardDetails.prices, false);
            }
        } catch (error) {
            console.warn(`Could not fetch details for ${card.name}:`, error);
        }
    };

    const scrapeAllItems = async () => {
        scrapeAllBtn.disabled = true;
        progressContainer.classList.remove('hidden');
        const totalItems = cardList.length;

        for (let i = 0; i < totalItems; i++) {
            const card = cardList[i];
            const itemElement = document.getElementById(`analysis-item-${card.id}`);

            const progressPercentage = ((i + 1) / totalItems) * 100;
            progressBar.style.width = `${progressPercentage}%`;
            progressText.textContent = `Scraping ${i + 1} / ${totalItems}`;

            if (itemElement) itemElement.classList.add('scraping');

            try {
                if (!card.tcgplayerId) {
                    console.warn(`Skipping scrape for ${card.name} (no TCGPlayer ID)`);
                    continue;
                }
                const response = await fetch('/api/scrape-lows', {
                  method: 'POST',
                  headers: {
                    'Content-Type': 'application/json'
                  },
                  body: JSON.stringify({
                    tcgplayerId: card.tcgplayerId,
                    cardName: card.name,
                    setCode: card.setCode,
                    collectorNumber: card.collectorNumber,
                    foilType: card.foilType,
                    condition: "LP"
                  })
                })
                console.log(card)
                if (!response.ok) throw new Error(`Scrape failed for ${card.name}`);
                const scrapedData = await response.json();
                
                updatePriceRow(card.id, scrapedData, true);

            } catch (error) {
                console.error(error);
            } finally {
                if (itemElement) itemElement.classList.remove('scraping');
                await new Promise(resolve => setTimeout(resolve, 200));
            }
        }
        scrapeAllBtn.textContent = 'Scraping Complete';
        progressText.textContent = `Complete: ${totalItems} / ${totalItems}`;
    };

    const initializePage = async () => {
        if (!listId) {
            analysisContainer.innerHTML = '<p style="color: red;">No list ID found in URL.</p>';
            return;
        }

        try {
            const response = await fetch(`/api/list/${listId}`);
            if (!response.ok) throw new Error("Could not fetch list data.");
            const listData = await response.json();
            
            cardList = listData.content;
            listNameHeader.textContent = listData.name || `Analysis for List ${listId}`;

            if (cardList.length === 0) {
                 analysisContainer.innerHTML = '<p>This list is empty.</p>';
                 return;
            }
            analysisContainer.innerHTML = '';

            cardList.forEach(card => renderAndFetchDetails(card));

        } catch (error) {
            console.error(error);
            analysisContainer.innerHTML = `<p style="color: red;">${error.message}</p>`;
        }
    };

    scrapeAllBtn.addEventListener('click', scrapeAllItems);
    initializePage();
});
