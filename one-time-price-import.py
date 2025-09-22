# one-time-price-import.py
import sqlite3
import json
import ijson
import os
import time
from decimal import Decimal # <-- NEW: Import the Decimal type

# --- NEW: Custom JSON Encoder ---
# This class teaches the json library how to handle the Decimal type.
class DecimalEncoder(json.JSONEncoder):
    def default(self, o):
        if isinstance(o, Decimal):
            # If it's a Decimal, convert it to a float
            return float(o)
        # For everything else, use the default behavior
        return super().default(o)

# --- Configuration ---
SOURCE_JSON_PATH = 'data/AllPrices.json'
TARGET_DB_PATH = 'data/AllData.sqlite'

def main():
    """
    Creates the initial AllData.sqlite database and populates it with
    historical price data by streaming the massive AllPrices.json file.
    This script should only be run once.
    """
    start_time = time.time()
    print("Starting the one-time price history import...")

    os.makedirs(os.path.dirname(TARGET_DB_PATH), exist_ok=True)
    if os.path.exists(TARGET_DB_PATH):
        print(f"Warning: Target database {TARGET_DB_PATH} already exists. Appending price history table.")

    conn = None
    try:
        conn = sqlite3.connect(TARGET_DB_PATH)
        cursor = conn.cursor()

        print("Creating 'price_history' table...")
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS price_history (
                uuid TEXT PRIMARY KEY,
                price_json TEXT NOT NULL
            )
        """)
        conn.commit()

        print(f"Streaming historical prices from {SOURCE_JSON_PATH}...")
        print("This may take several minutes. Please be patient.")
        
        insert_sql = "INSERT OR REPLACE INTO price_history (uuid, price_json) VALUES (?, ?)"
        cursor.execute("BEGIN TRANSACTION")
        
        count = 0
        with open(SOURCE_JSON_PATH, 'rb') as f:
            for uuid, price_object in ijson.kvitems(f, 'data'):
                # --- UPDATED LINE ---
                # Use our custom DecimalEncoder to handle the conversion
                price_json_str = json.dumps(price_object, cls=DecimalEncoder)
                cursor.execute(insert_sql, (uuid, price_json_str))
                count += 1
                if count % 50000 == 0:
                    print(f"  -> Processed {count:,} price records...", end='\r')

        print(f"\nCommitting {count:,} records to the database...")
        conn.commit()
        print("✅ Price history import complete.")

    except Exception as e:
        print(f"\n❌ An error occurred: {e}")
        if conn: conn.rollback()
    finally:
        if conn: conn.close()

    end_time = time.time()
    print(f"\n🎉 One-time import finished successfully!")
    print(f"Total time taken: {end_time - start_time:.2f} seconds.")

if __name__ == '__main__':
    main()