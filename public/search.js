document.addEventListener('DOMContentLoaded', () => {

    const printingsContainer = document.getElementById('printings-container');



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
        printingsContainer.style.display = 'flex';
        printingsContainer.innerHTML = '<em style="color: white;">Loading printings...</em>';
        selectedPrinting = null;

    try {
        const response = await fetch(`/api/printings/${encodeURIComponent(cardName)}`);
        if (!response.ok) throw new Error('Card not found');
        const allPrintings = await response.json();

        // --- Step 2: Data Restructuring (Now on the Frontend) ---
        const printingsMap = new Map();

        for (const printing of allPrintings) {
            if (!printingsMap.has(printing.id)) {
                // If this is the first time we see this printing, add it to the map
                printingsMap.set(printing.id, {
                    ...printing,
                    // Initialize a Set to store available finishes
                    available_finishes: new Set()
                });
            }
            
            // Add all available finishes from the 'finishes' array to our Set
            printing.finishes.forEach(finish => {
                printingsMap.get(printing.id).available_finishes.add(finish);
            });
        }

        // The map already ensures printings are unique and sorted by release date
        const combinedPrintings = Array.from(printingsMap.values());



        // --- 2. Rendering Logic ---
        printingsContainer.innerHTML = '';

        if (combinedPrintings.length === 0) {
            throw new Error('No valid printings found');
        }

        // This function now creates one element with multiple finish badges
        const createPrintingElement = (printing) => {
            if (!printing.image_uris) return;

            const itemDiv = document.createElement('div');
            itemDiv.className = 'printing-item';

            // Image and Info are created as before
            const img = document.createElement('img');
            img.src = printing.image_uris.small;
            img.title = `${printing.name} - ${printing.set_name} (${printing.set.toUpperCase()}) #${printing.collector_number}`;
            img.alt = img.title;
            itemDiv.appendChild(img);

            const infoDiv = document.createElement('div');
            infoDiv.className = 'printing-info';
            infoDiv.textContent = `[${printing.set.toUpperCase()}] #${printing.collector_number}`;
            itemDiv.appendChild(infoDiv);

            // Create a container for the finish badges
            const finishesContainer = document.createElement('div');
            finishesContainer.className = 'finishes-container';

            // Add badges based on the available finishes for this printing
            if (printing.available_finishes.has('nonfoil')) {
                const badge = document.createElement('span');
                badge.className = 'finish-badge nonfoil';
                badge.style.color = 'white';
                badge.textContent = 'Non-Foil';
                finishesContainer.appendChild(badge);
            }
            if (printing.available_finishes.has('foil')) {
                const badge = document.createElement('span');
                badge.className = 'finish-badge foil';
                badge.style.color = 'gold';
                badge.textContent = ' ✨ Foil';
                finishesContainer.appendChild(badge);
            }
            if (printing.available_finishes.has('etched')) {
                const badge = document.createElement('span');
                badge.className = 'finish-badge etched';
                badge.style.color = 'deepskyblue';
                badge.textContent = ' 💎 Etched';
                finishesContainer.appendChild(badge);
            }

            itemDiv.appendChild(finishesContainer);
            
            // --- NEW CODE: Create the "View Details" button ---
            const expandButton = document.createElement('a');
            expandButton.className = 'expand-button';
            expandButton.textContent = 'View Details';
            // Set the link's destination to the specific card page
            expandButton.href = `/cards/${printing.set}/${printing.collector_number}`;
            itemDiv.appendChild(expandButton);
            // --- END OF NEW CODE ---


            // Add click listener
            itemDiv.addEventListener('click', () => {
                document.querySelectorAll('.printing-item.selected').forEach(el => el.classList.remove('selected'));
                itemDiv.classList.add('selected');
            });

            printingsContainer.appendChild(itemDiv);
        };
        // Render the combined and sorted list of printings
        combinedPrintings.forEach(createPrintingElement);

    } catch (error) {
        printingsContainer.innerHTML = `<p class="error">Could not find any printings for "${cardName}".</p>`;
    }

    })

})