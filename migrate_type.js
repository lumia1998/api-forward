const Database = require('better-sqlite3');
const path = require('path');

const dbPath = path.join(__dirname, 'data', 'config.db');
const db = new Database(dbPath);

// Add type column if it doesn't exist
try {
    db.exec('ALTER TABLE api_endpoints ADD COLUMN type TEXT DEFAULT "image"');
    console.log('Added type column to api_endpoints table.');
} catch (e) {
    if (e.message.includes('duplicate column name')) {
        console.log('Column type already exists.');
    } else {
        console.log('Note:', e.message);
    }
}

db.close();
console.log('Migration complete.');
