import { integer } from './validation.mjs';
import { inspectSchema, normalizeSchema } from './schema.mjs';
import { inspectQuery } from './sql-inspector.mjs';
import { isCompiledQuery } from './query-compiler.mjs';

function compiledFor(query, dialect) {
  if (!isCompiledQuery(query) || query.dialect !== dialect) throw new TypeError('Adapter reads require an unchanged query from compileTemplate for this dialect.');
}

/** Uses the existing engine connection and executes the read synchronously inside
 * the same snapshot as the schema check. Caller retains ownership of the engine.
 */
export class SQLiteAdapter {
  constructor(engine) { this.engine = engine; this.dialect = 'sqlite'; }
  snapshot() { return inspectSchema(this.engine.db); }
  explain(query) {
    compiledFor(query, this.dialect);
    return inspectQuery(this.engine.db, query.sql, { params: query.values, allowedTables: query.tables });
  }
  read(query, { signal, beforeExecute } = {}) {
    compiledFor(query, this.dialect); signal?.throwIfAborted();
    this.engine.exec('SAVEPOINT _jevsql_governed_read');
    const db = this.engine.db, previous = db.prepare('PRAGMA query_only').get().query_only;
    try {
      if (this.snapshot().hash !== query.schemaHash) throw new Error('Schema changed after review. Prepare a new query.');
      const inspection = this.explain(query);
      if (inspection.findings.some((item) => item.level === 'block')) throw new Error('Compiled query did not pass database inspection.');
      db.exec('PRAGMA query_only=ON');
      beforeExecute?.();
      const started = performance.now();
      const rows = db.prepare(query.sql).all(...query.values);
      signal?.throwIfAborted();
      db.exec(`PRAGMA query_only=${previous ? 'ON' : 'OFF'}`);
      db.exec('RELEASE _jevsql_governed_read');
      return { rows, stats: { rowCount: rows.length, wallMs: Math.round(performance.now() - started), dialect: this.dialect } };
    } catch (error) {
      db.exec(`PRAGMA query_only=${previous ? 'ON' : 'OFF'}`);
      db.exec('ROLLBACK TO _jevsql_governed_read'); db.exec('RELEASE _jevsql_governed_read'); throw error;
    }
  }
}

const COLUMNS = `SELECT c.table_schema,c.table_name,c.column_name,c.data_type,c.character_maximum_length,
  c.numeric_precision,c.numeric_scale,c.is_nullable,c.column_default,c.ordinal_position,
  c.collation_name,c.is_generated,c.generation_expression,t.table_type
  FROM information_schema.columns c JOIN information_schema.tables t
  ON t.table_schema=c.table_schema AND t.table_name=c.table_name
  WHERE c.table_schema=PLACEHOLDER AND t.table_type IN ('BASE TABLE','VIEW')
  ORDER BY c.table_name,c.ordinal_position`;
const CHECKS = `SELECT t.table_schema,t.table_name,t.constraint_name,c.check_clause
  FROM information_schema.table_constraints t JOIN information_schema.check_constraints c
  ON c.constraint_schema=t.constraint_schema AND c.constraint_name=t.constraint_name
  WHERE t.table_schema=PLACEHOLDER AND t.constraint_type='CHECK'
  ORDER BY t.table_name,t.constraint_name`;
const VIEWS = `SELECT table_schema,table_name,view_definition FROM information_schema.views
  WHERE table_schema=PLACEHOLDER ORDER BY table_name`;
const PG_INDEXES = `SELECT ns.nspname AS table_schema,c.relname AS table_name,i.relname AS index_name,
  idx.indisunique AS is_unique,(idx.indpred IS NOT NULL) AS is_partial,keys.position AS ordinal_position,
  a.attname AS column_name,pg_catalog.pg_get_indexdef(idx.indexrelid,keys.position::int,true) AS term_definition
  FROM pg_catalog.pg_index idx JOIN pg_catalog.pg_class c ON c.oid=idx.indrelid
  JOIN pg_catalog.pg_class i ON i.oid=idx.indexrelid
  JOIN pg_catalog.pg_namespace ns ON ns.oid=c.relnamespace
  CROSS JOIN LATERAL unnest(idx.indkey) WITH ORDINALITY AS keys(attnum,position)
  LEFT JOIN pg_catalog.pg_attribute a ON a.attrelid=c.oid AND a.attnum=keys.attnum
  WHERE ns.nspname=$1 AND NOT idx.indisprimary ORDER BY c.relname,i.relname,keys.position`;
const MYSQL_INDEXES = `SELECT table_schema,table_name,index_name,(non_unique=0) AS is_unique,
  seq_in_index AS ordinal_position,column_name,expression AS term_definition,collation
  FROM information_schema.statistics WHERE table_schema=? AND index_name<>'PRIMARY'
  ORDER BY table_name,index_name,seq_in_index`;
