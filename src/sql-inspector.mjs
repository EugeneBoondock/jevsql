import { readQuery, bindAll, maskSql, topLevelWords } from './sql.mjs';
import { quoteIdentifier as qi } from './validation.mjs';
import { redactText, digest } from './privacy.mjs';

const PURE_FUNCTIONS = new Set(('abs avg char coalesce concat concat_ws count date datetime format glob hex if ifnull iif instr json json_array json_array_length json_extract json_object json_quote json_type json_valid julianday length like likelihood likely lower ltrim max min nullif printf quote replace round rtrim sign strftime substr substring sum time total trim typeof unicode unixepoch unlikely upper').split(' '));
const WRITE_OPS = new Set(['OpenWrite', 'CreateBtree', 'Destroy', 'Clear', 'DropTable', 'DropIndex', 'DropTrigger', 'Vacuum', 'SetCookie', 'JournalMode', 'Checkpoint', 'VUpdate', 'VCreate', 'VDestroy', 'ParseSchema']);

/** Remove values and comments from SQL sent to a reviewer. This is a lexer only;
 * execution approval uses the database compiler or the governed query compiler.
 */
export function sqlMetadata(sql, { dialect = 'sqlite' } = {}) {
  if (typeof sql !== 'string' || !sql.trim()) throw new TypeError('SQL is required.');
  if (!['sqlite', 'postgresql', 'mysql'].includes(dialect)) throw new TypeError('Unknown SQL dialect.');
  let out = '', i = 0, comments = 0, literals = 0;
  while (i < sql.length) {
    if (sql.startsWith('--', i) || (dialect === 'mysql' && sql[i] === '#')) {
      comments++; while (i < sql.length && sql[i] !== '\n') i++; out += '\n'; continue;
    }
    if (sql.startsWith('/*', i)) {
      comments++; let depth = 1; i += 2;
      while (i < sql.length && depth) {
        if (dialect === 'postgresql' && sql.startsWith('/*', i)) { depth++; i += 2; }
        else if (sql.startsWith('*/', i)) { depth--; i += 2; }
        else i++;
      }
      if (depth) throw new SyntaxError('Unclosed SQL comment.');
      out += ' '; continue;
    }
    if (dialect === 'postgresql' && sql[i] === '$') {
      const marker = sql.slice(i).match(/^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/)?.[0];
      if (marker) {
        const end = sql.indexOf(marker, i + marker.length);
        if (end < 0) throw new SyntaxError('Unclosed SQL string.');
        i = end + marker.length; out += "'[value]'"; literals++; continue;
      }
    }
    const quote = sql[i];
    if (["'", '"', '`', '['].includes(quote)) {
      const isValue = quote === "'" || (dialect === 'mysql' && quote === '"');
      const endQuote = quote === '[' ? ']' : quote;
      const start = i++; let closed = false;
      while (i < sql.length) {
        if (sql[i] === '\\' && (dialect === 'mysql' || (dialect === 'postgresql' && /[Ee]/.test(sql[start - 1] ?? '')))) { i += 2; continue; }
        if (sql[i++] === endQuote) {
          if (endQuote !== ']' && sql[i] === endQuote) { i++; continue; }
          closed = true; break;
        }
      }
      if (!closed) throw new SyntaxError('Unclosed SQL quoted value.');
      out += isValue ? "'[value]'" : sql.slice(start, i);
      if (isValue) literals++;
      continue;
    }
    if (/\d/.test(sql[i]) && (i === 0 || !/[\w$:?]/.test(sql[i - 1]))) {
      const number = sql.slice(i).match(/^(?:0x[\da-f]+|\d+(?:\.\d*)?(?:e[+-]?\d+)?)/i)[0];
      out += '0'; i += number.length; literals++; continue;
    }
    out += sql[i++];
  }
  return { sql: redactText(out), commentsRemoved: comments, literalsRemoved: literals, dialect };
}

