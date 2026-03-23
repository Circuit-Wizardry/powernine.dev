import sqlite3
import requests
import time
import os
import re

# --- Configuration ---
DATABASE_FILE = os.path.join(os.path.dirname(__file__), '..', 'data', 'AllData.sqlite')
SCRYFALL_BASE_URL = 'https://api.scryfall.com/cards/'
DELAY_SECONDS = 0.1  # 100ms delay to be polite to the Scryfall API (max 10 requests per second)
# ---------------------

def ensure_scryfall_id_column_exists(conn):
    """
    Checks if the 'scryfallId' column exists in the 'inventory' table and adds it if not.
    """
    cursor = conn.cursor()
    try:
        # Check if the column exists by attempting to read it
        cursor.execute("SELECT scryfallId FROM inventory LIMIT 1;")
        print("   'scryfallId' column already exists in 'inventory' table.")
    except sqlite3.OperationalError as e:
        # If the column doesn't exist, we'll get an error, so we add it.
        if "no such column: scryfallId" in str(e):
            print("   'scryfallId' column not found. Adding column to 'inventory' table...")
            cursor.execute("ALTER TABLE inventory ADD COLUMN scryfallId TEXT;")
            conn.commit()
            print("   Column added successfully.")
        else:
            raise e # Re-raise other operational errors

def get_cards_to_update(conn):
    """
    Fetches all inventory items that are currently missing a Scryfall ID.
    We need the inventory ID (i.id) to update the specific row later.
    """
    print("2. Querying database for inventory items missing Scryfall IDs...")
    cursor = conn.cursor()
    
    # Select all required fields for items where scryfallId is NULL or empty
    query = """
    SELECT 
        id, setCode, collectorNumber
    FROM inventory
    WHERE scryfallId IS NULL OR scryfallId = '';
    """
    
    cursor.execute(query)
    # The result is a list of tuples: [(id, 'SET', 'NUM'), (id2, 'SET2', 'NUM2'), ...]
    cards_to_update = cursor.fetchall()
    print(f"   Found {len(cards_to_update)} inventory items needing updates.")
    return cards_to_update

def fetch_scryfall_id(set_code, collector_number):
    """
    Fetches the Scryfall UUID for a given card using the Scryfall API.
    
    IMPORTANT: Strips non-digit characters from collector_number before lookup.
    """
    
    # --- NEW LOGIC: Clean the collector number ---
    # Scryfall expects only digits for the lookup path, though the query parameter 
    # would allow for non-digits. Cleaning it here ensures we get the primary card number.
    
    # This keeps digits (0-9). Example: '256a' becomes '256'. '123_S' becomes '123'.
    # cleaned_number = re.sub(r'[^0-9]', '', collector_number)
    cleaned_number = collector_number
    
    if not cleaned_number:
        print(f"   [WARN] Collector number '{collector_number}' from set '{set_code}' reduced to empty string. Skipping.")
        return None
        
    # Scryfall uses lowercase set codes and base collector numbers
    url = f"{SCRYFALL_BASE_URL}{set_code}/{cleaned_number}"
    
    try:
        response = requests.get(url)
        response.raise_for_status() # Raise an HTTPError for bad responses (4xx or 5xx)
        data = response.json()
        
        # We need the unique ID for the specific printing
        scryfall_id = data.get('id') 
        return scryfall_id
        
    except requests.exceptions.HTTPError as e:
        if e.response.status_code == 404:
            print(f"   [WARN] Card not found on Scryfall after cleaning number ({collector_number}): {SCRYFALL_BASE_URL}{set_code.lower()}/{cleaned_number}")
            return None
        print(f"   [ERROR] HTTP Error fetching {set_code}/{collector_number}: {e}")
        return None
    except requests.exceptions.RequestException as e:
        print(f"   [ERROR] Request failed for {set_code}/{collector_number}: {e}")
        return None
    

def update_inventory_record(conn, inventory_id, scryfall_id):
    """
    Updates the 'scryfallId' column in the 'inventory' table for a specific row.
    """
    cursor = conn.cursor()
    update_query = """
    UPDATE inventory
    SET scryfallId = ?
    WHERE id = ?
    """
    cursor.execute(update_query, (scryfall_id, inventory_id))
    return cursor.rowcount

def main():
    """Main function to orchestrate the update process."""
    if not os.path.exists(DATABASE_FILE):
        print(f"Error: Database file '{DATABASE_FILE}' not found.")
        print("Please ensure the script is in the same directory as your SQLite database file.")
        return

    try:
        # 1. Connect and ensure schema is ready
        conn = sqlite3.connect(DATABASE_FILE)
        print("1. Ensuring database schema is ready...")
        ensure_scryfall_id_column_exists(conn)
        
        # 2. Get the list of cards to process
        cards_to_process = get_cards_to_update(conn)
        
        if not cards_to_process:
            print("3. No inventory items found needing a Scryfall ID update. Exiting.")
            return

        print("\n3. Starting Scryfall API calls and database updates...")
        updated_count = 0
        
        for i, (inventory_id, set_code, collector_number) in enumerate(cards_to_process):
            # Print progress
            if (i + 1) % 10 == 0 or i == 0 or i == len(cards_to_process) - 1:
                print(f"   Processing item {i + 1}/{len(cards_to_process)}: {set_code}/{collector_number} (ID: {inventory_id[:8]}...)")

            scryfall_id = fetch_scryfall_id(set_code, collector_number)
            
            if scryfall_id:
                rows_changed = update_inventory_record(conn, inventory_id, scryfall_id)
                if rows_changed > 0:
                    updated_count += 1
            
            # Pause to respect the API rate limit
            time.sleep(DELAY_SECONDS)
        
        # Commit all changes to the database
        conn.commit()
        print("\n4. Update complete.")
        print(f"   Successfully fetched and updated Scryfall IDs for {updated_count} inventory items.")

    except sqlite3.Error as e:
        print(f"\n[FATAL ERROR] SQLite database error: {e}")
        if 'conn' in locals() and conn:
            conn.rollback() # Ensure no partial changes are saved
    except Exception as e:
        print(f"\n[FATAL ERROR] An unexpected error occurred: {e}")
    finally:
        if 'conn' in locals() and conn:
            conn.close()
            print("   Database connection closed.")

if __name__ == "__main__":
    main()
