import { readQuery } from './sql.mjs';
import { integer, quoteIdentifier as qi, stableJson } from './validation.mjs';

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS _jevsql_tables (
    name TEXT PRIMARY KEY, sql TEXT NOT NULL, key_column TEXT NOT NULL,
    params_json TEXT NOT NULL, model TEXT NOT NULL, cache_namespace TEXT NOT NULL,
    revision INTEGER NOT NULL, refreshed_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS _jevsql_changes (
    table_name TEXT NOT NULL, revision INTEGER NOT NULL, record_key TEXT NOT NULL,
    change_type TEXT NOT NULL, before_json TEXT, after_json TEXT, detected_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS _jevsql_changes_lookup ON _jevsql_changes(table_name, revision);
  CREATE TABLE IF NOT EXISTS _jevsql_runs (
    table_name TEXT NOT NULL, revision INTEGER NOT NULL, stats_json TEXT NOT NULL,
    decisions_json TEXT NOT NULL, PRIMARY KEY(table_name, revision)
  );
`;

function metadata(engine, name) {
  const exists = engine.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='_jevsql_tables'").get();
  return exists ? engine.db.prepare('SELECT * FROM _jevsql_tables WHERE name = ?').get(name) : undefined;
}

function tableName(name) {
  if (typeof name !== 'string' || !/^[A-Za-z][A-Za-z0-9_]*$/.test(name) || name.toLowerCase().startsWith('sqlite_')) {
    throw new TypeError('Decision table names must start with a letter and contain only letters, digits, or underscores.');
  }
  return name;
}

export function diffRows(before, after, key) {
  const index = (rows) => {
    const map = new Map();
    for (const row of rows) {
      const value = row[key];
      if (!['string', 'number'].includes(typeof value) || (typeof value === 'number' && !Number.isFinite(value))) {
        throw new TypeError(`Every row needs a non-null string or number in key column ${key}.`);
      }
      const token = stableJson(value);
      if (map.has(token)) throw new Error(`Duplicate decision-table key in column ${key}.`);
      map.set(token, row);
    }
    return map;
  };
  const oldRows = index(before), newRows = index(after);
  const changes = { added: [], updated: [], removed: [], unchanged: 0 };
  for (const [token, row] of newRows) {
    const old = oldRows.get(token);
    if (!old) changes.added.push(row);
    else if (stableJson(old) !== stableJson(row)) {
      const columns = [...new Set([...Object.keys(old), ...Object.keys(row)])].filter((column) => stableJson(old[column]) !== stableJson(row[column]));
      changes.updated.push({ key: row[key], before: old, after: row, columns });
    } else changes.unchanged++;
  }
  for (const [token, row] of oldRows) if (!newRows.has(token)) changes.removed.push(row);
  return changes;
}

/** Persist a SELECT as a normal, indexed SQLite table and record its changes. */
export async function materialize(engine, name, sql, { key = 'id', params = [], dryRun = false, signal } = {}) {
  tableName(name);
  sql = readQuery(sql);
  qi(key);
  const owned = metadata(engine, name);
  const existing = engine.db.prepare('SELECT name, type FROM sqlite_master WHERE name = ? COLLATE NOCASE').get(name);
  if (existing && !owned) throw new Error(`Refusing to overwrite existing ${existing.type} ${name}. Choose a new decision table name.`);
  if (owned && owned.key_column !== key) throw new Error('A saved decision table must keep its key column. Use a new table for a different key.');
  const columns = engine.db.prepare(sql).columns().map((column) => column.name);
  if (!columns.includes(key)) throw new Error(`Query must return key column ${key}.`);
  if (new Set(columns.map((column) => column.toLowerCase())).size !== columns.length) throw new Error('Decision table queries need distinct column names.');
  if (owned && existing) {
    const stored = engine.db.prepare(`PRAGMA table_info(${qi(name)})`).all().map((column) => column.name);
    if (stableJson(stored) !== stableJson(columns)) throw new Error('Decision table columns changed. Use a new table name for the new shape.');
  }
  if (dryRun) return { name, key, dryRun: true, stats: await engine.explain(sql, { params, signal }) };

  engine.db.exec('SAVEPOINT _jevsql_refresh');
  try {
    const before = existing ? engine.db.prepare(`SELECT * FROM ${qi(name)}`).all() : [];
    const { rows, stats, decisions } = await engine.query(sql, { params, audit: true, signal });
    signal?.throwIfAborted();
    const changes = diffRows(before, rows, key);
    const revision = (owned?.revision ?? 0) + 1;
    const refreshedAt = new Date().toISOString();
    engine.db.exec(SCHEMA);
    if (!existing) engine.db.exec(`CREATE TABLE ${qi(name)} (${columns.map((column) => `${qi(column)}${column === key ? ' PRIMARY KEY NOT NULL' : ''}`).join(', ')})`);
    const insert = engine.db.prepare(`INSERT INTO ${qi(name)} (${columns.map(qi).join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`);
    const remove = engine.db.prepare(`DELETE FROM ${qi(name)} WHERE ${qi(key)} = ?`);
    const changedColumns = columns.filter((column) => column !== key);
    const update = changedColumns.length ? engine.db.prepare(`UPDATE ${qi(name)} SET ${changedColumns.map((column) => `${qi(column)} = ?`).join(', ')} WHERE ${qi(key)} = ?`) : null;
    const log = engine.db.prepare('INSERT INTO _jevsql_changes VALUES (?, ?, ?, ?, ?, ?, ?)');
    const record = (kind, previous, next) => log.run(name, revision, stableJson((next ?? previous)[key]), kind,
      previous ? stableJson(previous) : null, next ? stableJson(next) : null, refreshedAt);
    for (const row of changes.removed) { remove.run(row[key]); record('removed', row, null); }
    for (const row of changes.added) { insert.run(...columns.map((column) => row[column])); record('added', null, row); }
    for (const change of changes.updated) {
      update.run(...changedColumns.map((column) => change.after[column]), change.key);
      record('updated', change.before, change.after);
    }
    engine.db.prepare(`INSERT INTO _jevsql_tables VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(name) DO UPDATE SET sql=excluded.sql, params_json=excluded.params_json,
      model=excluded.model, cache_namespace=excluded.cache_namespace, revision=excluded.revision, refreshed_at=excluded.refreshed_at`)
      .run(name, sql, key, JSON.stringify(params), engine.model, engine.cacheNamespace, revision, refreshedAt);
    engine.db.prepare('INSERT INTO _jevsql_runs VALUES (?, ?, ?, ?)').run(name, revision, JSON.stringify(stats), JSON.stringify(decisions));
    engine.db.exec('RELEASE _jevsql_refresh');
    return { name, key, revision, refreshedAt, rows, changes, stats, decisions };
  } catch (error) {
    engine.db.exec('ROLLBACK TO _jevsql_refresh');
    engine.db.exec('RELEASE _jevsql_refresh');
    throw error;
  }
}

export async function refresh(engine, name, options = {}) {
  const saved = metadata(engine, tableName(name));
  if (!saved) throw new Error(`No saved decision table named ${name}.`);
  if (saved.model !== engine.model || saved.cache_namespace !== engine.cacheNamespace) {
    throw new Error('Refresh requires the saved model and cache namespace. Call materialize() explicitly to change them.');
  }
  return materialize(engine, name, saved.sql, { ...options, key: saved.key_column, params: JSON.parse(saved.params_json) });
}

export function decisionTables(engine) {
  const exists = engine.db.prepare("SELECT 1 FROM sqlite_master WHERE name='_jevsql_tables'").get();
  return exists ? engine.db.prepare('SELECT name, key_column AS key, model, cache_namespace AS cacheNamespace, revision, refreshed_at AS refreshedAt FROM _jevsql_tables ORDER BY name').all() : [];
}

export function changeHistory(engine, name, { revision, limit = 100 } = {}) {
  if (!metadata(engine, tableName(name))) throw new Error(`No saved decision table named ${name}.`);
  integer(limit, 'limit');
  if (revision != null) integer(revision, 'revision');
  const rows = revision == null
    ? engine.db.prepare('SELECT * FROM _jevsql_changes WHERE table_name=? ORDER BY revision DESC, rowid LIMIT ?').all(name, limit)
    : engine.db.prepare('SELECT * FROM _jevsql_changes WHERE table_name=? AND revision=? ORDER BY rowid LIMIT ?').all(name, revision, limit);
  return rows.map((row) => ({ table: row.table_name, revision: row.revision, key: JSON.parse(row.record_key),
    type: row.change_type, before: JSON.parse(row.before_json), after: JSON.parse(row.after_json), detectedAt: row.detected_at }));
}

/** Each query returns violating rows. Failure is explicit and suitable for CI. */
export async function check(engine, rules, { dryRun = false, signal } = {}) {
  if (!Array.isArray(rules) || !rules.length) throw new TypeError('Supply a non-empty array of data checks.');
  const names = new Set();
  for (const rule of rules) {
    if (!rule || typeof rule.name !== 'string' || !rule.name.trim() || names.has(rule.name)) throw new TypeError('Data checks need distinct, non-empty names.');
    names.add(rule.name); readQuery(rule.sql); integer(rule.maxRows ?? 0, 'maxRows', 0);
  }
  const checks = [];
  for (const rule of rules) {
    const { rows, stats } = await engine.query(rule.sql, { params: rule.params ?? [], dryRun, signal });
    checks.push({ name: rule.name, passed: dryRun ? null : rows.length <= (rule.maxRows ?? 0),
      violations: dryRun ? null : rows.length, maxRows: rule.maxRows ?? 0, examples: rows.slice(0, 20), stats });
  }
  return { ok: dryRun ? null : checks.every((item) => item.passed), estimated: dryRun, checks };
}
