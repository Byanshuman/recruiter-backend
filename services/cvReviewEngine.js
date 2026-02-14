const crypto = require('crypto');
const skillOntology = require('../ontology/skills.json');

const MODEL_VERSION = 'RIE-CV-v2.0';
const DEFAULT_WEIGHTS = {
  structure: 0.2,
  skillDensity: 0.2,
  experienceDepth: 0.2,
  achievements: 0.2,
  clarity: 0.2
};

const IMPACT_VERBS = [
  'led', 'built', 'delivered', 'improved', 'increased', 'reduced', 'optimized', 'launched',
  'scaled', 'managed', 'designed', 'implemented', 'automated', 'streamlined', 'grew'
];

const BUSINESS_OUTCOME_TERMS = [
  'revenue', 'cost', 'conversion', 'retention', 'latency', 'performance', 'uptime',
  'customer', 'sla', 'efficiency', 'throughput', 'churn', 'roi', 'kpi'
];

const BUZZWORDS = [
  'synergy', 'go-getter', 'rockstar', 'ninja', 'guru', 'hardworking', 'results-driven',
  'dynamic', 'fast learner', 'team player', 'detail-oriented'
];

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const round3 = (n) => Math.round(n * 1000) / 1000;

const tokenize = (text) => String(text || '')
  .toLowerCase()
  .split(/[^a-z0-9+.#]/g)
  .map((t) => t.trim())
  .filter(Boolean);

const splitSentences = (text) => String(text || '')
  .split(/[.!?]+/)
  .map((s) => s.trim())
  .filter(Boolean);

const countWords = (text) => tokenize(text).length;

const normalizeSkill = (skill) => {
  const raw = String(skill || '').trim().toLowerCase();
  if (!raw) return '';
  for (const [canonical, variants] of Object.entries(skillOntology || {})) {
    if (canonical.toLowerCase() === raw) return canonical;
    if ((variants || []).some((v) => String(v).toLowerCase() === raw)) return canonical;
  }
  return raw;
};

const normalizeSkills = (skills) => {
  const out = [];
  const seen = new Set();
  for (const skill of (skills || [])) {
    const s = normalizeSkill(skill);
    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
};

const extractJson = (text) => {
  if (!text) return null;
  const match = String(text).match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    return JSON.parse(match[0]);
  } catch {
    return null;
  }
};

const promptHash = (text) => crypto.createHash('sha256').update(text).digest('hex').slice(0, 16);

const evaluateStructure = (input) => {
  const text = input.parsedResumeText || '';
  const candidate = input.candidate || {};
  const words = countWords(text);
  const measurableHits = (text.match(/\b\d+(?:\.\d+)?\s?(%|x|k|m|million|billion|days?|months?|years?|users?|customers?|projects?)\b/gi) || []).length;

  const hasSummary = Boolean(candidate.summary && String(candidate.summary).trim().length >= 40);
  const hasSkillsSection = Array.isArray(candidate.skills) && candidate.skills.length > 0;
  const hasMeasurableAchievements = measurableHits >= 2;
  const optimalLength = words >= 250 && words <= 900;

  const score =
    (hasSummary ? 4 : 0) +
    (hasSkillsSection ? 4 : 0) +
    clamp(measurableHits * 1.5, 0, 6) +
    (optimalLength ? 6 : words < 120 ? 1 : 3);

  return {
    score: Math.round(clamp(score, 0, 20)),
    diagnostics: { hasSummary, hasSkillsSection, measurableHits, words, optimalLength }
  };
};

const evaluateSkillDensity = (input) => {
  const candidate = input.candidate || {};
  const roleTokens = new Set(tokenize(candidate.role || input.optionalJobContext?.title || ''));
  const skills = normalizeSkills(candidate.skills || []);
  const uniqueCount = skills.length;

  const repeatedPenalty = Math.max(0, (candidate.skills || []).length - uniqueCount);
  const domainConsistencyHits = skills.filter((s) => tokenize(s).some((t) => roleTokens.has(t))).length;
  const domainConsistency = uniqueCount > 0 ? domainConsistencyHits / uniqueCount : 0;

  const score =
    clamp(uniqueCount * 0.9, 0, 10) +
    clamp(domainConsistency * 6, 0, 6) +
    clamp(4 - repeatedPenalty, 0, 4);

  return {
    score: Math.round(clamp(score, 0, 20)),
    diagnostics: { uniqueCount, repeatedPenalty, domainConsistency: round3(domainConsistency), canonicalSkills: skills }
  };
};

const seniorityRank = (title) => {
  const t = String(title || '').toLowerCase();
  if (/principal|staff|director|head|vp|chief/.test(t)) return 5;
  if (/lead|senior/.test(t)) return 4;
  if (/mid|engineer ii|analyst ii/.test(t)) return 3;
  if (/junior|associate|intern|trainee/.test(t)) return 1;
  return 2;
};

const evaluateExperienceDepth = (input) => {
  const candidate = input.candidate || {};
  const history = Array.isArray(candidate.experienceHistory) ? candidate.experienceHistory : [];
  const years = Number(candidate.experienceYears ?? candidate.experience ?? 0) || 0;

  const yearsScore = clamp(years * 1.2, 0, 8);

  let progressionUp = 0;
  for (let i = 1; i < history.length; i += 1) {
    if (seniorityRank(history[i].title) >= seniorityRank(history[i - 1].title)) progressionUp += 1;
  }
  const progression = history.length > 1 ? progressionUp / (history.length - 1) : (years > 3 ? 0.7 : 0.5);
  const progressionScore = clamp(progression * 4, 0, 4);

  const avgTenureMonths = history.length > 0
    ? history.reduce((acc, h) => acc + (Number(h?.tenureMonths || 0) || 0), 0) / history.length
    : years * 12;
  const stabilityScore = clamp(avgTenureMonths / 12, 0, 4);

  const role = String(candidate.role || '').toLowerCase();
  const coherenceHits = history.filter((h) => tokenize(h.title || '').some((t) => role.includes(t))).length;
  const coherence = history.length > 0 ? coherenceHits / history.length : (role ? 0.6 : 0.4);
  const coherenceScore = clamp(coherence * 4, 0, 4);

  return {
    score: Math.round(clamp(yearsScore + progressionScore + stabilityScore + coherenceScore, 0, 20)),
    diagnostics: {
      years,
      progression: round3(progression),
      avgTenureMonths: round3(avgTenureMonths),
      coherence: round3(coherence)
    }
  };
};

const evaluateAchievements = (input) => {
  const text = String(input.parsedResumeText || '');
  const lower = text.toLowerCase();
  const quantified = (text.match(/\b\d+(?:\.\d+)?\s?(%|x|k|m|million|billion|users?|customers?|days?|months?|years?)\b/gi) || []).length;
  const impactVerbHits = IMPACT_VERBS.filter((v) => lower.includes(v)).length;
  const businessOutcomeHits = BUSINESS_OUTCOME_TERMS.filter((v) => lower.includes(v)).length;

  const score =
    clamp(quantified * 1.0, 0, 8) +
    clamp(impactVerbHits * 0.8, 0, 6) +
    clamp(businessOutcomeHits * 1.0, 0, 6);

  return {
    score: Math.round(clamp(score, 0, 20)),
    diagnostics: { quantified, impactVerbHits, businessOutcomeHits }
  };
};

const evaluateClarity = (input) => {
  const text = String(input.parsedResumeText || '');
  const sentences = splitSentences(text);
  const words = countWords(text);
  const avgSentenceLen = sentences.length > 0 ? words / sentences.length : words;

  const buzzwordHits = BUZZWORDS.filter((b) => text.toLowerCase().includes(b)).length;
  const longSentenceRatio = sentences.length > 0
    ? sentences.filter((s) => countWords(s) > 30).length / sentences.length
    : 0;

  const readabilityScore = clamp(10 - Math.abs(18 - avgSentenceLen) * 0.5, 0, 10);
  const professionalismScore = clamp(10 - (buzzwordHits * 1.2) - (longSentenceRatio * 5), 0, 10);

  return {
    score: Math.round(clamp(readabilityScore + professionalismScore, 0, 20)),
    diagnostics: {
      avgSentenceLen: round3(avgSentenceLen),
      buzzwordHits,
      longSentenceRatio: round3(longSentenceRatio)
    }
  };
};

const deterministicCvAnalysis = (input) => {
  const structure = evaluateStructure(input);
  const skillDensity = evaluateSkillDensity(input);
  const experienceDepth = evaluateExperienceDepth(input);
  const achievements = evaluateAchievements(input);
  const clarity = evaluateClarity(input);

  const breakdown = {
    structure: structure.score,
    skillDensity: skillDensity.score,
    experienceDepth: experienceDepth.score,
    achievements: achievements.score,
    clarity: clarity.score
  };

  const overall = Object.entries(breakdown).reduce(
    (acc, [k, score]) => acc + (((score / 20) * (DEFAULT_WEIGHTS[k] || 0.2)) * 100),
    0
  );

  const dataCompleteness = clamp((
    (input.parsedResumeText ? 1 : 0) +
    (input.candidate?.name ? 1 : 0) +
    (input.candidate?.role ? 1 : 0) +
    ((input.candidate?.skills || []).length > 0 ? 1 : 0) +
    ((input.candidate?.experienceHistory || []).length > 0 ? 1 : 0)
  ) / 5, 0, 1);

  const structuralConfidence = clamp(((breakdown.structure / 20) * 0.5) + ((breakdown.clarity / 20) * 0.5), 0, 1);

  const riskFlags = [];
  if (breakdown.structure < 10) riskFlags.push('Weak CV structure');
  if (breakdown.achievements < 8) riskFlags.push('Low quantified achievement evidence');
  if (breakdown.skillDensity < 8) riskFlags.push('Low skill density or domain alignment');
  if (breakdown.experienceDepth < 8) riskFlags.push('Shallow or incoherent experience depth');
  if (breakdown.clarity < 8) riskFlags.push('Clarity/professionalism concerns');

  return {
    overallScore: Math.round(clamp(overall, 0, 100)),
    breakdown,
    riskFlags,
    confidence: {
      dataCompleteness: round3(dataCompleteness),
      structuralConfidence: round3(structuralConfidence)
    },
    diagnostics: {
      structure: structure.diagnostics,
      skillDensity: skillDensity.diagnostics,
      experienceDepth: experienceDepth.diagnostics,
      achievements: achievements.diagnostics,
      clarity: clarity.diagnostics
    }
  };
};

const buildAiPrompts = (input, deterministic) => {
  const systemPrompt = [
    'You are MM Recruiter Intelligence Engine (RIE) AI Interpretation Layer.',
    'You are not allowed to generate the final numeric score.',
    'Only use evidence from provided resume text, candidate fields, and deterministic diagnostics.',
    'Do not invent any claim, certification, language proficiency, or achievement.',
    'Return strict JSON only with keys: executiveSummary, strengths, improvements, seniorityEstimate, hiringReadiness, modelConfidence.',
    'strengths/improvements must be arrays of objects: {label, evidence}. Max 5 each.'
  ].join(' ');

  const userPayload = {
    parsedResumeText: input.parsedResumeText,
    candidate: input.candidate,
    optionalJobContext: input.optionalJobContext || null,
    deterministic: {
      overallScore: deterministic.overallScore,
      breakdown: deterministic.breakdown,
      diagnostics: deterministic.diagnostics,
      riskFlags: deterministic.riskFlags
    }
  };

  return {
    systemPrompt,
    userPrompt: JSON.stringify(userPayload)
  };
};

const sanitizeAiInsights = (raw) => {
  if (!raw || typeof raw !== 'object') return null;

  const mapEvidenceItems = (list) => {
    if (!Array.isArray(list)) return [];
    const out = [];
    const seen = new Set();
    for (const item of list) {
      const label = String(item?.label || item || '').trim();
      const evidence = String(item?.evidence || '').trim();
      if (!label) continue;
      const key = label.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ label, evidence });
      if (out.length >= 5) break;
    }
    return out;
  };

  const ai = {
    executiveSummary: String(raw.executiveSummary || '').trim(),
    strengths: mapEvidenceItems(raw.strengths),
    improvements: mapEvidenceItems(raw.improvements),
    seniorityEstimate: String(raw.seniorityEstimate || 'Mid').trim(),
    hiringReadiness: String(raw.hiringReadiness || 'Needs Review').trim(),
    modelConfidence: round3(clamp(Number(raw.modelConfidence ?? 0.55), 0, 1))
  };

  if (!ai.executiveSummary) return null;
  return ai;
};

