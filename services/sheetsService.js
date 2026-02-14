
const { sheets, SPREADSHEET_ID, SHEETS_INIT_ERROR } = require("../config/googleSheets");

/**
 * Safely extracts value from a row array with a fallback.
 */
const getVal = (row, index, fallback = "") => {
    return (row && row[index] !== undefined && row[index] !== null) ? row[index] : fallback;
};

const getNumber = (row, index, fallback = 0) => {
    const raw = getVal(row, index, "");
    const parsed = parseInt(raw, 10);
    return Number.isFinite(parsed) ? parsed : fallback;
};

const normalizePhone = (value) => {
    if (value === undefined || value === null) return "";
    const trimmed = String(value).trim();
    if (!trimmed) return "";
    // Prevent Google Sheets from treating +countrycode as a formula
    if (trimmed.startsWith('+')) return `'${trimmed}`;
    return trimmed;
};

const mapRowToObj = (sheetName, row) => {
    if (!row || row.length === 0) return null;
    
    if (sheetName === 'Candidates') {
        return {
            id: getVal(row, 0),
            name: getVal(row, 1),
            email: getVal(row, 2),
            phone: getVal(row, 3),
            role: getVal(row, 4),
            experience: getNumber(row, 5, 0),
            skills: getVal(row, 6, "").split(",").map(s => s.trim()).filter(Boolean),
            stage: getVal(row, 7, "Applied"),
            resumeUrl: getVal(row, 8),
            linkedIn: getVal(row, 9),
            currentCTC: getVal(row, 10),
            expectedCTC: getVal(row, 11),
            noticePeriod: getVal(row, 12),
            source: getVal(row, 13, "Manual"),
            recruiterId: getVal(row, 14),
            notes: getVal(row, 15),
            appliedDate: getVal(row, 16, new Date().toISOString()),
            updatedAt: getVal(row, 17, new Date().toISOString()),
            educationDegree: getVal(row, 18),
            educationInstitution: getVal(row, 19),
            educationYear: getVal(row, 20)
        };
    }
    if (sheetName === 'Jobs') {
        return {
            id: getVal(row, 0),
            title: getVal(row, 1),
            department: getVal(row, 2),
            status: getVal(row, 3, "Open"),
            priority: getVal(row, 4, "Medium"),
            description: getVal(row, 5),
            headcount: getNumber(row, 6, 1),
            minExperience: getNumber(row, 7, 0),
            requiredSkills: getVal(row, 8, "").split(",").map(s => s.trim()).filter(Boolean),
            preferredSkills: getVal(row, 9, "").split(",").map(s => s.trim()).filter(Boolean)
        };
    }
    if (sheetName === 'Interviews') {
        return {
            id: getVal(row, 0),
            candidateId: getVal(row, 1),
            candidateName: getVal(row, 2),
            jobId: getVal(row, 3),
            date: getVal(row, 4),
            round: getVal(row, 5, "Technical"),
            status: getVal(row, 6, "Scheduled"),
            feedback: getVal(row, 7),
            meetingLink: getVal(row, 8),
            interviewerId: getVal(row, 9),
            interviewerName: getVal(row, 10),
            interviewerEmail: getVal(row, 11)
        };
    }
    if (sheetName === 'Interviewers') {
        return {
            id: getVal(row, 0),
            email: getVal(row, 1),
            name: getVal(row, 2),
            role: getVal(row, 3),
            createdAt: getVal(row, 4),
            updatedAt: getVal(row, 5),
            image: getVal(row, 6)
        };
    }
    if (sheetName === 'Users') { // Renamed from 'Admins' to match spreadsheet
        return {
            id: getVal(row, 0),             // A: ID
            email: getVal(row, 1),          // B: Email
            passwordHash: getVal(row, 2),   // C: Password_Hash
            name: getVal(row, 3),           // D: Full_Name
            role: getVal(row, 4),           // E: Role
            createdAt: getVal(row, 5),      // F: Created_At
            updatedAt: getVal(row, 6),      // G: Updated_At
            mustChangePassword: getVal(row, 7) === "TRUE" // H: Must_Change_Password
        };
    }
    if (sheetName === 'Settings') {
        return {
            companyName: getVal(row, 0),
            companyWebsite: getVal(row, 1),
            aiSensitivity: getVal(row, 2, "Balanced"),
            enableAutoScreening: getVal(row, 3) === "TRUE",
            defaultCurrency: getVal(row, 4, "USD"),
            timezone: getVal(row, 5, "UTC"),
            dataRetentionDays: getNumber(row, 6, 365)
        };
    }
    return null;
};

