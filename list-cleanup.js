import path from 'path';
import sqlite3Base from 'sqlite3';
import { fileURLToPath } from 'url';
import readline from 'readline';

const sqlite3 = sqlite3Base.verbose();

// --- Configuration ---
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DB_PATH = path.join(__dirname, 'data', 'AllData.sqlite');

// --- Create a command-line interface ---
const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

/**
 * Main function to run the cleanup process.
 */
async function runCleanup() {
    console.log(`Connecting to database at: ${DB_PATH}`);
    
    // Connect with Read/Write permissions
    const db = new sqlite3.Database(DB_PATH, sqlite3.OPEN_READWRITE, (err) => {
        if (err) {
            console.error('❌ Error connecting to database:', err.message);
            rl.close();
            return;
        }
    });

    try {
        // --- Step 1: Count the lists to be deleted ---
        const countSql = `SELECT COUNT(*) as count FROM imported_lists WHERE isPermanent = 1`;
        
        db.get(countSql, [], (err, row) => {
            if (err) {
                console.error('❌ Error counting saved lists:', err.message);
                db.close();
                rl.close();
                return;
            }

            const listCount = row.count;
            if (listCount === 0) {
                console.log('✅ No permanently saved lists found. Nothing to delete.');
                db.close();
                rl.close();
                return;
            }

            // --- Step 2: Ask for user confirmation ---
            console.log('\n==================== WARNING ====================');
            console.log(`You are about to permanently delete ${listCount} saved lists.`);
            console.log('This action cannot be undone.');
            console.log('=============================================');
            
            rl.question('Type "yes" to confirm and proceed: ', (answer) => {
                if (answer.toLowerCase() !== 'yes') {
                    console.log('\nCleanup cancelled. No lists were deleted.');
                    db.close();
                    rl.close();
                    return;
                }

                // --- Step 3: Execute the deletion ---
                console.log('\nDeleting saved lists...');
                const deleteSql = `DELETE FROM imported_lists WHERE isPermanent = 1`;
                
                db.run(deleteSql, function(err) {
                    if (err) {
                        console.error('❌ Error deleting lists:', err.message);
                    } else {
                        console.log(`\n🎉 Success! Deleted ${this.changes} saved lists.`);
                    }
                    
                    db.close();
                    rl.close();
                });
            });
        });

    } catch (error) {
        console.error('An unexpected error occurred:', error);
        db.close();
        rl.close();
    }
}

// Run the script
runCleanup();