const MYSQL_TRIGGERS = `SELECT trigger_schema,trigger_name,event_object_table,action_timing,event_manipulation,action_statement
  FROM information_schema.triggers WHERE trigger_schema=? ORDER BY trigger_name`;
const PG_TRIGGERS = `SELECT ns.nspname AS trigger_schema,t.tgname AS trigger_name,c.relname AS event_object_table,
  pg_catalog.pg_get_triggerdef(t.oid) AS action_statement
  FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid=t.tgrelid
  JOIN pg_catalog.pg_namespace ns ON ns.oid=c.relnamespace
  WHERE ns.nspname=$1 AND NOT t.tgisinternal ORDER BY t.tgname`;
const CONSTRAINTS = `SELECT t.table_schema,t.table_name,t.constraint_name,t.constraint_type,k.column_name,k.ordinal_position
  FROM information_schema.table_constraints t JOIN information_schema.key_column_usage k
  ON t.constraint_schema=k.constraint_schema AND t.constraint_name=k.constraint_name AND t.table_name=k.table_name
  WHERE t.table_schema=PLACEHOLDER AND t.constraint_type IN ('PRIMARY KEY','UNIQUE')
  ORDER BY t.table_name,t.constraint_name,k.ordinal_position`;
const PG_FK = `SELECT ns.nspname AS table_schema,c.relname AS table_name,con.conname AS constraint_name,
  a.attname AS column_name,nt.nspname AS referenced_table_schema,t.relname AS referenced_table_name,
  b.attname AS referenced_column_name,keys.position AS ordinal_position,
  con.confdeltype AS delete_rule,con.confupdtype AS update_rule
  FROM pg_catalog.pg_constraint con JOIN pg_catalog.pg_class c ON c.oid=con.conrelid
  JOIN pg_catalog.pg_namespace ns ON ns.oid=c.relnamespace
  JOIN pg_catalog.pg_class t ON t.oid=con.confrelid JOIN pg_catalog.pg_namespace nt ON nt.oid=t.relnamespace
  CROSS JOIN LATERAL unnest(con.conkey,con.confkey) WITH ORDINALITY AS keys(source,target,position)
  JOIN pg_catalog.pg_attribute a ON a.attrelid=c.oid AND a.attnum=keys.source
  JOIN pg_catalog.pg_attribute b ON b.attrelid=t.oid AND b.attnum=keys.target
  WHERE con.contype='f' AND ns.nspname=$1 ORDER BY c.relname,con.conname,keys.position`;
const MYSQL_FK = `SELECT k.table_schema,k.table_name,k.constraint_name,k.column_name,k.referenced_table_schema,
  k.referenced_table_name,k.referenced_column_name,k.ordinal_position,r.delete_rule,r.update_rule
  FROM information_schema.key_column_usage k JOIN information_schema.referential_constraints r
  ON r.constraint_schema=k.constraint_schema AND r.constraint_name=k.constraint_name AND r.table_name=k.table_name
  WHERE k.table_schema=? AND k.referenced_table_name IS NOT NULL ORDER BY k.table_name,k.constraint_name,k.ordinal_position`;

const ruleName = (value) => ({ a: 'NO ACTION', r: 'RESTRICT', c: 'CASCADE', n: 'SET NULL', d: 'SET DEFAULT' })[value] ?? value;
const lowerKeys = (row) => Object.fromEntries(Object.entries(row).map(([key, value]) => [key.toLowerCase(), value]));

/** A remote snapshot only describes what its server would answer. Optional
 * catalogs — check constraints before MySQL 8.0.16, expression index columns —
 * are collected when available and recorded as missing when they are not, so a
 * narrower snapshot is visible rather than silently equal to a complete one.
 */
