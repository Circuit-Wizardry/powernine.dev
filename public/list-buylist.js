document.addEventListener('DOMContentLoaded', () => {
    // --- DOM Elements ---
    const analysisContainer = document.getElementById('analysis-container');
    const scrapeAllBtn = document.getElementById('scrape-all-btn');
    const progressContainer = document.getElementById('progress-container');
    const progressBar = document.getElementById('progress-bar');
    const progressText = document.getElementById('progress-text');
    const listNameHeader = document.getElementById('list-name-header');
    const tcgLowSlider = document.getElementById('tcg-low-slider');
    const tcgLowSliderValue = document.getElementById('tcg-low-slider-value');

    // --- State ---
    let cardList = [];
    const pathParts = window.location.pathname.split('/');
    const listId = pathParts[pathParts.length - 1];
    let tcgLowTargetPercent = tcgLowSlider ? Number(tcgLowSlider.value) / 100 : 0.85;

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

    const CARD_IMAGE_PLACEHOLDER = '/image/card-placeholder.jpg';

    const buildTcgImageUrl = (tcgId) => {
        if (!tcgId) return null;
        return `https://tcgplayer-cdn.tcgplayer.com/product/${tcgId}_in_200x200.jpg`;
    };

    const tryParseJson = (value) => {
        if (!value) return null;
        if (typeof value === 'string') {
            try {
                return JSON.parse(value);
            } catch {
                return null;
            }
        }
        return typeof value === 'object' ? value : null;
    };

    const findImageFromCardData = (cardData) => {
        const parsedCard = tryParseJson(cardData) || cardData;
        if (!parsedCard || typeof parsedCard !== 'object') return null;

        const directImage = tryParseJson(parsedCard.imageUris || parsedCard.image_uris);
        if (directImage) {
            return directImage.normal || directImage.large || directImage.small || directImage.png || directImage.border_crop || null;
        }

        const faces = tryParseJson(parsedCard.cardFaces || parsedCard.card_faces);
        if (Array.isArray(faces)) {
            for (const face of faces) {
                const faceImage = findImageFromCardData(face);
                if (faceImage) return faceImage;
            }
        }

        return null;
    };

    const resolveInitialImageUrl = (card) => {
        if (!card) return null;

        const directKeys = ['imageUrl', 'imageURI', 'image_uri', 'imageSmall', 'image_small', 'smallImage'];
        for (const key of directKeys) {
            if (card[key]) return card[key];
        }

        const idCandidates = [
            card.tcgplayerId,
            card.tcgplayerID,
            card.tcgplayerProductId,
            card.tcgplayerProductID,
            card.tcgplayer_id
        ].filter(Boolean);

        for (const id of idCandidates) {
            const url = buildTcgImageUrl(id);
            if (url) {
                if (!card.tcgplayerId) card.tcgplayerId = id;
                return url;
            }
        }

        return null;
    };

    const updateImageFromDetails = (imageEl, card, cardDetails) => {
        if (!imageEl) return;

        const idCandidates = [
            card?.tcgplayerId,
            card?.tcgplayerProductId,
            cardDetails?.identifiers?.tcgplayerProductId,
            cardDetails?.identifiers?.tcgplayerId
        ].filter(Boolean);

        for (const id of idCandidates) {
            const url = buildTcgImageUrl(id);
            if (url) {
                if (card) card.tcgplayerId = id;
                imageEl.src = url;
                return;
            }
        }

        const fallbackImage = findImageFromCardData(cardDetails?.card);
        if (fallbackImage) {
            imageEl.src = fallbackImage;
        }
    };

    const writePriceCell = (cell, value, fallbackText = 'N/A') => {
        if (!cell) return;
        if (typeof value === 'number' && Number.isFinite(value)) {
            cell.textContent = formatPrice(value);
            cell.dataset.numeric = value;
        } else if (typeof value === 'string') {
            cell.textContent = value;
            delete cell.dataset.numeric;
        } else {
            cell.textContent = fallbackText;
            delete cell.dataset.numeric;
        }
    };

    const getBaseLowForCard = (card) => {
        if (typeof card.tcgLow === 'number' && Number.isFinite(card.tcgLow)) return card.tcgLow;
        if (typeof card.tcgLowPlusShipping === 'number' && Number.isFinite(card.tcgLowPlusShipping)) return card.tcgLowPlusShipping;
        return null;
    };

    const computeTargetBuyPrice = (card) => {
        const baseLow = getBaseLowForCard(card);
        if (!Number.isFinite(baseLow)) return null;
        const target = baseLow * tcgLowTargetPercent;
        return Number.isFinite(target) ? target : null;
    };

    const applyProfitClasses = (card, itemContainer) => {
        if (!itemContainer) return;
        const referencePrice =
            (typeof card.targetBuyPrice === 'number' && Number.isFinite(card.targetBuyPrice))
                ? card.targetBuyPrice
                : getBaseLowForCard(card);

        ['ckBuylist', 'scgBuylist', 'csiBuylist'].forEach((buylistKey) => {
            const cell = itemContainer.querySelector(`[data-price-type="${buylistKey}"]`);
            if (!cell) return;
            cell.classList.remove('profitable', 'warning', 'loss');

            const value = Number(cell.dataset.numeric);
            if (!Number.isFinite(value) || !Number.isFinite(referencePrice)) return;

            const ratio = value / referencePrice;
            if (ratio >= 1.05) {
                cell.classList.add('profitable');
            } else if (ratio >= 0.95) {
                cell.classList.add('warning');
            } else {
                cell.classList.add('loss');
            }
        });
    };

    const updateTargetHeaders = () => {
        const percentLabel = `${Math.round(tcgLowTargetPercent * 100)}%`;
        document.querySelectorAll('[data-role="target-percent-label"]').forEach(label => {
            label.textContent = percentLabel;
        });
        if (tcgLowSliderValue) {
            tcgLowSliderValue.textContent = percentLabel;
        }
    };

    const refreshTargetAndProfit = () => {
        cardList.forEach((card) => {
            const container = document.getElementById(`analysis-item-${card.id}`);
            if (!container) return;
            card.targetBuyPrice = computeTargetBuyPrice(card);
            const targetCell = container.querySelector('[data-price-type="targetBuy"]');
            writePriceCell(targetCell, card.targetBuyPrice, '--');
            applyProfitClasses(card, container);
        });
    };

    updateTargetHeaders();

    const updatePriceRow = (cardId, data, isLiveScrape = false) => {
        const itemContainer = document.getElementById(`analysis-item-${cardId}`);
        if (!itemContainer) return;

        const card = cardList.find(c => c.id === cardId);
        if (!card) return;

        if (isLiveScrape) {
            if (typeof data.tcgLow === 'number' && Number.isFinite(data.tcgLow)) {
                card.tcgLow = data.tcgLow;
            }
            if (typeof data.tcgLowPlusShipping === 'number' && Number.isFinite(data.tcgLowPlusShipping)) {
                card.tcgLowPlusShipping = data.tcgLowPlusShipping;
            }

            const tcgLowCell = itemContainer.querySelector('[data-price-type="tcgLow"]');
            writePriceCell(tcgLowCell, card.tcgLow, 'Awaiting scrape');

            const tcgLowShipCell = itemContainer.querySelector('[data-price-type="tcgLowPlusShipping"]');
            writePriceCell(tcgLowShipCell, card.tcgLowPlusShipping, 'Awaiting scrape');
        } else {
            const foilType = card.foilType;
            const tcgMarketPrice = getLatestPrice(data?.paper?.tcgplayer?.retail?.[foilType]);
            const ckBuylistPrice = getBuylists(data, 'cardkingdom', foilType);
            const scgBuylistPrice = getBuylists(data, 'starcitygames', foilType);
            const csiBuylistPrice = getBuylists(data, 'coolstuffinc', foilType);

            card.tcgMarketPrice = tcgMarketPrice;
            card.ckBuylistPrice = ckBuylistPrice;
            card.scgBuylistPrice = scgBuylistPrice;
            card.csiBuylistPrice = csiBuylistPrice;

            writePriceCell(itemContainer.querySelector('[data-price-type="tcgMarketPrice"]'), tcgMarketPrice);
            writePriceCell(itemContainer.querySelector('[data-price-type="ckBuylist"]'), ckBuylistPrice);
            writePriceCell(itemContainer.querySelector('[data-price-type="scgBuylist"]'), scgBuylistPrice);
            writePriceCell(itemContainer.querySelector('[data-price-type="csiBuylist"]'), csiBuylistPrice);
        }

        card.targetBuyPrice = computeTargetBuyPrice(card);
        writePriceCell(itemContainer.querySelector('[data-price-type="targetBuy"]'), card.targetBuyPrice, '--');

        applyProfitClasses(card, itemContainer);
    };
    
    const renderAndFetchDetails = async (card) => {
        const itemElement = document.createElement('div');
        itemElement.className = 'analysis-item';
        itemElement.id = `analysis-item-${card.id}`;

        const initialImageUrl = resolveInitialImageUrl(card) || CARD_IMAGE_PLACEHOLDER;
        const percentLabel = `${Math.round(tcgLowTargetPercent * 100)}%`;

        itemElement.innerHTML = `
            <img src="${initialImageUrl}" alt="${card.name}" class="item-image" data-role="card-image" style="width: 50px; height: 70px;">
            <div class="item-details">
                <div class="item-header">${card.name} (x${card.quantity}) (${card.setCode}) - ${card.foilType}</div>
                <div class="price-table-container">
                    <table>
                        <thead>
                            <tr>
                                <th>TCG Market</th>
                                <th>TCG Low</th>
                                <th class="target-column">Target @ <span data-role="target-percent-label">${percentLabel}</span></th>
                                <th>TCG Low + Ship</th>
                                <th>CK Buylist</th>
                                <th>SCG Buylist</th>
                                <th>CSI Buylist</th>
                            </tr>
                        </thead>
                        <tbody>
                            <tr>
                                <td data-price-type="tcgMarketPrice">...</td>
                                <td data-price-type="tcgLow">Awaiting scrape</td>
                                <td data-price-type="targetBuy">--</td>
                                <td data-price-type="tcgLowPlusShipping">Awaiting scrape</td>
                                <td data-price-type="ckBuylist">...</td>
                                <td data-price-type="scgBuylist">...</td>
                                <td data-price-type="csiBuylist">...</td>
                            </tr>
                        </tbody>
                    </table>
                </div>
            </div>`;
        analysisContainer.appendChild(itemElement);
        const tcgLowCell = itemElement.querySelector('[data-price-type="tcgLow"]');
        writePriceCell(tcgLowCell, card.tcgLow, 'Awaiting scrape');

        const tcgLowShipCell = itemElement.querySelector('[data-price-type="tcgLowPlusShipping"]');
        writePriceCell(tcgLowShipCell, card.tcgLowPlusShipping, 'Awaiting scrape');

        card.targetBuyPrice = computeTargetBuyPrice(card);
        const targetCell = itemElement.querySelector('[data-price-type="targetBuy"]');
        writePriceCell(targetCell, card.targetBuyPrice, '--');
        applyProfitClasses(card, itemElement);

        const imageElement = itemElement.querySelector('[data-role="card-image"]');
        if (imageElement) {
            imageElement.addEventListener('error', () => {
                imageElement.onerror = null;
                imageElement.src = CARD_IMAGE_PLACEHOLDER;
            }, { once: true });
        }

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

            updateImageFromDetails(imageElement, card, cardDetails);
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
                    condition: "LP",
                    store: 'tcgplayer'
                  })
                })
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

            cardList = listData.content.map((card, index) => ({
                ...card,
                id: `${card.setCode}-${card.collectorNumber}-${card.foilType}-${index}`,
                tcgLow: (typeof card.tcgLow === 'number' && !isNaN(card.tcgLow)) ? card.tcgLow : null,
                tcgLowPlusShipping: (typeof card.tcgLowPlusShipping === 'number' && !isNaN(card.tcgLowPlusShipping)) ? card.tcgLowPlusShipping : null,
                targetBuyPrice: null
            }));
            listNameHeader.textContent = listData.name || `Analysis for List ${listId}`;

            if (cardList.length === 0) {
                 analysisContainer.innerHTML = '<p>This list is empty.</p>';
                 return;
            }
            analysisContainer.innerHTML = '';

            cardList.forEach(card => renderAndFetchDetails(card));
            refreshTargetAndProfit();

        } catch (error) {
            console.error(error);
            analysisContainer.innerHTML = `<p style="color: red;">${error.message}</p>`;
        }
    };

    if (tcgLowSlider) {
        tcgLowSlider.addEventListener('input', (event) => {
            tcgLowTargetPercent = Number(event.target.value) / 100;
            updateTargetHeaders();
            refreshTargetAndProfit();
        });
    }

    scrapeAllBtn.addEventListener('click', scrapeAllItems);
    initializePage();
});


