const { google } = require("googleapis");
const fs = require("fs");
const path = require("path");

// Spreadsheet ID
const SPREADSHEET_ID =
  process.env.SPREADSHEET_ID || "1uXYf2meZd8gjzImvDzzA6msdgjAZF3HjO8qpra4wRD0";

const DEFAULT_KEY_PATH = path.join(__dirname, "../service-account-key.json");
const SERVICE_ACCOUNT_FILE = process.env.GOOGLE_SERVICE_ACCOUNT_FILE || DEFAULT_KEY_PATH;

let credentials;

if (process.env.GOOGLE_SERVICE_ACCOUNT) {
  try {
    credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT);
    console.log("Google Sheets credentials loaded from GOOGLE_SERVICE_ACCOUNT.");
  } catch {
    throw new Error("Failed to parse GOOGLE_SERVICE_ACCOUNT JSON.");
  }
} else if (fs.existsSync(SERVICE_ACCOUNT_FILE)) {
  try {
    const keyRaw = fs.readFileSync(SERVICE_ACCOUNT_FILE, "utf8");
    credentials = JSON.parse(keyRaw);
    console.log(`Google Sheets credentials loaded from ${SERVICE_ACCOUNT_FILE}.`);
  } catch {
    throw new Error(`Failed to read service account file: ${SERVICE_ACCOUNT_FILE}`);
  }
} else {
  throw new Error(
    "Google Sheets credentials missing. Set GOOGLE_SERVICE_ACCOUNT or place service-account-key.json in recruiter-backend."
  );
}

const auth = new google.auth.GoogleAuth({
  credentials,
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});

const sheets = google.sheets({ version: "v4", auth });

module.exports = {
  sheets,
  SPREADSHEET_ID,
};