const DATA_WRITES = ['INSERT', 'UPDATE', 'DELETE', 'MERGE', 'REPLACE', 'TRUNCATE', 'UPSERT'];
const SCHEMA_WRITES = ['CREATE', 'DROP', 'ALTER', 'RENAME', 'COMMENT'];
const PERMISSION_WRITES = ['GRANT', 'REVOKE'];
const MAINTENANCE = ['VACUUM', 'ANALYZE', 'REINDEX', 'CHECKPOINT', 'CLUSTER', 'OPTIMIZE', 'REPAIR'];
const CLASS_BY_HEAD = {
  SELECT: 'read', WITH: 'read', VALUES: 'read', TABLE: 'read', EXPLAIN: 'read', SHOW: 'read', DESCRIBE: 'read',
  INSERT: 'insert', REPLACE: 'insert', UPSERT: 'insert', MERGE: 'update', UPDATE: 'update',
  DELETE: 'delete', TRUNCATE: 'delete',
  CREATE: 'schema', DROP: 'schema', ALTER: 'schema', RENAME: 'schema', COMMENT: 'schema',
  GRANT: 'permission', REVOKE: 'permission',
  VACUUM: 'maintenance', ANALYZE: 'maintenance', REINDEX: 'maintenance', CHECKPOINT: 'maintenance',
  CLUSTER: 'maintenance', OPTIMIZE: 'maintenance', REPAIR: 'maintenance',
};

/**
 * Classify a proposed statement from its text alone, without a database and
 * without executing anything. This is the deterministic half of the guardrail:
 * it decides the operation class and whether the statement is destructive or
 * unbounded, so that a model answer is never what permits a write.
 *
 * Quoted identifiers and comments are masked before keywords are read, so a
 * column named "drop" is not a DROP. A data-changing keyword anywhere, including
 * inside a writable CTE, still counts. Classification is deliberately
 * pessimistic: anything it cannot resolve is unknown, which never auto-runs.
 *
 * @returns {{operation: string, statementCount: number, changesData: boolean,
 *   changesSchema: boolean, changesPermissions: boolean, destructive: boolean,
 *   unbounded: boolean, filtered: boolean, limited: boolean, reasons: string[],
 *   sql: string, dialect: string}}
 */
export function classifyStatement(input, { dialect = 'sqlite' } = {}) {
  let metadata;
  try {
    metadata = sqlMetadata(input, { dialect });
  } catch (error) {
    /*
     * The contract above says anything this cannot resolve is unknown, which
     * never auto-runs. It threw instead: a SyntaxError from sqlMetadata or
     * maskSql travelled straight out through reviewStatement, so an unclosed
     * quote — routine in text a model wrote — crashed the review rather than
     * being refused by it.
     *
     * Unknown AND unsafe. A statement nobody could parse is not evidence of a
     * harmless one.
     */
    if (!(error instanceof SyntaxError)) throw error;
    return { operation: 'unknown', statementCount: 1, changesData: false, changesSchema: false,
      changesPermissions: false, destructive: true, unbounded: true, filtered: false, limited: false,
      reasons: [`could not be parsed: ${error.message.replace(/\.$/, '').toLowerCase()}`],
      sql: null, dialect };
  }
  /*
   * Read the words from the DIALECT-AWARE mask, not from maskSql.
   *
   * maskSql knows nothing about PostgreSQL dollar-quoting or MySQL backslash
   * escapes, so `SELECT $$ drop table users $$::text` put DROP and TABLE into
   * the keyword bag and a plain read came back as operation: schema,
   * destructive: true. sqlMetadata already handles both, and its output is
   * what the reviewer is shown, so the classification should agree with it.
   */
  const masked = metadata.sql;
  const words = [...masked.matchAll(/[A-Za-z_][A-Za-z0-9_]*/g)].map((match) => match[0].toUpperCase());
  const has = (word) => words.includes(word);
  const outer = topLevelWords(masked);
  const head = outer[0]?.word ?? words[0] ?? null;
  const statementCount = [...masked.matchAll(/;/g)].filter((match) => masked.slice(match.index + 1).trim()).length + 1;
  const changesData = DATA_WRITES.some(has);
  const changesSchema = SCHEMA_WRITES.some(has);
  const changesPermissions = PERMISSION_WRITES.some(has);
  /*
   * A WHERE only narrows the statement it belongs to.
   *
   * These were a flat search of every word in the statement, so a qualifier
   * anywhere counted as a qualifier everywhere. A writable CTE puts a whole
   * separate statement inside parentheses, and
   *
   *   WITH recent AS (SELECT id FROM orders WHERE created_at > '2020-01-01')
   *   DELETE FROM audit_log
   *
   * emptied the audit log while reporting destructive: false, unbounded: false
   * and no reasons at all, because the SELECT's WHERE answered for the DELETE.
   * `requiredApproval` then dropped from out_of_band_human to human. The same
   * held for LIMIT inside a CTE in front of an unbounded UPDATE.
   *
   * A CTE body is parenthesised, so depth is what separates the two: only a
   * qualifier at depth 0, positioned after the write keyword it is supposed to
   * narrow, is that write's own.
   */
  const outerAt = (word) => outer.filter((entry) => entry.word === word).map((entry) => entry.start);
  const writeStart = Math.min(...['DELETE', 'UPDATE', 'INSERT', 'REPLACE', 'UPSERT', 'MERGE', 'TRUNCATE']
    .flatMap(outerAt).concat(Number.POSITIVE_INFINITY));
  const qualifies = (word) => outerAt(word).some((start) => start > writeStart);
  const filtered = qualifies('WHERE');
  const limited = ['LIMIT', 'FETCH', 'TOP'].some(qualifies);
  const reasons = [];
  if (has('DROP')) reasons.push('drops a schema object');
  if (has('TRUNCATE')) reasons.push('truncates a table');
  if (has('DELETE') && !filtered) reasons.push('deletes without a WHERE clause');
  if (has('UPDATE') && !filtered) reasons.push('updates without a WHERE clause');
  if (has('REVOKE')) reasons.push('removes a granted permission');
  if (has('DETACH') || has('DEALLOCATE')) reasons.push('detaches a database object');
  // The leading keyword is the weakest evidence: a writable CTE starts with WITH
  // and still deletes. Classify by the strongest operation present anywhere.
  const operation = changesPermissions ? 'permission'
    : changesSchema ? 'schema'
      : has('DELETE') || has('TRUNCATE') ? 'delete'
        : has('UPDATE') || has('MERGE') ? 'update'
          : has('INSERT') || has('REPLACE') || has('UPSERT') ? 'insert'
            : CLASS_BY_HEAD[head] ?? (MAINTENANCE.some(has) ? 'maintenance' : 'unknown');
  return { operation, statementCount, changesData, changesSchema, changesPermissions,
    destructive: reasons.length > 0, unbounded: (changesData || changesSchema) && !filtered && !limited,
    filtered, limited, reasons, sql: metadata.sql, dialect };
}

