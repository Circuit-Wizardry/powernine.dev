document.addEventListener('DOMContentLoaded', () => {
    // --- Existing DOM Elements ---
    const importBtn = document.getElementById('import-csv-btn');
    const modal = document.getElementById('import-modal');
    const closeBtn = modal.querySelector('.close-button');
    const fileInput = document.getElementById('csv-file-input');
    const uploadBtn = document.getElementById('upload-button');
    const uploadMessage = document.getElementById('upload-message');
    
    // --- NEW DOM Elements ---
    const pasteInput = document.getElementById('paste-text-input');
    const pasteBtn = document.getElementById('paste-button');
    const pasteMessage = document.getElementById('paste-message');

    // --- Event Listeners for Modal ---
    importBtn.addEventListener('click', () => modal.style.display = 'flex');
    closeBtn.addEventListener('click', () => modal.style.display = 'none');
    window.addEventListener('click', (event) => {
        if (event.target === modal) modal.style.display = 'none';
    });

    // Handle the file upload
    uploadBtn.addEventListener('click', async () => {
        const file = fileInput.files[0];

        // --- Client-side validation ---
        if (!file) {
            uploadMessage.textContent = 'Please select a file.';
            uploadMessage.style.color = '#E53E3E'; // Red
            return;
        }
        if (file.type !== 'text/csv') {
            uploadMessage.textContent = 'Invalid file type. Please upload a .csv file.';
            uploadMessage.style.color = '#E53E3E';
            return;
        }
        const fiveMB = 5 * 1024 * 1024;
        if (file.size > fiveMB) {
            uploadMessage.textContent = 'File is too large. Maximum size is 5MB.';
            uploadMessage.style.color = '#E53E3E';
            return;
        }
        
        uploadMessage.textContent = 'Uploading and processing...';
        uploadMessage.style.color = '#4FD1C5'; // Teal

        // --- Send to server ---
        const formData = new FormData();
        formData.append('cardList', file);

        const response = await fetch('/api/import-csv', {
            method: 'POST',
            body: formData
        });

        const result = await response.json();

        if (response.ok) {
            // SUCCESS: Instead of saving to session storage, we redirect!
            window.location.href = `/list/${result.listId}`;
        } else {
            // Handle error
            alert(`Error: ${result.message}`);
        }
    });
    
    // --- NEW: Event Listener for PASTED TEXT ---
    pasteBtn.addEventListener('click', async () => {
      console.log('Processing pasted text...');
        const textContent = pasteInput.value.trim();
        if (!textContent) {
            pasteMessage.textContent = 'Please paste some text first.';
            pasteMessage.style.color = '#ff8a80';
            return;
        }

        pasteBtn.disabled = true;
        pasteBtn.textContent = 'Processing...';
        pasteMessage.textContent = '';

        try {
            const response = await fetch('/api/import-text', {
                method: 'POST',
                headers: { 'Content-Type': 'text/plain' },
                body: textContent
            });

            const result = await response.json();
            if (!response.ok) {
                throw new Error(result.message || 'Failed to process pasted text.');
            }

            // Success! Redirect to the new list page
            window.location.href = `/list/${result.listId}`;

        } catch (error) {
            pasteMessage.textContent = `Error: ${error.message}`;
            pasteMessage.style.color = '#ff8a80';
            pasteBtn.disabled = false;
            pasteBtn.textContent = 'Process Pasted Text';
        }
    });
});