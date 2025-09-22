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
        printingsContainer.style.display = 'inline';
        printingsContainer.innerHTML = '<em style="color: white;">Loading printings...</em>';
        selectedPrinting = null;

        try {
            const response = await fetch(`/api/printings/${encodeURIComponent(cardName)}`);
            if (!response.ok) throw new Error('Card not found');
            const printings = await response.json();
            
            printingsContainer.innerHTML = '';
            printings.forEach(printing => {
                if (!printing.image_uris) return;
                
                const img = document.createElement('img');
                img.src = printing.image_uris.small;
                img.title = `${printing.name} - ${printing.set_name} (#${printing.collector_number})`;
                img.alt = img.title;
                
                const itemDiv = document.createElement('div');
                itemDiv.className = 'printing-item';
                itemDiv.appendChild(img);
                
                itemDiv.addEventListener('click', () => {
                    document.querySelectorAll('.printing-item.selected').forEach(el => el.classList.remove('selected'));
                    itemDiv.classList.add('selected');
                });

                printingsContainer.appendChild(itemDiv);
            });
        } catch (error) {
            printingsContainer.innerHTML = `<p class="error">Could not find any printings for "${cardName}".</p>`;
        }

    })

})