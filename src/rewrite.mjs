// Collect-pass rewriting.
//
// On the first pass the judgments are not resolved yet, so a predicate like
// `WHERE jev_noul(body, '...') > 0.7` would filter rows out before we ever learn
// what they say — and those rows would never be judged. For collect passes only,
// filters that mention a jev_ function are relaxed, which yields a superset of the
// rows the real query needs. Non-jev filters are kept, so we never scan (or pay
// for) more of the table than the query actually touches.
//
// This is deliberately a string-level transform with a hard rule: when the shape is
// anything but a top-level AND chain, fall back to relaxing the whole clause. The
// engine re-runs until no judgment is missing, so an over-cautious rewrite costs a
// round trip, never a wrong answer.
import { JEV_FUNCTIONS } from './functions.mjs';

const JEV_CALL = new RegExp(`\\b(${JEV_FUNCTIONS.join('|')})\\s*\\(`, 'i');

/** Blank out string literals so text inside quotes never looks like code. */
function withoutLiterals(sql) {
  return sql.replace(/'(?:[^']|'')*'|"(?:[^"]|"")*"/g, (match) => ' '.repeat(match.length));
}

export function mentionsJev(sql) { return JEV_CALL.test(withoutLiterals(sql)); }

/** Split on a top-level keyword (depth 0, outside quotes). Returns the pieces. */
function splitTopLevel(text, keyword) {
  const parts = [];
  const pattern = new RegExp(`^${keyword}$`, 'i');
  let depth = 0, quote = null, token = '', current = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      current += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') { quote = ch; current += ch; token = ''; continue; }
    if (ch === '(') depth += 1;
    if (ch === ')') depth -= 1;

    if (/[A-Za-z_]/.test(ch)) token += ch;
    else {
      if (depth === 0 && pattern.test(token)) {
        parts.push(current.slice(0, current.length - token.length));
        current = '';
      }
      token = '';
    }
    current += ch;
  }
  if (depth === 0 && pattern.test(token)) { parts.push(current.slice(0, current.length - token.length)); current = ''; }
  parts.push(current);
  return parts;
}

/** Find a top-level clause keyword's span in a statement. */
function clauseSpan(sql, keyword, stopWords) {
  const upper = sql.toUpperCase();
  const start = findTopLevelKeyword(upper, keyword);
  if (start === -1) return null;
  let end = sql.length;
  for (const stop of stopWords) {
    const at = findTopLevelKeyword(upper, stop, start + keyword.length);
    if (at !== -1 && at < end) end = at;
  }
  return { start, end, body: sql.slice(start + keyword.length, end) };
}

function findTopLevelKeyword(upperSql, keyword, from = 0) {
  let depth = 0, quote = null;
  for (let i = from; i < upperSql.length; i++) {
    const ch = upperSql[i];
    if (quote) { if (ch === quote) quote = null; continue; }
    if (ch === "'" || ch === '"') { quote = ch; continue; }
    if (ch === '(') { depth += 1; continue; }
    if (ch === ')') { depth -= 1; continue; }
    if (depth !== 0) continue;
    if (upperSql.startsWith(keyword, i)) {
      const before = i === 0 ? ' ' : upperSql[i - 1];
      const after = upperSql[i + keyword.length] ?? ' ';
      if (!/[A-Z0-9_]/.test(before) && !/[A-Z0-9_]/.test(after)) return i;
    }
  }
  return -1;
}

// A judgment predicate must still be *evaluated* during collection (that is how we
// learn which judgments the query needs) while not filtering anything out. Wrapping
// it as `(<predicate> OR 1=1)` does both: SQLite evaluates the left side for every
// row, and the row always passes. `OR TRUE` would be folded away and never called,
// which is why 1=1 is used here (see the guard test in test/unit.test.mjs).
const alwaysTrue = (part) => ` (${part.trim()} OR 1=1) `;

function relaxClause(body) {
  const conjuncts = splitTopLevel(body, 'AND');
  // A top-level OR mixing judgments with ordinary filters cannot be split safely,
  // so relax the clause as a whole.
  if (conjuncts.length === 1 && /\bOR\b/i.test(withoutLiterals(body))) return alwaysTrue(body);
  return conjuncts.map((part) => (mentionsJev(part) ? alwaysTrue(part) : part)).join(' AND ');
}

/**
 * Rewrite a statement for a collect pass.
 * @returns {{sql: string, relaxed: string[]}} relaxed lists what was loosened
 */
export function relaxForCollect(sql) {
  const relaxed = [];
  let out = sql;

  for (const [keyword, stops] of [
    ['WHERE', ['GROUP BY', 'HAVING', 'WINDOW', 'ORDER BY', 'LIMIT', 'OFFSET']],
    ['HAVING', ['WINDOW', 'ORDER BY', 'LIMIT', 'OFFSET']],
  ]) {
    const span = clauseSpan(out, keyword, stops);
    if (!span || !mentionsJev(span.body)) continue;
    const replacement = relaxClause(span.body);
    out = out.slice(0, span.start) + keyword + replacement + out.slice(span.end);
    relaxed.push(keyword);
  }

  // A LIMIT on top of a jev-driven ORDER BY would truncate before the ordering is known.
  const order = clauseSpan(out, 'ORDER BY', ['LIMIT', 'OFFSET']);
  if (order && mentionsJev(order.body)) {
    const limit = clauseSpan(out, 'LIMIT', []);
    if (limit) { out = out.slice(0, limit.start).trimEnd(); relaxed.push('LIMIT'); }
  }

  return { sql: out, relaxed };
}
