// Executable evidence for a migration review.
//
// A review packet says which test packs a change needs. Until something runs
// them, the packet is a claim. This module replays a migration on a scratch
// database, proves the DDL actually produces the schema the review was written
// against, runs the named packs, and checks that the rollback restores what it
// started from. Nothing here calls a model and nothing touches a real database:
// the caller supplies baseline DDL, and every statement runs in a private
// in-memory SQLite instance that is discarded afterwards.

import './quiet.mjs';
import { DatabaseSync } from 'node:sqlite';
import { inspectSchema, normalizeSchema, diffSchemas } from './schema.mjs';
import { readQuery } from './sql.mjs';
import { integer, stableJson } from './validation.mjs';
import { digest } from './privacy.mjs';

const text = (value, label) => {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${label} must be a non-empty SQL string.`);
  return value;
};

function userTables(db) {
  return db.prepare(`SELECT name FROM sqlite_schema WHERE type='table'
    AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_jevsql_%' ORDER BY name`).all().map((row) => row.name);
}

const encode = (value) => value instanceof Uint8Array
  ? ['blob', Buffer.from(value).toString('base64')] : [typeof value, value];

/** A bounded, order-independent capture of every user table's contents. Rows
 * stay internal to this module: only counts and hashes reach the report. */
function snapshotData(db, maxRows) {
  const tables = {};
  let truncated = false;
  for (const name of userTables(db)) {
    const statement = db.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`);
    const rows = [];
    for (const row of statement.iterate()) {
      if (rows.length >= maxRows) { truncated = true; break; }
      rows.push(row);
    }
    tables[name] = { columns: statement.columns().map(({ name: column }) => column), rows, rowCount: rows.length };
  }
  return { tables, truncated };
}

/** Project both sides onto the columns they share, so adding or dropping a
 * column is a schema change rather than evidence that rows were altered. */
function sameRows(before, after) {
  const shared = before.columns.filter((column) => after.columns.includes(column));
  const project = (table) => table.rows.map((row) => stableJson(shared.map((column) => encode(row[column])))).sort();
  return { shared, equal: digest(project(before)) === digest(project(after)) };
}

const tableHashes = (data) => Object.fromEntries(Object.entries(data.tables).map(([name, table]) =>
  [name, { rowCount: table.rowCount, columns: table.columns,
    hash: digest(table.rows.map((row) => stableJson(table.columns.map((column) => encode(row[column])))).sort()) }]));

function runPack(db, pack, maxRows) {
  const checks = (pack.checks ?? []).map((check) => {
    const name = text(check?.name, 'check.name');
    let rows, error = null;
    try {
      rows = db.prepare(readQuery(check.sql)).all(...(Array.isArray(check.params) ? check.params : []));
    } catch (failure) {
      return { name, passed: false, violations: null, error: failure.message, examples: [] };
    }
    const allowed = integer(check.maxRows ?? 0, 'check.maxRows', 0);
    return { name, passed: rows.length <= allowed, violations: rows.length, maxRows: allowed,
      examples: rows.slice(0, Math.min(5, maxRows)), error };
  });
  return { name: text(pack?.name, 'pack.name'), passed: checks.every((check) => check.passed), checks };
}

/**
 * Replay a migration and report what actually happened.
 *
 * `baselineSql` builds the starting schema and `fixtures` populate it. `up` is
 * applied, then every supplied pack runs against the migrated database, then
 * `down` is applied if present and the result is compared back to the baseline.
 *
 * `declaredAfter` is the after-schema the review was written against. Comparing
 * it to the schema the DDL really produced is the point: a review packet that
 * describes a different schema from the one the migration builds is evidence
 * about nothing. A mismatch is reported as a diff, not just a boolean.
 *
 * Rollback is checked on schema and on data separately, because a `down` that
 * restores the shape while discarding rows is not a rollback. Fixture rows are
 * the only data involved; this proves the statements behave on the supplied
 * fixtures, never that they are safe on a production volume.
 *
 * @returns {{ok: boolean, applied: boolean, error: ?string, baseline: object,
 *   after: ?object, declared: ?object, matchesDeclaredAfter: ?boolean,
 *   declaredDifferences: object[], packs: object[], rollback: object,
 *   data: object, stats: object}}
 */
export function verifyMigration({ baselineSql, up, down = null, fixtures = [], packs = [],
  declaredAfter = null, maxRows = 1000 } = {}) {
  text(baselineSql, 'baselineSql');
  text(up, 'up');
  if (down !== null) text(down, 'down');
  integer(maxRows, 'maxRows', 1, 100000);
  if (!Array.isArray(fixtures) || !Array.isArray(packs)) throw new TypeError('fixtures and packs must be arrays.');
  const started = performance.now();
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('PRAGMA foreign_keys = ON');
    db.exec(baselineSql);
    for (const fixture of fixtures) {
      const sql = text(typeof fixture === 'string' ? fixture : fixture?.sql, 'fixture.sql');
      db.prepare(sql).run(...(Array.isArray(fixture?.params) ? fixture.params : []));
    }
    const baseline = inspectSchema(db);
    const baselineData = snapshotData(db, maxRows);

    let applied = true, error = null, after = null, afterData = null;
    try { db.exec(up); } catch (failure) { applied = false; error = failure.message; }
    if (applied) { after = inspectSchema(db); afterData = snapshotData(db, maxRows); }

    const declared = declaredAfter ? normalizeSchema(declaredAfter) : null;
    const declaredDifferences = applied && declared ? diffSchemas(after, declared) : [];
    const matchesDeclaredAfter = applied && declared ? declared.hash === after.hash : null;

    const packResults = applied ? packs.map((pack) => runPack(db, pack, maxRows)) : [];

    // Every table that survived the migration is compared row for row against
    // its baseline, so a migration that quietly empties a table is visible.
    const preserved = [], lost = [];
    if (applied) {
      for (const [name, before] of Object.entries(baselineData.tables)) {
        const next = afterData.tables[name];
        if (!next) { lost.push({ table: name, reason: 'table_removed', rowsBefore: before.rowCount }); continue; }
        const { shared, equal } = sameRows(before, next);
        const droppedColumns = before.columns.filter((column) => !next.columns.includes(column));
        if (equal && !droppedColumns.length) preserved.push(name);
        else if (equal) preserved.push(name), lost.push({ table: name, reason: 'columns_removed',
          rowsBefore: before.rowCount, rowsAfter: next.rowCount, columns: droppedColumns });
        else lost.push({ table: name, reason: next.rowCount < before.rowCount ? 'rows_removed' : 'rows_changed',
          rowsBefore: before.rowCount, rowsAfter: next.rowCount, comparedColumns: shared });
      }
    }

    const rollback = { supplied: down !== null, applied: null, restoresSchema: null, restoresData: null, error: null, differences: [] };
    if (down !== null && applied) {
      try {
        db.exec(down);
        rollback.applied = true;
        const restored = inspectSchema(db);
        rollback.restoresSchema = restored.hash === baseline.hash;
        rollback.differences = diffSchemas(baseline, restored);
        rollback.restoresData = stableJson(tableHashes(snapshotData(db, maxRows))) === stableJson(tableHashes(baselineData));
      } catch (failure) { rollback.applied = false; rollback.error = failure.message; }
    }

    const ok = applied && packResults.every((pack) => pack.passed) && matchesDeclaredAfter !== false
      && !lost.length && (down === null || (rollback.restoresSchema === true && rollback.restoresData === true));
    return { ok, applied, error, baseline, after, declared, matchesDeclaredAfter, declaredDifferences,
      packs: packResults, rollback, data: { preserved, lost, truncated: baselineData.truncated || Boolean(afterData?.truncated) },
      stats: { wallMs: Math.round(performance.now() - started), fixtures: fixtures.length,
        packs: packResults.length, checks: packResults.reduce((sum, pack) => sum + pack.checks.length, 0) },
      evidence: 'replayed on supplied fixtures in a scratch SQLite database' };
  } finally { db.close(); }
}

/** Standard packs by name, so a review that asks for `read-path` can be given
 * something executable. Each returns checks for the supplied tables. A pack is a
 * starting point a team extends, not a proof of coverage. */
export function standardPacks(names, { tables = [], keyColumns = {} } = {}) {
  if (!Array.isArray(names)) throw new TypeError('Pack names must be an array.');
  const quoted = (name) => `"${String(name).replaceAll('"', '""')}"`;
  const builders = {
    'read-path': () => tables.map((table) => ({ name: `${table} is readable`, sql: `SELECT * FROM ${quoted(table)} LIMIT 1`, maxRows: 1 })),
    'schema-contract': () => tables.map((table) => ({ name: `${table} exists`,
      sql: `SELECT name FROM sqlite_schema WHERE type='table' AND name='${String(table).replaceAll("'", "''")}'`, maxRows: 1 })),
    backfill: () => tables.flatMap((table) => (keyColumns[table] ? [{ name: `${table} has no unfilled ${keyColumns[table]}`,
      sql: `SELECT 1 FROM ${quoted(table)} WHERE ${quoted(keyColumns[table])} IS NULL`, maxRows: 0 }] : [])),
    constraint: () => tables.map((table) => ({ name: `${table} satisfies its foreign keys`,
      sql: `SELECT 1 FROM pragma_foreign_key_check(${`'${String(table).replaceAll("'", "''")}'`})`, maxRows: 0 })),
    'tenant-isolation': () => tables.flatMap((table) => (keyColumns[table] ? [{ name: `${table} rows all carry a tenant`,
      sql: `SELECT 1 FROM ${quoted(table)} WHERE ${quoted(keyColumns[table])} IS NULL`, maxRows: 0 }] : [])),
  };
  return names.filter((name) => builders[name]).map((name) => ({ name, checks: builders[name]() }));
}