async function remoteSnapshot(run, dialect, schemaName) {
  const marker = dialect === 'postgresql' ? '$1' : '?';
  const missing = [];
  const optional = async (label, sql, params) => {
    try { return (await run(sql, params)).map(lowerKeys); }
    catch { missing.push(label); return []; }
  };
  const columns = (await run(COLUMNS.replace('PLACEHOLDER', marker), [schemaName])).map(lowerKeys);
  const constraints = (await run(CONSTRAINTS.replace('PLACEHOLDER', marker), [schemaName])).map(lowerKeys);
  const foreign = (await run(dialect === 'postgresql' ? PG_FK : MYSQL_FK, [schemaName])).map(lowerKeys);
  const indexes = await optional('indexes', dialect === 'postgresql' ? PG_INDEXES : MYSQL_INDEXES, [schemaName]);
  const checks = await optional('checks', CHECKS.replace('PLACEHOLDER', marker), [schemaName]);
  const viewRows = await optional('views', VIEWS.replace('PLACEHOLDER', marker), [schemaName]);
  const triggerRows = await optional('triggers', dialect === 'postgresql' ? PG_TRIGGERS : MYSQL_TRIGGERS, [schemaName]);

  const tables = new Map(), views = new Map();
  for (const row of columns) {
    const name = `${row.table_schema}.${row.table_name}`;
    const isView = String(row.table_type).toUpperCase() === 'VIEW';
    let type = row.data_type;
    if (row.character_maximum_length != null) type += `(${row.character_maximum_length})`;
    else if (['numeric', 'decimal'].includes(type) && row.numeric_precision != null) type += `(${row.numeric_precision},${row.numeric_scale ?? 0})`;
    // ordinal_position is 1-based in information_schema; snapshots are 0-based.
    // Without it, a reordered catalog would hash identically to the original.
    const position = Number(row.ordinal_position);
    if (!Number.isSafeInteger(position) || position < 1) throw new TypeError('Catalog returned an invalid ordinal_position.');
    if (isView) {
      if (!views.has(name)) views.set(name, { name, columns: [], definition: null });
      views.get(name).columns.push({ name: row.column_name, type, nullable: row.is_nullable === 'YES', position: position - 1 });
      continue;
    }
    if (!tables.has(name)) tables.set(name, { name, columns: [], indexes: [], foreignKeys: [], constraints: [] });
    const pk = constraints.find((c) => c.table_name === row.table_name && c.column_name === row.column_name && c.constraint_type === 'PRIMARY KEY');
    const generated = row.generation_expression ? { expression: String(row.generation_expression),
      storage: String(row.is_generated ?? '').toUpperCase().includes('STORED') ? 'stored' : 'virtual' } : null;
    tables.get(name).columns.push({ name: row.column_name, type, nullable: row.is_nullable === 'YES',
      defaultValue: row.column_default ?? null, primaryKey: pk ? Number(pk.ordinal_position) : 0, position: position - 1,
      collation: row.collation_name ?? null, generated });
  }
  for (const row of constraints) {
    const table = tables.get(`${row.table_schema}.${row.table_name}`); if (!table) continue;
    let index = table.indexes.find((item) => item.name === row.constraint_name);
    if (!index) { index = { name: row.constraint_name, columns: [], unique: true, terms: [] }; table.indexes.push(index); }
    index.columns.push(row.column_name);
    index.terms.push({ column: row.column_name });
  }
  for (const row of indexes) {
    const table = tables.get(`${row.table_schema}.${row.table_name}`); if (!table) continue;
    if (table.indexes.some((item) => item.name === row.index_name && !item.terms.length)) continue;
    let index = table.indexes.find((item) => item.name === row.index_name);
    if (!index) {
      index = { name: row.index_name, columns: [], unique: Boolean(Number(row.is_unique)),
        partial: Boolean(Number(row.is_partial ?? 0)), terms: [] };
      table.indexes.push(index);
    }
    // An expression term has no column name in either catalog; keep it as an
    // expression so the diff can still see it change.
    const column = row.column_name ?? null;
    index.columns.push(column);
    index.terms.push({ column, descending: String(row.collation ?? '').toUpperCase() === 'D',
      ...(column === null && row.term_definition ? { expression: String(row.term_definition) } : {}) });
  }
  for (const row of checks) {
    const table = tables.get(`${row.table_schema}.${row.table_name}`); if (!table) continue;
    table.constraints.push({ kind: 'check', name: row.constraint_name, columns: [], expression: String(row.check_clause) });
  }
  for (const row of foreign) {
    const table = tables.get(`${row.table_schema}.${row.table_name}`); if (!table) continue;
    let fk = table.foreignKeys.find((item) => item.name === row.constraint_name);
    if (!fk) {
      fk = { name: row.constraint_name, columns: [], referenceTable: `${row.referenced_table_schema}.${row.referenced_table_name}`,
        referenceColumns: [], onDelete: ruleName(row.delete_rule), onUpdate: ruleName(row.update_rule) };
      table.foreignKeys.push(fk);
    }
    fk.columns.push(row.column_name); fk.referenceColumns.push(row.referenced_column_name);
  }
  for (const row of viewRows) {
    const name = `${row.table_schema}.${row.table_name}`;
    if (!views.has(name)) views.set(name, { name, columns: [], definition: null });
    views.get(name).definition = row.view_definition ?? null;
  }
  const triggers = triggerRows.map((row) => ({
    name: row.trigger_name, table: row.event_object_table == null ? null : `${schemaName}.${row.event_object_table}`,
    timing: row.action_timing ?? null, event: row.event_manipulation ?? null, definition: row.action_statement ?? null,
  }));
  const snapshot = normalizeSchema({ dialect, tables: [...tables.values()], views: [...views.values()], triggers });
  return missing.length ? { ...snapshot, unavailableCatalogs: missing } : snapshot;
}

