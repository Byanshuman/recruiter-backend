
const { google } = require("googleapis");
const path = require("path");
const fs = require("fs");

// IMPORTANT: Ensure you have a service-account-key.json in this directory
// or set up environment variables for production.
const KEY_PATH = path.join(__dirname, "../service-account-key.json");

const keyRaw = fs.readFileSync(KEY_PATH, "utf8");
if (keyRaw.includes("YOUR_PRIVATE_KEY_HERE") || keyRaw.includes("your-project-id")) {
    throw new Error(
        "Service account key is a placeholder. Replace recruiter-backend/service-account-key.json with a real key JSON."
    );
}

// User Spreadsheet ID from provided URL: 1uXYf2meZd8gjzImvDzzA6msdgjAZF3HjO8qpra4wRD0
const SPREADSHEET_ID = process.env.SPREADSHEET_ID || "1uXYf2meZd8gjzImvDzzA6msdgjAZF3HjO8qpra4wRD0";

const auth = new google.auth.GoogleAuth({
    keyFile: KEY_PATH,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});

const sheets = google.sheets({ version: "v4", auth });

module.exports = {
    sheets,
    SPREADSHEET_ID
};
