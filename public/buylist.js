document.addEventListener('DOMContentLoaded', () => {
    // --- DOM Elements ---
    const analysisContainer = document.getElementById('analysis-container');
    const scrapeAllBtn = document.getElementById('scrape-all-btn');
    const progressContainer = document.getElementById('progress-container');
    const progressBar = document.getElementById('progress-bar');
    const progressText = document.getElementById('progress-text');

    // --- State ---
    let inventory = [];

    // --- Helper Functions (from inventory.js) ---
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
    
    const updatePriceRow = (itemId, data, isLiveScrape = false) => {
        const itemContainer = document.getElementById(`analysis-item-${itemId}`);
        if (!itemContainer) return;

        const item = inventory.find(i => i.id === itemId);
        if (!item) return;

        if (isLiveScrape) {
            // --- LIVE SCRAPE LOGIC (FIXED) ---
            // 1. Update the text content for any new data we received.
            for (const key in data) {
                const cell = itemContainer.querySelector(`[data-price-type="${key}"]`);
                if (cell) {
                    cell.textContent = formatPrice(data[key]);
                }
            }
            
            // 2. Re-evaluate profitability for ALL buylists against the new TCG Low price.
            const referencePrice = data.tcgLowPlusShipping ?? item.tcgLowPlusShipping;
            
            if (typeof referencePrice !== 'number') {
                console.warn(`      -> No valid reference price for item ${item.id}. Cannot evaluate profitability.`);
                return; 
            }

            ['ckBuylist', 'scgBuylist', 'csiBuylist'].forEach(buylistKey => {
                const buylistCell = itemContainer.querySelector(`[data-price-type="${buylistKey}"]`);
                if (buylistCell) {
                    let buylistPrice;
                    // Use the newly scraped price if it exists in our data...
                    if (data[buylistKey] !== undefined && data[buylistKey] !== null) {
                        buylistPrice = data[buylistKey];
                    } else {
                        // ...otherwise, read the price that's already on the page from the initial load.
                        const currentText = buylistCell.textContent;
                        buylistPrice = currentText.startsWith('$') ? parseFloat(currentText.replace('$', '')) : null;
                    }

                    // 3. Now perform the comparison with the correct price.
                    if (typeof buylistPrice === 'number' && buylistPrice > referencePrice) {
                        buylistCell.classList.add('profitable');
                    } else {
                        buylistCell.classList.remove('profitable');
                    }
                }
            });
        } else {
            // --- INITIAL LOAD LOGIC (Unchanged) ---
            const referencePrice = item.tcgLowPlusShipping;
            const foilType = item.foilType;

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
    
    // --- The rest of the file (renderAndFetchDetails, scrapeAllItems, etc.) remains the same ---
    
    const renderAndFetchDetails = async (item) => {
        const itemElement = document.createElement('div');
        itemElement.className = 'analysis-item';
        itemElement.id = `analysis-item-${item.id}`;

        const imageUrl = item.tcgplayerId
            ? `https://tcgplayer-cdn.tcgplayer.com/product/${item.tcgplayerId}_in_200x200.jpg`
            : 'https://placehold.co/100x140/1a1a1a/e0e0e0?text=N/A';
        
        itemElement.innerHTML = `
            <img src="${imageUrl}" alt="${item.name}" class="item-image" style="width: 50px; height: 70px;">
            <div class="item-details">
                <div class="item-header">${item.name} (${item.setCode}) - ${item.condition} ${item.foilType !== 'normal' ? `(${item.foilType})` : ''}</div>
                <div class="price-table-container">
                    <table>
                        <thead> <tr> <th>TCG Market</th> <th>TCG Low</th> <th>TCG Low + Ship</th> <th>CK Buylist</th> <th>SCG Buylist</th> <th>CSI Buylist</th> </tr> </thead>
                        <tbody>
                            <tr>
                                <td data-price-type="tcgMarketPrice">...</td>
                                <td data-price-type="tcgLow">${formatPrice(item.tcgLow)}</td>
                                <td data-price-type="tcgLowPlusShipping">${formatPrice(item.tcgLowPlusShipping)}</td>
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
            const response = await fetch(`/api/card/details/${item.setCode}/${item.collectorNumber}`);
            if (!response.ok) throw new Error('Details fetch failed');
            const cardDetails = await response.json();
            if (cardDetails && cardDetails.prices) {
                updatePriceRow(item.id, cardDetails.prices, false);
            }
        } catch (error) {
            console.warn(`Could not fetch details for ${item.name}:`, error);
        }
    };
    
    const scrapeAllItems = async () => {
        scrapeAllBtn.disabled = true;
        progressContainer.classList.remove('hidden');
        const totalItems = inventory.length;

        for (let i = 0; i < totalItems; i++) {
            const item = inventory[i];
            const itemElement = document.getElementById(`analysis-item-${item.id}`);

            const progressPercentage = ((i + 1) / totalItems) * 100;
            progressBar.style.width = `${progressPercentage}%`;
            progressText.textContent = `Scraping ${i + 1} / ${totalItems}`;

            if (itemElement) itemElement.classList.add('scraping');

            try {
                if (!item.tcgplayerId) {
                     console.warn(`Skipping scrape for ${item.name} - missing TCGPlayer ID.`);
                     continue;
                }
                
                const [lowsResponse, buylistsResponse] = await Promise.all([
                    fetch('/api/scrape-lows', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            tcgplayerId: item.tcgplayerId,
                            cardName: item.name,
                            setCode: item.setCode,
                            collectorNumber: item.collectorNumber,
                            foilType: item.foilType,
                            condition: item.condition
                        })
                    }),
                    fetch('/api/scrape-buylists', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            cardName: item.name,
                            setCode: item.setCode,
                            collectorNumber: item.collectorNumber,
                            foilType: item.foilType,
                        })
                    })
                ]);

                if (!lowsResponse.ok || !buylistsResponse.ok) {
                    throw new Error(`A scrape request failed for ${item.name}`);
                }
                
                const lowsData = await lowsResponse.json();
                const buylistsData = await buylistsResponse.json();
                
                const mergedData = { ...lowsData, ...buylistsData };

                item.tcgLowPlusShipping = mergedData.tcgLowPlusShipping;
                
                updatePriceRow(item.id, mergedData, true);

            } catch (error) {
                console.error(error);
            } finally {
                if (itemElement) itemElement.classList.remove('scraping');
                console.log(`Cooldown... waiting 2 seconds before next card.`);
                await new Promise(resolve => setTimeout(resolve, 2000));
            }
        }
        scrapeAllBtn.textContent = 'Scraping Complete';
        progressText.textContent = `Complete: ${totalItems} / ${totalItems}`;
    };

    const initializePage = async () => {
        try {
            const response = await fetch('/api/inventory');
            if (!response.ok) throw new Error("Could not fetch inventory.");
            inventory = await response.json();
            
            if (inventory.length === 0) {
                 analysisContainer.innerHTML = '<p>No inventory items found.</p>';
                 return;
            }
            analysisContainer.innerHTML = ''; 

            inventory.forEach(item => renderAndFetchDetails(item));

        } catch (error) {
            console.error(error);
            analysisContainer.innerHTML = `<p style="color: red;">${error.message}</p>`;
        }
    };

    scrapeAllBtn.addEventListener('click', scrapeAllItems);
    initializePage();
});