const mapObjToRow = (sheetName, obj) => {
    if (sheetName === 'Candidates') {
        return [
            obj.id, obj.name, obj.email, normalizePhone(obj.phone),
            obj.role, obj.experience, (obj.skills || []).join(", "), 
            obj.stage, obj.resumeUrl || "", obj.linkedIn || "",
            obj.currentCTC || "", obj.expectedCTC || "", obj.noticePeriod || "",
            obj.source || "Manual", obj.recruiterId || "", obj.notes || "",
            obj.appliedDate || new Date().toISOString(), obj.updatedAt || new Date().toISOString(),
            obj.educationDegree || "", obj.educationInstitution || "", obj.educationYear || ""
        ];
    }
    if (sheetName === 'Jobs') {
        return [
            obj.id,
            obj.title,
            obj.department,
            obj.status,
            obj.priority,
            obj.description,
            obj.headcount ?? 1,
            obj.minExperience ?? 0,
            (obj.requiredSkills || []).join(", "),
            (obj.preferredSkills || []).join(", ")
        ];
    }
    if (sheetName === 'Interviews') {
        return [
            obj.id,
            obj.candidateId,
            obj.candidateName,
            obj.jobId,
            obj.date,
            obj.round,
            obj.status,
            obj.feedback || "",
            obj.meetingLink || "",
            obj.interviewerId || "",
            obj.interviewerName || "",
            obj.interviewerEmail || ""
        ];
    }
    if (sheetName === 'Interviewers') {
        return [
            obj.id,
            obj.email,
            obj.name,
            obj.role || "",
            obj.createdAt || new Date().toISOString(),
            obj.updatedAt || new Date().toISOString(),
            obj.image || ""
        ];
    }
    if (sheetName === 'Users') {
        return [
            obj.id, 
            obj.email, 
            obj.passwordHash || "", 
            obj.name, 
            obj.role, 
            obj.createdAt || new Date().toISOString(), 
            obj.updatedAt || new Date().toISOString(),
            obj.mustChangePassword ? "TRUE" : "FALSE"
        ];
    }
    if (sheetName === 'Settings') {
        return [
            obj.companyName, obj.companyWebsite, obj.aiSensitivity, 
            obj.enableAutoScreening ? "TRUE" : "FALSE", 
            obj.defaultCurrency, obj.timezone, obj.dataRetentionDays
        ];
    }
    return [];
};

