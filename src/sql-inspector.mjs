import { readQuery, bindAll } from './sql.mjs';
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
    roots.set(`${database.seq}:1`, { table: `${database.name}.sqlite_schema`, columns: ['type', 'name', 'tbl_name', 'rootpage', 'sql'] });
    for (const entry of db.prepare(`SELECT name,tbl_name,type,rootpage FROM ${qi(database.name)}.sqlite_schema WHERE rootpage>0`).all()) {
      const names = entry.type === 'index'
        ? db.prepare(`PRAGMA ${qi(database.name)}.index_info(${qi(entry.name)})`).all().map((column) => column.name)
        : db.prepare(`PRAGMA ${qi(database.name)}.table_info(${qi(entry.name)})`).all().map((column) => column.name);
      roots.set(`${database.seq}:${entry.rootpage}`, { table: `${database.name}.${entry.tbl_name}`, columns: names });
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
  for (const opcode of opcodes) {
    const source = cursors.get(opcode.p1);
    if (opcode.opcode === 'Column' && source?.columns[opcode.p2]) columns.add(`${source.table}.${source.columns[opcode.p2]}`);
  }
  const allowed = allowedTables == null ? null : new Set(allowedTables.map((name) => (name.includes('.') ? name : `main.${name}`).toLowerCase()));
  for (const table of tables) if (allowed && !allowed.has(table.toLowerCase())) fail('table_not_allowed', `Table ${table} is outside the permitted scope.`);
  const denied = new Set(deniedColumns.map((name) => (name.split('.').length === 2 ? `main.${name}` : name).toLowerCase()));
  for (const column of columns) if (denied.has(column.toLowerCase())) fail('column_not_allowed', `Column ${column} is outside the permitted scope.`);
  const plan = bindAll(db.prepare(`EXPLAIN QUERY PLAN ${sql}`), params).map((row) => ({ id: row.id, parent: row.parent, detail: row.detail }));
  return { valid: true, readOnly: !findings.some((item) => ['mutation', 'unapproved_function', 'virtual_source', 'unknown_source'].includes(item.code)),
    tables: [...tables], columns: [...columns], functions: [...functions], findings,
    plan, metadata: sqlMetadata(sql), fingerprint: digest(opcodes.map(({ opcode, p1, p2, p3, p4 }) => [opcode, p1, p2, p3, p4])) };
}
