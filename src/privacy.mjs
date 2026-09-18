import { createHash } from 'node:crypto';
import { stableJson } from './validation.mjs';

export const digest = (value) => createHash('sha256').update(stableJson(value)).digest('hex');

/** Require JSON data, with finite numbers and no silent field loss. */
export function jsonData(value, depth = 0, seen = new Set()) {
  if (depth > 40) throw new RangeError('JSON data exceeds the nesting limit.');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (!value || typeof value !== 'object' || seen.has(value)) throw new TypeError('Supply finite, acyclic JSON data.');
  if (!Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new TypeError('Supply plain JSON objects.');
  seen.add(value);
  const result = Array.isArray(value)
    ? value.map((item) => jsonData(item, depth + 1, seen))
    : Object.fromEntries(Object.entries(value).map(([key, item]) => [key, jsonData(item, depth + 1, seen)]));
  seen.delete(value);
  return result;
}

const PRIVATE_FIELD = /^(?:password|passwd|secret|api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|cookie|ssn|email|phone|credit[_-]?card|private[_-]?key)$/i;

/** Luhn check, so a long order number is not mistaken for a card. */
function luhn(digits) {
  let sum = 0, double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let value = digits.charCodeAt(i) - 48;
    if (double) { value *= 2; if (value > 9) value -= 9; }
    sum += value;
    double = !double;
  }
  return sum % 10 === 0;
}

const PATTERNS = [
  // A primary account number is the one value most worth never sending. Spaces
  // and dashes are common in pasted text, and the Luhn check keeps invoice and
  // order numbers of the same length intact.
  [/\b\d(?:[ -]?\d){12,18}\b/g, (match) => {
    const digits = match.replace(/\D/g, '');
    return digits.length >= 13 && digits.length <= 19 && luhn(digits) ? '[card removed]' : match;
  }],
  [/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g, '[private key removed]'],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [removed]'],
  [/\b(?:sk-(?:proj-)?|AKIA)[A-Za-z0-9_-]{12,}\b/g, '[key removed]'],
  [/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[token removed]'],
  [/(\b(?:password|passwd|secret|api[_-]?key|access[_-]?token)\s*[:=]\s*)[^\s,;]+/gi, '$1[removed]'],
  [/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[email removed]'],
  [/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[credentials removed]@'],
];

export function redactText(text) {
  return PATTERNS.reduce((value, [pattern, replacement]) => value.replace(pattern, replacement), String(text));
}

/** Question text is authored configuration, but it can still carry caller-supplied
 * descriptions — runbook summaries, option labels, rubric levels — that reach the
 * provider and the stored receipt. Redact its string values without touching the
 * keys, because Choice option labels are part of the answer contract.
 */
export function redactQuestions(questions) {
  let redactions = 0;
  const walk = (entry) => {
    if (typeof entry === 'string') {
      const clean = redactText(entry);
      if (clean !== entry) redactions++;
      return clean;
    }
    if (Array.isArray(entry)) return entry.map(walk);
    if (entry && typeof entry === 'object') return Object.fromEntries(Object.entries(entry).map(([key, item]) => [key, walk(item)]));
    return entry;
  };
  return { questions: walk(jsonData(questions)), redactions };
}

/** Rules-based minimisation, not a guarantee that arbitrary prose contains no PII.
 * allowFields restricts top-level fields before any external request is made.
 */
export function redactState(input, { allowFields, privateFields = [] } = {}) {
  const value = jsonData(input);
  if (allowFields !== undefined && (!Array.isArray(allowFields) || allowFields.some((field) => typeof field !== 'string'))) {
    throw new TypeError('allowFields must be an array of top-level field names.');
  }
  if (!Array.isArray(privateFields) || privateFields.some((field) => typeof field !== 'string')) throw new TypeError('privateFields must be field names.');
  const denied = new Set(privateFields.map((field) => field.toLowerCase()));
  let redactions = 0, omittedFields = 0;
  const walk = (entry) => {
    if (typeof entry === 'string') {
      const clean = redactText(entry);
      if (clean !== entry) redactions++;
      return clean;
    }
    if (Array.isArray(entry)) return entry.map(walk);
    if (entry && typeof entry === 'object') return Object.fromEntries(Object.entries(entry).map(([key, item]) => {
      if (PRIVATE_FIELD.test(key) || denied.has(key.toLowerCase())) { redactions++; return [key, '[removed]']; }
      return [key, walk(item)];
    }));
    return entry;
  };
  let selected = value;
  if (allowFields !== undefined) {
    if (!value || Array.isArray(value) || typeof value !== 'object') throw new TypeError('allowFields requires an object state.');
    const allowed = new Set(allowFields);
    selected = Object.fromEntries(Object.entries(value).filter(([key]) => {
      if (allowed.has(key)) return true;
      omittedFields++; return false;
    }));
  }
  return { state: walk(selected), redactions, omittedFields };
}
