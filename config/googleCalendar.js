const { google } = require("googleapis");
const path = require("path");
const fs = require("fs");

const KEY_PATH = path.join(__dirname, "../service-account-key.json");
const CALENDAR_ID = process.env.CALENDAR_ID || "primary";

let credentials;
let keyFile;
let calendar;
let CALENDAR_INIT_ERROR = null;

if (process.env.GOOGLE_SERVICE_ACCOUNT) {
    try {
        credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT);
        console.log("Google Calendar credentials loaded from GOOGLE_SERVICE_ACCOUNT.");
    } catch {
        CALENDAR_INIT_ERROR = "Failed to parse GOOGLE_SERVICE_ACCOUNT JSON for Calendar.";
    }
} else if (fs.existsSync(KEY_PATH)) {
    const keyRaw = fs.readFileSync(KEY_PATH, "utf8");
    if (keyRaw.includes("YOUR_PRIVATE_KEY_HERE") || keyRaw.includes("your-project-id")) {
        CALENDAR_INIT_ERROR =
            "Service account key is a placeholder. Replace recruiter-backend/service-account-key.json with a real key JSON.";
    } else {
        keyFile = KEY_PATH;
        console.log(`Google Calendar credentials loaded from ${KEY_PATH}.`);
    }
} else {
    CALENDAR_INIT_ERROR =
        "Google Calendar credentials missing. Set GOOGLE_SERVICE_ACCOUNT or place service-account-key.json in recruiter-backend.";
}

if (credentials || keyFile) {
    const auth = new google.auth.GoogleAuth({
        ...(credentials ? { credentials } : { keyFile }),
        scopes: ["https://www.googleapis.com/auth/calendar"],
    });

    calendar = google.calendar({ version: "v3", auth });
} else {
    console.error(`Google Calendar init skipped: ${CALENDAR_INIT_ERROR}`);
}

module.exports = {
    calendar,
    CALENDAR_ID,
    CALENDAR_INIT_ERROR
};
