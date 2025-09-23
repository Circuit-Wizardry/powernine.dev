document.addEventListener('DOMContentLoaded', () => {
    const importModal = document.getElementById('import-modal');
    const importBtn = document.getElementById('import-csv-btn');
    const closeBtn = document.querySelector('.close-button');
    const uploadBtn = document.getElementById('upload-button');
    const fileInput = document.getElementById('csv-file-input');
    const uploadMessage = document.getElementById('upload-message');

    // Show the modal
    importBtn.addEventListener('click', () => {
        importModal.style.display = 'flex';
    });

    // Hide the modal
    const closeModal = () => {
        importModal.style.display = 'none';
        fileInput.value = ''; // Reset file input
        uploadMessage.textContent = ''; // Clear message
    };

    closeBtn.addEventListener('click', closeModal);
    window.addEventListener('click', (event) => {
        if (event.target === importModal) {
            closeModal();
        }
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
});