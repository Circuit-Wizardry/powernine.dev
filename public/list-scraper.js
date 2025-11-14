// --- Helper function to open a popup window ---
function openManaPoolWindow(url) {
    const width = 600;
    const height = 800;
    const left = window.screen.width - width - 20; // Position on the right with a small margin
    const top = 20; // Position from the top with a small margin
    const features = `width=${width},height=${height},left=${left},top=${top},resizable=yes,scrollbars=yes`;
    window.open(url, 'manapoolWindow', features);
}

// --- Helper function to create the URL-friendly card name ---
function createCardSlug(cardName) {
    return cardName.toLowerCase()
        .replace(/\s+/g, '-')       // Replace spaces with hyphens
        .replace(/[^a-z0-9-]/g, ''); // Remove all non-alphanumeric characters except hyphens
}

document.addEventListener('DOMContentLoaded', () => {
    const inventoryBody = document.getElementById('inventory-body');
    const scrapeAllBtn = document.getElementById('scrape-all-btn');
    const downloadCsvBtn = document.getElementById('download-csv-btn');
    const scrapeStatus = document.getElementById('scrape-status');
    const loadingMessage = document.getElementById('loading-message');
    const controlsDiv = document.querySelector('.controls');
    const inventoryTable = document.getElementById('inventory-table');
    const escapeHtml = (value = '') => String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');

    // --- 1. Fetch Initial Inventory Data ---
    fetch('/api/inventory')
        .then(res => res.ok ? res.json() : Promise.reject(`Server error (Status: ${res.status})`))
        .then(inventory => {
            if (!inventory || inventory.length === 0) {
                 loadingMessage.textContent = 'Your inventory is empty.';
                 return;
            }
            renderInventory(inventory);
            loadingMessage.style.display = 'none';
            controlsDiv.style.display = 'flex';
            inventoryTable.style.display = 'table';
        })
        .catch(err => {
            loadingMessage.textContent = `Failed to load inventory: ${err}`;
            loadingMessage.style.color = 'var(--danger-color)';
        });

    // --- 2. Render the inventory in the table ---
    function renderInventory(inventory) {
        inventoryBody.innerHTML = '';
        inventory.forEach(item => {
            const row = document.createElement('tr');
            Object.assign(row.dataset, {
                id: item.id,
                tcgplayerId: item.tcgplayerId,
                name: item.name,
                setCode: item.setCode,
                collectorNumber: item.collectorNumber,
                foilType: item.foilType,
                quantity: item.quantity,
                condition: item.condition,
                scryfallId: item.scryfallId || ''
            });

            row.innerHTML = `
                <td>${escapeHtml(item.name)}</td>
                <td>${escapeHtml(item.setCode)}</td>
                <td>${escapeHtml(item.collectorNumber)}</td>
                <td>${escapeHtml(item.foilType)}</td>
                <td>${escapeHtml(item.condition)}</td>
                <td>${escapeHtml(item.quantity)}</td>
                <td><input type="number" step="0.01" class="price-input" placeholder="0.00"></td>
                <td class="status-cell"><span class="status status-pending">Pending</span></td>
            `;
            inventoryBody.appendChild(row);
        });
    }
    
    // --- 3. Scrape Logic ---
    scrapeAllBtn.addEventListener('click', async () => {
        const rows = Array.from(inventoryBody.querySelectorAll('tr'));
        let processedCount = 0;

        scrapeAllBtn.disabled = true;
        downloadCsvBtn.disabled = true;
        scrapeStatus.innerHTML = `<div class="loader"></div>Scraping 0 / ${rows.length}...`;
        
        for (const row of rows) {
            await scrapeSingleCard(row);
            processedCount++;
            scrapeStatus.innerHTML = `<div class="loader"></div>Scraping ${processedCount} / ${rows.length}...`;
        }
        
        scrapeAllBtn.disabled = false;
        downloadCsvBtn.disabled = false;
        scrapeStatus.textContent = `Status: Scraping complete! Ready to download CSV.`;
    });

    async function scrapeSingleCard(row) {
        const statusCell = row.querySelector('.status-cell');
        const priceInput = row.querySelector('.price-input');
        
        const setManualLink = (errorText) => {
            priceInput.classList.add('manual-entry');
            priceInput.placeholder = errorText;
            const cardSlug = createCardSlug(row.dataset.name);
            const manaPoolUrl = `https://manapool.com/card/${row.dataset.setCode.toLowerCase()}/${row.dataset.collectorNumber}/${cardSlug}`;
            statusCell.innerHTML = `<a href="${manaPoolUrl}" class="status status-manual" onclick="openManaPoolWindow(this.href); return false;">Manual</a>`;
        };

        if (!row.dataset.tcgplayerId) {
            statusCell.innerHTML = `<span class="status status-error">No TCG ID</span>`;
            return;
        }

        try {
            statusCell.innerHTML = `<span class="status status-scraping">Scraping...</span>`;
            

            const res = await fetch('/api/scrape-lows', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    tcgplayerId: row.dataset.tcgplayerId,
                    cardName: row.dataset.name,
                    condition: row.dataset.condition,
                    setCode: row.dataset.setCode,
                    collectorNumber: row.dataset.collectorNumber,
                    foilType: row.dataset.foilType,
                })
            });
            
            if (!res.ok) throw new Error(`API Error ${res.status}`);
            const prices = await res.json();
            
            if (prices.manaPoolLow && prices.manaPoolLow > 0) {
                const finalPrice = Math.max(0.01, prices.manaPoolLow - 0.05).toFixed(2);
                priceInput.value = finalPrice;
                statusCell.innerHTML = `<span class="status status-priced">Priced</span>`;
            } else {
                setManualLink("Enter Price");
            }

        } catch (error) {
            console.error(`Failed to scrape ${row.dataset.name}:`, error);
            setManualLink("Error");
        }
    }
    
    // --- 4. CSV Download Logic ---
    downloadCsvBtn.addEventListener('click', () => {
        const headers = ['Name', 'Quantity', 'Foil', 'Scryfall ID', 'Purchase price', 'Condition', 'Language'];
        const rows = Array.from(inventoryBody.querySelectorAll('tr'));
        
        const mapConditionToManabox = (internalCondition) => {
            switch ((internalCondition || 'NM').toUpperCase()) {
                case 'NM': case 'M': return 'mint';
                case 'LP': return 'near_mint';
                case 'MP': return 'excellent';
                case 'HP': return 'lightly played';
                case 'DMG': return 'poor';
                default: return 'near_mint';
            }
        };

        const csvRows = rows.map(row => {
            const priceInput = row.querySelector('.price-input');
            const price = parseFloat(priceInput.value).toFixed(2) || '0.00';
            const escapedName = `"${row.dataset.name.replace(/"/g, '""')}"`;

            const data = [
                escapedName,
                row.dataset.quantity,
                row.dataset.foilType,
                row.dataset.scryfallId,
                price,
                mapConditionToManabox(row.dataset.condition),
                'en'
            ];
            return data.join(',');
        });

        const csvContent = [headers.join(','), ...csvRows].join('\n');
        
        const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
        const link = document.createElement("a");
        const url = URL.createObjectURL(blob);
        link.setAttribute("href", url);
        link.setAttribute("download", "manapool_export.csv");
        link.style.visibility = 'hidden';
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        
        scrapeStatus.textContent = 'Status: CSV has been downloaded!';
    });
});

