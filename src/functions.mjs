// The jev_* SQL functions: how their arguments map onto a TypeSafe question,
// and how one answer maps back onto each function's return value.
//
// Several functions can share a single judgment. jev_choice, jev_choice_conf and
// jev_prob over the same (state, question, options) all read one Choice answer,
// so they cost one API question between them, not three.

import { createHash } from 'node:crypto';

export const JEV_FUNCTIONS = [
  'jev_noul', 'jev_bool',
  'jev_choice', 'jev_choice_conf', 'jev_prob',
  'jev_score', 'jev_score_conf',
];

/** Options/levels may be given as a JSON array, or a comma/pipe separated list. */
export function parseList(raw) {
  if (Array.isArray(raw)) return raw.map(String);
  const text = String(raw ?? '').trim();
  if (!text) return [];
  if (text.startsWith('[')) {
    try {
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed)) return parsed.map(String);
    } catch { /* fall through to separator parsing */ }
  }
  return text.split(text.includes('|') ? '|' : ',').map((s) => s.trim()).filter(Boolean);
}

function asText(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/**
 * Turn one SQL function call into the judgment it needs.
 * @returns {{kind: 'noul'|'choice'|'score', state: string, question: string, criteria: any, read: (answer) => any}}
 */
export function judgmentFor(fnName, args) {
  const state = asText(args[0]);
  const question = asText(args[1]);

  switch (fnName) {
    case 'jev_noul':
      return { kind: 'noul', state, question, criteria: null, read: (a) => a.noul };

    case 'jev_bool': {
      const threshold = args[2] == null ? 0.5 : Number(args[2]);
      return { kind: 'noul', state, question, criteria: null, read: (a) => (a.noul >= threshold ? 1 : 0) };
    }

    case 'jev_choice': {
      const options = parseList(args[2]);
      const minConfidence = args[3] == null ? 0 : Number(args[3]);
      return {
        kind: 'choice', state, question, criteria: options,
        read: (a) => (a.confidence >= minConfidence ? a.choice : null),
      };
    }

    case 'jev_choice_conf':
      return { kind: 'choice', state, question, criteria: parseList(args[2]), read: (a) => a.confidence };

    case 'jev_prob': {
      const options = parseList(args[2]);
      const label = asText(args[3]);
      return { kind: 'choice', state, question, criteria: options, read: (a) => a.probabilities[label] ?? 0 };
    }

    case 'jev_score': {
      const levels = parseList(args[2]);
      return { kind: 'score', state, question, criteria: levels, read: (a) => a.score };
    }

    case 'jev_score_conf':
      return { kind: 'score', state, question, criteria: parseList(args[2]), read: (a) => a.confidence };

    default:
      throw new Error(`Unknown JevSQL function: ${fnName}`);
  }
}

/** Identity of a judgment: same inputs anywhere in any query means one API question. */
export function judgmentKey(model, { kind, state, question, criteria }) {
  const payload = JSON.stringify([model, kind, question, criteria, state]);
  return createHash('sha256').update(payload).digest('hex');
}

/** The question object sent to TypeSafe, pointing at one row of a batched state. */
export function questionBody({ kind, question, criteria }, rowPath) {
  const instructions = { question, subject: `\`${rowPath}\`` };
  if (kind === 'noul') return { type: 'noul', instructions };
  if (kind === 'choice') return { type: 'choice', instructions, criteria: Object.fromEntries(criteria.map((o) => [o, null])) };
  return { type: 'score', instructions, criteria };
}

/** Value used while a judgment is still unresolved (collect passes only). */
export function placeholderFor(kind) {
  if (kind === 'noul') return 0.5;
  if (kind === 'choice') return null;
  return 0;
}
