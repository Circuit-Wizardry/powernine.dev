// In public/home.js

document.addEventListener('DOMContentLoaded', () => {
    const createListBtn = document.getElementById('create-list-btn');

    if (createListBtn) {
        createListBtn.addEventListener('click', async () => {
            try {
                createListBtn.disabled = true;
                createListBtn.textContent = 'Creating...';

                const response = await fetch('/api/lists/create', {
                    method: 'POST'
                });

                if (!response.ok) {
                    throw new Error('Failed to create list on the server.');
                }

                const data = await response.json();
                const listId = data.listId;

                // Redirect the user to the new, empty list page
                window.location.href = `/list/${listId}`;

            } catch (error) {
                console.error(error);
                createListBtn.textContent = 'Creation Failed';
                // Re-enable the button after a delay so the user can try again
                setTimeout(() => {
                    createListBtn.disabled = false;
                    createListBtn.textContent = 'Create New List';
                }, 2000);
            }
        });
    }
});