const guardAiInsights = (ai, input, deterministic) => {
  if (!ai) return null;
  const evidencePool = new Set([
    ...tokenize(input.parsedResumeText),
    ...tokenize(input.candidate?.role),
    ...(input.candidate?.skills || []).flatMap(tokenize),
    ...(input.optionalJobContext?.requiredSkills || []).flatMap(tokenize),
    ...(input.optionalJobContext?.preferredSkills || []).flatMap(tokenize)
  ]);

  const isEvidenceBacked = (item) => {
    const tokens = tokenize(`${item.label} ${item.evidence}`);
    return tokens.some((t) => evidencePool.has(t));
  };

  const strengths = ai.strengths.filter(isEvidenceBacked);
  const improvements = ai.improvements.filter(isEvidenceBacked);

  if (strengths.length === 0 && improvements.length === 0) return null;

  return {
    ...ai,
    strengths: strengths.length ? strengths : [{ label: 'Relevant skills present', evidence: 'Detected from candidate skills and resume context' }],
    improvements: improvements.length ? improvements : deterministic.riskFlags.slice(0, 3).map((r) => ({ label: r, evidence: 'Deterministic risk signal' }))
  };
};

const deterministicFallbackInsights = (deterministic) => {
  const top = Object.entries(deterministic.breakdown)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 2)
    .map(([k, v]) => ({ label: k, evidence: `Deterministic sub-score ${v}/20` }));

  const low = Object.entries(deterministic.breakdown)
    .sort((a, b) => a[1] - b[1])
    .slice(0, 2)
    .map(([k, v]) => ({ label: k, evidence: `Deterministic sub-score ${v}/20` }));

  return {
    executiveSummary: 'Deterministic CV review generated due to unavailable or low-confidence AI interpretation.',
    strengths: top,
    improvements: low,
    seniorityEstimate: deterministic.breakdown.experienceDepth >= 14 ? 'Senior' : deterministic.breakdown.experienceDepth >= 9 ? 'Mid' : 'Junior',
    hiringReadiness: deterministic.overallScore >= 75 ? 'Interview Ready' : deterministic.overallScore >= 55 ? 'Screening Recommended' : 'Needs Development',
    modelConfidence: 0.4
  };
};

