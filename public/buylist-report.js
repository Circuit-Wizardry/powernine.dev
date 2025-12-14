document.addEventListener('DOMContentLoaded', () => {
    const updatedEl = document.getElementById('buylist-updated');
    const summaryEl = document.getElementById('buylist-summary');
    const tableBody = document.getElementById('buylist-table-body');
    const refreshBtn = document.getElementById('buylist-refresh-btn');
    const PLACEHOLDER_IMG = 'https://placehold.co/200x280/1a1a1a/e0e0e0?text=No+Image';

    const formatCurrency = (value) => {
        if (!Number.isFinite(value)) return '--';
        return `$${value.toFixed(2)}`;
    };

    let hoverPreview = document.querySelector('.buylist-hover-preview');
    let hoverPreviewImg = hoverPreview?.querySelector('img');
    if (!hoverPreview) {
        hoverPreview = document.createElement('div');
        hoverPreview.className = 'buylist-hover-preview';
        hoverPreview.innerHTML = `<img src="${PLACEHOLDER_IMG}" alt="Card preview">`;
        hoverPreviewImg = hoverPreview.querySelector('img');
        document.body.appendChild(hoverPreview);
    }

    const render = (report) => {
        if (updatedEl) {
            updatedEl.textContent = report?.generatedAt
                ? new Date(report.generatedAt).toLocaleString()
                : 'never';
        }
        if (!tableBody) return;
        const deals = Array.isArray(report?.allDeals) ? report.allDeals : (Array.isArray(report?.topDeals) ? report.topDeals : []);
        if (!deals.length) {
            tableBody.innerHTML = '<p class="empty">No buylist opportunities found. Refresh to populate.</p>';
            return;
        }
        tableBody.innerHTML = deals.map((deal) => {
            const vendors = [
                { key: 'CK', value: deal.ckBuylist },
                { key: 'SCG', value: deal.scgBuylist }
            ].filter(v => Number.isFinite(v.value));
            let bestValue = null;
            if (vendors.length) {
                vendors.sort((a, b) => b.value - a.value);
                bestValue = vendors[0].value;
            }
            const highlight = (value) => {
                if (!Number.isFinite(value)) return '';
                return value === bestValue ? ' best' : '';
            };
            const spreadPct = Number.isFinite(deal.marginPercent) ? deal.marginPercent : 0;
            const spreadClass = spreadPct > 0
                ? ' spread-positive'
                : (Math.abs(spreadPct) > 20 ? ' spread-alert' : '');
            return `
                <div class="buylist-row" data-img="${deal.imageUrl || ''}" data-tcg-id="${deal.tcgplayerId || ''}">
                    <span class="cell name">${deal.name || 'Unknown'} <small>${deal.setCode || ''}</small></span>
                    <span class="cell">${formatCurrency(deal.tcgLowPlusShipping)}</span>
                    <span class="cell${highlight(deal.ckBuylist)}">${formatCurrency(deal.ckBuylist)}</span>
                    <span class="cell${highlight(deal.scgBuylist)}">${formatCurrency(deal.scgBuylist)}</span>
                    <span class="cell spread${spreadClass}">${formatCurrency(deal.marginDollar)} (${(deal.marginPercent || 0).toFixed(1)}%)</span>
                </div>
            `;
        }).join('');
        if (summaryEl) {
            const avg = report?.summary?.averageMarginPercent;
            summaryEl.textContent = `Total deals: ${report?.totalDeals || 0} | Avg spread: ${Number.isFinite(avg) ? avg.toFixed(1) + '%' : 'n/a'}`;
        }
    };

    const load = async (force = false) => {
        try {
            const endpoint = force ? '/api/buylist/report/refresh' : '/api/buylist/report';
            const response = await fetch(endpoint, { method: force ? 'POST' : 'GET' });
            if (!response.ok) throw new Error(await response.text() || 'Failed to fetch buylist report.');
            const data = await response.json();
            render(data);
        } catch (error) {
            console.error('[buylist] load error:', error);
            if (tableBody) tableBody.innerHTML = `<p class="error">Failed to load buylist report: ${error.message}</p>`;
        }
    };

    if (refreshBtn) {
        refreshBtn.addEventListener('click', () => load(true));
    }

    const getRowImage = (row) => {
        const dataSrc = row?.dataset?.img;
        if (dataSrc) return dataSrc;
        const tcgId = row?.dataset?.tcgId;
        if (tcgId) return `https://tcgplayer-cdn.tcgplayer.com/product/${tcgId}_in_200x200.jpg`;
        return PLACEHOLDER_IMG;
    };

    const hidePreview = () => {
        hoverPreview?.classList.remove('show');
    };

    if (tableBody) {
        tableBody.addEventListener('mouseenter', (event) => {
            const nameCell = event.target.closest('.cell.name');
            if (!nameCell) return;
            const row = nameCell.closest('.buylist-row');
            if (!row) return;
            if (hoverPreviewImg) hoverPreviewImg.src = getRowImage(row);
            hoverPreview?.classList.add('show');
        }, true);

        tableBody.addEventListener('mousemove', (event) => {
            const nameCell = event.target.closest('.cell.name');
            if (!nameCell || !hoverPreview) return;
            hoverPreview.style.left = `${event.clientX + 16}px`;
            hoverPreview.style.top = `${event.clientY - 20}px`;
        });

        tableBody.addEventListener('mouseleave', (event) => {
            const nameCell = event.target.closest('.cell.name');
            if (!nameCell) return;
            hidePreview();
        }, true);

        tableBody.addEventListener('mouseout', (event) => {
            if (!event.relatedTarget || !tableBody.contains(event.relatedTarget)) {
                hidePreview();
            }
        });
        tableBody.addEventListener('mouseleave', () => hidePreview());
    }

    load(false);
});
