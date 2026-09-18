// Collect-pass rewriting.
//
// On the first pass the judgments are not resolved yet, so a predicate like
// `WHERE jev_noul(body, '...') > 0.7` would filter rows out before we ever learn
// what they say — and those rows would never be judged. For collect passes only,
// filters that mention a jev_ function are relaxed, which yields a superset of the
// rows the real query needs. Simple non-jev filters narrow the candidate set.
//
// This is deliberately a string-level transform with a hard rule: when the shape is
// anything but a top-level AND chain, fall back to relaxing the whole clause. The
// engine reruns the original statement and rejects unresolved work after a
// bounded number of rounds. Complex and volatile SQL needs separate validation.
import { JEV_FUNCTIONS } from './functions.mjs';
import { maskSql, topLevelWords } from './sql.mjs';

const JEV_CALL = new RegExp(`\\b(${JEV_FUNCTIONS.join('|')})\\s*\\(`, 'i');

export function mentionsJev(sql) { return JEV_CALL.test(maskSql(sql, { keepJevNames: true })); }

/** Find a top-level clause keyword's span in a statement. */
function clauseSpan(sql, keyword, stopWords) {
  const start = findTopLevelKeyword(sql, keyword);
  if (start === -1) return null;
  let end = sql.length;
  for (const stop of stopWords) {
    const at = findTopLevelKeyword(sql, stop, start + keyword.length);
    if (at !== -1 && at < end) end = at;
  }
  return { start, end, body: sql.slice(start + keyword.length, end) };
}

function findTopLevelKeyword(upperSql, keyword, from = 0) {
  const words = topLevelWords(upperSql);
  const target = keyword.split(' ');
  for (let i = 0; i < words.length; i++) {
    if (words[i].start >= from && target.every((word, j) => words[i + j]?.word === word)) return words[i].start;
  }
  return -1;
}

// A judgment predicate must still be *evaluated* during collection (that is how we
// learn which judgments the query needs) while not filtering anything out. Wrapping
// it as `(<predicate> OR 1=1)` does both: SQLite evaluates the left side for every
// row, and the row always passes. `OR TRUE` would be folded away and never called,
// which is why 1=1 is used here (see the guard test in test/unit.test.mjs).
const alwaysTrue = (part) => ` (${part.trim()}${part.includes('--') ? '\n' : ''} OR 1=1) `;

function relaxClause(body) {
  const words = topLevelWords(body);
  // OR precedence, CASE branches, and BETWEEN bounds cannot be split as AND chains.
  if (words.some(({ word }) => ['OR', 'BETWEEN', 'CASE'].includes(word))) return alwaysTrue(body);
  const conjuncts = [], separators = words.filter(({ word }) => word === 'AND');
  let start = 0;
  for (const separator of separators) { conjuncts.push(body.slice(start, separator.start)); start = separator.end; }
  conjuncts.push(body.slice(start));
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
    ['WHERE', ['GROUP BY', 'HAVING', 'WINDOW', 'ORDER BY', 'LIMIT', 'OFFSET', 'UNION', 'EXCEPT', 'INTERSECT']],
    ['HAVING', ['WINDOW', 'ORDER BY', 'LIMIT', 'OFFSET', 'UNION', 'EXCEPT', 'INTERSECT']],
  ]) {
    const span = clauseSpan(out, keyword, stops);
    if (!span || !mentionsJev(span.body)) continue;
    const replacement = relaxClause(span.body);
    out = out.slice(0, span.start) + keyword + replacement + out.slice(span.end);
    relaxed.push(keyword);
  }

  // A LIMIT on top of a jev-driven ORDER BY would truncate before the ordering is known.
  const order = clauseSpan(out, 'ORDER BY', ['LIMIT', 'OFFSET']);
  // ORDER BY can reference an alias or ordinal of a judgment in SELECT.
  // A relaxed WHERE with LIMIT must also visit candidates beyond early rejects.
  if ((order && mentionsJev(out)) || relaxed.length) {
    const limit = clauseSpan(out, 'LIMIT', []);
    if (limit) { out = out.slice(0, limit.start).trimEnd(); relaxed.push('LIMIT'); }
  }

  return { sql: out, relaxed };
}
