/**
 * Read SQL somebody else wrote and name the ways it can be quietly wrong.
 *
 * The compiler in query-compiler.mjs proves things because it built the query
 * itself: it knows the foreign keys, the collations and the grain. Most SQL in
 * the world is not built that way. It is a string in an application, often
 * against PostgreSQL, and nothing here can execute it, plan it, or ask the
 * server about it.
 *
 * So this is text analysis, and it is deliberately narrow. Every check below
 * either holds from the shape of the statement alone or is not made. Nothing
 * here guesses at cardinality, and nothing here is evidence that a query IS
 * correct — an empty finding list means only that none of these shapes are
 * present.
 *
 * What it does NOT do, on purpose:
 *
 *   - It does not decide whether a join multiplies an aggregate. That needs
 *     declared keys and collations, which is exactly what compileTemplate has
 *     and a string does not. Claiming it from text would be a guess wearing a
 *     proof's clothes.
 *   - It does not resolve names. `NOT IN (SELECT id FROM t)` is flagged for
 *     what the shape costs when the column is nullable; whether it is nullable
 *     is a question for the schema, and the finding says so.
 *   - It does not rank or score. Every finding carries the condition under
 *     which it is a defect, so a reader can settle it in one look.
 *
 * Offsets survive the mask (maskSql pads with spaces), so every finding can
 * point at the line it came from.
 */
import { maskSql, topLevelWords } from './sql.mjs';

/** Words at any depth, with their depth and position. topLevelWords keeps only depth 0. */
function scan(masked) {
  const words = [];
  let depth = 0;
  for (const match of masked.matchAll(/[A-Za-z_][A-Za-z0-9_]*|[()]/g)) {
    if (match[0] === '(') depth++;
    else if (match[0] === ')') depth--;
    else words.push({ word: match[0].toUpperCase(), depth, start: match.index });
  }
  return words;
}

const lineOf = (text, index) => text.slice(0, index).split('\n').length;

/**
 * Name the ways a statement can run clean and answer wrongly.
 *
 * @param {string} sql
 * @param {{dialect?: string}} [options]
 * @returns {{findings: Array<{level: string, code: string, detail: string, line: number}>}}
 */
