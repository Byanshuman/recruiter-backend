const { google } = require("googleapis");
const fs = require("fs");
const path = require("path");

// Spreadsheet ID
const SPREADSHEET_ID =
  process.env.SPREADSHEET_ID || "1uXYf2meZd8gjzImvDzzA6msdgjAZF3HjO8qpra4wRD0";

const DEFAULT_KEY_PATH = path.join(__dirname, "../service-account-key.json");
const SERVICE_ACCOUNT_FILE = process.env.GOOGLE_SERVICE_ACCOUNT_FILE || DEFAULT_KEY_PATH;

let credentials;
let sheets;
let SHEETS_INIT_ERROR = null;

if (process.env.GOOGLE_SERVICE_ACCOUNT) {
  try {
    credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT);
    console.log("Google Sheets credentials loaded from GOOGLE_SERVICE_ACCOUNT.");
  } catch {
    SHEETS_INIT_ERROR = "Failed to parse GOOGLE_SERVICE_ACCOUNT JSON.";
  }
} else if (fs.existsSync(SERVICE_ACCOUNT_FILE)) {
  try {
    const keyRaw = fs.readFileSync(SERVICE_ACCOUNT_FILE, "utf8");
    credentials = JSON.parse(keyRaw);
    console.log(`Google Sheets credentials loaded from ${SERVICE_ACCOUNT_FILE}.`);
  } catch {
    SHEETS_INIT_ERROR = `Failed to read service account file: ${SERVICE_ACCOUNT_FILE}`;
  }
} else {
  SHEETS_INIT_ERROR =
    "Google Sheets credentials missing. Set GOOGLE_SERVICE_ACCOUNT or place service-account-key.json in recruiter-backend.";
}

if (credentials) {
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });

  sheets = google.sheets({ version: "v4", auth });
} else {
  console.error(`Google Sheets init skipped: ${SHEETS_INIT_ERROR}`);
}

module.exports = {
  sheets,
  SPREADSHEET_ID,
  SHEETS_INIT_ERROR,
};
