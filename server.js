
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
const crypto = require('crypto');
const sheetsService = require('./services/sheetsService');
const cvReviewEngine = require('./services/cvReviewEngine');
const skillMatchEngine = require('./services/skillMatchEngine');
const { calendar, CALENDAR_ID, CALENDAR_INIT_ERROR } = require('./config/googleCalendar');
const roleModels = require('./config/roleModels');
const skillOntology = require('./ontology/skills.json');

const RIE_MODEL_VERSION = 'RIE-v2.1';

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

app.post('/api/rie/parse-cv-strict', async (req, res) => {
    try {
        const { parsedResumeText, candidate } = req.body || {};
        if (!parsedResumeText || typeof parsedResumeText !== 'string') {
            return res.status(400).json({ error: 'parsedResumeText is required.' });
        }
        const parsed = skillMatchEngine.parseCvStrict(parsedResumeText, candidate || {});
        res.json({ parsed });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/rie/skill-match', async (req, res) => {
    try {
        const { parsedResumeText, candidate, selectedJobId, selectedJob } = req.body || {};
        if (!parsedResumeText || typeof parsedResumeText !== 'string') {
            return res.status(400).json({ error: 'parsedResumeText is required.' });
        }
        if ((!selectedJobId || typeof selectedJobId !== 'string') && !selectedJob) {
            return res.status(400).json({ error: 'selectedJobId or selectedJob is required.' });
        }

        let job = selectedJob || null;
        if (!job && selectedJobId) {
            const jobs = await sheetsService.getData('Jobs');
            job = jobs.find(j => (j.id || '').toString() === selectedJobId);
        }
        if (!job) {
            return res.status(404).json({ error: 'Selected job not found.' });
        }

        const parsed = skillMatchEngine.parseCvStrict(parsedResumeText, candidate || {});
        const result = skillMatchEngine.evaluateSkillMatch({ parsed, job });
        const sheetRecord = skillMatchEngine.buildSheetRecord({
            cvText: parsedResumeText,
            parsed,
            selectedJob: job,
            result
        });

        await sheetsService.appendCvReviewUnique(sheetRecord);

        res.json(result);
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

const AI_STOPWORDS = new Set([
    'and', 'or', 'the', 'a', 'an', 'to', 'of', 'for', 'with', 'in', 'on', 'at', 'by', 'from', 'as',
    'is', 'are', 'this', 'that', 'be', 'will', 'we', 'you', 'our', 'your', 'candidate', 'job'
]);

const tokenizeText = (value) => String(value || '')
    .toLowerCase()
    .split(/[^a-z0-9+.#]/g)
    .map(token => token.trim())
    .filter(token => token.length > 2 && !AI_STOPWORDS.has(token));

const capList = (items, size = 4, keySelector) => {
    const out = [];
    const seen = new Set();
    for (const item of (items || [])) {
        if (item === null || item === undefined) continue;
        const key = keySelector
            ? keySelector(item)
            : (typeof item === 'string'
                ? item.trim().toLowerCase()
                : JSON.stringify(item));
        if (!key) continue;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(item);
        if (out.length >= size) break;
    }
    return out;
};
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

const ONTOLOGY_INDEX = (() => {
    const index = new Map();
    Object.entries(skillOntology || {}).forEach(([canonical, variants]) => {
        index.set(String(canonical).toLowerCase(), canonical);
        (variants || []).forEach(v => index.set(String(v).toLowerCase(), canonical));
    });
    return index;
})();

const normalizeSkill = (skill) => {
    const raw = String(skill || '').trim();
    if (!raw) return '';
    const exact = ONTOLOGY_INDEX.get(raw.toLowerCase());
    if (exact) return exact;
    const tokens = tokenizeText(raw);
    for (const token of tokens) {
        const mapped = ONTOLOGY_INDEX.get(token);
        if (mapped) return mapped;
    }
    return raw.toLowerCase();
};

const normalizeSkillList = (skills) =>
    capList((skills || []).map(normalizeSkill).filter(Boolean), 50, s => String(s).trim().toLowerCase());

const inferRoleModel = (job) => {
    const context = `${job?.title || ''} ${job?.department || ''} ${job?.description || ''}`.toLowerCase();
    if (/counsel|therapy|psycholog|wellness|mental/.test(context)) return { key: 'counseling', weights: roleModels.counseling };
    if (/engineer|developer|software|frontend|backend|devops|data/.test(context)) return { key: 'tech', weights: roleModels.tech };
    return { key: 'default', weights: roleModels.default };
};

const promptHash = (prompt) => crypto.createHash('sha256').update(prompt).digest('hex').slice(0, 16);

const toStrengthObject = (label, matchedWith, weightImpact) => ({
    label,
    evidence: `Mapped from candidate.skills`,
    matchedWith,
    weightImpact: Math.round(weightImpact)
});

const toGapObject = (label, reason, impactLevel) => ({
    label,
    reason,
    impactLevel
});

const sanitizeAiScreenResult = (raw) => {
    if (!raw || typeof raw !== 'object') return null;
    const fitScore = Number(raw.fitScore);
    const modelConfidence = Number(raw.modelConfidence ?? raw.confidence);
    if (!Number.isFinite(fitScore) || fitScore < 0 || fitScore > 100) return null;
    if (!Number.isFinite(modelConfidence) || modelConfidence < 0 || modelConfidence > 1) return null;

    const strengths = Array.isArray(raw.strengths) ? raw.strengths.map((s) => {
        if (typeof s === 'string') {
            return { label: s.trim(), evidence: 'AI inferred from provided data', matchedWith: 'Job profile', weightImpact: 6 };
        }
        return {
            label: String(s?.label || '').trim(),
            evidence: String(s?.evidence || 'AI inferred from provided data').trim(),
            matchedWith: String(s?.matchedWith || 'Job profile').trim(),
            weightImpact: Number.isFinite(Number(s?.weightImpact)) ? Number(s.weightImpact) : 6
        };
    }).filter(s => s.label) : [];

    const gaps = Array.isArray(raw.gaps) ? raw.gaps.map((g) => {
        if (typeof g === 'string') {
            return { label: g.trim(), reason: 'Missing or weak evidence', impactLevel: 'medium' };
        }
        return {
            label: String(g?.label || '').trim(),
            reason: String(g?.reason || 'Missing or weak evidence').trim(),
            impactLevel: String(g?.impactLevel || 'medium').toLowerCase()
        };
    }).filter(g => g.label) : [];

    const riskFlags = capList(Array.isArray(raw.riskFlags) ? raw.riskFlags.map(String) : [], 6, v => String(v).trim().toLowerCase());
    const recommendation = typeof raw.recommendation === 'string' ? raw.recommendation.trim() : '';

    return {
        fitScore: Math.round(fitScore),
        modelConfidence: Math.round(modelConfidence * 1000) / 1000,
        strengths: capList(strengths, 4, s => String(s?.label || '').trim().toLowerCase()),
        gaps: capList(gaps, 4, g => String(g?.label || '').trim().toLowerCase()),
        riskFlags,
        recommendation
    };
};

const buildDeterministicSignals = (candidate, job) => {
    const candidateSkills = normalizeSkillList(candidate?.skills);
    const requiredSkills = normalizeSkillList(job?.requiredSkills);
    const preferredSkills = normalizeSkillList(job?.preferredSkills);
    const { key: roleKey, weights } = inferRoleModel(job);

    const candidateTokenSet = new Set([
        ...tokenizeText(candidate?.role),
        ...candidateSkills.flatMap(tokenizeText)
    ]);

    const matches = (skills) => skills.filter(skill => tokenizeText(skill).some(t => candidateTokenSet.has(t)));
    const matchedRequired = matches(requiredSkills);
    const matchedPreferred = matches(preferredSkills);
    const missingRequired = requiredSkills.filter(skill => !matchedRequired.includes(skill));
    const missingPreferred = preferredSkills.filter(skill => !matchedPreferred.includes(skill));

    const requiredCoverage = requiredSkills.length ? matchedRequired.length / requiredSkills.length : 0.5;
    const preferredCoverage = preferredSkills.length ? matchedPreferred.length / preferredSkills.length : 0.5;

    const minExperience = Number(job?.minExperience) || 0;
    const candidateExperience = Number(candidate?.experience) || 0;
    const experienceMatch = minExperience > 0
        ? clamp(candidateExperience / minExperience, 0, 1)
        : 0.8;
    const experienceGap = Math.max(0, minExperience - candidateExperience);

    const rawFit = (
        (requiredCoverage * weights.requiredWeight) +
        (preferredCoverage * weights.preferredWeight) +
        (experienceMatch * weights.experienceWeight) +
        ((matchedPreferred.length > 0 ? 1 : 0.6) * (weights.softSkillWeight || 0))
    ) * 100;
    const fitScore = Math.round(clamp(rawFit, 0, 100));

    const candidateDataFields = ['name', 'email', 'role', 'experience'];
    const dataCompleteness = clamp(
        (
            candidateDataFields.filter(k => String(candidate?.[k] || '').trim().length > 0).length +
            (candidateSkills.length > 0 ? 1 : 0) +
            (requiredSkills.length > 0 ? 1 : 0)
        ) / (candidateDataFields.length + 2),
        0,
        1
    );

    const coverageConfidence = clamp((requiredCoverage * 0.7) + (preferredCoverage * 0.2) + (experienceMatch * 0.1), 0, 1);

    const strengths = capList([
        ...matchedRequired.map(label => toStrengthObject(label, 'Job.requiredSkills', 10)),
        ...matchedPreferred.map(label => toStrengthObject(label, 'Job.preferredSkills', 6)),
        ...candidateSkills
            .filter(s => !matchedRequired.includes(s) && !matchedPreferred.includes(s))
            .slice(0, 2)
            .map(label => toStrengthObject(label, 'Candidate.profile', 3))
    ], 4, s => String(s?.label || '').trim().toLowerCase());

    const gaps = capList([
        ...missingRequired.map(label => toGapObject(label, 'Required but missing', 'high')),
        ...missingPreferred.map(label => toGapObject(label, 'Preferred but missing', 'medium')),
        ...(experienceGap > 0 ? [toGapObject('experience', `Experience short by ${experienceGap} year(s)`, 'high')] : [])
    ], 4, g => String(g?.label || '').trim().toLowerCase());

    const riskFlags = capList([
        ...(requiredCoverage < 0.5 ? ['Low required-skill coverage'] : []),
        ...(experienceGap > 0 ? ['Experience below requirement'] : []),
        ...(dataCompleteness < 0.6 ? ['Incomplete candidate profile data'] : [])
    ], 6, v => String(v).trim().toLowerCase());

    const recommendation = fitScore >= 80
        ? 'Strong fit. Fast-track to interview with scenario-based validation.'
        : fitScore >= 60
            ? 'Moderate fit. Continue with structured screening focused on missing skills.'
            : 'Partial fit. Consider alternate role mapping or targeted upskilling plan.';

    return {
        fitScore,
        coverage: {
            requiredCoverage: Math.round(requiredCoverage * 1000) / 1000,
            preferredCoverage: Math.round(preferredCoverage * 1000) / 1000,
            experienceMatch: Math.round(experienceMatch * 1000) / 1000
        },
        confidence: {
            modelConfidence: 0.65,
            dataCompleteness: Math.round(dataCompleteness * 1000) / 1000,
            coverageConfidence: Math.round(coverageConfidence * 1000) / 1000,
            finalConfidence: Math.round(((dataCompleteness * 0.35) + (coverageConfidence * 0.65)) * 1000) / 1000
        },
        strengths,
        gaps,
        riskFlags,
        recommendation,
        deterministicSignals: {
            roleModel: roleKey,
            matchedRequired,
            missingRequired,
            matchedPreferred,
            missingPreferred,
            minExperience,
            candidateExperience
        },
        scoringWeights: weights
    };
};

const isEvidenceBacked = (text, deterministic) => {
    const tokens = tokenizeText(text);
    if (tokens.length === 0) return false;
    const evidencePool = new Set([
        ...deterministic.strengths.map(s => s.label).flatMap(tokenizeText),
        ...deterministic.gaps.map(g => g.label).flatMap(tokenizeText),
        ...deterministic.deterministicSignals.matchedRequired.flatMap(tokenizeText),
        ...deterministic.deterministicSignals.missingRequired.flatMap(tokenizeText),
        ...deterministic.deterministicSignals.matchedPreferred.flatMap(tokenizeText),
        ...deterministic.deterministicSignals.missingPreferred.flatMap(tokenizeText)
    ]);
    return tokens.some(t => evidencePool.has(t));
};

const fuseRieResult = (ai, deterministic, meta) => {
    if (!ai) {
        return {
            modelVersion: RIE_MODEL_VERSION,
            fitScore: deterministic.fitScore,
            confidence: deterministic.confidence,
            coverage: deterministic.coverage,
            strengths: deterministic.strengths,
            gaps: deterministic.gaps,
            riskFlags: deterministic.riskFlags,
            recommendation: deterministic.recommendation,
            explainability: {
                deterministicWeight: 1,
                aiWeight: 0
            },
            scoringWeights: deterministic.scoringWeights,
            promptHash: meta.promptHash,
            timestamp: new Date().toISOString(),
            deterministicSignals: deterministic.deterministicSignals
        };
    }

    const deterministicWeight = 0.3;
    const aiWeight = 0.7;
    const fitScore = Math.round(clamp((ai.fitScore * aiWeight) + (deterministic.fitScore * deterministicWeight), 0, 100));
    const modelConfidence = Math.round(clamp((ai.modelConfidence * aiWeight) + (deterministic.confidence.modelConfidence * deterministicWeight), 0, 1) * 1000) / 1000;
    const finalConfidence = Math.round(
        clamp(
            (modelConfidence * 0.45) +
            (deterministic.confidence.dataCompleteness * 0.25) +
            (deterministic.confidence.coverageConfidence * 0.30),
            0,
            1
        ) * 1000
    ) / 1000;

    const strengths = capList(
        ai.strengths.filter(s => isEvidenceBacked(`${s.label} ${s.evidence}`, deterministic)),
        4,
        s => String(s?.label || '').trim().toLowerCase()
    );
    const gaps = capList(
        ai.gaps.filter(g => isEvidenceBacked(`${g.label} ${g.reason}`, deterministic)),
        4,
        g => String(g?.label || '').trim().toLowerCase()
    );

    return {
        modelVersion: RIE_MODEL_VERSION,
        fitScore,
        confidence: {
            modelConfidence,
            dataCompleteness: deterministic.confidence.dataCompleteness,
            coverageConfidence: deterministic.confidence.coverageConfidence,
            finalConfidence
        },
        coverage: deterministic.coverage,
        strengths: strengths.length >= 2 ? strengths : deterministic.strengths,
        gaps: gaps.length >= 2 ? gaps : deterministic.gaps,
        riskFlags: capList([...deterministic.riskFlags, ...ai.riskFlags], 6, v => String(v).trim().toLowerCase()),
        recommendation: ai.recommendation || deterministic.recommendation,
        explainability: {
            deterministicWeight,
            aiWeight
        },
        scoringWeights: deterministic.scoringWeights,
        promptHash: meta.promptHash,
        timestamp: new Date().toISOString(),
        deterministicSignals: deterministic.deterministicSignals,
        aiRawResponse: meta.aiRawResponse
    };
};

app.post('/api/ai/screen', async (req, res) => {
    try {
        const { candidate, job } = req.body || {};
        const apiKey = process.env.OPENROUTER_API_KEY;
        const model = process.env.OPENROUTER_MODEL || 'openai/gpt-4o-mini';
        if (!candidate || !job) {
            return res.status(400).json({ error: 'Missing candidate or job payload' });
        }

        // Deterministic-only strategy score: strict skill match + experience, no inferred skills.
        const parsedCandidate = {
            name: candidate.name || 'Not Found',
            experienceYears: Number(candidate.experience) || 0,
            skills: Array.isArray(candidate.skills) ? candidate.skills : []
        };
        const deterministic = skillMatchEngine.evaluateSkillMatch({
            parsed: parsedCandidate,
            job
        });

        const strengths = [
            ...deterministic.matchedRequiredSkills,
            ...deterministic.matchedPreferredSkills
        ];
        const gaps = [
            ...deterministic.missingRequiredSkills,
            ...deterministic.missingPreferredSkills
        ];
        const normalizeSkill = (value) => String(value || '').trim().toLowerCase();
        const sentenceCount = (text) => String(text || '')
            .split(/[.!?]+/)
            .map((s) => s.trim())
            .filter(Boolean).length;
        const hasSpeculativeLanguage = (text) => /\b(likely|probably|may have|seems to)\b/i.test(String(text || ''));

        const deterministicRecommendation = deterministic.hiringRecommendation === 'Strong Match'
            ? 'Required skill coverage is strong and experience aligns with role expectations. Recommend interview progression.'
            : deterministic.hiringRecommendation === 'Moderate Match'
                ? 'Coverage is partial with identifiable required-skill gaps. Proceed only with targeted screening for missing capabilities.'
                : 'Required skill gaps are material relative to current role requirements. Recommend alternate role mapping or skill-bridge plan before progression.';

        let strengthsOut = strengths.length > 0 ? strengths : [];
        let gapsOut = gaps.length > 0 ? gaps : [];
        let recommendationOut = deterministicRecommendation;

        let fitScoreOut = deterministic.finalFitScore;
        let confidenceOut = deterministic.confidenceScore;

        // AI-first scoring + narrative with strict schema and fallback to deterministic values.
        if (apiKey) {
            const systemPrompt = [
                'You are a senior hiring panel analyst producing enterprise-grade hiring feedback.',
                'You are responsible for generating numeric scoring and evidence-bound feedback.',
                'STRICT OPERATIONAL CONSTRAINTS:',
                '1. You MUST use ONLY the provided structured inputs: matchedSkills[], missingSkills[], experienceSummary, jobTitle (optional context only).',
                '2. You MUST NOT infer new skills, expand abbreviations into new competencies, derive skills from company names, assume certifications, assume language proficiency, infer domain expertise not explicitly listed, or modify/reinterpret numeric scoring signals.',
                '3. You MUST NOT introduce bias related to gender, ethnicity, geography, education prestige, or organization names.',
                '4. strengths[] MUST be an exact subset of matchedSkills[]. No grouping, semantic expansion, or rewording.',
                '5. gaps[] MUST be an exact subset of missingSkills[].',
                '6. recommendation MUST be based strictly on coverage and experience alignment, neutral and evidence-based.',
                '7. Feedback must be deterministic-aligned, evidence-traceable, audit-ready, and HR-compliant.',
                'OUTPUT REQUIREMENTS:',
                'Return STRICT JSON only with schema: {"fitScore": number, "confidence": number, "strengths": string[], "gaps": string[], "recommendation": string}.',
                'fitScore must be an integer from 0 to 100.',
                'confidence must be a decimal from 0 to 1 with up to 3 decimals.',
                'Recommendation must be concise (2-4 sentences), reference only provided structured evidence, and avoid speculation.',
                'If insufficient data is provided, return {"fitScore":0,"confidence":0,"strengths":[],"gaps":[],"recommendation":"Insufficient structured data for evaluation."}',
                'FAIL-SAFE RULE: if any instruction conflicts with evidence boundaries, default to omission rather than speculation.'
            ].join(' ');
            const experienceSummary = deterministic.experienceMatchScore >= 1
                ? `Experience meets minimum requirement (${Number(parsedCandidate.experienceYears || 0)} years).`
                : `Experience is below minimum requirement (${Number(parsedCandidate.experienceYears || 0)} years).`;

            const userPrompt = JSON.stringify({
                jobTitle: job.title || '',
                matchedSkills: strengths,
                missingSkills: gaps,
                experienceSummary,
                scoringContext: {
                    requiredRatio: deterministic.requiredRatio,
                    preferredRatio: deterministic.preferredRatio,
                    experienceMatchScore: deterministic.experienceMatchScore
                }
            });

            try {
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

                if (response.ok) {
                    const data = await response.json();
                    const content = data?.choices?.[0]?.message?.content || '';
                    const parsed = extractJson(content);
                    const allowedStrengths = new Map(strengths.map((s) => [normalizeSkill(s), s]));
                    const allowedGaps = new Map(gaps.map((g) => [normalizeSkill(g), g]));
                    const safeStrengths = Array.isArray(parsed?.strengths)
                        ? [...new Set(parsed.strengths.map((v) => normalizeSkill(v)).filter((v) => allowedStrengths.has(v)))]
                            .map((v) => allowedStrengths.get(v))
                        : [];
                    const safeGaps = Array.isArray(parsed?.gaps)
                        ? [...new Set(parsed.gaps.map((v) => normalizeSkill(v)).filter((v) => allowedGaps.has(v)))]
                            .map((v) => allowedGaps.get(v))
                        : [];
                    const safeRecommendation = typeof parsed?.recommendation === 'string' ? parsed.recommendation.trim() : '';
                    const isRecommendationValid = safeRecommendation.length >= 20
                        && sentenceCount(safeRecommendation) >= 2
                        && sentenceCount(safeRecommendation) <= 4
                        && !hasSpeculativeLanguage(safeRecommendation);
                    const aiFitScore = Number(parsed?.fitScore);
                    const aiConfidence = Number(parsed?.confidence);
                    const isFitScoreValid = Number.isFinite(aiFitScore) && aiFitScore >= 0 && aiFitScore <= 100;
                    const isConfidenceValid = Number.isFinite(aiConfidence) && aiConfidence >= 0 && aiConfidence <= 1;

                    strengthsOut = safeStrengths;
                    gapsOut = safeGaps;
                    if (isRecommendationValid) recommendationOut = safeRecommendation;
                    if (isFitScoreValid) fitScoreOut = Math.round(aiFitScore);
                    if (isConfidenceValid) confidenceOut = Number(aiConfidence.toFixed(3));
                }
            } catch {
                // keep deterministic fallback on AI failure
            }
        }

        if (strengthsOut.length === 0 && gapsOut.length === 0) {
            recommendationOut = 'Insufficient structured data for evaluation.';
        }

        res.json({
            fitScore: fitScoreOut,
            confidence: confidenceOut,
            strengths: strengthsOut,
            gaps: gapsOut,
            recommendation: recommendationOut,
            requiredRatio: deterministic.requiredRatio,
            preferredRatio: deterministic.preferredRatio,
            experienceMatchScore: deterministic.experienceMatchScore,
            scoringModelVersion: skillMatchEngine.SCORING_MODEL_VERSION
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/ai/cv-review', async (req, res) => {
    try {
        const { parsedResumeText, candidate, optionalJobContext } = req.body || {};
        const apiKey = process.env.OPENROUTER_API_KEY;
        const model = process.env.OPENROUTER_MODEL || 'openai/gpt-4o-mini';

        if (!apiKey) {
            return res.status(400).json({ error: 'Missing OPENROUTER_API_KEY' });
        }
        if (!parsedResumeText || typeof parsedResumeText !== 'string') {
            return res.status(400).json({ error: 'parsedResumeText is required' });
        }
        if (!candidate || typeof candidate !== 'object') {
            return res.status(400).json({ error: 'candidate object is required' });
        }

        const result = await cvReviewEngine.reviewCv(
            {
                parsedResumeText,
                candidate,
                optionalJobContext: optionalJobContext || null
            },
            {
                apiKey,
                model,
                siteUrl: process.env.OPENROUTER_SITE_URL,
                appName: process.env.OPENROUTER_APP_NAME
            }
        );

        res.json(result);
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