export function analyzeQueryText(sql, { dialect = 'sqlite' } = {}) {
  if (typeof sql !== 'string' || !sql.trim()) throw new TypeError('SQL is required.');
  if (!['sqlite', 'postgresql', 'mysql'].includes(dialect)) throw new TypeError('Unknown SQL dialect.');
  let masked;
  try {
    masked = maskSql(sql);
  } catch (error) {
    // Unreadable is not the same as clean. Say so rather than returning [].
    if (!(error instanceof SyntaxError)) throw error;
    return { findings: [{ level: 'review', code: 'unreadable_sql', line: 1,
      detail: `This statement could not be read, so none of these checks ran: ${error.message.toLowerCase()}` }] };
  }
  const words = scan(masked);
  const findings = [];
  const at = (index) => lineOf(sql, index);
  const add = (level, code, index, detail) => findings.push({ level, code, line: at(index), detail });

  /*
   * A LIMIT with no ORDER BY beside it.
   *
   * The rows are whichever ones the plan reached first. Add an index, change
   * the statistics, upgrade the server, and the same statement answers with a
   * different set — no error either time. Paginating with it skips and repeats
   * rows; taking a "top N" with it returns an arbitrary N.
   *
   * Scoped by depth, so a LIMIT inside a subquery is judged against that
   * subquery's own ORDER BY, and a window function's `OVER (ORDER BY ...)`
   * — which sits one level deeper — is never mistaken for one.
   */
  for (const limit of words.filter((entry) => entry.word === 'LIMIT')) {
    const sameLevel = words.filter((entry) => entry.depth === limit.depth && entry.start < limit.start);
    const boundary = [...sameLevel].reverse().find((entry) => ['ORDER', 'SELECT'].includes(entry.word));
    if (boundary?.word === 'ORDER') continue;
    /*
     * How much this costs depends on how many rows were asked for.
     *
     * Run over a real application, the first version of this check raised 158
     * findings and 150 of them were `LIMIT 1` — existence and lookup queries
     * where an arbitrary row is the whole point. A list nobody reads is worth
     * the same as no list, so the size of the window decides the level.
     *
     * OFFSET is the one that is always wrong: paging through an unordered
     * result skips rows and repeats others, and the totals never add up.
     */
    const rest = masked.slice(limit.start);
    const size = (rest.match(/^LIMIT\s+(\d+)/i) || [])[1];
    const paged = /\bOFFSET\b/i.test(masked);
    if (paged) {
      add('review', 'unstable_pagination', limit.start,
        'This pages through an unordered result. Rows shift between pages, so some are shown twice and others never.');
    } else if (size === '1') {
      add('note', 'arbitrary_row', limit.start,
        'LIMIT 1 with no ORDER BY returns an arbitrary row. That is right for an existence check and wrong if a particular row was meant.');
    } else {
      add('review', 'unstable_window', limit.start,
        'This LIMIT has no ORDER BY, so it returns an arbitrary window. Which rows come back can change when the plan does, with no error either time.');
    }
  }

  /*
   * NOT IN over a subquery.
   *
   * If the subquery ever yields a single NULL, the predicate is UNKNOWN for
   * every row and the statement returns nothing at all — correctly, per the
   * standard, and silently. It is the one null rule that turns a filter into
   * an empty result rather than a wrong one, which is why it survives review:
   * an empty answer reads like "there are none".
   */
  for (const index of [...masked.matchAll(/\bNOT\s+IN\s*\(\s*SELECT\b/gi)].map((match) => match.index)) {
    add('review', 'not_in_subquery', index,
      'NOT IN over a subquery returns no rows at all if that subquery yields one NULL. Use NOT EXISTS, or confirm the inner column is NOT NULL.');
  }

  /*
   * COUNT(*) next to an outer join.
   *
   * An unmatched left row still produces one row, so COUNT(*) counts it as
   * one. Counting a column from the joined side counts it as none. Both are
   * correct answers to different questions and the query says which only by
   * accident.
   */
  const outerJoin = [...masked.matchAll(/\b(LEFT|RIGHT|FULL)\s+(OUTER\s+)?JOIN\b/gi)][0];
  if (outerJoin) {
    for (const index of [...masked.matchAll(/\bCOUNT\s*\(\s*\*\s*\)/gi)].map((match) => match.index)) {
      add('note', 'count_star_over_outer_join', index,
        'COUNT(*) beside an outer join counts an unmatched row as one. Count a column from the joined side to count it as none.');
    }
  }

  /*
   * UNION without ALL.
   *
   * It deduplicates, which costs a sort and, more quietly, merges rows that
   * were meant to be separate. Two identical payments on the same day become
   * one payment.
   */
  for (const union of words.filter((entry) => entry.word === 'UNION')) {
    const next = words.find((entry) => entry.start > union.start);
    if (next?.word === 'ALL') continue;
    add('note', 'union_deduplicates', union.start,
      'UNION removes duplicate rows across both sides. Use UNION ALL unless merging identical rows is intended.');
  }

  return { findings };
}

/**
 * Run the analysis over many statements and keep only what was found.
 *
 * @param {Array<{id: string, sql: string, dialect?: string}>} statements
 * @returns {Array<{id: string, level: string, code: string, detail: string, line: number}>}
 */
export function analyzeQueryTexts(statements, { dialect = 'sqlite' } = {}) {
  if (!Array.isArray(statements)) throw new TypeError('statements must be an array.');
  const found = [];
  for (const entry of statements) {
    if (!entry || typeof entry.sql !== 'string') throw new TypeError('Each statement needs an sql string.');
    for (const finding of analyzeQueryText(entry.sql, { dialect: entry.dialect ?? dialect }).findings) {
      found.push({ id: String(entry.id ?? ''), ...finding });
    }
  }
  return found;
}
