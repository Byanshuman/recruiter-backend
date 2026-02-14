
const { db } = require('../config/database');

const sqlService = {
    // Generic Runner for async DB operations
    run(sql, params = []) {
        return new Promise((resolve, reject) => {
            db.run(sql, params, function(err) {
                if (err) reject(err);
                else resolve({ id: this.lastID, changes: this.changes });
            });
        });
    },

    all(sql, params = []) {
        return new Promise((resolve, reject) => {
            db.all(sql, params, (err, rows) => {
                if (err) reject(err);
                else resolve(rows);
            });
        });
    },

    get(sql, params = []) {
        return new Promise((resolve, reject) => {
            db.get(sql, params, (err, row) => {
                if (err) reject(err);
                else resolve(row);
            });
        });
    },

    // Resource Specific Methods
    async getCandidates() {
        const rows = await this.all("SELECT * FROM candidates ORDER BY appliedDate DESC");
        return rows.map(r => ({
            ...r,
            skills: r.skills ? r.skills.split(',').map(s => s.trim()) : []
        }));
    },

    async saveCandidate(c) {
        const skillsStr = Array.isArray(c.skills) ? c.skills.join(',') : '';
        const existing = await this.get("SELECT id FROM candidates WHERE id = ?", [c.id]);
        
        if (existing) {
            await this.run(`
                UPDATE candidates SET 
                name=?, email=?, phone=?, role=?, experience=?, skills=?, stage=?, 
                currentCTC=?, expectedCTC=?, noticePeriod=?, source=?, recruiterId=?, notes=?, updatedAt=?
                WHERE id=?`, 
                [c.name, c.email, c.phone, c.role, c.experience, skillsStr, c.stage, 
                 c.currentCTC, c.expectedCTC, c.noticePeriod, c.source, c.recruiterId, c.notes, new Date().toISOString(), c.id]);
        } else {
            await this.run(`
                INSERT INTO candidates (id, name, email, phone, role, experience, skills, stage, appliedDate, updatedAt, currentCTC, expectedCTC, noticePeriod, source, recruiterId, notes)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [c.id, c.name, c.email, c.phone, c.role, c.experience, skillsStr, c.stage, c.appliedDate || new Date().toISOString(), new Date().toISOString(), c.currentCTC, c.expectedCTC, c.noticePeriod, c.source, c.recruiterId, c.notes]);
        }
        return c;
    },

    async getJobs() {
        return this.all("SELECT * FROM jobs");
    },

    async saveJob(j) {
        const existing = await this.get("SELECT id FROM jobs WHERE id = ?", [j.id]);
        if (existing) {
            await this.run("UPDATE jobs SET title=?, department=?, status=?, priority=?, description=? WHERE id=?", 
                [j.title, j.department, j.status, j.priority, j.description, j.id]);
        } else {
            await this.run("INSERT INTO jobs (id, title, department, status, priority, description) VALUES (?, ?, ?, ?, ?, ?)",
                [j.id, j.title, j.department, j.status, j.priority, j.description]);
        }
        return j;
    },

    async getInterviews() {
        return this.all("SELECT * FROM interviews ORDER BY date ASC");
    },

    async saveInterview(i) {
        // SQL handles PK conflicts or updates if needed. Simplistic Insert for history.
        await this.run("INSERT INTO interviews (id, candidateId, candidateName, jobId, date, round, status, feedback) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            [i.id, i.candidateId, i.candidateName, i.jobId, i.date, i.round, i.status, i.feedback]);
        return i;
    }
};

module.exports = sqlService;
