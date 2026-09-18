import { probability, stableJson, structured } from './validation.mjs';

export const DECISION_FUNCTIONS = ['jev_decide', 'jev_match', 'jev_choice_probs', 'jev_score_norm', 'jev_score_probs', 'jev_pick', 'jev_pick_conf'];

export function parseCriteria(raw, kind) {
  let value = structured(raw);
  if (typeof value !== 'object' || value == null) {
    const text = String(raw ?? '').trim();
    if (/^[\[{]/.test(text)) throw new TypeError('Invalid JSON rubric.');
    value = text.split(text.includes('|') ? '|' : ',').map((s) => s.trim()).filter(Boolean);
  }
  if (kind === 'score') {
    if (!Array.isArray(value) || value.length < 2 || value.length > 10) throw new TypeError('Score requires 2 to 10 descriptive levels.');
    if (value.some((level) => level == null || (typeof level === 'string' && !level.trim()))) throw new TypeError('Score levels need descriptions.');
  } else {
    const labels = Array.isArray(value) ? value : Object.keys(value);
    if (labels.length < 2 || labels.length > 255) throw new TypeError('Choice requires 2 to 255 options.');
    if (labels.some((v) => typeof v !== 'string' || !v.trim()) || new Set(labels).size !== labels.length) {
      throw new TypeError('Choice labels must be distinct, non-empty strings.');
    }
  }
  return value;
}

/** Deterministic discovery; the model selects a span and code copies it. */
export function findCandidates(text, kind = 'email') {
  if (text == null) return [];
  const patterns = {
    email: /[A-Za-z0-9.!#$%&*+/=?^_`{|}~-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
    phone: /\+?\d[\d ().-]{5,}\d/g,
    money: /(?:[$€£¥]|\b(?:USD|EUR|GBP|ZAR)\s*)\s*\d[\d,]*(?:\.\d{1,2})?/g,
    url: /https?:\/\/[^\s<>"']+/g,
    line: /[^\r\n]+/g,
  };
  const pattern = patterns[kind];
  if (!(pattern instanceof RegExp)) throw new TypeError('Candidate kind must be email, phone, money, url, or line.');
  const values = [...new Set((String(text).match(pattern) ?? []).map((s) => s.trim()).filter(Boolean))];
  if (values.length > 254) throw new RangeError('More than 254 candidates. Narrow the source text first.');
  return values;
}

export function decisionJudgment(fnName, args, base) {
  const { state, question } = base;
  if (fnName === 'jev_decide') {
    const low = probability(args[2] ?? 0.1, 'low threshold');
    const high = probability(args[3] ?? 0.9, 'high threshold');
    if (low >= high) throw new TypeError('The low threshold must be below the high threshold.');
    return { kind: 'noul', state, question, criteria: null, read: (a) => a.noul < low ? 0 : a.noul > high ? 1 : null };
  }
  if (fnName === 'jev_match') {
    return {
      kind: 'noul', criteria: null,
      state: stableJson({ left: structured(args[0]), right: structured(args[1]) }),
      question: structured(args[2] ?? 'Do the left and right records refer to the same real-world entity?'),
      read: (a) => a.noul,
    };
  }
  if (fnName === 'jev_choice_probs') return {
    kind: 'choice', state, question, criteria: parseCriteria(args[2], 'choice'), read: (a) => JSON.stringify(a.probabilities),
  };
  if (fnName === 'jev_score_norm' || fnName === 'jev_score_probs') {
    const criteria = parseCriteria(args[2], 'score');
    return { kind: 'score', state, question, criteria,
      read: fnName === 'jev_score_norm' ? (a) => a.score / (criteria.length - 1) : (a) => JSON.stringify(a.probabilities) };
  }
  const candidates = typeof args[2] === 'string' ? JSON.parse(args[2]) : args[2];
  if (!Array.isArray(candidates) || candidates.length > 254
      || candidates.some((s) => typeof s !== 'string' || !s || !String(args[0]).includes(s))) {
    throw new TypeError('Pick candidates must be a JSON array of up to 254 exact spans present in the source text.');
  }
  const min = fnName === 'jev_pick' ? probability(args[3] ?? 0.8, 'min confidence') : 0;
  if (!candidates.length) return null;
  const spans = [...new Set(candidates)];
  const criteria = Object.fromEntries(spans.map((value, i) => [`c${i}`, value]));
  criteria.none = 'No supplied candidate answers the question in this source.';
  return {
    kind: 'choice', state, criteria,
    question: { question, task: 'Select the exact source span that answers the question. Select none when absent or unsupported.' },
    read: (a) => fnName === 'jev_pick_conf' ? a.confidence
      : a.choice === 'none' || a.confidence < min ? null : spans[Number(a.choice.slice(1))],
  };
}