/** SQLite compiles EXPLAIN without running the candidate statement. Its bytecode
 * exposes reads through subqueries, views, and CTEs, and catches writable CTEs.
 * This deliberately refuses virtual sources and unapproved functions.
 */
export function inspectQuery(db, input, { params = [], allowedTables, deniedColumns = [], allowedFunctions = [] } = {}) {
  const findings = [];
  const fail = (code, detail) => findings.push({ level: 'block', code, detail });
  let sql, opcodes;
  try {
    sql = readQuery(input);
    opcodes = bindAll(db.prepare(`EXPLAIN ${sql}`), params);
  } catch {
    return { valid: false, readOnly: false, tables: [], columns: [], functions: [], findings: [{ level: 'block', code: 'invalid_read_query', detail: 'Database compilation refused this single read statement.' }] };
  }
  const roots = new Map(), cursors = new Map(), tables = new Set(), columns = new Set(), functions = new Set();
  for (const database of db.prepare('PRAGMA database_list').all()) {
    const properties = new Map(db.prepare(`PRAGMA ${qi(database.name)}.table_list`).all()
      .filter((row) => row.schema === database.name).map((row) => [row.name, row]));
    // A rowid table reads its INTEGER PRIMARY KEY through Rowid, never Column.
    const rowidAlias = (table) => {
      if (properties.get(table)?.wr) return null;
      const key = db.prepare(`PRAGMA ${qi(database.name)}.table_info(${qi(table)})`).all().filter((column) => column.pk);
      return key.length === 1 && key[0].type.toUpperCase() === 'INTEGER' ? key[0].name : null;
    };
    roots.set(`${database.seq}:1`, { table: `${database.name}.sqlite_schema`,
      columns: ['type', 'name', 'tbl_name', 'rootpage', 'sql'], rowidColumn: null });
    for (const entry of db.prepare(`SELECT name,tbl_name,type,rootpage FROM ${qi(database.name)}.sqlite_schema WHERE rootpage>0`).all()) {
      let names;
      if (entry.type === 'index') {
        // index_xinfo is the physical record order, including trailing key columns.
        // An expression term has no column name and stays deliberately unresolved.
        names = db.prepare(`PRAGMA ${qi(database.name)}.index_xinfo(${qi(entry.name)})`).all()
          .sort((a, b) => a.seqno - b.seqno).map((column) => column.name ?? null);
      } else {
        const info = db.prepare(`PRAGMA ${qi(database.name)}.table_info(${qi(entry.name)})`).all();
        const key = info.filter((column) => column.pk).sort((a, b) => a.pk - b.pk);
        // A WITHOUT ROWID row is stored key-first, so declared order is not the
        // physical order and reading table_info positions names the wrong column.
        names = properties.get(entry.name)?.wr
          ? [...key.map((column) => column.name), ...info.filter((column) => !column.pk).map((column) => column.name)]
          : info.map((column) => column.name);
      }
      roots.set(`${database.seq}:${entry.rootpage}`, { table: `${database.name}.${entry.tbl_name}`,
        columns: names, rowidColumn: rowidAlias(entry.tbl_name) });
    }
  }
  for (const opcode of opcodes) {
    if (WRITE_OPS.has(opcode.opcode) || (opcode.opcode === 'Transaction' && opcode.p2 !== 0)) fail('mutation', 'Statement contains a database write operation.');
    if (opcode.opcode === 'VOpen') fail('virtual_source', 'Virtual table reads require a separately approved adapter.');
    if (opcode.opcode === 'OpenRead') {
      const source = roots.get(`${opcode.p3}:${opcode.p2}`);
      if (!source) fail('unknown_source', 'A database read could not be assigned to a schema object.');
      else { cursors.set(opcode.p1, source); tables.add(source.table); }
    }
    if (['Function', 'PureFunc', 'AggStep', 'AggStep1'].includes(opcode.opcode)) {
      const name = String(opcode.p4).replace(/\(.*/, '').toLowerCase(); functions.add(name);
      if (!PURE_FUNCTIONS.has(name) && !allowedFunctions.includes(name)) fail('unapproved_function', `Function ${name} is outside the approved set.`);
    }
  }
  let unresolvedReads = 0;
  for (const opcode of opcodes) {
    const source = cursors.get(opcode.p1);
    if (!source) continue;
    if (opcode.opcode === 'Column') {
      const name = source.columns[opcode.p2];
      if (name) columns.add(`${source.table}.${name}`);
      else unresolvedReads++;
    }
    // The rowid is a readable value: an INTEGER PRIMARY KEY alias when one is
    // declared, otherwise the implicit rowid, which a policy can also deny.
    if (['Rowid', 'IdxRowid'].includes(opcode.opcode)) columns.add(`${source.table}.${source.rowidColumn ?? 'rowid'}`);
  }
  const allowed = allowedTables == null ? null : new Set(allowedTables.map((name) => (name.includes('.') ? name : `main.${name}`).toLowerCase()));
  for (const table of tables) if (allowed && !allowed.has(table.toLowerCase())) fail('table_not_allowed', `Table ${table} is outside the permitted scope.`);
  const denied = new Set(deniedColumns.map((name) => (name.split('.').length === 2 ? `main.${name}` : name).toLowerCase()));
  for (const column of columns) if (denied.has(column.toLowerCase())) fail('column_not_allowed', `Column ${column} is outside the permitted scope.`);
  // A column rule can only be enforced over reads this inspection could name.
  if (denied.size && unresolvedReads) {
    fail('unresolved_column_read', `${unresolvedReads} read(s) could not be resolved to a named column while a column policy applies.`);
  }
  const plan = bindAll(db.prepare(`EXPLAIN QUERY PLAN ${sql}`), params).map((row) => ({ id: row.id, parent: row.parent, detail: row.detail }));
  return { valid: true, readOnly: !findings.some((item) => ['mutation', 'unapproved_function', 'virtual_source', 'unknown_source'].includes(item.code)),
    tables: [...tables], columns: [...columns], functions: [...functions], findings,
    plan, metadata: sqlMetadata(sql), fingerprint: digest(opcodes.map(({ opcode, p1, p2, p3, p4 }) => [opcode, p1, p2, p3, p4])) };
}
