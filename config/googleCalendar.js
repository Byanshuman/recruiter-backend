const { google } = require("googleapis");
const path = require("path");
const fs = require("fs");

const KEY_PATH = path.join(__dirname, "../service-account-key.json");

const keyRaw = fs.readFileSync(KEY_PATH, "utf8");
if (keyRaw.includes("YOUR_PRIVATE_KEY_HERE") || keyRaw.includes("your-project-id")) {
    throw new Error(
        "Service account key is a placeholder. Replace recruiter-backend/service-account-key.json with a real key JSON."
    );
}

const CALENDAR_ID = process.env.CALENDAR_ID || "primary";

const auth = new google.auth.GoogleAuth({
    keyFile: KEY_PATH,
    scopes: ["https://www.googleapis.com/auth/calendar"],
});

const calendar = google.calendar({ version: "v3", auth });

module.exports = {
    calendar,
    CALENDAR_ID
};
