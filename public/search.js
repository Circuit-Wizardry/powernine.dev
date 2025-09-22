document.addEventListener('DOMContentLoaded', () => {

    function normalizeString(str) {
        return str
            .toLowerCase() // Convert to lowercase
            .replace(/[^\w\s]|_/g, "") // Remove all non-word characters except whitespace
            .replace(/\s+/g, " "); // Collapse multiple whitespaces into a single space
    }

    searchBar = document.getElementById('search-bar');
        const cardFilter = function(text, input) {
        // Normalize both the suggestion text and the user's input
        let normalizedText = normalizeString(text.label || text);
        let normalizedInput = normalizeString(input);

        // Check if the normalized text includes the normalized input
        return normalizedText.includes(normalizedInput);
    };

    fetch('/api/card-names')
            .then(res => res.json())
            .then(data => {
                cardNameList = data;
                new Awesomplete(searchBar, { list: cardNameList, filter: cardFilter });
            });

    searchBar.addEventListener('awesomplete-selectcomplete', async (event) => {
        const cardName = event.text.value;
        const searchDiv = document.getElementById('search-div');
        searchDiv.style.position = 'fixed';
        searchDiv.style.top = '2%';


        // Example variable for number of cards
        const numCards = 5; // You can set this dynamically as needed

        // Remove existing card container if present
        let existingContainer = document.getElementById('card-container');
        if (existingContainer) {
            existingContainer.remove();
        }

        // Create a new container for the cards
        const cardContainer = document.createElement('div');
        cardContainer.id = 'card-container';
        cardContainer.style.display = 'flex';
        cardContainer.style.flexDirection = 'row';
        cardContainer.style.gap = '16px';
        cardContainer.style.marginTop = '18%';

        // Generate card divs
        for (let i = 0; i < numCards; i++) {
            const card = document.createElement('div');
            card.style.width = '126px';
            card.style.height = '172px';
            card.style.borderRadius = '12px';
            card.style.boxShadow = '0 2px 8px rgba(0,0,0,0.15)';
            card.style.background = `hsl(${(i * 60) % 360}, 70%, 80%)`;
            card.style.display = 'flex';
            card.style.alignItems = 'center';
            card.style.justifyContent = 'center';
            card.style.fontWeight = 'bold';
            card.style.fontSize = '1.2em';
            card.textContent = `Card ${i + 1}`;
            cardContainer.appendChild(card);
        }

        // Insert the card container after searchDiv
        searchDiv.parentNode.insertBefore(cardContainer, searchDiv.nextSibling);
    })

})