/** A driver lease must be exclusive and idle. Use a database account restricted
 * to the intended schema. Jev never receives the lease or connection settings.
 */
class RemoteAdapter {
  constructor({ acquire, schemaName, statementTimeoutMs = 2000 }, dialect) {
    if (typeof acquire !== 'function') throw new TypeError('Supply acquire() returning an exclusive driver connection.');
    if (typeof schemaName !== 'string' || !schemaName.trim()) throw new TypeError('schemaName is required.');
    this.acquire = acquire; this.schemaName = schemaName; this.dialect = dialect;
    this.statementTimeoutMs = integer(statementTimeoutMs, 'statementTimeoutMs', 1, 60000);
  }

  async transaction(work, signal) {
    signal?.throwIfAborted();
    const connection = await this.acquire();
    let began = false, broken = false;
    const run = async (sql, params = []) => {
      signal?.throwIfAborted();
      if (this.dialect === 'postgresql') return (await connection.query(sql, params)).rows ?? [];
      const [rows] = await connection.execute(sql, params); return Array.isArray(rows) ? rows : [];
    };
    try {
      if (this.dialect === 'postgresql') {
        await run('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY'); began = true;
        await run("SELECT set_config('statement_timeout',$1,true)", [String(this.statementTimeoutMs)]);
        await run("SELECT set_config('lock_timeout',$1,true)", [String(this.statementTimeoutMs)]);
      } else {
        await run('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
        await run('SET SESSION MAX_EXECUTION_TIME=?', [this.statementTimeoutMs]);
        await run('SET SESSION lock_wait_timeout=?', [Math.max(1, Math.ceil(this.statementTimeoutMs / 1000))]);
        await run('SET SESSION innodb_lock_wait_timeout=?', [Math.max(1, Math.ceil(this.statementTimeoutMs / 1000))]);
        await run('START TRANSACTION READ ONLY'); began = true;
      }
      const result = await work(run); signal?.throwIfAborted();
      await run('COMMIT'); began = false; return result;
    } catch (error) {
      if (began) {
        try {
          // Rollback must run even after the caller cancelled.
          if (this.dialect === 'postgresql') await connection.query('ROLLBACK');
          else await connection.execute('ROLLBACK');
        } catch { broken = true; }
      }
      throw error;
    } finally {
      if (broken && typeof connection.destroy === 'function') connection.destroy();
      else if (typeof connection.release === 'function') connection.release(broken ? new Error('Rollback failed') : undefined);
    }
  }

  snapshot({ signal } = {}) { return this.transaction((run) => remoteSnapshot(run, this.dialect, this.schemaName), signal); }

  async explain(query, { signal } = {}) {
    compiledFor(query, this.dialect);
    return this.transaction(async (run) => {
      if ((await remoteSnapshot(run, this.dialect, this.schemaName)).hash !== query.schemaHash) throw new Error('Schema changed after compilation.');
      const prefix = this.dialect === 'postgresql' ? 'EXPLAIN (FORMAT JSON) ' : 'EXPLAIN FORMAT=JSON ';
      const rows = await run(prefix + query.sql, query.values);
      const value = rows[0]?.['QUERY PLAN'] ?? rows[0]?.EXPLAIN;
      if (value === undefined) throw new Error('Driver did not return a JSON execution plan.');
      return typeof value === 'string' ? JSON.parse(value) : value;
    }, signal);
  }

  async read(query, { signal, beforeExecute } = {}) {
    compiledFor(query, this.dialect);
    return this.transaction(async (run) => {
      if ((await remoteSnapshot(run, this.dialect, this.schemaName)).hash !== query.schemaHash) throw new Error('Schema changed after review. Prepare a new query.');
      const sql = this.dialect === 'mysql' ? query.sql.replace(/^SELECT /, `SELECT /*+ MAX_EXECUTION_TIME(${this.statementTimeoutMs}) */ `) : query.sql;
      const started = performance.now();
      beforeExecute?.();
      const rows = await run(sql, query.values);
      if (rows.length > query.maxRows) throw new Error('Driver returned more rows than the compiled limit.');
      return { rows, stats: { rowCount: rows.length, wallMs: Math.round(performance.now() - started), dialect: this.dialect } };
    }, signal);
  }
}

export class PostgreSQLAdapter extends RemoteAdapter {
  constructor(options) { super({ schemaName: 'public', ...options }, 'postgresql'); }
}
export class MySQLAdapter extends RemoteAdapter {
  constructor(options) { super(options, 'mysql'); }
}
