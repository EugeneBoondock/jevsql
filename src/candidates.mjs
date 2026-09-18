// Candidate query rewrites and index proposals.
//
// The division the documents insist on is the whole design here. A rules engine
// proposes; a typed review judges whether the proposal still means the same
// thing; and then code — not the model — decides whether it is actually faster,
// by building the index and measuring. Selectivity, index size and runtime are
// never inferred from a model answer.
//
// Equivalence gets the same treatment. A model can say two statements look
// equivalent; only executing both against deliberately awkward fixtures can
// show that they are not.

import './quiet.mjs';
import { DatabaseSync } from 'node:sqlite';
import { normalizeSchema } from './schema.mjs';
import { maskSql, readQuery } from './sql.mjs';
import { inspectQuery } from './sql-inspector.mjs';
import { integer, stableJson } from './validation.mjs';
import { digest } from './privacy.mjs';

const quote = (name) => `"${String(name).replaceAll('"', '""')}"`;

/**
 * Extract the access pattern of a read: which columns it filters by equality,
 * which by range, and which it orders on.
 *
 * This is a lexical reading of masked SQL, not a planner. It is used to propose
 * candidates, and every proposal is then measured, so an imprecise extraction
 * costs a wasted benchmark rather than a wrong conclusion.
 */
export function extractAccessPattern(sql, { dialect = 'sqlite' } = {}) {
  const masked = maskSql(String(sql));
  const strip = (name) => String(name).replace(/^[`"[]|[`"\]]$/g, '');
  const clause = (keyword, stops) => {
    const start = new RegExp(`\\b${keyword}\\b`, 'i').exec(masked);
    if (!start) return '';
    const rest = masked.slice(start.index + start[0].length);
    const end = stops.map((stop) => rest.search(new RegExp(`\\b${stop}\\b`, 'i'))).filter((index) => index >= 0);
    return rest.slice(0, end.length ? Math.min(...end) : rest.length);
  };
  const where = clause('WHERE', ['GROUP BY', 'HAVING', 'WINDOW', 'ORDER BY', 'LIMIT', 'OFFSET']);
  const order = clause('ORDER BY', ['LIMIT', 'OFFSET']);
  const reference = '(?:[A-Za-z_][A-Za-z0-9_$]*\\.)?[A-Za-z_][A-Za-z0-9_$]*';
  const equality = [], range = [];
  for (const match of where.matchAll(new RegExp(`(${reference})\\s*(=|<=|>=|<|>|<>|!=|\\bIN\\b|\\bLIKE\\b|\\bBETWEEN\\b|\\bIS\\b)`, 'gi'))) {
    const column = strip(match[1]);
    if (/^(?:and|or|not|null|true|false)$/i.test(column)) continue;
    const operator = match[2].toUpperCase();
    (['=', 'IN', 'IS'].includes(operator) ? equality : range).push(column);
  }
  const ordering = [...order.matchAll(new RegExp(`(${reference})(\\s+(?:ASC|DESC))?`, 'gi'))]
    .map((match) => ({ column: strip(match[1]), descending: /desc/i.test(match[2] ?? '') }))
    .filter((entry) => !/^(?:asc|desc)$/i.test(entry.column));
  const tables = [...masked.matchAll(new RegExp(`\\b(?:FROM|JOIN)\\s+(${reference})`, 'gi'))].map((match) => strip(match[1]));
  return { tables: [...new Set(tables)], equality: [...new Set(equality)], range: [...new Set(range)],
    order: ordering, dialect, fingerprint: digest([tables, equality, range, ordering]) };
}

/**
 * Propose index candidates from a workload.
 *
 * Equality columns lead, then a single range column, then the ordering — the
 * ordinary composite-index rule. A candidate that an existing index already
 * covers as a prefix is skipped rather than proposed and then rejected.
 */
export function proposeIndexes(snapshot, workload, { maxCandidates = 20, maxColumns = 4 } = {}) {
  const schema = normalizeSchema(snapshot);
  if (!Array.isArray(workload)) throw new TypeError('workload must be an array of statements.');
  integer(maxCandidates, 'maxCandidates', 1, 200);
  integer(maxColumns, 'maxColumns', 1, 8);
  const insensitive = schema.identifierCase === 'insensitive';
  const key = (value) => insensitive ? String(value).toLowerCase() : String(value);
  const tables = new Map(schema.tables.map((table) => [key(table.name), table]));
  const proposals = new Map();

  for (const entry of workload) {
    const sql = typeof entry === 'string' ? entry : entry?.sql;
    if (typeof sql !== 'string' || !sql.trim()) continue;
    const pattern = extractAccessPattern(sql, { dialect: schema.dialect });
    for (const tableName of pattern.tables) {
      const table = tables.get(key(tableName));
      if (!table) continue;
      const owns = (column) => table.columns.some((entry2) => key(entry2.name) === key(column.includes('.') ? column.split('.').pop() : column));
      const bare = (column) => table.columns.find((entry2) => key(entry2.name) === key(column.includes('.') ? column.split('.').pop() : column))?.name;
      const equality = [...new Set(pattern.equality.filter(owns).map(bare))];
      const range = [...new Set(pattern.range.filter(owns).map(bare))].slice(0, 1);
      const ordering = pattern.order.filter((item) => owns(item.column)).map((item) => ({ ...item, column: bare(item.column) }));
      const columns = [...equality, ...range, ...ordering.map((item) => item.column).filter((column) => !equality.includes(column) && !range.includes(column))]
        .slice(0, maxColumns);
      if (!columns.length) continue;
      // A prefix match on an existing index means the database can already use
      // it for this pattern, so proposing another one only costs writes.
      const covered = table.indexes.some((index) => index.columns.length >= columns.length
        && columns.every((column, position) => key(index.columns[position] ?? '') === key(column)));
      const primaryCovered = table.primaryKey.length >= columns.length
        && columns.every((column, position) => key(table.primaryKey[position]) === key(column));
      if (covered || primaryCovered) continue;
      const name = `idx_${table.name}_${columns.join('_')}`.replace(/[^A-Za-z0-9_]/g, '_').slice(0, 60);
      if (proposals.has(name)) { proposals.get(name).statements++; continue; }
      proposals.set(name, {
        name, table: table.name, columns,
        descending: ordering.filter((item) => item.descending).map((item) => item.column),
        rationale: [equality.length ? `equality on ${equality.join(', ')}` : null,
          range.length ? `range on ${range.join(', ')}` : null,
          ordering.length ? `ordering by ${ordering.map((item) => item.column).join(', ')}` : null].filter(Boolean).join('; '),
        createSql: `CREATE INDEX ${quote(name)} ON ${quote(table.name)} (${columns.map((column, position) => {
          const descending = ordering.find((item) => item.column === column && item.descending) && position >= equality.length;
          return `${quote(column)}${descending ? ' DESC' : ''}`;
        }).join(', ')})`,
        dropSql: `DROP INDEX ${quote(name)}`,
        statements: 1,
      });
    }
  }
  return [...proposals.values()].sort((a, b) => b.statements - a.statements || a.name.localeCompare(b.name)).slice(0, maxCandidates);
}

function timeStatement(db, sql, params, repeats) {
  const statement = db.prepare(sql);
  let rowCount = 0;
  const samples = [];
  for (let run = 0; run < repeats; run++) {
    const started = performance.now();
    const rows = statement.all(...params);
    samples.push(performance.now() - started);
    rowCount = rows.length;
  }
  samples.sort((a, b) => a - b);
  return { rowCount, runs: repeats, medianMs: samples[Math.floor(samples.length / 2)],
    bestMs: samples[0], worstMs: samples.at(-1) };
}

/**
 * Build a candidate index, measure the statement with and without it, and drop
 * it again. The write cost is measured too, because an index that halves a read
 * and doubles every insert is not obviously an improvement.
 *
 * Timings come from one process on one machine against whatever data is
 * present. They are evidence for a comparison, not a production prediction.
 */
export function measureIndexCandidate(db, candidate, { sql, params = [], repeats = 5, writeProbe = null } = {}) {
  if (!db || typeof db.prepare !== 'function') throw new TypeError('A DatabaseSync connection is required.');
  integer(repeats, 'repeats', 1, 1000);
  readQuery(sql);
  const plan = () => db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params).map((row) => row.detail).join(' | ');
  const before = { ...timeStatement(db, sql, params, repeats), plan: plan() };
  const beforeWrite = writeProbe ? timeStatement(db, `SELECT 1`, [], 1) : null;
  let after = null, writeCost = null, error = null;
  db.exec('SAVEPOINT _jevsql_candidate');
  try {
    db.exec(candidate.createSql);
    after = { ...timeStatement(db, sql, params, repeats), plan: plan() };
    if (writeProbe) {
      const started = performance.now();
      for (let run = 0; run < repeats; run++) db.prepare(writeProbe.sql).run(...(writeProbe.params ?? []));
      writeCost = { runs: repeats, totalMs: performance.now() - started };
    }
  } catch (failure) { error = failure.message; }
  finally { db.exec('ROLLBACK TO _jevsql_candidate'); db.exec('RELEASE _jevsql_candidate'); }
  const improvement = after && before.medianMs > 0 ? 1 - after.medianMs / before.medianMs : null;
  return { candidate: candidate.name, applied: after !== null, error, before, after, writeCost, beforeWrite,
    planChanged: after !== null && after.plan !== before.plan,
    sameRowCount: after !== null && after.rowCount === before.rowCount,
    medianImprovement: improvement,
    verdict: error ? 'failed' : !after ? 'failed'
      : after.rowCount !== before.rowCount ? 'changed-results'
        : improvement !== null && improvement >= 0.2 ? 'faster'
          : improvement !== null && improvement <= -0.2 ? 'slower' : 'no-measured-difference',
    evidence: 'measured in this process against the current data volume' };
}

/**
 * Compare a rewrite against its original on deliberately awkward fixtures.
 *
 * The fixtures matter more than the comparison: NULLs, duplicates, empty sets
 * and boundary values are exactly where a "semantically equivalent" rewrite
 * stops being equivalent. Each fixture is applied to a scratch database, both
 * statements run, and results are compared as multisets unless order is asked
 * for. A pass is evidence on these fixtures, never a proof of equivalence.
 */
export function propertyCompare({ baselineSql, original, candidate, fixtures = [], params = [],
  candidateParams = params, ordered = false, maxRows = 1000 } = {}) {
  readQuery(original); readQuery(candidate);
  integer(maxRows, 'maxRows', 1, 100000);
  if (!Array.isArray(fixtures) || !fixtures.length) throw new TypeError('Supply at least one fixture.');
  const results = fixtures.map((fixture, index) => {
    const name = fixture?.name ?? `fixture-${index + 1}`;
    const db = new DatabaseSync(':memory:');
    try {
      db.exec('PRAGMA foreign_keys = ON');
      db.exec(baselineSql);
      for (const statement of fixture?.statements ?? []) {
        db.prepare(typeof statement === 'string' ? statement : statement.sql).run(...(statement?.params ?? []));
      }
      for (const sql of [original, candidate]) {
        const inspection = inspectQuery(db, sql, { params });
        if (inspection.findings.some((finding) => finding.level === 'block')) {
          return { name, equal: false, reason: 'not_a_pure_read', findings: inspection.findings };
        }
      }
      const read = (sql, values) => {
        const statement = db.prepare(sql);
        const rows = [];
        for (const row of statement.iterate(...values)) {
          if (rows.length > maxRows) throw new RangeError('Property comparison row limit exceeded.');
          rows.push(row);
        }
        return { columns: statement.columns().map(({ name: column }) => column), rows };
      };
      const left = read(original, params), right = read(candidate, candidateParams);
      const encode = ({ rows, columns }) => {
        const encoded = rows.map((row) => stableJson(columns.map((column) => {
          const value = row[column];
          return value instanceof Uint8Array ? ['blob', Buffer.from(value).toString('base64')] : [typeof value, value];
        })));
        return ordered ? encoded : encoded.slice().sort();
      };
      const columnsMatch = stableJson(left.columns) === stableJson(right.columns);
      const equal = columnsMatch && stableJson(encode(left)) === stableJson(encode(right));
      return { name, equal, columnsMatch, originalRows: left.rows.length, candidateRows: right.rows.length,
        ...(equal ? {} : { originalSample: left.rows.slice(0, 3), candidateSample: right.rows.slice(0, 3) }) };
    } catch (error) {
      return { name, equal: false, reason: 'fixture_failed', error: error.message };
    } finally { db.close(); }
  });
  const failed = results.filter((result) => !result.equal);
  return { equivalent: failed.length === 0, fixtures: results.length, failed: failed.length, results,
    ordered, note: 'Equivalence is established on these fixtures only.' };
}

/** Fixtures that catch the cases a rewrite most often breaks. Each is a set of
 * statements the caller adapts to their own tables. */
export function edgeCaseFixtures({ table, column, keyColumn = 'id' } = {}) {
  const insert = (values) => ({ sql: `INSERT INTO ${quote(table)} (${quote(keyColumn)}, ${quote(column)}) VALUES (?, ?)`, params: values });
  return [
    { name: 'empty table', statements: [] },
    { name: 'single row', statements: [insert([1, 'a'])] },
    { name: 'duplicate values', statements: [insert([1, 'a']), insert([2, 'a']), insert([3, 'a'])] },
    { name: 'null values', statements: [insert([1, null]), insert([2, 'a']), insert([3, null])] },
    { name: 'mixed case', statements: [insert([1, 'a']), insert([2, 'A']), insert([3, 'a '])] },
    { name: 'empty string', statements: [insert([1, '']), insert([2, 'a'])] },
  ];
}
