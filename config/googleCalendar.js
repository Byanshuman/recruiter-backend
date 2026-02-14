const { google } = require("googleapis");
const path = require("path");
const fs = require("fs");

const KEY_PATH = path.join(__dirname, "../service-account-key.json");
const CALENDAR_ID = process.env.CALENDAR_ID || "primary";

let credentials;
let keyFile;

if (process.env.GOOGLE_SERVICE_ACCOUNT) {
    try {
        credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT);
        console.log("Google Calendar credentials loaded from GOOGLE_SERVICE_ACCOUNT.");
    } catch {
        throw new Error("Failed to parse GOOGLE_SERVICE_ACCOUNT JSON for Calendar.");
    }
} else if (fs.existsSync(KEY_PATH)) {
    const keyRaw = fs.readFileSync(KEY_PATH, "utf8");
    if (keyRaw.includes("YOUR_PRIVATE_KEY_HERE") || keyRaw.includes("your-project-id")) {
        throw new Error(
            "Service account key is a placeholder. Replace recruiter-backend/service-account-key.json with a real key JSON."
        );
    }
    keyFile = KEY_PATH;
    console.log(`Google Calendar credentials loaded from ${KEY_PATH}.`);
} else {
    throw new Error(
        "Google Calendar credentials missing. Set GOOGLE_SERVICE_ACCOUNT or place service-account-key.json in recruiter-backend."
    );
}

const auth = new google.auth.GoogleAuth({
    ...(credentials ? { credentials } : { keyFile }),
    scopes: ["https://www.googleapis.com/auth/calendar"],
});

const calendar = google.calendar({ version: "v3", auth });

module.exports = {
    calendar,
    CALENDAR_ID
};