const mergeHybrid = (deterministic, aiInsights) => {
  const aiConfidence = round3(clamp(aiInsights.modelConfidence, 0, 1));
  const finalConfidence = round3(clamp(
    (deterministic.confidence.dataCompleteness * 0.35) +
    (deterministic.confidence.structuralConfidence * 0.35) +
    (aiConfidence * 0.30),
    0,
    1
  ));

  return {
    modelVersion: MODEL_VERSION,
    overallScore: deterministic.overallScore,
    breakdown: deterministic.breakdown,
    aiInsights: {
      executiveSummary: aiInsights.executiveSummary,
      strengths: aiInsights.strengths,
      improvements: aiInsights.improvements,
      seniorityEstimate: aiInsights.seniorityEstimate,
      hiringReadiness: aiInsights.hiringReadiness
    },
    riskFlags: deterministic.riskFlags,
    confidence: {
      dataCompleteness: deterministic.confidence.dataCompleteness,
      structuralConfidence: deterministic.confidence.structuralConfidence,
      aiConfidence,
      finalConfidence
    }
  };
};

const reviewCv = async (input, options) => {
  const deterministic = deterministicCvAnalysis(input);
  const prompts = buildAiPrompts(input, deterministic);

  let aiRawResponse = '';
  let aiInsights = null;

  try {
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${options.apiKey}`,
        'Content-Type': 'application/json',
        ...(options.siteUrl ? { 'HTTP-Referer': options.siteUrl } : {}),
        ...(options.appName ? { 'X-Title': options.appName } : {})
      },
      body: JSON.stringify({
        model: options.model,
        messages: [
          { role: 'system', content: prompts.systemPrompt },
          { role: 'user', content: prompts.userPrompt }
        ],
        temperature: 0.2
      })
    });

    if (response.ok) {
      const data = await response.json();
      aiRawResponse = data?.choices?.[0]?.message?.content || '';
      aiInsights = guardAiInsights(
        sanitizeAiInsights(extractJson(aiRawResponse)),
        input,
        deterministic
      );
    }
  } catch {
    aiInsights = null;
  }

  if (!aiInsights) {
    aiInsights = deterministicFallbackInsights(deterministic);
  }

  const result = mergeHybrid(deterministic, aiInsights);
  return {
    ...result,
    audit: {
      scoringVersion: MODEL_VERSION,
      scoringWeights: DEFAULT_WEIGHTS,
      promptHash: promptHash(`${prompts.systemPrompt}\n${prompts.userPrompt}`),
      deterministicDiagnostics: deterministic.diagnostics,
      aiRawResponse
    }
  };
};

module.exports = {
  MODEL_VERSION,
  DEFAULT_WEIGHTS,
  deterministicCvAnalysis,
  buildAiPrompts,
  reviewCv
};
