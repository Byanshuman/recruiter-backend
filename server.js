
const fs = require('fs');
const path = require('path');

const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
    const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
    for (const line of lines) {
        if (!line || line.trim().startsWith('#')) continue;
        const idx = line.indexOf('=');
        if (idx === -1) continue;
        const key = line.slice(0, idx).trim();
        const rawValue = line.slice(idx + 1).trim();
        if (!key) continue;
        const value = rawValue.replace(/^"(.*)"$/, '$1');
        if (process.env[key] === undefined) {
            process.env[key] = value;
        }
    }
}

const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const sheetsService = require('./services/sheetsService');
const { calendar, CALENDAR_ID, CALENDAR_INIT_ERROR } = require('./config/googleCalendar');

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

app.get('/api/health', async (req, res) => {
    try {
        const fast = req.query.fast === '1';
        const tabs = fast ? undefined : await sheetsService.verifyAllTabs();
        res.json({ 
            status: 'ok', 
            database: 'connected', 
            engine: 'Google Sheets API v4',
            ...(tabs ? { tabs_found: tabs } : {}),
            timestamp: new Date() 
        });
    } catch (err) {
        res.status(500).json({ status: 'error', message: err.message });
    }
});

// Settings Routes
app.get('/api/settings', async (req, res) => {
    try {
        const data = await sheetsService.getData('Settings');
        res.json(data);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/settings', async (req, res) => {
    try {
        const result = await sheetsService.updateData('Settings', null, req.body);
        res.json(result);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Admin/User Routes
app.get('/api/admins', async (req, res) => {
    try {
        const data = await sheetsService.getData('Users'); // Targeted 'Users' sheet
        res.json(data);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/admins', async (req, res) => {
    try {
        const result = await sheetsService.appendData('Users', req.body);
        res.status(201).json(result);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/admins/provision', async (req, res) => {
    try {
        const { id, name, email, role, tempPassword } = req.body;
        if (!tempPassword || tempPassword.length < 8) {
            return res.status(400).json({ error: 'Temporary password must be at least 8 characters.' });
        }
        const timestamp = new Date().toISOString();
        const passwordHash = await bcrypt.hash(tempPassword, 10);
        const newAdmin = {
            id,
            name,
            email,
            role,
            passwordHash,
            mustChangePassword: true,
            createdAt: timestamp,
            updatedAt: timestamp
        };
        const result = await sheetsService.appendData('Users', newAdmin);
        res.status(201).json(result);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/admins/:id', async (req, res) => {
    try {
        await sheetsService.deleteData('Users', req.params.id);
        res.status(204).end();
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/auth/login', async (req, res) => {
    try {
        const { email, password } = req.body;
        if (!email || !password) {
            return res.status(400).json({ error: 'Email and password are required.' });
        }
        const admins = await sheetsService.getData('Users');
        const user = admins.find(a => a.email.toLowerCase() === email.toLowerCase());
        if (!user) return res.status(401).json({ error: 'Invalid credentials.' });

        const ok = await bcrypt.compare(password, user.passwordHash || '');
        if (!ok) return res.status(401).json({ error: 'Invalid credentials.' });

        const { passwordHash, ...safeUser } = user;
        res.json({ user: safeUser });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/auth/change-password', async (req, res) => {
    try {
        const { id, newPassword } = req.body;
        if (!id || !newPassword || newPassword.length < 8) {
            return res.status(400).json({ error: 'New password must be at least 8 characters.' });
        }
        const admins = await sheetsService.getData('Users');
        const user = admins.find(a => a.id === id);
        if (!user) return res.status(404).json({ error: 'User not found.' });

        const updated = {
            ...user,
            passwordHash: await bcrypt.hash(newPassword, 10),
            mustChangePassword: false,
            updatedAt: new Date().toISOString()
        };

        const result = await sheetsService.updateData('Users', id, updated);
        res.json(result);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Candidate Routes
app.get('/api/candidates', async (req, res) => {
    try {
        const data = await sheetsService.getData('Candidates');
        res.json(data);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/candidates', async (req, res) => {
    try {
        const result = await sheetsService.appendData('Candidates', req.body);
        res.status(201).json(result);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

const stageRank = {
    Applied: 1,
    Screening: 2,
    Interview: 3,
    Offer: 4,
    Onboarding: 5,
    Rejected: 0
};

const mergeCandidates = (primary, secondary) => {
    const pick = (a, b) => a && String(a).trim().length > 0 ? a : b;
    const pickLonger = (a, b) => {
        const aLen = a ? String(a).trim().length : 0;
        const bLen = b ? String(b).trim().length : 0;
        return aLen >= bLen ? a : b;
    };
    const mergeSkills = (a = [], b = []) => {
        const merged = new Set([...a, ...b].map(s => String(s).trim()).filter(Boolean));
        return Array.from(merged);
    };
    const pickStage = (a, b) => (stageRank[a] ?? 0) >= (stageRank[b] ?? 0) ? a : b;
    const pickDateMin = (a, b) => {
        const da = a ? new Date(a).getTime() : Infinity;
        const db = b ? new Date(b).getTime() : Infinity;
        if (da <= db) return a || b;
        return b || a;
    };
    const pickDateMax = (a, b) => {
        const da = a ? new Date(a).getTime() : -Infinity;
        const db = b ? new Date(b).getTime() : -Infinity;
        if (da >= db) return a || b;
        return b || a;
    };

    return {
        ...primary,
        name: pick(primary.name, secondary.name),
        email: pick(primary.email, secondary.email),
        phone: pick(primary.phone, secondary.phone),
        role: pick(primary.role, secondary.role),
        experience: Math.max(primary.experience || 0, secondary.experience || 0),
        skills: mergeSkills(primary.skills, secondary.skills),
        stage: pickStage(primary.stage, secondary.stage),
        resumeUrl: pick(primary.resumeUrl, secondary.resumeUrl),
        linkedIn: pick(primary.linkedIn, secondary.linkedIn),
        currentCTC: pick(primary.currentCTC, secondary.currentCTC),
        expectedCTC: pick(primary.expectedCTC, secondary.expectedCTC),
        noticePeriod: pick(primary.noticePeriod, secondary.noticePeriod),
        source: pick(primary.source, secondary.source),
        recruiterId: pick(primary.recruiterId, secondary.recruiterId),
        notes: pickLonger(primary.notes, secondary.notes),
        educationDegree: pick(primary.educationDegree, secondary.educationDegree),
        educationInstitution: pick(primary.educationInstitution, secondary.educationInstitution),
        educationYear: pick(primary.educationYear, secondary.educationYear),
        appliedDate: pickDateMin(primary.appliedDate, secondary.appliedDate),
        updatedAt: pickDateMax(primary.updatedAt, secondary.updatedAt)
    };
};

const candidateQualityScore = (c) => {
    return (
        (c.skills ? c.skills.length : 0) * 2 +
        (c.phone ? 1 : 0) +
        (c.role ? 1 : 0) +
        (c.experience ? 1 : 0) +
        (c.resumeUrl ? 1 : 0) +
        (c.linkedIn ? 1 : 0)
    );
};

app.post('/api/candidates/dedupe', async (req, res) => {
    try {
        const rows = await sheetsService.getRows('Candidates');
        const byEmail = new Map();
        for (const row of rows) {
            const email = row.data && row.data.email ? String(row.data.email).trim().toLowerCase() : '';
            if (!email) continue;
            if (!byEmail.has(email)) byEmail.set(email, []);
            byEmail.get(email).push(row);
        }

        let groups = 0;
        let removed = 0;
        let updated = 0;

        for (const [email, group] of byEmail.entries()) {
            if (group.length < 2) continue;
            groups += 1;
            const sorted = [...group].sort((a, b) => candidateQualityScore(b.data) - candidateQualityScore(a.data));
            const primary = sorted[0];
            let merged = primary.data;
            for (let i = 1; i < sorted.length; i += 1) {
                merged = mergeCandidates(merged, sorted[i].data);
            }
            await sheetsService.updateRow('Candidates', primary.rowIndex, merged);
            updated += 1;
            for (let i = 1; i < sorted.length; i += 1) {
                await sheetsService.clearRow('Candidates', sorted[i].rowIndex);
                removed += 1;
            }
        }

        res.json({ status: 'ok', groups, updated, removed });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.put('/api/candidates/:id', async (req, res) => {
    try {
        const result = await sheetsService.updateData('Candidates', req.params.id, req.body);
        res.json(result);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/candidates/:id', async (req, res) => {
    try {
        const email = typeof req.query.email === 'string' ? req.query.email : undefined;
        await sheetsService.deleteData('Candidates', req.params.id, email);
        res.status(204).end();
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Job Routes
app.get('/api/jobs', async (req, res) => {
    try {
        const data = await sheetsService.getData('Jobs');
        res.json(data);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/jobs', async (req, res) => {
    try {
        const result = await sheetsService.appendData('Jobs', req.body);
        res.status(201).json(result);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.put('/api/jobs/:id', async (req, res) => {
    try {
        const result = await sheetsService.updateData('Jobs', req.params.id, req.body);
        res.json(result);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/jobs/:id', async (req, res) => {
    try {
        await sheetsService.deleteData('Jobs', req.params.id);
        res.status(204).end();
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Interview Routes
app.get('/api/interviews', async (req, res) => {
    try {
        const data = await sheetsService.getData('Interviews');
        res.json(data);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/interviews', async (req, res) => {
    try {
        const result = await sheetsService.appendData('Interviews', req.body);
        res.status(201).json(result);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.put('/api/interviews/:id', async (req, res) => {
    try {
        const result = await sheetsService.updateData('Interviews', req.params.id, req.body);
        res.json(result);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Interviewers Routes
app.get('/api/interviewers', async (req, res) => {
    try {
        const data = await sheetsService.getData('Interviewers');
        res.json(data);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/interviewers', async (req, res) => {
    try {
        const result = await sheetsService.appendData('Interviewers', req.body);
        res.status(201).json(result);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.put('/api/interviewers/:id', async (req, res) => {
    try {
        const result = await sheetsService.updateData('Interviewers', req.params.id, req.body);
        res.json(result);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

const makeICalUID = (rawId) => {
    const safe = String(rawId || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const base = safe || 'unknown';
    return `${base}@mm-recruiter-pro`;
};

app.post('/api/calendar/sync', async (req, res) => {
    try {
        if (!calendar) {
            return res.status(503).json({ error: CALENDAR_INIT_ERROR || 'Google Calendar client is not initialized.' });
        }
        const interviews = await sheetsService.getData('Interviews');
        const jobs = await sheetsService.getData('Jobs');
        const jobMap = new Map(jobs.map(j => [j.id, j.title]));

        let created = 0;
        let updated = 0;
        let skipped = 0;

        for (const interview of interviews) {
            if (!interview.date) {
                skipped += 1;
                continue;
            }
            const start = new Date(interview.date);
            if (Number.isNaN(start.getTime())) {
                skipped += 1;
                continue;
            }
            const end = new Date(start.getTime() + 30 * 60 * 1000);
            const jobTitle = jobMap.get(interview.jobId) || 'Interview';
            const iCalUID = makeICalUID(interview.id);
            const summary = `${interview.round} Interview - ${interview.candidateName}`;
            const description = `Role: ${jobTitle}`;

            const event = {
                summary,
                description,
                start: { dateTime: start.toISOString() },
                end: { dateTime: end.toISOString() },
                iCalUID
            };

            try {
                const existing = await calendar.events.list({
                    calendarId: CALENDAR_ID,
                    iCalUID,
                    maxResults: 1,
                    singleEvents: true
                });
                const match = existing.data.items && existing.data.items.length > 0 ? existing.data.items[0] : null;
                if (match && match.id) {
                    await calendar.events.update({ calendarId: CALENDAR_ID, eventId: match.id, requestBody: event });
                    updated += 1;
                } else {
                    await calendar.events.insert({ calendarId: CALENDAR_ID, requestBody: event });
                    created += 1;
                }
            } catch (err) {
                throw err;
            }
        }

        res.json({
            status: 'ok',
            calendarId: CALENDAR_ID,
            created,
            updated,
            skipped
        });
    } catch (err) {
        console.error('Calendar sync failed:', err);
        res.status(500).json({ error: err.message });
    }
});

const extractJson = (text) => {
    if (!text) return null;
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
        return JSON.parse(match[0]);
    } catch {
        return null;
    }
};

const normalizeName = (value) => {
    if (!value) return '';
    const normalized = String(value).trim().replace(/\s+/g, ' ');
    if (!normalized) return '';
    return normalized
        .split(' ')
        .map(token => token
            .split(/([-'])/)
            .map(part => (part === '-' || part === "'")
                ? part
                : part.charAt(0).toUpperCase() + part.slice(1).toLowerCase()
            )
            .join('')
        )
        .join(' ');
};

const splitNameFromEmail = (email) => {
    if (!email) return '';
    const local = String(email).split('@')[0];
    if (!local || !/[._-]/.test(local)) return '';
    const parts = local.split(/[._-]+/).filter(Boolean);
    if (parts.length < 2) return '';
    return normalizeName(parts.join(' '));
};

const sanitizeAiScreenResult = (raw) => {
    if (!raw || typeof raw !== 'object') return null;
    const fitScore = Number(raw.fitScore);
    const confidence = Number(raw.confidence);
    if (!Number.isFinite(fitScore) || fitScore < 0 || fitScore > 100) return null;
    if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) return null;
    const strengths = Array.isArray(raw.strengths) ? raw.strengths.filter(Boolean).map(String) : [];
    const gaps = Array.isArray(raw.gaps) ? raw.gaps.filter(Boolean).map(String) : [];
    const recommendation = typeof raw.recommendation === 'string' ? raw.recommendation : '';
    return {
        fitScore: Math.round(fitScore),
        confidence: Math.round(confidence * 1000) / 1000,
        strengths,
        gaps,
        recommendation
    };
};

app.post('/api/ai/screen', async (req, res) => {
    try {
        const { candidate, job } = req.body || {};
        const apiKey = process.env.OPENROUTER_API_KEY;
        const model = process.env.OPENROUTER_MODEL || 'openai/gpt-4o-mini';
        if (!apiKey) {
            return res.status(400).json({ error: 'Missing OPENROUTER_API_KEY' });
        }
        if (!candidate || !job) {
            return res.status(400).json({ error: 'Missing candidate or job payload' });
        }

        const systemPrompt = [
            'You are an expert recruitment analyst.',
            'Return a strict JSON object with keys: fitScore (0-100 integer), confidence (0-1 number), strengths (array of short strings), gaps (array of short strings), recommendation (string).',
            'Do not include any extra text outside JSON.'
        ].join(' ');

        const userPrompt = `Candidate:\n${JSON.stringify(candidate)}\n\nJob:\n${JSON.stringify(job)}`;

        const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${apiKey}`,
                'Content-Type': 'application/json',
                ...(process.env.OPENROUTER_SITE_URL ? { 'HTTP-Referer': process.env.OPENROUTER_SITE_URL } : {}),
                ...(process.env.OPENROUTER_APP_NAME ? { 'X-Title': process.env.OPENROUTER_APP_NAME } : {})
            },
            body: JSON.stringify({
                model,
                messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: userPrompt }
                ],
                temperature: 0.2
            })
        });

        if (!response.ok) {
            const errorText = await response.text();
            return res.status(response.status).json({ error: errorText || 'OpenRouter request failed' });
        }

        const data = await response.json();
        const content = data?.choices?.[0]?.message?.content || '';
        const parsed = extractJson(content);
        const sanitized = sanitizeAiScreenResult(parsed);
        if (!sanitized) {
            return res.status(422).json({ error: 'Invalid AI response format' });
        }
        res.json(sanitized);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/ai/parse-cv', async (req, res) => {
    try {
        const { text } = req.body || {};
        const apiKey = process.env.OPENROUTER_API_KEY;
        const model = process.env.OPENROUTER_MODEL || 'openai/gpt-4o-mini';
        if (!apiKey) {
            return res.status(400).json({ error: 'Missing OPENROUTER_API_KEY' });
        }
        if (!text || typeof text !== 'string') {
            return res.status(400).json({ error: 'Missing CV text' });
        }

        const systemPrompt = [
            'You are a resume parser. Extract candidate fields from the resume text.',
            'Return strict JSON with keys:',
            'name, email, phone, role, experience (number of years as integer),',
            'skills (array of strings), currentCTC, expectedCTC,',
            'education (object with degree, institution, year).',
            'If a field is missing, return an empty string or empty array.',
            'Use ONLY the resume text to determine the name. Never use the filename.',
            'Return the full name in Title Case with spaces (e.g., John White Smith).',
            'If the name appears concatenated in the resume, infer spaces only if clearly indicated elsewhere in the resume text.',
            'If you are not confident about the name, return an empty string.',
            'Do not include any extra text outside JSON.'
        ].join(' ');

        const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${apiKey}`,
                'Content-Type': 'application/json',
                ...(process.env.OPENROUTER_SITE_URL ? { 'HTTP-Referer': process.env.OPENROUTER_SITE_URL } : {}),
                ...(process.env.OPENROUTER_APP_NAME ? { 'X-Title': process.env.OPENROUTER_APP_NAME } : {})
            },
            body: JSON.stringify({
                model,
                messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: text }
                ],
                temperature: 0.1
            })
        });

        if (!response.ok) {
            const errorText = await response.text();
            return res.status(response.status).json({ error: errorText || 'OpenRouter request failed' });
        }

        const data = await response.json();
        const content = data?.choices?.[0]?.message?.content || '';
        const parsed = extractJson(content);
        if (!parsed) {
            return res.status(500).json({ error: 'Invalid AI response format' });
        }
        const normalizedName = normalizeName(parsed.name || '');
        const fallbackName = normalizedName.includes(' ') ? normalizedName : splitNameFromEmail(parsed.email || '');
        res.json({
            ...parsed,
            name: fallbackName || normalizedName
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`\n🚀 IT Recruiter Sheets Engine is active on port ${PORT}`);
});
