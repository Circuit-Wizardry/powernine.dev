document.addEventListener('DOMContentLoaded', () => {
    // --- Get all DOM elements ---
    const pageLeft = document.getElementById('binder-page-left');
    const pageRight = document.getElementById('binder-page-right');
    const switchViewBtn = document.getElementById('switch-view-btn');
    const prevButton = document.getElementById('prev-page');
    const nextButton = document.getElementById('next-page');
    const pageIndicator = document.getElementById('page-indicator');
    const loader = document.getElementById('loader');

    // Modal elements
    const cardModal = document.getElementById('card-modal');
    const closeModalBtn = document.getElementById('close-modal-btn');
    const modalImage = document.getElementById('modal-image');
    const modalCardName = document.getElementById('modal-card-name');
    const modalQuantity = document.getElementById('modal-quantity');
    const modalPrice = document.getElementById('modal-price');
    const modalListLink = document.getElementById('modal-list-link');

    // --- State variables ---
    const CARDS_PER_PAGE = 18;
    let currentPage = 1;
    let totalPages = 1;
    let allCardData = []; // Will store COMBINED data objects

    /**
     * Renders a specific page of the binder.
     */
    const renderPage = (pageNum) => {
        pageLeft.innerHTML = '';
        pageRight.innerHTML = '';
        
        const startIndex = (pageNum - 1) * CARDS_PER_PAGE;
        const endIndex = pageNum * CARDS_PER_PAGE;
        const cardsToDisplay = allCardData.slice(startIndex, endIndex);

        cardsToDisplay.forEach((card, index) => {
            const cardSlot = document.createElement('div');
            cardSlot.className = 'card-slot';
            
            const cardImage = document.createElement('img');
            cardImage.className = 'card-image';
            cardImage.src = card.image_uris?.normal || 'https://placehold.co/245x342/1a1a1a/e0e0e0?text=No+Image';
            cardImage.alt = card.name;
            cardImage.loading = 'lazy';
            
            // Add click listener to open the modal with the COMBINED card data
            cardImage.addEventListener('click', () => openModal(card));
            
            cardSlot.appendChild(cardImage);

            if (index < 9) {
                pageLeft.appendChild(cardSlot);
            } else {
                pageRight.appendChild(cardSlot);
            }
        });
        
        currentPage = pageNum;
        pageIndicator.textContent = `Page ${currentPage} of ${totalPages}`;
        prevButton.disabled = currentPage === 1;
        nextButton.disabled = currentPage === totalPages;
    };

    /**
     * Populates and shows the modal with data for a specific card.
     * @param {object} card - The COMBINED card data object.
     */
    const openModal = (card) => {
        modalImage.src = card.image_uris?.large || card.image_uris?.normal || '';
        modalCardName.textContent = card.name;
        
        modalQuantity.textContent = card.quantity;

        let price = 'N/A';
        if (card.foilType === 'foil' && card.prices?.usd_foil) {
            price = card.prices.usd_foil;
        } else if (card.foilType === 'etched' && card.prices?.usd_etched) {
            price = card.prices.usd_etched;
        } else if (card.prices?.usd) {
            price = card.prices.usd; // Default to non-foil price
        }
        modalPrice.textContent = `$${price}`;
        
        cardModal.classList.add('active');
    };

    /**
     * Fetches the initial list and pre-fetches all Scryfall data.
     */
    const loadBinder = async () => {
        const pathParts = window.location.pathname.split('/');
        const listId = pathParts[pathParts.length - 1];

        if (!listId) {
            loader.textContent = 'No list ID found in the URL.';
            return;
        }

        switchViewBtn.href = `/list/${listId}`;
        modalListLink.href = `/list/${listId}`;

        try {
            const listResponse = await fetch(`/api/list/${listId}`);
            if (!listResponse.ok) throw new Error('Could not find the imported card list.');
            
            // --- THIS IS THE FIX ---
            // The API now returns an object, so we destructure the 'content' property
            // to get the array of cards.
            const { content: importedCards } = await listResponse.json();
            
            totalPages = Math.ceil(importedCards.length / CARDS_PER_PAGE) || 1;

            const fetchPromises = importedCards.map(async (cardIdentifier) => {
                const response = await fetch(`https://api.scryfall.com/cards/${cardIdentifier.setCode.toLowerCase()}/${cardIdentifier.collectorNumber}`);
                if (!response.ok) {
                    console.error(`Failed to fetch ${cardIdentifier.name}`);
                    return null;
                }
                const scryfallData = await response.json();
                
                // Merge Scryfall data with the user's specific data
                return {
                    ...scryfallData, // All the data from Scryfall
                    foilType: cardIdentifier.foilType, // The user's specific foil type
                    quantity: cardIdentifier.quantity   // The user's specific quantity
                };
            });
            
            loader.textContent = `Loading ${importedCards.length} card images...`;
            allCardData = (await Promise.all(fetchPromises)).filter(card => card !== null);
            
            loader.style.display = 'none';
            renderPage(1);

        } catch (error) {
            loader.textContent = error.message;
        }
    };

    // --- Event Listeners ---
    closeModalBtn.addEventListener('click', () => cardModal.classList.remove('active'));
    nextButton.addEventListener('click', () => { if (currentPage < totalPages) renderPage(currentPage + 1); });
    prevButton.addEventListener('click', () => { if (currentPage > 1) renderPage(currentPage - 1); });
    cardModal.addEventListener('click', (event) => { if (event.target === cardModal) cardModal.classList.remove('active'); });

    // --- Initial Load ---
    loadBinder();
});