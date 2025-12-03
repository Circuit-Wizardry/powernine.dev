(function(window) {
    function createBuylistModal(options = {}) {
        const {
            modal,
            formatCurrency = (value) => {
                if (typeof value === 'number' && Number.isFinite(value)) {
                    return `$${value.toFixed(2)}`;
                }
                return 'N/A';
            },
            formatListName = (value) => value || '',
            getLatestPrice = () => null,
            saveSnapshot,
            onSnapshotChange
        } = options;

        if (!modal) {
            const noop = () => {};
            return {
                init: noop,
                open: noop,
                setListNameResolver: noop,
                loadSnapshot: noop,
                runAnalysis: noop,
                close: noop
            };
        }

        const elements = {
            modal,
            backdrop: modal.querySelector('.buylist-modal-backdrop'),
            dialog: modal.querySelector('.buylist-modal-dialog'),
            closeBtn: modal.querySelector('[data-close=\"buylist-modal\"]') || document.getElementById('buylist-close-btn'),
            runBtn: document.getElementById('buylist-run-btn'),
            progressWrap: document.getElementById('buylist-progress'),
            progressFill: document.getElementById('buylist-progress-bar'),
            progressText: document.getElementById('buylist-progress-text'),
            slider: document.getElementById('buylist-target-slider'),
            sliderValue: document.getElementById('buylist-target-value'),
            sortSelect: document.getElementById('buylist-sort-select'),
            container: document.getElementById('buylist-analysis-container'),
            status: document.getElementById('buylist-snapshot-status'),
            subtitle: document.getElementById('buylist-modal-subtitle'),
            generateBtn: document.getElementById('buylist-generate-message-btn'),
            messageModal: document.getElementById('buylist-message-modal'),
            messageBackdrop: document.querySelector('#buylist-message-modal .buylist-modal-backdrop'),
            messageCloseBtn: document.getElementById('buylist-message-close-btn'),
            messageCards: document.getElementById('buylist-message-cards'),
            messagePrompt: document.getElementById('buylist-message-prompt'),
            messageOutput: document.getElementById('buylist-message-output'),
            messageGenerateBtn: document.getElementById('buylist-message-generate-btn'),
            messageCopyBtn: document.getElementById('buylist-message-copy-btn'),
            messageStatus: document.getElementById('buylist-message-status'),
            messageCount: document.getElementById('buylist-message-count'),
            messageSlider: document.getElementById('buylist-message-slider'),
            messageSliderValue: document.getElementById('buylist-message-slider-value')
        };

        const CARD_IMAGE_PLACEHOLDER = '/image/card-placeholder.jpg';
        const BUYLIST_KEYS = ['ckBuylist', 'scgBuylist', 'csiBuylist'];
        const BUYLIST_LABELS = {
            ckBuylist: 'Card Kingdom',
            scgBuylist: 'Star City Games',
            csiBuylist: 'CoolStuffInc'
        };
        const DEFAULT_MESSAGE_PROMPT = 'Draft a friendly message to a card seller asking if they\'d be open to my offer. Keep it informal. Examples: "Hey, I\'m interested in these cards:"; "Hi! I\'m interested in these cards". Do NOT include asterisks or markdown formatting. Keep it 1-2 sentences. List the cards interested in and the TOTAL price for all of them at the end. Do not include individual prices. Add whitespace between the card list so they\'re on different lines. Include amount of each card in the form (1) (2) etc';

        const priceTooltip = document.createElement('div');
        priceTooltip.className = 'buylist-tooltip';
        priceTooltip.style.left = '0px';
        priceTooltip.style.top = '0px';
        document.body.appendChild(priceTooltip);
        let tooltipActive = false;

        const normalizeSortKey = (value) => {
            if (value === 'profit-desc') return 'margin-percent-desc';
            return value || 'margin-percent-desc';
        };

        const formatSignedCurrency = (value) => {
            if (!Number.isFinite(value)) return 'N/A';
            const sign = value > 0 ? '+' : value < 0 ? '-' : '';
            return `${sign}${formatCurrency(Math.abs(value))}`;
        };

        const formatSignedPercent = (value) => {
            if (!Number.isFinite(value)) return 'N/A';
            const sign = value > 0 ? '+' : value < 0 ? '-' : '';
            return `${sign}${value.toFixed(1)}%`;
        };

        const state = {
            initialized: false,
            contextId: null,
            getCards: () => [],
            getListName: () => '',
            analysisItems: [],
            tcgLowTargetPercent: 0.85,
            sortKey: 'margin-percent-desc',
            isScraping: false,
            snapshot: null,
            savedAt: null,
            escHandler: null,
            snapshotSaveTimeout: null,
            saveSnapshot,
            onSnapshotChange,
            messageEscHandler: null,
            messageCandidates: [],
            primaryWasOpenBeforeMessage: false,
            negotiatePercent: 0.9
        };

        const toNumeric = (value) => {
            const num = Number(value);
            return Number.isFinite(num) ? num : null;
        };

        const writePriceCell = (cell, value, fallbackText = '--') => {
            if (!cell) return;
            if (typeof value === 'number' && Number.isFinite(value)) {
                cell.textContent = formatCurrency(value);
                cell.dataset.numeric = value;
            } else if (typeof value === 'string') {
                cell.textContent = value;
                delete cell.dataset.numeric;
            } else {
                cell.textContent = fallbackText;
                delete cell.dataset.numeric;
            }
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
            const parsed = tryParseJson(cardData) || cardData;
            if (!parsed || typeof parsed !== 'object') return null;

            const images = parsed.imageUris || parsed.image_uris;
            const parsedImages = tryParseJson(images) || images;
            if (parsedImages && typeof parsedImages === 'object') {
                return parsedImages.normal || parsedImages.large || parsedImages.small || parsedImages.png || parsedImages.border_crop || null;
            }

            const faces = tryParseJson(parsed.cardFaces || parsed.card_faces);
            if (Array.isArray(faces)) {
                for (const face of faces) {
                    const faceImage = findImageFromCardData(face);
                    if (faceImage) return faceImage;
                }
            }
            return null;
        };

        const resolveInitialImageUrl = (card) => {
            if (card.imageUrl) return card.imageUrl;
            if (card.tcgplayerId) {
                return `https://tcgplayer-cdn.tcgplayer.com/product/${card.tcgplayerId}_in_200x200.jpg`;
            }
            return CARD_IMAGE_PLACEHOLDER;
        };

        const updateImageFromDetails = (imageEl, card, cardDetails) => {
            if (!imageEl) return;
            const identifiers = cardDetails?.identifiers || {};
            const candidateIds = [card.tcgplayerId, identifiers.tcgplayerProductId, identifiers.tcgplayerId].filter(Boolean);
            if (!card.tcgplayerId && candidateIds.length) {
                card.tcgplayerId = candidateIds[0];
            }
            for (const id of candidateIds) {
                imageEl.src = `https://tcgplayer-cdn.tcgplayer.com/product/${id}_in_200x200.jpg`;
                card.imageUrl = imageEl.src;
                return;
            }
            const fallbackImage = findImageFromCardData(cardDetails?.card);
            if (fallbackImage) {
                imageEl.src = fallbackImage;
                card.imageUrl = fallbackImage;
            }
        };

        const updateStatus = (message, highlight = false) => {
            if (!elements.status) return;
            if (message) {
                elements.status.textContent = message;
            } else if (state.savedAt) {
                const savedDate = new Date(state.savedAt);
                elements.status.textContent = `Last saved ${savedDate.toLocaleString()}`;
            } else {
                elements.status.textContent = '';
            }
            if (highlight || state.savedAt) {
                elements.status.classList.add('active');
            } else {
                elements.status.classList.remove('active');
            }
        };

        const updateTargetLabels = () => {
            const percentText = `${Math.round(state.tcgLowTargetPercent * 100)}%`;
            if (elements.sliderValue) elements.sliderValue.textContent = percentText;
            state.analysisItems.forEach((item) => {
                if (item.targetLabel) item.targetLabel.textContent = percentText;
            });
        };

        const getReferencePrice = (item) => {
            if (Number.isFinite(item.metrics.targetBuyPrice)) return item.metrics.targetBuyPrice;
            if (Number.isFinite(item.metrics.tcgLowPlusShipping)) return item.metrics.tcgLowPlusShipping;
            if (Number.isFinite(item.metrics.tcgLow)) return item.metrics.tcgLow;
            return null;
        };

        const updateMarginsForItem = (item) => {
            const reference = getReferencePrice(item);
            item.metrics.margins = item.metrics.margins || {};

            BUYLIST_KEYS.forEach((key) => {
                const value = toNumeric(item.metrics[key]);
                let marginDollar = null;
                let marginPercent = null;

                if (Number.isFinite(value) && Number.isFinite(reference) && reference !== 0) {
                    marginDollar = value - reference;
                    marginPercent = (marginDollar / reference) * 100;
                } else if (Number.isFinite(value) && Number.isFinite(reference) && reference === 0) {
                    marginDollar = value;
                    marginPercent = null;
                } else if (!Number.isFinite(reference)) {
                    marginDollar = null;
                    marginPercent = null;
                }

                item.metrics.margins[key] = {
                    dollar: Number.isFinite(marginDollar) ? marginDollar : null,
                    percent: Number.isFinite(marginPercent) ? marginPercent : null,
                    reference: Number.isFinite(reference) ? reference : null
                };

                const cell = item.cells[key];
                if (cell) {
                    if (Number.isFinite(marginDollar)) {
                        cell.dataset.marginDollar = marginDollar;
                    } else {
                        delete cell.dataset.marginDollar;
                    }

                    if (Number.isFinite(marginPercent)) {
                        cell.dataset.marginPercent = marginPercent;
                    } else {
                        delete cell.dataset.marginPercent;
                    }

                    if (Number.isFinite(reference)) {
                        cell.dataset.reference = reference;
                    } else {
                        delete cell.dataset.reference;
                    }
                }
            });

            return reference;
        };

        const applyProfitClasses = (item) => {
            const reference = updateMarginsForItem(item);

            BUYLIST_KEYS.forEach((key) => {
                const cell = item.cells[key];
                if (!cell) return;
                cell.classList.remove('profitable', 'warning', 'loss');

                const value = toNumeric(item.metrics[key]);
                if (!Number.isFinite(value) || !Number.isFinite(reference) || reference <= 0) return;

                const ratio = value / reference;
                if (ratio >= 1.05) {
                    cell.classList.add('profitable');
                } else if (ratio >= 0.95) {
                    cell.classList.add('warning');
                } else {
                    cell.classList.add('loss');
                }
            });
        };

        const positionTooltip = (cell, event) => {
            let left;
            let top;
            if (event && typeof event.clientX === 'number' && typeof event.clientY === 'number') {
                left = event.clientX + window.scrollX + 16;
                top = event.clientY + window.scrollY + 16;
            } else {
                const rect = cell.getBoundingClientRect();
                left = rect.left + window.scrollX + rect.width / 2;
                top = rect.top + window.scrollY - 12;
            }

            const tooltipWidth = priceTooltip.offsetWidth || 200;
            const tooltipHeight = priceTooltip.offsetHeight || 100;
            const minLeft = window.scrollX + 12;
            const minTop = window.scrollY + 12;
            const maxLeft = window.scrollX + window.innerWidth - tooltipWidth - 12;
            const maxTop = window.scrollY + window.innerHeight - tooltipHeight - 12;

            if (!Number.isFinite(left)) left = minLeft;
            if (!Number.isFinite(top)) top = minTop;

            left = Math.min(Math.max(left, minLeft), Math.max(minLeft, maxLeft));
            top = Math.min(Math.max(top, minTop), Math.max(minTop, maxTop));

            priceTooltip.style.left = `${left}px`;
            priceTooltip.style.top = `${top}px`;
        };

        const buildTooltipContent = (label, value, reference, marginDollar, marginPercent) => {
            const valueText = Number.isFinite(value) ? formatCurrency(value) : 'N/A';
            const referenceText = Number.isFinite(reference) ? formatCurrency(reference) : 'N/A';
            const marginDollarText = formatSignedCurrency(marginDollar);
            const marginPercentText = formatSignedPercent(marginPercent);

            return `
                <div class="tooltip-title">${label}</div>
                <div class="tooltip-row"><span>Buylist</span><span>${valueText}</span></div>
                <div class="tooltip-row"><span>Reference</span><span>${referenceText}</span></div>
                <div class="tooltip-row"><span>Margin</span><span>${marginDollarText}</span></div>
                <div class="tooltip-row"><span>Margin (%)</span><span>${marginPercentText}</span></div>
            `;
        };

        const showPriceTooltip = (cell, item, key, event) => {
            updateMarginsForItem(item);
            const margins = item.metrics.margins?.[key] || {};
            const value = toNumeric(item.metrics[key]);
            priceTooltip.innerHTML = buildTooltipContent(
                cell.dataset.label || key,
                value,
                margins.reference,
                margins.dollar,
                margins.percent
            );
            positionTooltip(cell, (event && typeof event.clientX === 'number') ? event : null);
            priceTooltip.classList.add('visible');
            tooltipActive = true;
        };

        const hidePriceTooltip = () => {
            if (!tooltipActive) return;
            priceTooltip.classList.remove('visible');
            priceTooltip.innerHTML = '';
            tooltipActive = false;
        };

        const registerPriceHover = (cell, item, key, label) => {
            if (!cell) return;
            cell.classList.add('price-hoverable');
            cell.dataset.label = label;
            cell.setAttribute('tabindex', '0');
            cell.addEventListener('mouseenter', (event) => showPriceTooltip(cell, item, key, event));
            cell.addEventListener('mousemove', (event) => positionTooltip(cell, event));
            cell.addEventListener('mouseleave', hidePriceTooltip);
            cell.addEventListener('focus', (event) => showPriceTooltip(cell, item, key, event));
            cell.addEventListener('blur', hidePriceTooltip);
        };

        const computeTargetForItem = (item) => {
            const baseLow = Number.isFinite(item.metrics.tcgLowPlusShipping)
                ? item.metrics.tcgLowPlusShipping
                : Number.isFinite(item.metrics.tcgLow)
                    ? item.metrics.tcgLow
                    : null;

            if (Number.isFinite(baseLow)) {
                item.metrics.targetBuyPrice = baseLow * state.tcgLowTargetPercent;
                writePriceCell(item.cells.targetBuy, item.metrics.targetBuyPrice, '--');
            } else {
                item.metrics.targetBuyPrice = null;
                writePriceCell(item.cells.targetBuy, null, '--');
            }
            applyProfitClasses(item);
        };

        const refreshTargetAndProfit = () => {
            updateTargetLabels();
            state.analysisItems.forEach((item) => computeTargetForItem(item));
        };

        const normalizeCard = (card) => ({
            id: card.id,
            name: card.name,
            setCode: card.setCode,
            collectorNumber: card.collectorNumber,
            foilType: card.foilType,
            quantity: Number(card.quantity) || 0,
            tcgplayerId: card.tcgplayerId || card.tcgplayerProductId || null,
            imageUrl: card.imageUrl || null
        });

        const createAnalysisItem = (card) => {
            const element = document.createElement('div');
            element.className = 'analysis-item';
            element.dataset.cardId = card.id;

            element.innerHTML = `
                <img src="${resolveInitialImageUrl(card)}" alt="${card.name}" class="item-image" data-role="image">
                <div class="item-details">
                    <div class="item-header">${card.name} (x${card.quantity}) <span>${card.setCode} - ${card.foilType}</span></div>
                    <div class="price-table-container">
                        <table>
                            <thead>
                                <tr>
                                    <th>TCG Market</th>
                                    <th>TCG Low</th>
                                    <th class="target-column">Target @ <span data-role="target-percent-label"></span></th>
                                    <th>TCG Low + Ship</th>
                                    <th>CK Buylist</th>
                                    <th>SCG Buylist</th>
                                    <th>CSI Buylist</th>
                                </tr>
                            </thead>
                            <tbody>
                                <tr>
                                    <td data-price-type="tcgMarketPrice">--</td>
                                    <td data-price-type="tcgLow">Awaiting scrape</td>
                                    <td data-price-type="targetBuy">--</td>
                                    <td data-price-type="tcgLowPlusShipping">Awaiting scrape</td>
                                    <td data-price-type="ckBuylist">--</td>
                                    <td data-price-type="scgBuylist">--</td>
                                    <td data-price-type="csiBuylist">--</td>
                                </tr>
                            </tbody>
                        </table>
                    </div>
                </div>
            `;

            const imageElement = element.querySelector('[data-role="image"]');
            imageElement.addEventListener('error', () => {
                imageElement.onerror = null;
                imageElement.src = CARD_IMAGE_PLACEHOLDER;
            }, { once: true });

            const cells = {
                tcgMarketPrice: element.querySelector('[data-price-type="tcgMarketPrice"]'),
                tcgLow: element.querySelector('[data-price-type="tcgLow"]'),
                targetBuy: element.querySelector('[data-price-type="targetBuy"]'),
                tcgLowPlusShipping: element.querySelector('[data-price-type="tcgLowPlusShipping"]'),
                ckBuylist: element.querySelector('[data-price-type="ckBuylist"]'),
                scgBuylist: element.querySelector('[data-price-type="scgBuylist"]'),
                csiBuylist: element.querySelector('[data-price-type="csiBuylist"]')
            };

            const item = {
                card,
                metrics: {
                    tcgMarketPrice: null,
                    tcgLow: null,
                    tcgLowPlusShipping: null,
                    ckBuylist: null,
                    scgBuylist: null,
                    csiBuylist: null,
                    targetBuyPrice: null,
                    margins: {}
                },
                element,
                imageElement,
                cells,
                targetLabel: element.querySelector('[data-role="target-percent-label"]')
            };

            registerPriceHover(cells.ckBuylist, item, 'ckBuylist', 'Card Kingdom Buylist');
            registerPriceHover(cells.scgBuylist, item, 'scgBuylist', 'Star City Games Buylist');
            registerPriceHover(cells.csiBuylist, item, 'csiBuylist', 'CoolStuffInc Buylist');

            return item;
        };

        const renderAnalysisItems = () => {
            if (!elements.container) return;
            hidePriceTooltip();
            elements.container.innerHTML = '';
            if (!state.analysisItems.length) {
                const empty = document.createElement('p');
                empty.className = 'buylist-empty-state';
                empty.textContent = 'Run analysis to populate results.';
                elements.container.appendChild(empty);
                return;
            }
            const fragment = document.createDocumentFragment();
            state.analysisItems.forEach((item) => fragment.appendChild(item.element));
            elements.container.appendChild(fragment);
        };

        const getLatestFromHistory = (history) => {
            if (!history || typeof history !== 'object') return null;
            const dates = Object.keys(history);
            if (!dates.length) return null;
            const latestDate = dates.sort((a, b) => new Date(b) - new Date(a))[0];
            return toNumeric(history[latestDate]);
        };

        const getBuylistFromDetails = (details, vendor, foilType) => {
            return getLatestFromHistory(details?.prices?.paper?.[vendor]?.buylist?.[foilType]);
        };

        const fetchCardDetails = async (item) => {
            const { card } = item;
            const response = await fetch(`/api/card/details/${card.setCode}/${card.collectorNumber}`);
            if (!response.ok) throw new Error('Card details request failed');
            const details = await response.json();
            const foilType = card.foilType;
            const paperPrices = details?.prices?.paper || {};

            item.metrics.tcgMarketPrice = toNumeric(getLatestPrice(paperPrices?.tcgplayer?.retail?.[foilType]));
            item.metrics.ckBuylist = toNumeric(getBuylistFromDetails(details, 'cardkingdom', foilType));
            item.metrics.scgBuylist = toNumeric(getBuylistFromDetails(details, 'starcitygames', foilType));
            item.metrics.csiBuylist = toNumeric(getBuylistFromDetails(details, 'coolstuffinc', foilType));

            writePriceCell(item.cells.tcgMarketPrice, item.metrics.tcgMarketPrice, '--');
            writePriceCell(item.cells.ckBuylist, item.metrics.ckBuylist, '--');
            writePriceCell(item.cells.scgBuylist, item.metrics.scgBuylist, '--');
            writePriceCell(item.cells.csiBuylist, item.metrics.csiBuylist, '--');

            updateImageFromDetails(item.imageElement, card, details);

            if (!card.tcgplayerId) {
                const identifiers = details?.identifiers || {};
                card.tcgplayerId = identifiers.tcgplayerProductId || identifiers.tcgplayerId || card.tcgplayerId || null;
            }

            return details;
        };

        const scrapeLiveLows = async (item) => {
            const { card } = item;
            if (!card.tcgplayerId) {
                writePriceCell(item.cells.tcgLow, 'No TCG ID', 'No TCG ID');
                writePriceCell(item.cells.tcgLowPlusShipping, 'No TCG ID', 'No TCG ID');
                return;
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
                    condition: 'LP',
                    store: 'tcgplayer'
                })
            });
            if (!response.ok) throw new Error('Live scrape failed');
            const data = await response.json();
            item.metrics.tcgLow = toNumeric(data.tcgLow);
            item.metrics.tcgLowPlusShipping = toNumeric(data.tcgLowPlusShipping);

            writePriceCell(item.cells.tcgLow, item.metrics.tcgLow, 'N/A');
            writePriceCell(item.cells.tcgLowPlusShipping, item.metrics.tcgLowPlusShipping, 'N/A');
        };

        const scrapeExternalBuylists = async (item) => {
            const { card } = item;
            const response = await fetch('/api/scrape-buylists', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    cardName: card.name,
                    setCode: card.setCode,
                    collectorNumber: card.collectorNumber,
                    foilType: card.foilType
                })
            });
            if (!response.ok) throw new Error('Buylist scrape failed');
            const data = await response.json();
            if (Object.prototype.hasOwnProperty.call(data, 'scgBuylist')) {
                item.metrics.scgBuylist = toNumeric(data.scgBuylist);
                writePriceCell(item.cells.scgBuylist, item.metrics.scgBuylist, '--');
            }
            applyProfitClasses(item);
        };

        const getBestMarginDollar = (item) => {
            updateMarginsForItem(item);
            let best = -Infinity;
            BUYLIST_KEYS.forEach((key) => {
                const margin = item.metrics.margins?.[key]?.dollar;
                if (Number.isFinite(margin)) {
                    best = Math.max(best, margin);
                }
            });
            return best;
        };

        const getBestMarginPercent = (item) => {
            updateMarginsForItem(item);
            let best = -Infinity;
            BUYLIST_KEYS.forEach((key) => {
                const percent = item.metrics.margins?.[key]?.percent;
                if (Number.isFinite(percent)) {
                    best = Math.max(best, percent);
                }
            });
            return best;
        };

        const getProfitScore = (item) => getBestMarginPercent(item);

        const getTcgLowValue = (item) => {
            const lowShip = toNumeric(item.metrics.tcgLowPlusShipping);
            if (Number.isFinite(lowShip)) return lowShip;
            return toNumeric(item.metrics.tcgLow) ?? Infinity;
        };

        const getBestMarginSummary = (item) => {
            updateMarginsForItem(item);
            let bestKey = null;
            let bestPercent = -Infinity;
            let bestDollar = -Infinity;

            BUYLIST_KEYS.forEach((key) => {
                const entry = item.metrics.margins?.[key];
                if (!entry) return;
                const percent = Number(entry.percent);
                const dollar = Number(entry.dollar);
                if (Number.isFinite(percent) && percent > bestPercent) {
                    bestPercent = percent;
                    bestDollar = Number.isFinite(dollar) ? dollar : bestDollar;
                    bestKey = key;
                    return;
                }
                if (!Number.isFinite(bestPercent) && Number.isFinite(dollar) && dollar > bestDollar) {
                    bestDollar = dollar;
                    bestKey = key;
                }
            });

            const reference = getReferencePrice(item);
            const buylistValue = bestKey ? toNumeric(item.metrics[bestKey]) : null;

            return {
                key: bestKey,
                vendorLabel: bestKey ? BUYLIST_LABELS[bestKey] || bestKey : null,
                buylistValue,
                reference,
                marginPercent: Number.isFinite(bestPercent) ? bestPercent : null,
                marginDollar: Number.isFinite(bestDollar) ? bestDollar : null
            };
        };

        const buildMessageCandidates = () => {
            const candidates = state.analysisItems.map((item) => ({
                item,
                summary: getBestMarginSummary(item)
            }));
            candidates.sort((a, b) => {
                const aScore = Number.isFinite(a.summary.marginPercent) ? a.summary.marginPercent : -Infinity;
                const bScore = Number.isFinite(b.summary.marginPercent) ? b.summary.marginPercent : -Infinity;
                if (Number.isFinite(aScore) || Number.isFinite(bScore)) return bScore - aScore;
                const aDollar = Number.isFinite(a.summary.marginDollar) ? a.summary.marginDollar : -Infinity;
                const bDollar = Number.isFinite(b.summary.marginDollar) ? b.summary.marginDollar : -Infinity;
                return bDollar - aDollar;
            });
            state.messageCandidates = candidates;
            return candidates;
        };

        const renderMessageCards = () => {
            if (!elements.messageCards) return;
            const candidates = state.messageCandidates || [];
            elements.messageCards.innerHTML = '';
            if (!candidates.length) {
                const empty = document.createElement('div');
                empty.className = 'buylist-message-empty';
                empty.textContent = 'Run analysis to populate cards with margins.';
                elements.messageCards.appendChild(empty);
                if (elements.messageCount) elements.messageCount.textContent = '0 cards';
                return;
            }

            const fragment = document.createDocumentFragment();
            candidates.forEach((entry, index) => {
            const { item, summary } = entry;
            const tcgLow = toNumeric(item.metrics.tcgLow);
            const negotiated = Number.isFinite(tcgLow) ? tcgLow * state.negotiatePercent : null;
            const row = document.createElement('label');
            row.className = 'buylist-message-row';
            row.dataset.cardIndex = index;

            const checkbox = document.createElement('input');
                checkbox.type = 'checkbox';
                checkbox.dataset.cardIndex = index;
                checkbox.checked = index < 10 || candidates.length <= 10;

                const body = document.createElement('div');
                const title = document.createElement('div');
                title.className = 'buylist-message-row__title';
                title.textContent = `${item.card.name} (x${item.card.quantity})`;

                const meta = document.createElement('div');
                meta.className = 'buylist-message-row__meta';
                meta.textContent = `${item.card.setCode} • #${item.card.collectorNumber} • ${item.card.foilType}`;

                const pricing = document.createElement('div');
                pricing.className = 'buylist-message-row__pricing';
                if (Number.isFinite(negotiated)) {
                    const marginText = Number.isFinite(summary.marginPercent)
                        ? formatSignedPercent(summary.marginPercent)
                        : formatSignedCurrency(summary.marginDollar);
                    const referenceText = Number.isFinite(tcgLow) ? formatCurrency(tcgLow) : 'N/A';
                    pricing.textContent = `Offer: ${formatCurrency(negotiated)} (${Math.round(state.negotiatePercent * 100)}% of TCG Low ${referenceText}) • Best margin: ${marginText}`;
                } else {
                    pricing.textContent = 'No TCG Low available to compute offer.';
                }

                body.appendChild(title);
                body.appendChild(meta);
                body.appendChild(pricing);

                row.appendChild(checkbox);
                row.appendChild(body);
                fragment.appendChild(row);
            });

            elements.messageCards.appendChild(fragment);
            if (elements.messageCount) elements.messageCount.textContent = `${candidates.length} card${candidates.length === 1 ? '' : 's'}`;
        };

        const closeMessageModal = () => {
            if (!elements.messageModal) return;
            elements.messageModal.classList.add('hidden');
            elements.messageModal.setAttribute('aria-hidden', 'true');
            elements.messageModal.style.display = 'none';
            if (state.messageEscHandler) {
                document.removeEventListener('keydown', state.messageEscHandler);
                state.messageEscHandler = null;
            }
            if (state.primaryWasOpenBeforeMessage && modal) {
                modal.style.display = 'flex';
                modal.classList.add('open');
                modal.classList.remove('hidden');
                modal.setAttribute('aria-hidden', 'false');
                document.body.classList.add('modal-open');
            }
            state.primaryWasOpenBeforeMessage = false;
        };

        const openMessageModal = () => {
            if (!elements.messageModal) return;
            if (!state.analysisItems.length) {
                updateStatus('Run analysis before generating a message.', true);
                return;
            }
            state.primaryWasOpenBeforeMessage = modal && modal.classList.contains('open');
            if (state.primaryWasOpenBeforeMessage) {
                modal.style.display = 'none';
                modal.classList.add('hidden');
                modal.setAttribute('aria-hidden', 'true');
                modal.classList.remove('open');
            }
            buildMessageCandidates();
            renderMessageCards();
            if (elements.messagePrompt && !elements.messagePrompt.dataset.userEdited) {
                elements.messagePrompt.value = DEFAULT_MESSAGE_PROMPT;
            }
            if (elements.messageSliderValue) {
                elements.messageSliderValue.textContent = `${Math.round(state.negotiatePercent * 100)}%`;
            }
            if (elements.messageSlider) {
                elements.messageSlider.value = Math.round(state.negotiatePercent * 100);
            }
            elements.messageModal.style.display = 'flex';
            elements.messageModal.classList.add('open');
            elements.messageModal.classList.remove('hidden');
            elements.messageModal.setAttribute('aria-hidden', 'false');
            document.body.classList.add('modal-open');
            state.messageEscHandler = (event) => {
                if (event.key === 'Escape') {
                    closeMessageModal();
                }
            };
            document.addEventListener('keydown', state.messageEscHandler);
        };

        const collectSelectedMessageCards = () => {
            if (!elements.messageCards) return [];
            const selected = [];
            const checkboxes = elements.messageCards.querySelectorAll('input[type="checkbox"][data-card-index]');
            checkboxes.forEach((checkbox) => {
                if (!checkbox.checked) return;
                const index = Number(checkbox.dataset.cardIndex);
                if (Number.isNaN(index)) return;
                const entry = state.messageCandidates[index];
                if (entry) selected.push(entry);
            });
            return selected;
        };

        const setMessageStatus = (message, isError = false) => {
            if (!elements.messageStatus) return;
            elements.messageStatus.textContent = message || '';
            elements.messageStatus.classList.toggle('active', Boolean(message));
            elements.messageStatus.classList.toggle('error', isError);
        };

        const handleGenerateMessage = async () => {
            if (!elements.messageGenerateBtn) return;
            const selected = collectSelectedMessageCards();
            if (!selected.length) {
                setMessageStatus('Select at least one card to include.', true);
                return;
            }

            const promptText = (elements.messagePrompt?.value || DEFAULT_MESSAGE_PROMPT).trim() || DEFAULT_MESSAGE_PROMPT;
            const payload = {
                listName: state.getListName(),
                prompt: promptText,
                offerPercent: state.negotiatePercent,
                cards: selected.map(({ item, summary }) => {
                    const tcgLow = toNumeric(item.metrics.tcgLow);
                    const negotiated = Number.isFinite(tcgLow) ? tcgLow * state.negotiatePercent : null;
                    return {
                        name: item.card.name,
                        quantity: item.card.quantity,
                        buylistPrice: negotiated
                    };
                })
            };

            setMessageStatus('Generating with ChatGPT...');
            elements.messageGenerateBtn.disabled = true;
            if (elements.generateBtn) elements.generateBtn.disabled = true;

            try {
                const response = await fetch('/api/buylist/generate-message', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify(payload)
                });
                const data = await response.json().catch(() => ({}));
                if (!response.ok) {
                    throw new Error(data.error || 'Failed to generate message.');
                }
                if (elements.messageOutput) {
                    elements.messageOutput.value = data.message || '';
                }
                setMessageStatus('Message generated. You can tweak or copy it.');
            } catch (error) {
                console.error(error);
                setMessageStatus(error.message || 'Failed to generate message.', true);
            } finally {
                elements.messageGenerateBtn.disabled = false;
                if (elements.generateBtn) elements.generateBtn.disabled = state.isScraping;
            }
        };

        const handleCopyMessage = async () => {
            if (!elements.messageOutput || !elements.messageOutput.value) {
                setMessageStatus('Nothing to copy yet.', true);
                return;
            }
            try {
                await navigator.clipboard.writeText(elements.messageOutput.value);
                setMessageStatus('Copied to clipboard.');
            } catch (error) {
                console.error(error);
                setMessageStatus('Unable to copy automatically.', true);
            }
        };

        const applySort = () => {
            const sortKey = normalizeSortKey(state.sortKey);
            state.sortKey = sortKey;
            const comparators = {
                'margin-percent-desc': (a, b) => getBestMarginPercent(b) - getBestMarginPercent(a),
                'profit-desc': (a, b) => getBestMarginPercent(b) - getBestMarginPercent(a),
                'margin-dollar-desc': (a, b) => getBestMarginDollar(b) - getBestMarginDollar(a),
                'ck-desc': (a, b) => (toNumeric(b.metrics.ckBuylist) ?? -Infinity) - (toNumeric(a.metrics.ckBuylist) ?? -Infinity),
                'tcg-asc': (a, b) => getTcgLowValue(a) - getTcgLowValue(b),
                'name-asc': (a, b) => a.card.name.localeCompare(b.card.name)
            };
            const comparator = comparators[sortKey] || comparators['margin-percent-desc'];
            if (elements.sortSelect && elements.sortSelect.value !== state.sortKey) {
                elements.sortSelect.value = state.sortKey;
            }
            state.analysisItems.sort(comparator);
            renderAnalysisItems();
        };

        const persistSnapshot = async () => {
            if (!state.analysisItems.length || typeof state.saveSnapshot !== 'function') return;
            if (state.snapshotSaveTimeout) {
                clearTimeout(state.snapshotSaveTimeout);
                state.snapshotSaveTimeout = null;
            }
            updateStatus('Saving snapshot...', true);
            const snapshotPayload = {
                targetPercent: state.tcgLowTargetPercent,
                sortKey: state.sortKey,
                items: state.analysisItems.map((item) => ({
                    card: {
                        id: item.card.id,
                        name: item.card.name,
                        setCode: item.card.setCode,
                        collectorNumber: item.card.collectorNumber,
                        foilType: item.card.foilType,
                        quantity: item.card.quantity,
                        tcgplayerId: item.card.tcgplayerId || null,
                        imageUrl: item.card.imageUrl || null
                    },
                    metrics: {
                        tcgMarketPrice: item.metrics.tcgMarketPrice,
                        tcgLow: item.metrics.tcgLow,
                        tcgLowPlusShipping: item.metrics.tcgLowPlusShipping,
                        ckBuylist: item.metrics.ckBuylist,
                        scgBuylist: item.metrics.scgBuylist,
                        csiBuylist: item.metrics.csiBuylist,
                        targetBuyPrice: item.metrics.targetBuyPrice
                    }
                }))
            };

            try {
                await state.saveSnapshot(snapshotPayload);
                state.savedAt = new Date().toISOString();
                snapshotPayload.savedAt = state.savedAt;
                state.snapshot = snapshotPayload;
                if (typeof state.onSnapshotChange === 'function') {
                    state.onSnapshotChange({ ...snapshotPayload });
                }
                updateStatus();
            } catch (error) {
                console.error(error);
                updateStatus('Failed to save snapshot');
            }
        };

        const scheduleSnapshotSave = () => {
            if (!state.analysisItems.length) return;
            if (state.snapshotSaveTimeout) clearTimeout(state.snapshotSaveTimeout);
            state.snapshotSaveTimeout = setTimeout(persistSnapshot, 600);
        };

        const runAnalysis = async () => {
            if (state.isScraping) return;
            const cards = state.getCards();
            if (!cards.length) {
                state.analysisItems = [];
                renderAnalysisItems();
                updateStatus('This list is empty.');
                return;
            }

            state.isScraping = true;
            if (elements.runBtn) elements.runBtn.disabled = true;
            if (elements.generateBtn) elements.generateBtn.disabled = true;
            if (elements.progressWrap) elements.progressWrap.classList.remove('hidden');
            if (elements.progressFill) elements.progressFill.style.width = '0%';
            if (elements.progressText) elements.progressText.textContent = `0 / ${cards.length}`;

            state.analysisItems = cards.map((card) => createAnalysisItem(normalizeCard(card)));
            renderAnalysisItems();
            refreshTargetAndProfit();

            for (let index = 0; index < state.analysisItems.length; index++) {
                const item = state.analysisItems[index];
                try {
                    await fetchCardDetails(item);
                } catch (error) {
                    console.error(error);
                }

                try {
                    await scrapeLiveLows(item);
                } catch (error) {
                    console.error(error);
                    writePriceCell(item.cells.tcgLow, 'Error', 'Error');
                    writePriceCell(item.cells.tcgLowPlusShipping, 'Error', 'Error');
                }

                computeTargetForItem(item);

                try {
                    await scrapeExternalBuylists(item);
                } catch (error) {
                    console.error(error);
                }

                scheduleSnapshotSave();

                if (elements.progressFill) {
                    const percent = ((index + 1) / state.analysisItems.length) * 100;
                    elements.progressFill.style.width = `${percent}%`;
                }
                if (elements.progressText) {
                    elements.progressText.textContent = `Processing ${index + 1} / ${state.analysisItems.length}`;
                }
            }

            if (elements.progressWrap) elements.progressWrap.classList.add('hidden');
            state.isScraping = false;
            if (elements.runBtn) elements.runBtn.disabled = false;
            if (elements.generateBtn) elements.generateBtn.disabled = false;

            applySort();
            refreshTargetAndProfit();
            await persistSnapshot();
        };

        const loadSnapshot = (snapshot) => {
            state.snapshot = snapshot || null;
            state.savedAt = snapshot?.savedAt || null;
            if (!snapshot || !Array.isArray(snapshot.items)) {
                state.analysisItems = [];
                renderAnalysisItems();
                updateStatus();
                if (typeof state.onSnapshotChange === 'function') {
                    state.onSnapshotChange(null);
                }
                return;
            }

            state.tcgLowTargetPercent = Number(snapshot.targetPercent) || state.tcgLowTargetPercent;
            state.sortKey = normalizeSortKey(snapshot.sortKey) || state.sortKey;

            if (elements.slider) {
                elements.slider.value = Math.round(state.tcgLowTargetPercent * 100);
                if (elements.sliderValue) {
                    elements.sliderValue.textContent = `${Math.round(state.tcgLowTargetPercent * 100)}%`;
                }
            }
            if (elements.sortSelect) {
                elements.sortSelect.value = state.sortKey;
            }

            state.analysisItems = snapshot.items.map((entry) => {
                const item = createAnalysisItem(normalizeCard(entry.card));
                if (entry.metrics) {
                    item.metrics.tcgMarketPrice = toNumeric(entry.metrics.tcgMarketPrice);
                    item.metrics.tcgLow = toNumeric(entry.metrics.tcgLow);
                    item.metrics.tcgLowPlusShipping = toNumeric(entry.metrics.tcgLowPlusShipping);
                    item.metrics.ckBuylist = toNumeric(entry.metrics.ckBuylist);
                    item.metrics.scgBuylist = toNumeric(entry.metrics.scgBuylist);
                    item.metrics.csiBuylist = toNumeric(entry.metrics.csiBuylist);
                    item.metrics.targetBuyPrice = toNumeric(entry.metrics.targetBuyPrice);

                    writePriceCell(item.cells.tcgMarketPrice, item.metrics.tcgMarketPrice, '--');
                    writePriceCell(item.cells.tcgLow, item.metrics.tcgLow, 'N/A');
                    writePriceCell(item.cells.tcgLowPlusShipping, item.metrics.tcgLowPlusShipping, 'N/A');
                    writePriceCell(item.cells.ckBuylist, item.metrics.ckBuylist, '--');
                    writePriceCell(item.cells.scgBuylist, item.metrics.scgBuylist, '--');
                    writePriceCell(item.cells.csiBuylist, item.metrics.csiBuylist, '--');
                }
                if (item.targetLabel) {
                    item.targetLabel.textContent = `${Math.round(state.tcgLowTargetPercent * 100)}%`;
                }
                if (entry.card?.imageUrl) {
                    item.card.imageUrl = entry.card.imageUrl;
                    item.imageElement.src = entry.card.imageUrl;
                }
                return item;
            });

            renderAnalysisItems();
            refreshTargetAndProfit();
            applySort();
            updateStatus();
            if (typeof state.onSnapshotChange === 'function') {
                state.onSnapshotChange({ ...snapshot });
            }
        };

        const setListNameResolver = (resolver) => {
            if (typeof resolver === 'function') {
                state.getListName = resolver;
            }
        };

        const open = () => {
            if (!state.initialized) return;
            hidePriceTooltip();
            modal.style.display = 'flex';
            modal.classList.add('open');
            modal.classList.remove('hidden');
            modal.setAttribute('aria-hidden', 'false');
            document.body.classList.add('modal-open');
            if (elements.subtitle) {
                elements.subtitle.textContent = `Analyzing ${formatListName(state.getListName())}`;
            }
            updateTargetLabels();
            renderAnalysisItems();
            refreshTargetAndProfit();
            applySort();
            updateStatus();

            state.escHandler = (event) => {
                if (event.key === 'Escape') {
                    close();
                }
            };
            document.addEventListener('keydown', state.escHandler);
        };

        const close = () => {
            hidePriceTooltip();
            closeMessageModal();
            modal.classList.add('hidden');
            modal.setAttribute('aria-hidden', 'true');
            modal.style.display = 'none';
            modal.classList.remove('open');
            document.body.classList.remove('modal-open');
            if (state.escHandler) {
                document.removeEventListener('keydown', state.escHandler);
                state.escHandler = null;
            }
        };

        const init = ({
            contextId,
            getCards,
            nameResolver,
            initialSnapshot,
            saveSnapshot: saveOverride,
            onSnapshotChange: onSnapshotChangeOverride
        } = {}) => {
            state.contextId = contextId || null;
            state.getCards = typeof getCards === 'function' ? getCards : state.getCards;
            setListNameResolver(nameResolver);
            if (typeof saveOverride === 'function') {
                state.saveSnapshot = saveOverride;
            }
            if (typeof onSnapshotChangeOverride === 'function') {
                state.onSnapshotChange = onSnapshotChangeOverride;
            }

            if (!state.initialized) {
                state.initialized = true;

                if (elements.slider) {
                    const initialPercent = Number(elements.slider.value) / 100;
                    if (Number.isFinite(initialPercent) && initialPercent > 0) {
                        state.tcgLowTargetPercent = initialPercent;
                    }
                    if (elements.sliderValue) {
                        elements.sliderValue.textContent = `${Math.round(state.tcgLowTargetPercent * 100)}%`;
                    }
                    elements.slider.addEventListener('input', (event) => {
                        const percent = Number(event.target.value) / 100;
                        state.tcgLowTargetPercent = percent;
                        if (elements.sliderValue) {
                            elements.sliderValue.textContent = `${Math.round(percent * 100)}%`;
                        }
                        refreshTargetAndProfit();
                        applySort();
                        scheduleSnapshotSave();
                    });
                }

                if (elements.sortSelect) {
                    elements.sortSelect.value = state.sortKey;
                    elements.sortSelect.addEventListener('change', (event) => {
                        const nextKey = normalizeSortKey(event.target.value);
                        state.sortKey = nextKey;
                        if (elements.sortSelect.value !== nextKey) {
                            elements.sortSelect.value = nextKey;
                        }
                        applySort();
                        scheduleSnapshotSave();
                    });
                }

                if (elements.runBtn) {
                    elements.runBtn.addEventListener('click', () => {
                        runAnalysis();
                    });
                }

                if (elements.generateBtn) {
                    elements.generateBtn.addEventListener('click', openMessageModal);
                    elements.generateBtn.disabled = state.isScraping;
                }

                if (elements.messageCloseBtn) {
                    elements.messageCloseBtn.addEventListener('click', closeMessageModal);
                }

                if (elements.messageBackdrop) {
                    elements.messageBackdrop.addEventListener('click', closeMessageModal);
                }

                if (elements.messageGenerateBtn) {
                    elements.messageGenerateBtn.addEventListener('click', handleGenerateMessage);
                }

                if (elements.messageCopyBtn) {
                    elements.messageCopyBtn.addEventListener('click', handleCopyMessage);
                }

                if (elements.messagePrompt) {
                    elements.messagePrompt.addEventListener('input', () => {
                        elements.messagePrompt.dataset.userEdited = 'true';
                    });
                }

                if (elements.messageSlider) {
                    elements.messageSlider.addEventListener('input', (event) => {
                        const percent = Number(event.target.value) / 100;
                        if (Number.isFinite(percent) && percent > 0) {
                            state.negotiatePercent = percent;
                            if (elements.messageSliderValue) {
                                elements.messageSliderValue.textContent = `${Math.round(percent * 100)}%`;
                            }
                            renderMessageCards();
                        }
                    });
                }

                if (elements.closeBtn) {
                    elements.closeBtn.addEventListener('click', close);
                }

                if (elements.backdrop) {
                    elements.backdrop.addEventListener('click', close);
                }
            }

            if (initialSnapshot) {
                loadSnapshot(initialSnapshot);
            } else {
                renderAnalysisItems();
                updateStatus();
            }
        };

        return {
            init,
            open,
            close,
            loadSnapshot,
            setListNameResolver,
            runAnalysis
        };
    }

    window.createBuylistModal = createBuylistModal;
})(window);



