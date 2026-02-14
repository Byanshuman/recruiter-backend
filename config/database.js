
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

// Database file path
const dbPath = path.resolve(__dirname, '../recruiter_pro.db');

const db = new sqlite3.Database(dbPath, (err) => {
    if (err) {
        console.error('❌ SQL Database Connection Error:', err.message);
    } else {
        console.log('✅ SQL Database Connected Successfully.');
    }
});

/**
 * Initializes the database schema if tables don't exist.
 */
const initSchema = () => {
    db.serialize(() => {
        // Admins Table
        db.run(`CREATE TABLE IF NOT EXISTS admins (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            email TEXT UNIQUE NOT NULL,
            role TEXT NOT NULL,
            createdAt TEXT NOT NULL
        )`);

        // Jobs Table
        db.run(`CREATE TABLE IF NOT EXISTS jobs (
            id TEXT PRIMARY KEY,
            title TEXT NOT NULL,
            department TEXT,
            status TEXT DEFAULT 'Open',
            priority TEXT DEFAULT 'Medium',
            description TEXT
        )`);

        // Candidates Table
        db.run(`CREATE TABLE IF NOT EXISTS candidates (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            email TEXT NOT NULL,
            phone TEXT,
            role TEXT,
            experience INTEGER DEFAULT 0,
            skills TEXT, -- Stored as comma-separated string
            stage TEXT DEFAULT 'Applied',
            resumeUrl TEXT,
            linkedIn TEXT,
            currentCTC TEXT,
            expectedCTC TEXT,
            noticePeriod TEXT,
            source TEXT,
            recruiterId TEXT,
            notes TEXT,
            appliedDate TEXT,
            updatedAt TEXT
        )`);

        // Interviews Table
        db.run(`CREATE TABLE IF NOT EXISTS interviews (
            id TEXT PRIMARY KEY,
            candidateId TEXT,
            candidateName TEXT,
            jobId TEXT,
            date TEXT,
            round TEXT,
            status TEXT DEFAULT 'Scheduled',
            feedback TEXT,
            FOREIGN KEY (candidateId) REFERENCES candidates (id) ON DELETE CASCADE,
            FOREIGN KEY (jobId) REFERENCES jobs (id) ON DELETE CASCADE
        )`);

        // Seed Root Super Admin if empty
        db.get("SELECT count(*) as count FROM admins", (err, row) => {
            if (row && row.count === 0) {
                db.run("INSERT INTO admins (id, name, email, role, createdAt) VALUES (?, ?, ?, ?, ?)", 
                ['super-admin-001', 'Alex Recruiter', 'alex@recruiterpro.io', 'Super Admin', new Date().toISOString()]);
                console.log('🌱 Seeded root super admin.');
            }
        });
    });
};

module.exports = { db, initSchema };