const sheetsService = {
    ensureSheets() {
        if (!sheets) {
            throw new Error(SHEETS_INIT_ERROR || "Google Sheets client is not initialized.");
        }
    },
    async getRows(sheetName) {
        try {
            this.ensureSheets();
            const response = await sheets.spreadsheets.values.get({
                spreadsheetId: SPREADSHEET_ID,
                range: `${sheetName}!A2:Z`,
            });
            const rows = response.data.values || [];
            return rows.map((row, index) => ({
                rowIndex: index,
                data: mapRowToObj(sheetName, row)
            })).filter(item => item.data !== null && (item.data.id || item.data.companyName));
        } catch (error) {
            console.error(`Error reading ${sheetName} rows:`, error.message);
            throw error;
        }
    },
    async getData(sheetName) {
        try {
            this.ensureSheets();
            const response = await sheets.spreadsheets.values.get({
                spreadsheetId: SPREADSHEET_ID,
                range: `${sheetName}!A2:Z`,
            });
            const rows = response.data.values || [];
            if (sheetName === 'Settings') {
                return mapRowToObj(sheetName, rows[0]) || {
                    companyName: 'MM Recruiter Pro',
                    companyWebsite: 'https://recruiterpro.io',
                    aiSensitivity: 'Balanced',
                    enableAutoScreening: true,
                    defaultCurrency: 'USD',
                    timezone: 'UTC',
                    dataRetentionDays: 365
                };
            }
            return rows
                .map(row => mapRowToObj(sheetName, row))
                .filter(item => item !== null && (item.id || item.companyName));
        } catch (error) {
            console.error(`Error reading ${sheetName}:`, error.message);
            throw error;
        }
    },

    async appendData(sheetName, data) {
        try {
            this.ensureSheets();
            const row = mapObjToRow(sheetName, data);
            await sheets.spreadsheets.values.append({
                spreadsheetId: SPREADSHEET_ID,
                range: `${sheetName}!A:A`,
                valueInputOption: "USER_ENTERED",
                resource: { values: [row] },
            });
            return data;
        } catch (error) {
            console.error(`Error appending to ${sheetName}:`, error.message);
            throw error;
        }
    },

    async updateData(sheetName, id, data) {
        try {
            this.ensureSheets();
            if (sheetName === 'Settings') {
                const row = mapObjToRow(sheetName, data);
                await sheets.spreadsheets.values.update({
                    spreadsheetId: SPREADSHEET_ID,
                    range: `Settings!A2:Z2`,
                    valueInputOption: "USER_ENTERED",
                    resource: { values: [row] },
                });
                return data;
            }

            const currentData = await this.getData(sheetName);
            let rowIndex = currentData.findIndex(item => item.id === id);
            if (rowIndex === -1 && sheetName === 'Jobs') {
                const targetTitle = (data.title || '').toLowerCase();
                const targetDept = (data.department || '').toLowerCase();
                rowIndex = currentData.findIndex(item =>
                    (item.title || '').toLowerCase() === targetTitle &&
                    (item.department || '').toLowerCase() === targetDept
                );
            }
            if (rowIndex === -1) throw new Error("Record not found");

            const row = mapObjToRow(sheetName, data);
            const range = `${sheetName}!A${rowIndex + 2}:Z${rowIndex + 2}`;

            await sheets.spreadsheets.values.update({
                spreadsheetId: SPREADSHEET_ID,
                range: range,
                valueInputOption: "USER_ENTERED",
                resource: { values: [row] },
            });
            return data;
        } catch (error) {
            console.error(`Error updating ${sheetName}:`, error.message);
            throw error;
        }
    },
    async updateRow(sheetName, rowIndex, data) {
        try {
            this.ensureSheets();
            const row = mapObjToRow(sheetName, data);
            const range = `${sheetName}!A${rowIndex + 2}:Z${rowIndex + 2}`;
            await sheets.spreadsheets.values.update({
                spreadsheetId: SPREADSHEET_ID,
                range,
                valueInputOption: "USER_ENTERED",
                resource: { values: [row] },
            });
            return data;
        } catch (error) {
            console.error(`Error updating ${sheetName} row:`, error.message);
            throw error;
        }
    },
    async clearRow(sheetName, rowIndex) {
        try {
            this.ensureSheets();
            const range = `${sheetName}!A${rowIndex + 2}:Z${rowIndex + 2}`;
            await sheets.spreadsheets.values.clear({
                spreadsheetId: SPREADSHEET_ID,
                range,
            });
        } catch (error) {
            console.error(`Error clearing ${sheetName} row:`, error.message);
            throw error;
        }
    },

    async deleteData(sheetName, id, fallbackEmail) {
        try {
            this.ensureSheets();
            if (sheetName === 'Users' && id === 'super-admin-001') {
                throw new Error("Cannot delete root super admin.");
            }
            const currentData = await this.getData(sheetName);
            const normalizedId = (id || '').toString().trim().toLowerCase();
            let rowIndex = currentData.findIndex(item => (item.id || '').toString().trim().toLowerCase() === normalizedId);

            if (rowIndex === -1 && sheetName === 'Candidates') {
                const normalizedEmail = (fallbackEmail || '').toString().trim().toLowerCase();
                if (normalizedEmail) {
                    rowIndex = currentData.findIndex(item => (item.email || '').toString().trim().toLowerCase() === normalizedEmail);
                } else if (normalizedId.includes('@')) {
                    rowIndex = currentData.findIndex(item => (item.email || '').toString().trim().toLowerCase() === normalizedId);
                }
            }

            if (rowIndex === -1) return;

            const range = `${sheetName}!A${rowIndex + 2}:Z${rowIndex + 2}`;
            await sheets.spreadsheets.values.clear({
                spreadsheetId: SPREADSHEET_ID,
                range: range,
            });
        } catch (error) {
            console.error(`Error deleting from ${sheetName}:`, error.message);
            throw error;
        }
    },

    async verifyAllTabs() {
        this.ensureSheets();
        const required = ['Candidates', 'Jobs', 'Interviews', 'Users', 'Settings'];
        const results = {};
        for (const tab of required) {
            try {
                await sheets.spreadsheets.values.get({
                    spreadsheetId: SPREADSHEET_ID,
                    range: `${tab}!A1:A1`,
                });
                results[tab] = true;
            } catch {
                results[tab] = false;
            }
        }
        return results;
    }
};

module.exports = sheetsService;
