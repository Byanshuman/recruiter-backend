const SCORING_MODEL_VERSION = 'RIE-SkillMatch-v1.0';

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

const normalizeSkill = (value) => String(value || '').toLowerCase().trim();

const uniqueNormalized = (values) => {
  const seen = new Set();
  const out = [];
  for (const value of (values || [])) {
    const normalized = normalizeSkill(value);
    if (!normalized) continue;
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
};

const parseSectionBlock = (text, sectionNames) => {
  const lines = String(text || '').split(/\r?\n/);
  const startPattern = new RegExp(`^\\s*(?:${sectionNames.join('|')})\\s*[:\\-]?\\s*$`, 'i');
  const headingPattern = /^\s*[A-Za-z][A-Za-z\s]{2,}\s*[:\-]?\s*$/;
  let inSection = false;
  const block = [];

  for (const line of lines) {
    if (startPattern.test(line)) {
      inSection = true;
      continue;
    }
    if (inSection && headingPattern.test(line)) {
      break;
    }
    if (inSection) block.push(line);
  }
  return block.join('\n').trim();
};

const extractInlineList = (text, keys) => {
  const lines = String(text || '').split(/\r?\n/);
  const pattern = new RegExp(`^\\s*(?:${keys.join('|')})\\s*[:\\-]\\s*(.+)$`, 'i');
  for (const line of lines) {
    const match = line.match(pattern);
    if (match) {
      return match[1]
        .split(/[;,|]/)
        .map((s) => s.trim())
        .filter(Boolean);
    }
  }
  return [];
};

const extractExplicitSkills = (cvText) => {
  const inline = extractInlineList(cvText, ['skills', 'technical skills', 'core skills']);
  if (inline.length > 0) return uniqueNormalized(inline);

  const block = parseSectionBlock(cvText, ['skills', 'technical skills', 'core skills']);
  if (!block) return [];

  const parts = block
    .split(/\r?\n|[;,|]/)
    .map((s) => s.replace(/^[-•*]\s*/, '').trim())
    .filter(Boolean);

  return uniqueNormalized(parts);
};

const extractExplicitRoles = (cvText) => {
  const block = parseSectionBlock(cvText, ['experience', 'work experience', 'professional experience']);
  if (!block) return [];
  const lines = block.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const roles = [];
  for (const line of lines) {
    const roleMatch = line.match(/^(role|title|position)\s*[:\-]\s*(.+)$/i);
    if (roleMatch) roles.push(roleMatch[2].trim());
  }
  return roles;
};

const extractExplicitEducation = (cvText) => {
  const inline = extractInlineList(cvText, ['education']);
  if (inline.length > 0) return inline.join(' | ');
  const block = parseSectionBlock(cvText, ['education']);
  return block || 'Not Found';
};

const extractExplicitCertifications = (cvText) => {
  const inline = extractInlineList(cvText, ['certifications', 'certificates']);
  if (inline.length > 0) return inline;
  const block = parseSectionBlock(cvText, ['certifications', 'certificates']);
  if (!block) return ['Not Found'];
  const lines = block.split(/\r?\n/).map((line) => line.replace(/^[-•*]\s*/, '').trim()).filter(Boolean);
  return lines.length > 0 ? lines : ['Not Found'];
};

const extractCandidateName = (cvText, fallback = 'Not Found') => {
  const lines = String(cvText || '').split(/\r?\n/);
  for (const line of lines) {
    const match = line.match(/^\s*name\s*[:\-]\s*(.+)$/i);
    if (match) return match[1].trim();
  }
  return fallback;
};

const extractExperienceYears = (cvText, fallback = 0) => {
  const match = String(cvText || '').match(/(\d+(?:\.\d+)?)\s*\+?\s*(years|yrs)\b/i);
  if (!match) return Number(fallback) || 0;
  return Number(match[1]) || 0;
};

const parseCvStrict = (cvText, inputCandidate = {}) => {
  const normalizedText = String(cvText || '').trim();
  const skillsFromText = extractExplicitSkills(normalizedText);
  const explicitInputSkills = uniqueNormalized(inputCandidate.skills || []);
  const skills = skillsFromText.length > 0 ? skillsFromText : explicitInputSkills;

  return {
    name: inputCandidate.name || extractCandidateName(normalizedText),
    experienceYears: Number(inputCandidate.experienceYears) || extractExperienceYears(normalizedText, inputCandidate.experienceYears),
    skills: skills.length > 0 ? skills : ['Not Found'],
    workExperienceRoles: (Array.isArray(inputCandidate.experienceHistory) && inputCandidate.experienceHistory.length > 0)
      ? inputCandidate.experienceHistory.map((x) => x.title).filter(Boolean)
      : extractExplicitRoles(normalizedText),
    education: inputCandidate.education || extractExplicitEducation(normalizedText),
    certifications: extractExplicitCertifications(normalizedText)
  };
};

const pickHiringRecommendation = (score) => {
  if (score >= 75) return 'Strong Match';
  if (score >= 50) return 'Moderate Match';
  return 'Weak Match';
};

const evaluateSkillMatch = ({ parsed, job }) => {
  const candidateSkills = parsed.skills[0] === 'Not Found' ? [] : uniqueNormalized(parsed.skills);
  const workExperienceRoles = Array.isArray(parsed.workExperienceRoles) ? parsed.workExperienceRoles : [];
  const certifications = Array.isArray(parsed.certifications) ? parsed.certifications : [];
  const education = parsed.education || 'Not Found';
  const required = uniqueNormalized(job.requiredSkills || []);
  const preferred = uniqueNormalized(job.preferredSkills || []);

  const matchedRequiredSkills = required.filter((skill) => candidateSkills.includes(skill));
  const missingRequiredSkills = required.filter((skill) => !candidateSkills.includes(skill));
  const matchedPreferredSkills = preferred.filter((skill) => candidateSkills.includes(skill));
  const missingPreferredSkills = preferred.filter((skill) => !candidateSkills.includes(skill));

  const requiredRatio = required.length === 0 ? 1 : matchedRequiredSkills.length / required.length;
  const preferredRatio = preferred.length === 0 ? 0 : matchedPreferredSkills.length / preferred.length;

  const minExp = Number(job.minExperience) || 0;
  const expYears = Number(parsed.experienceYears) || 0;
  const experienceMatchScore = minExp <= 0
    ? 1
    : clamp(expYears >= minExp ? 1 : expYears / minExp, 0, 1);

  const finalFitScore = Math.round(
    clamp((requiredRatio * 60) + (preferredRatio * 20) + (experienceMatchScore * 20), 0, 100)
  );

  const requiredFields = [
    parsed.name && parsed.name !== 'Not Found',
    Number.isFinite(expYears) && expYears > 0,
    candidateSkills.length > 0,
    workExperienceRoles.length > 0,
    education && education !== 'Not Found',
    certifications.length > 0 && certifications[0] !== 'Not Found'
  ];
  const dataCompleteness = requiredFields.filter(Boolean).length / requiredFields.length;
  const confidenceScore = clamp(
    (requiredRatio * 0.5) + (experienceMatchScore * 0.3) + (dataCompleteness * 0.2),
    0,
    1
  );

  const riskFlags = [];
  if (missingRequiredSkills.length > 0) riskFlags.push('Missing critical required skills');
  if (experienceMatchScore < 1) riskFlags.push('Experience below requirement');
  if (candidateSkills.length === 0) riskFlags.push('No skills section found');

  return {
    candidateName: parsed.name || 'Not Found',
    jobTitle: job.title,
    matchedRequiredSkills,
    missingRequiredSkills,
    matchedPreferredSkills,
    missingPreferredSkills,
    experienceMatchScore: Number(experienceMatchScore.toFixed(3)),
    requiredRatio: Number(requiredRatio.toFixed(3)),
    preferredRatio: Number(preferredRatio.toFixed(3)),
    finalFitScore,
    hiringRecommendation: pickHiringRecommendation(finalFitScore),
    dataCompleteness: Number(dataCompleteness.toFixed(3)),
    confidenceScore: Number(confidenceScore.toFixed(3)),
    riskFlags,
    scoringModelVersion: SCORING_MODEL_VERSION,
    auditSignals: {
      candidateSkillsNormalized: candidateSkills,
      requiredSkillsNormalized: required,
      preferredSkillsNormalized: preferred
    }
  };
};

const buildSheetRecord = ({ cvText, parsed, selectedJob, result }) => {
  const timestamp = new Date().toISOString();
  return {
    id: `${parsed.name || 'unknown'}-${timestamp}`,
    timestamp,
    candidateName: parsed.name || 'Not Found',
    skills: (parsed.skills || []).join(', '),
    experienceYears: parsed.experienceYears || 0,
    selectedJob: selectedJob.title,
    fitScore: result.finalFitScore,
    matchedRequiredSkills: (result.matchedRequiredSkills || []).join(', '),
    missingRequiredSkills: (result.missingRequiredSkills || []).join(', '),
    cvText: cvText || '',
    requiredRatio: result.requiredRatio,
    preferredRatio: result.preferredRatio,
    experienceMatchScore: result.experienceMatchScore,
    confidenceScore: result.confidenceScore,
    scoringModelVersion: result.scoringModelVersion
  };
};

module.exports = {
  SCORING_MODEL_VERSION,
  normalizeSkill,
  parseCvStrict,
  evaluateSkillMatch,
  buildSheetRecord
};
