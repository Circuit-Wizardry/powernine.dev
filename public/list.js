document.addEventListener('DOMContentLoaded', () => {
    const container = document.getElementById('card-list-container');
    const importedDataString = sessionStorage.getItem('importedCardData');

    if (!importedDataString) {
        container.innerHTML = '<p>No card data found. Please import a CSV file first.</p>';
        return;
    }

    // A small helper function to prevent calling the APIs too quickly.
    // Scryfall's public API asks for a 50-100ms delay between requests.
    const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

    const processCards = async () => {
        try {
            const importedCards = JSON.parse(importedDataString);
            container.innerHTML = ''; // Clear loader

            for (const cardIdentifier of importedCards) {
                try {
                    // --- Step 1: Fetch main card data from Scryfall API ---
                    const scryfallUrl = `https://api.scryfall.com/cards/${cardIdentifier.setCode.toLowerCase()}/${cardIdentifier.collectorNumber}`;
                    const scryfallResponse = await fetch(scryfallUrl);
                    if (!scryfallResponse.ok) {
                        throw new Error(`Scryfall API error for ${cardIdentifier.name}`);
                    }
                    const scryfallData = await scryfallResponse.json();

                    // --- Step 2: Fetch pricing data from our server ---
                    const priceResponse = await fetch(`/api/prices/${cardIdentifier.setCode}/${cardIdentifier.collectorNumber}`);
                    if (!priceResponse.ok) {
                        throw new Error(`Pricing server error for ${cardIdentifier.name}`);
                    }
                    const priceData = await priceResponse.json();

                    // --- Step 3: Combine data and render the card ---
                    const price = cardIdentifier.isFoil ? (priceData.usd_foil || 'N/A') : (priceData.usd || 'N/A');
                    const imageUrl = scryfallData.image_uris?.normal || '';

                    const cardElement = document.createElement('div');
                    cardElement.className = 'card-item';
                    cardElement.innerHTML = `
                        <img src="${imageUrl}" alt="${scryfallData.name}" loading="lazy">
                        <div class="card-info">
                            <h3>${scryfallData.name} (x${cardIdentifier.quantity})</h3>
                            <p>${scryfallData.set_name} (#${scryfallData.collector_number})</p>
                            ${cardIdentifier.isFoil ? '<p><strong>Foil</strong></p>' : ''}
                            <p class="price">$${price}</p>
                        </div>
                    `;
                    container.appendChild(cardElement);

                } catch (error) {
                    console.error(`Failed to process ${cardIdentifier.name}:`, error);
                    // Display an error card in the UI if something goes wrong
                    const errorElement = document.createElement('div');
                    errorElement.className = 'card-item';
                    errorElement.innerHTML = `<p>Could not load data for ${cardIdentifier.name}</p>`;
                    container.appendChild(errorElement);
                }
                
                // Add a polite delay before the next request
                await delay(100); 
            }

        } catch (error) {
            console.error('Error processing card data:', error);
            container.innerHTML = `<p>Error loading card data: ${error.message}</p>`;
        } finally {
            // Clean up session storage after use
            sessionStorage.removeItem('importedCardData');
        }
    };

    processCards();
});