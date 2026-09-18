import { createHash } from 'node:crypto';

// Version describes this snapshot format, not SQLite's mutable schema counter.
// Names are catalog identifiers, without SQL quote delimiters. SQLite compares
// ASCII names without case; other dialects preserve case unless explicitly set.
const VERSION = 1;
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const lower = (s) => s.replace(/[A-Z]/g, (c) => c.toLowerCase());
const upper = (s) => s.replace(/[a-z]/g, (c) => c.toUpperCase());
const clone = (value) => structuredClone(value);
const list = (value, label) => {
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array.`);
  return value;
};
const name = (value) => {
  if (typeof value !== 'string' || !value.length || value.includes('\0')) {
    throw new TypeError('Schema identifiers must be non-empty strings without NUL.');
  }
  return value;
};
function stable(value) {
  return JSON.stringify(value, (_, item) => item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort(compare).map((key) => [key, item[key]])) : item);
}
const digest = (value) => createHash('sha256').update(stable(value)).digest('hex');
const same = (a, b) => stable(a) === stable(b);
const sorted = (items) => [...items].sort((a, b) => compare(stable(a), stable(b)));
const keyFor = (mode) => mode === 'insensitive' ? lower : (value) => value;

// A small DDL lexer keeps quoted names, strings, operators and comments apart.
// It never executes SQL or tries to infer references from query text.
function tokens(sql) {
  if (typeof sql !== 'string') throw new TypeError('SQL metadata must be a string.');
  return (sql.match(/--[^\r\n]*|\/\*[\s\S]*?\*\/|'(?:''|[^'])*'|"(?:""|[^"])*"|`(?:``|[^`])*`|\[[^\]]*\]|(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?|[\p{L}_][\p{L}\p{N}_$]*|->>|>=|<=|<>|!=|==|\|\||->|[^\s]/gu) ?? [])
    .filter((part) => !part.startsWith('--') && !part.startsWith('/*'));
}
const sqlText = (parts) => parts.map((part) => /^[\p{L}_]/u.test(part) ? upper(part) : part).join(' ');
const sql = (text) => sqlText(tokens(text));
function unquote(part) {
  if (part?.startsWith('[')) return part.slice(1, -1);
  if (/^["'`]/.test(part ?? '')) return part.slice(1, -1).replaceAll(part[0] + part[0], part[0]);
  return part;
}
function closeParen(parts, start) {
  let depth = 0;
  for (let i = start; i < parts.length; i++) {
    if (parts[i] === '(') depth++;
    if (parts[i] === ')' && --depth === 0) return i;
  }
  throw new TypeError('Unbalanced parentheses in schema SQL.');
}
function splitParts(parts) {
  const result = [];
  let start = 0;
  for (let i = 0; i < parts.length; i++) {
    if (parts[i] === '(') i = closeParen(parts, i);
    else if (parts[i] === ',') { result.push(parts.slice(start, i)); start = i + 1; }
  }
  if (start < parts.length) result.push(parts.slice(start));
  return result;
}
function uniqueNames(items, mode, label) {
  const keys = new Set();
  for (const item of items) {
    const key = keyFor(mode)(name(item.name));
    if (keys.has(key)) throw new TypeError(`Duplicate ${label}: ${item.name}.`);
    keys.add(key);
  }
  return [...items].sort((a, b) => compare(keyFor(mode)(a.name), keyFor(mode)(b.name)));
}
function defaultValue(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string') return sql(value);
  if (typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) return value;
  throw new TypeError('Column defaults must be SQL text, a finite number, a boolean, or null.');
}
function normalizeConstraint(value) {
  if (typeof value === 'string') return { kind: 'check', columns: [], expression: sql(value) };
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Invalid constraint.');
  const result = clone(value);
  result.kind ??= 'constraint';
  result.columns = list(result.columns ?? [], 'Constraint columns').map(name);
  for (const field of ['expression', 'definition']) if (result[field] != null) result[field] = sql(result[field]);
  return result;
}
function normalizeTable(table, mode) {
  name(table?.name);
  const columns = list(table.columns, 'Table columns').map((column) => {
    name(column?.name);
    const primaryKey = Number(column.primaryKey ?? 0);
    if (!Number.isSafeInteger(primaryKey) || primaryKey < 0) throw new TypeError('Invalid primary-key position.');
    const result = {
      name: column.name, type: sql(column.type ?? ''), nullable: column.nullable !== false,
      defaultValue: defaultValue(column.defaultValue), primaryKey,
      unique: Boolean(column.unique), collation: column.collation == null ? null : name(column.collation),
      generated: column.generated == null ? null : typeof column.generated === 'string'
        ? { expression: sql(column.generated), storage: 'virtual' }
        : { expression: sql(column.generated.expression), storage: lower(column.generated.storage ?? 'virtual') },
      autoIncrement: Boolean(column.autoIncrement), hidden: column.hidden ?? 0,
      checks: sorted(list(column.checks ?? [], 'Column checks').map(sql)),
    };
    if (column.position !== undefined) {
      if (!Number.isSafeInteger(column.position) || column.position < 0) throw new TypeError('Invalid column position.');
      result.position = column.position;
    }
    return result;
  });
  const key = keyFor(mode);
  uniqueNames(columns, mode, 'column');
  if (table.primaryKey !== undefined) {
    const primaryKey = list(table.primaryKey, 'Primary key').map(name);
    if (new Set(primaryKey.map(key)).size !== primaryKey.length
        || primaryKey.some((value) => !columns.some((column) => key(column.name) === key(value)))) {
      throw new TypeError(`Invalid primary key for ${table.name}.`);
    }
    for (const column of columns) column.primaryKey = primaryKey.map(key).indexOf(key(column.name)) + 1;
  }
  const primaryKey = columns.filter((column) => column.primaryKey).sort((a, b) => a.primaryKey - b.primaryKey);
  if (new Set(primaryKey.map((column) => column.primaryKey)).size !== primaryKey.length) {
    throw new TypeError(`Duplicate primary-key positions for ${table.name}.`);
  }
  const indexes = list(table.indexes ?? [], 'Indexes').map((index) => {
    const indexColumns = list(index.columns ?? index.terms?.map((term) => term.column) ?? [], 'Index columns')
      .map((column) => column == null ? null : name(column));
    const terms = list(index.terms ?? indexColumns.map((column) => ({ column })), 'Index terms').map((term) => ({
      column: term.column == null ? null : name(term.column), descending: Boolean(term.descending),
      collation: term.collation == null ? null : name(term.collation),
      ...(term.expression == null ? {} : { expression: sql(term.expression) }),
    }));
    if (terms.length !== indexColumns.length) throw new TypeError('Index terms and columns must have equal lengths.');
    return {
      name: name(index.name), columns: indexColumns, unique: Boolean(index.unique),
      origin: index.origin ?? 'c', partial: Boolean(index.partial), terms,
      definition: index.definition == null ? null : sql(index.definition),
    };
  });
  const foreignKeys = list(table.foreignKeys ?? [], 'Foreign keys').map((fk) => {
    const local = list(fk.columns, 'Foreign-key columns').map(name);
    const target = list(fk.referenceColumns ?? local.map(() => null), 'Referenced columns')
      .map((column) => column == null ? null : name(column));
    if (!local.length || local.length !== target.length) throw new TypeError('Foreign-key column counts must match.');
    return {
      ...(fk.name == null ? {} : { name: name(fk.name) }), columns: local,
      referenceTable: name(fk.referenceTable), referenceColumns: target,
      onDelete: sql(fk.onDelete ?? 'NO ACTION'), onUpdate: sql(fk.onUpdate ?? 'NO ACTION'),
      match: sql(fk.match ?? 'NONE'), deferrable: Boolean(fk.deferrable),
      initially: upper(fk.initially ?? 'IMMEDIATE'),
    };
  });
  return {
    name: table.name, kind: table.kind ?? 'table',
    columns: uniqueNames(columns, mode, 'column'), primaryKey: primaryKey.map((column) => column.name),
    foreignKeys: sortContracts(foreignKeys, mode), indexes: uniqueNames(indexes, mode, 'index'),
    constraints: sortContracts(list(table.constraints ?? [], 'Constraints').map(normalizeConstraint), mode),
    strict: Boolean(table.strict), withoutRowid: Boolean(table.withoutRowid),
    definition: table.definition == null ? null : sql(table.definition),
  };
}
function comparable(value, mode) {
  const key = keyFor(mode);
  if (Array.isArray(value)) return value.map((item) => comparable(item, mode));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([field, entry]) => [field,
    ['name', 'column', 'table', 'referenceTable', 'collation'].includes(field) && typeof entry === 'string' ? key(entry)
      : ['columns', 'referenceColumns', 'primaryKey'].includes(field) && Array.isArray(entry)
        ? entry.map((item) => typeof item === 'string' ? key(item) : comparable(item, mode))
        : comparable(entry, mode),
  ]));
}

function sortContracts(items, mode) {
  return [...items].sort((a, b) => compare(stable(comparable(a, mode)), stable(comparable(b, mode)))
    || compare(stable(a), stable(b)));
}

/** Return a fresh canonical {version: 1, dialect, identifierCase, tables, hash}.
 * Collections are sorted; compound-key order and column positions are retained.
 * PostgreSQL catalog names are case-sensitive, including quoted identifiers.
 * MySQL and unknown dialects default to sensitive; identifierCase can override it.
 */
function normalizeView(view, mode) {
  name(view?.name);
  const columns = list(view.columns ?? [], 'View columns').map((column) => {
    name(column?.name);
    return { name: column.name, type: sql(column.type ?? ''), nullable: column.nullable !== false,
      ...(column.position === undefined ? {} : { position: column.position }) };
  });
  uniqueNames(columns, mode, 'view column');
  return { name: view.name, kind: 'view', columns: uniqueNames(columns, mode, 'view column'),
    definition: view.definition == null ? null : sql(view.definition) };
}

function normalizeTrigger(trigger, mode) {
  name(trigger?.name);
  return { name: trigger.name, table: trigger.table == null ? null : name(trigger.table),
    timing: trigger.timing == null ? null : upper(trigger.timing), event: trigger.event == null ? null : upper(trigger.event),
    definition: trigger.definition == null ? null : sql(trigger.definition) };
}

/** Return a fresh canonical snapshot. Views and triggers are part of the
 * contract a consumer depends on, so they participate in the hash and the diff.
 */
export function normalizeSchema(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') throw new TypeError('A schema snapshot is required.');
  let dialect = lower(name(snapshot.dialect ?? 'sqlite'));
  const dialectAliases = { sqlite3: 'sqlite', postgres: 'postgresql', pg: 'postgresql', mssql: 'sqlserver' };
  dialect = Object.hasOwn(dialectAliases, dialect) ? dialectAliases[dialect] : dialect;
  const identifierCase = snapshot.identifierCase ?? (dialect === 'sqlite' ? 'insensitive' : 'sensitive');
  if (!['sensitive', 'insensitive'].includes(identifierCase)) throw new TypeError('Invalid identifierCase.');
  const tables = uniqueNames(list(snapshot.tables, 'Schema tables').map((table) => normalizeTable(table, identifierCase)),
    identifierCase, 'table');
  const views = uniqueNames(list(snapshot.views ?? [], 'Schema views').map((view) => normalizeView(view, identifierCase)),
    identifierCase, 'view');
  const triggers = uniqueNames(list(snapshot.triggers ?? [], 'Schema triggers').map((trigger) => normalizeTrigger(trigger, identifierCase)),
    identifierCase, 'trigger');
  const payload = { version: VERSION, dialect, identifierCase, tables, views, triggers };
  return { ...payload, hash: digest(comparable(payload, identifierCase)) };
}

function readTableClauses(table, definition) {
  if (table.kind === 'virtual') { table.definition = definition; return; }
  const parts = tokens(definition);
  const open = parts.indexOf('(');
  if (open < 0) { table.definition = definition; return; }
  const usedForeignKeys = new Set();
  for (const segment of splitParts(parts.slice(open + 1, closeParen(parts, open)))) {
    const isConstraint = ['CONSTRAINT', 'PRIMARY', 'UNIQUE', 'CHECK', 'FOREIGN'].includes(upper(segment[0]));
    const column = isConstraint ? undefined : table.columns.find((entry) => lower(entry.name) === lower(unquote(segment[0])));
    let constraintName;
    let local = column ? [column.name] : [];
    for (let i = column ? 1 : 0; i < segment.length; i++) {
      const word = upper(segment[i]);
      if (word === 'CONSTRAINT') constraintName = unquote(segment[++i]);
      else if (word === 'FOREIGN' && upper(segment[i + 1] ?? '') === 'KEY' && segment[i + 2] === '(') {
        const end = closeParen(segment, i + 2);
        local = splitParts(segment.slice(i + 3, end)).map((part) => unquote(part[0]));
        i = end;
      } else if (word === 'CHECK' && segment[i + 1] === '(') {
        const end = closeParen(segment, i + 1);
        table.constraints.push({ kind: 'check', columns: local, expression: sqlText(segment.slice(i + 2, end)),
          ...(constraintName ? { name: constraintName } : {}) });
        constraintName = undefined;
        i = end;
      } else if (word === 'COLLATE' && column) column.collation = unquote(segment[++i]);
      else if (word === 'AUTOINCREMENT' && column) column.autoIncrement = true;
      else if (word === 'AS' && column && segment[i + 1] === '(') {
        const end = closeParen(segment, i + 1);
        column.generated = { expression: sqlText(segment.slice(i + 2, end)), storage: column.hidden === 3 ? 'stored' : 'virtual' };
        i = end;
      } else if (word === 'REFERENCES') {
        const referenceTable = unquote(segment[i + 1]);
        const tail = segment.slice(i + 2);
        const referenceColumns = tail[0] === '(' ? splitParts(tail.slice(1, closeParen(tail, 0)))
          .map((part) => unquote(part[0])) : null;
        const options = { onDelete: 'NO ACTION', onUpdate: 'NO ACTION', deferrable: false, initially: 'IMMEDIATE' };
        for (let j = 0; j < tail.length; j++) {
          if (tail[j] === '(') { j = closeParen(tail, j); continue; }
          const token = upper(tail[j]);
          if (token === 'DEFERRABLE') options.deferrable = upper(tail[j - 1] ?? '') !== 'NOT';
          if (token === 'INITIALLY') options.initially = upper(tail[j + 1]);
          if (token === 'MATCH') options.match = unquote(tail[j + 1]);
          if (token === 'ON' && ['DELETE', 'UPDATE'].includes(upper(tail[j + 1] ?? ''))) {
            const action = upper(tail[j + 2]);
            const field = upper(tail[j + 1]) === 'DELETE' ? 'onDelete' : 'onUpdate';
            options[field] = ['SET', 'NO'].includes(action) ? `${action} ${upper(tail[j + 3])}` : action;
          }
        }
        const fk = table.foreignKeys.find((entry) => !usedForeignKeys.has(entry)
          && lower(entry.referenceTable) === lower(referenceTable) && same(entry.columns.map(lower), local.map(lower))
          && entry.onDelete === options.onDelete && entry.onUpdate === options.onUpdate
          && (!referenceColumns || same(entry.referenceColumns.map((value) => value == null ? null : lower(value)), referenceColumns.map(lower))));
        if (fk) {
          usedForeignKeys.add(fk);
          Object.assign(fk, options);
          if (constraintName) fk.name = constraintName;
        }
      } else if (word === 'ON' && upper(segment[i + 1] ?? '') === 'CONFLICT') {
        table.constraints.push({ kind: 'conflict', columns: local, definition: sqlText(segment) });
      } else if (segment[i] === '(') i = closeParen(segment, i);
    }
  }
}

/** Inspect only main-schema catalog/PRAGMA metadata on a Node DatabaseSync.
 * _jevsql_ tables are omitted unless includeSystem is true. SQLite-owned and
 * virtual shadow tables are always omitted. No rows, samples or statistics are read.
 * No statements change connection settings or the caller's transaction.
 */
export function inspectSchema(db, { includeSystem = false } = {}) {
  if (!db || typeof db.prepare !== 'function') throw new TypeError('A DatabaseSync connection is required.');
  const read = (text, ...args) => db.prepare(text).all(...args);
  const schemaVersion = () => read('PRAGMA main.schema_version')[0].schema_version;
  const start = schemaVersion();
  const catalog = read("SELECT name, type, tbl_name, sql FROM main.sqlite_schema WHERE type IN ('table', 'index', 'view', 'trigger')");
  const properties = new Map(read('PRAGMA main.table_list').filter((row) => row.schema === 'main').map((row) => [row.name, row]));
  const columnCache = new Map();
  const columnsFor = (table) => {
    const key = lower(table);
    if (!columnCache.has(key)) columnCache.set(key, read("SELECT * FROM pragma_table_xinfo(?, 'main')", table));
    return columnCache.get(key);
  };
  const indexSQL = new Map(catalog.filter((row) => row.type === 'index').map((row) => [row.name, row.sql]));
  const tables = catalog.filter((row) => row.type === 'table' && !lower(row.name).startsWith('sqlite_')
    && (includeSystem || !lower(row.name).startsWith('_jevsql_')) && properties.get(row.name)?.type !== 'shadow').map((row) => {
    const property = properties.get(row.name);
    const indexList = read("SELECT * FROM pragma_index_list(?, 'main')", row.name);
    const rawColumns = columnsFor(row.name);
    const pk = rawColumns.filter((column) => column.pk);
    const rowidAlias = pk.length === 1 && upper(pk[0].type) === 'INTEGER' && !property?.wr
      && !indexList.some((index) => index.origin === 'pk');
    const table = {
      name: row.name, kind: property?.type ?? 'table', strict: Boolean(property?.strict), withoutRowid: Boolean(property?.wr),
      columns: rawColumns.map((column) => ({ name: column.name, type: column.type,
        nullable: !(column.notnull || (column.pk && (property?.strict || property?.wr || rowidAlias))),
        defaultValue: column.dflt_value, primaryKey: column.pk, position: column.cid, hidden: column.hidden,
      })),
      foreignKeys: [], indexes: [], constraints: [],
    };
    const groups = new Map();
    for (const fk of read("SELECT * FROM pragma_foreign_key_list(?, 'main')", row.name)) {
      if (!groups.has(fk.id)) groups.set(fk.id, []);
      groups.get(fk.id).push(fk);
    }
    for (const group of groups.values()) {
      group.sort((a, b) => a.seq - b.seq);
      const fk = group[0];
      const targetPK = columnsFor(fk.table).filter((column) => column.pk).sort((a, b) => a.pk - b.pk);
      table.foreignKeys.push({ columns: group.map((entry) => entry.from), referenceTable: fk.table,
        referenceColumns: group.map((entry) => entry.to ?? targetPK[entry.seq]?.name ?? null),
        onDelete: fk.on_delete, onUpdate: fk.on_update, match: fk.match });
    }
    for (const index of indexList) {
      const parts = tokens(indexSQL.get(index.name) ?? '');
      const open = parts.indexOf('(');
      const expressions = open < 0 ? [] : splitParts(parts.slice(open + 1, closeParen(parts, open)));
      const terms = read("SELECT * FROM pragma_index_xinfo(?, 'main')", index.name)
        .filter((entry) => entry.key).sort((a, b) => a.seqno - b.seqno).map((entry, i) => ({
          column: entry.name, descending: Boolean(entry.desc), collation: entry.coll,
          ...(entry.cid === -2 ? { expression: sqlText(expressions[i] ?? []) } : {}),
        }));
      table.indexes.push({ name: index.name, columns: terms.map((term) => term.column), unique: Boolean(index.unique),
        origin: index.origin, partial: Boolean(index.partial), terms,
        definition: open < 0 ? null : sqlText(parts.slice(open)),
      });
    }
    readTableClauses(table, row.sql ?? '');
    return table;
  });
  // A replaced view or a new insert-blocking trigger changes what consumers see
  // without changing any table, so both are collected as part of the contract.
  const views = catalog.filter((row) => row.type === 'view'
    && (includeSystem || !lower(row.name).startsWith('_jevsql_'))).map((row) => ({
    name: row.name,
    columns: columnsFor(row.name).map((column) => ({ name: column.name, type: column.type,
      nullable: !column.notnull, position: column.cid })),
    definition: row.sql ?? null,
  }));
  const triggers = catalog.filter((row) => row.type === 'trigger'
    && (includeSystem || !lower(row.tbl_name ?? '').startsWith('_jevsql_'))).map((row) => {
    const parts = tokens(row.sql ?? '');
    const at = parts.findIndex((part) => ['BEFORE', 'AFTER', 'INSTEAD'].includes(upper(part)));
    const event = parts.slice(at + 1).find((part) => ['INSERT', 'UPDATE', 'DELETE'].includes(upper(part)));
    return { name: row.name, table: row.tbl_name ?? null,
      timing: at < 0 ? null : upper(parts[at] === 'INSTEAD' ? 'INSTEAD OF' : parts[at]),
      event: event ? upper(event) : null, definition: row.sql ?? null };
  });
  if (start !== schemaVersion()) {
    const error = new Error('Schema changed during inspection. Inspect it again.');
    error.code = 'SCHEMA_CHANGED_DURING_INSPECTION';
    throw error;
  }
  return normalizeSchema({ dialect: 'sqlite', tables, views, triggers });
}

function defaultKind(value) {
  if (value == null) return 'missing';
  if (typeof value !== 'string') return 'constant';
  let parts = tokens(value);
  while (parts[0] === '(' && closeParen(parts, 0) === parts.length - 1) parts = parts.slice(1, -1);
  if (!parts.length || (parts.length === 1 && upper(parts[0]) === 'NULL')) return 'missing';
  const text = parts.join('');
  return /^(?:'(?:''|[^'])*'|[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:E[+-]?\d+)?|TRUE|FALSE|X'[0-9A-F]*')$/i.test(text)
    ? 'constant' : 'expression';
}
function typeChange(before, after, dialect) {
  // SQLite's declared lengths are not enforced. Changed declarations still need
  // review, even when two unrelated names happen to have the same affinity.
  if (dialect === 'sqlite') return ['review', 'The SQLite type declaration changed; review value conversion and consumers.'];
  const known = ['postgresql', 'mysql', 'sqlserver'].includes(dialect);
  const parse = (type) => /^(.*?)(?:\s*\(\s*(\d+)\s*(?:,\s*(\d+)\s*)?\))?$/.exec(type);
  const a = parse(before), b = parse(after);
  const aliases = { INT: 'INTEGER', DECIMAL: 'NUMERIC',
    ...(dialect === 'postgresql' ? { INT2: 'SMALLINT', INT4: 'INTEGER', INT8: 'BIGINT', 'CHARACTER VARYING': 'VARCHAR' } : {}) };
  const family = (base) => aliases[base.trim()] ?? base.trim();
  if (known && a && b) {
    const x = family(a[1]), y = family(b[1]);
    const widths = { SMALLINT: 16, INTEGER: 32, BIGINT: 64 };
    if (widths[x] && widths[y] && a[2] === undefined && b[2] === undefined) {
      return widths[y] < widths[x] ? ['block', 'The integer range is smaller.'] : ['safe', 'The integer range is unchanged or larger.'];
    }
    if (x === 'VARCHAR' && y === 'VARCHAR' && (a[2] || dialect === 'postgresql') && (b[2] || dialect === 'postgresql')) {
      return Number(b[2] ?? Infinity) < Number(a[2] ?? Infinity)
        ? ['block', 'The text length limit is smaller.'] : ['safe', 'The text length limit is unchanged or larger.'];
    }
    if (x === 'NUMERIC' && y === 'NUMERIC' && a[2] && b[2]) {
      const oldScale = Number(a[3] ?? 0), newScale = Number(b[3] ?? 0);
      return newScale < oldScale || Number(b[2]) - newScale < Number(a[2]) - oldScale
        ? ['block', 'The decimal range or scale is smaller.'] : ['safe', 'The decimal range and scale are unchanged or larger.'];
    }
    if (dialect === 'postgresql' && x === 'VARCHAR' && y === 'TEXT') return ['safe', 'The text length limit was removed.'];
    if (dialect === 'postgresql' && x === 'TEXT' && y === 'VARCHAR' && b[2]) return ['block', 'A text length limit was added.'];
  }
  return ['review', 'Type compatibility is not established for these declarations and this dialect.'];
}

/** Return sorted Change[] records:
 * {id, kind, dialect, identifierCase, table, column?, columns?, severity,
 *  reason, before, after}. severity is safe, review, or block. No row contents are
 * consulted: review means compatibility needs evidence, not that a change is safe.
 */
export function diffSchemas(before, after) {
  const oldSchema = normalizeSchema(before), newSchema = normalizeSchema(after);
  const mode = oldSchema.identifierCase, key = keyFor(mode);
  const changes = [];
  function add(kind, table, severity, reason, oldValue, newValue, details = {}) {
    const change = { kind, dialect: oldSchema.dialect, identifierCase: mode, table, ...details,
      severity, reason, before: oldValue ?? null, after: newValue ?? null };
    changes.push({ id: digest(change).slice(0, 24), ...change });
  }
  if (oldSchema.dialect !== newSchema.dialect || mode !== newSchema.identifierCase) {
    add('schema_dialect_changed', null, 'block', 'The dialect or identifier comparison rules changed.',
      { dialect: oldSchema.dialect, identifierCase: mode },
      { dialect: newSchema.dialect, identifierCase: newSchema.identifierCase });
    return changes;
  }
  const equal = (a, b) => same(comparable(a, mode), comparable(b, mode));
  const indexScope = (index) => index.partial || index.columns.includes(null)
    || index.terms.some((term) => term.expression != null) ? [] : index.columns;
  const constraintScope = (constraint) => constraint.expression != null || constraint.definition != null ? [] : constraint.columns ?? [];
  const oldTables = new Map(oldSchema.tables.map((table) => [key(table.name), table]));
  const newTables = new Map(newSchema.tables.map((table) => [key(table.name), table]));
  for (const [id, table] of oldTables) {
    if (!newTables.has(id)) add('table_removed', table.name, 'block', 'The table and its contract were removed.', table, null);
  }
  for (const [id, table] of newTables) {
    const old = oldTables.get(id);
    if (!old) { add('table_added', table.name, 'safe', 'A new table was added.', null, table); continue; }
    const oldColumns = new Map(old.columns.map((column) => [key(column.name), column]));
    const newColumns = new Map(table.columns.map((column) => [key(column.name), column]));
    for (const [columnId, column] of oldColumns) {
      if (!newColumns.has(columnId)) add('column_removed', table.name, 'block', 'The column was removed.', column, null, { column: column.name });
    }
    for (const [columnId, column] of newColumns) {
      const prior = oldColumns.get(columnId), details = { column: column.name };
      if (!prior) {
        let severity = 'safe', reason = 'An optional column or a column with a constant default was added.';
        const defaultType = defaultKind(column.defaultValue);
        if (!column.nullable && defaultType === 'missing' && !column.generated) {
          severity = 'block'; reason = 'A required column was added without a non-NULL default.';
        } else if (column.primaryKey || column.unique || column.generated || column.checks.length
            || defaultType === 'expression' || (defaultType === 'constant' && (table.strict || oldSchema.dialect !== 'sqlite'))) {
          severity = 'review'; reason = 'The added column has constraints, a generated value, or a default whose compatibility needs review.';
        }
        add('column_added', table.name, severity, reason, null, column, details);
        continue;
      }
      if (prior.type !== column.type) {
        const [severity, reason] = typeChange(prior.type, column.type, oldSchema.dialect);
        add('column_type_changed', table.name, severity, reason, prior.type, column.type, details);
      }
      if (prior.nullable !== column.nullable) add('column_nullable_changed', table.name, column.nullable ? 'safe' : 'block',
        column.nullable ? 'NULL values are now allowed.' : 'Existing NULL values and nullable writes would be rejected.', prior.nullable, column.nullable, details);
      for (const field of ['defaultValue', 'unique', 'collation', 'generated', 'autoIncrement', 'hidden', 'checks']) {
        if (!equal({ [field]: prior[field] }, { [field]: column[field] })) {
          add(`column_${field}_changed`, table.name, field === 'unique' && !column[field] ? 'block' : 'review',
            `The column ${field} contract changed.`, prior[field], column[field], details);
        }
      }
    }
    if (!same(old.primaryKey.map(key), table.primaryKey.map(key))) add('primary_key_changed', table.name, 'block',
      'The primary-key columns or their order changed.', old.primaryKey, table.primaryKey,
      { columns: [...new Set([...old.primaryKey, ...table.primaryKey])].sort(compare) });
    if (old.columns.every((column) => column.position !== undefined) && table.columns.every((column) => column.position !== undefined)) {
      const order = (columns, other) => columns.filter((column) => other.has(key(column.name)))
        .sort((a, b) => a.position - b.position).map((column) => key(column.name));
      const a = order(old.columns, newColumns), b = order(table.columns, oldColumns);
      if (!same(a, b)) add('column_order_changed', table.name, 'review', 'The order of existing columns changed.', a, b);
    }
    for (const field of ['strict', 'withoutRowid', 'kind', 'definition']) {
      if (!equal(old[field], table[field])) add(`table_${field}_changed`, table.name, field === 'withoutRowid' ? 'block' : 'review',
        `The table ${field} contract changed.`, old[field], table[field]);
    }
    const oldIndexes = new Map(old.indexes.map((index) => [key(index.name), index]));
    const newIndexes = new Map(table.indexes.map((index) => [key(index.name), index]));
    for (const [indexId, index] of oldIndexes) {
      const next = newIndexes.get(indexId);
      const details = { columns: indexScope(index) };
      if (!next) add('index_removed', table.name, index.unique ? 'block' : 'review',
        index.unique ? 'A uniqueness guarantee was removed.' : 'An index used by consumers or query plans was removed.', index, null, details);
      else if (!equal(index, next)) add('index_changed', table.name, index.unique && !next.unique ? 'block' : 'review',
        'The index keys, uniqueness, expressions, predicate, order, or collation changed.', index, next,
        { columns: !indexScope(index).length || !indexScope(next).length ? [] : [...new Set([...index.columns, ...next.columns])].sort(compare) });
    }
    for (const [indexId, index] of newIndexes) if (!oldIndexes.has(indexId)) {
      const review = index.unique || !indexScope(index).length;
      add('index_added', table.name, review ? 'review' : 'safe',
        review ? 'The new index needs uniqueness, expression, or predicate checks.' : 'A non-unique index was added.',
        null, index, { columns: indexScope(index) });
    }
    for (const [field, prefix] of [['foreignKeys', 'foreign_key'], ['constraints', 'constraint']]) {
      const remaining = [...table[field]];
      const removed = old[field].filter((item) => {
        const at = remaining.findIndex((entry) => equal(item, entry));
        if (at < 0) return true;
        remaining.splice(at, 1);
        return false;
      });
      for (const item of removed) {
        const at = remaining.findIndex((entry) => equal({ kind: item.kind, columns: item.columns, name: item.name },
          { kind: entry.kind, columns: entry.columns, name: entry.name }));
        const next = at < 0 ? null : remaining.splice(at, 1)[0];
        add(`${prefix}_${next ? 'changed' : 'removed'}`, table.name, field === 'foreignKeys' ? 'block' : 'review',
          field === 'foreignKeys' ? 'A relationship or its write behavior changed.' : 'A declared constraint changed.',
          item, next, { columns: constraintScope(item) });
      }
      for (const item of remaining) add(`${prefix}_added`, table.name, 'review', 'Existing values and writes must meet a new constraint.',
        null, item, { columns: constraintScope(item) });
    }
  }
  // Views and triggers are contracts too: replacing a view silently changes what
  // a report reads, and a new trigger can reject writes that used to succeed.
  for (const [field, prefix, severityFor] of [
    ['views', 'view', () => 'review'],
    ['triggers', 'trigger', (before, after) => (!after && before?.event ? 'review' : 'review')],
  ]) {
    const oldItems = new Map(oldSchema[field].map((item) => [key(item.name), item]));
    const newItems = new Map(newSchema[field].map((item) => [key(item.name), item]));
    for (const [id, item] of oldItems) {
      if (!newItems.has(id)) {
        add(`${prefix}_removed`, item.table ?? item.name, field === 'views' ? 'block' : 'review',
          field === 'views' ? 'A view its consumers read was removed.' : 'A trigger that enforced behaviour was removed.',
          item, null, { [prefix]: item.name });
      }
    }
    for (const [id, item] of newItems) {
      const old = oldItems.get(id);
      if (!old) {
        add(`${prefix}_added`, item.table ?? item.name, field === 'views' ? 'safe' : 'review',
          field === 'views' ? 'A new view was added.' : 'A new trigger can reject or rewrite writes that previously succeeded.',
          null, item, { [prefix]: item.name });
      } else if (!equal(old, item)) {
        add(`${prefix}_changed`, item.table ?? item.name, severityFor(old, item),
          field === 'views' ? 'The view definition or its output columns changed.' : 'The trigger definition changed.',
          old, item, { [prefix]: item.name });
      }
    }
  }
  return changes.sort((a, b) => compare(stable([a.table, a.column ?? '', a.kind, a.id]), stable([b.table, b.column ?? '', b.kind, b.id])));
}

/** Return cloned affected asset records sorted by id. Asset ids are case-sensitive.
 * Assets: {id, references?: [{table, column? | columns?}], tables?: [name],
 * columns?: [{table, column}], dependsOn?: [id], dependencies?: [id | {assetId}]}.
 * A reference without columns means the whole table. Cycles are supported.
 * References are explicit catalog names; SQL strings are never parsed for assets.
 */
export function affectedAssets(changes, assets) {
  list(changes, 'Changes'); list(assets, 'Assets');
  const records = new Map(), reverse = new Map(), direct = new Set();
  for (const asset of assets) {
    name(asset?.id);
    if (records.has(asset.id)) throw new TypeError(`Duplicate asset id: ${asset.id}.`);
    records.set(asset.id, asset);
  }
  function reference(value, table) {
    if (typeof value === 'string') return table ? { table: name(table), columns: [name(value)] } : { table: name(value), columns: [] };
    if (!value || typeof value !== 'object') throw new TypeError('Invalid asset reference.');
    return { table: name(value.table ?? table), columns: value.column !== undefined ? [name(value.column)]
      : list(value.columns ?? [], 'Reference columns').map(name) };
  }
  for (const asset of assets) {
    const refs = [
      ...list(asset.references ?? [], 'Asset references').map((item) => reference(item)),
      ...list(asset.tables ?? [], 'Asset tables').map((item) => reference(item)),
      ...list(asset.columns ?? [], 'Asset columns').map((item) => reference(item, asset.table)),
    ];
    if (asset.table && !asset.columns?.length) refs.push(reference(asset.table));
    for (const dependency of [...list(asset.dependsOn ?? [], 'Asset dependencies'), ...list(asset.dependencies ?? [], 'Asset dependencies')]) {
      if (dependency?.table) { refs.push(reference(dependency)); continue; }
      const id = name(typeof dependency === 'string' ? dependency : dependency?.assetId ?? dependency?.id);
      if (!reverse.has(id)) reverse.set(id, new Set());
      reverse.get(id).add(asset.id);
    }
    const impacted = changes.some((change) => {
      if (change.table == null) return true;
      const key = keyFor(change.identifierCase ?? (['postgres', 'postgresql'].includes(change.dialect) ? 'sensitive'
        : change.dialect && change.dialect !== 'sqlite' ? 'sensitive' : 'insensitive'));
      const targets = [{ table: change.table, columns: change.column ? [change.column] : change.columns ?? [] }];
      if (change.kind?.startsWith('foreign_key_')) {
        for (const fk of [change.before, change.after]) if (fk?.referenceTable) targets.push({
          table: fk.referenceTable, columns: fk.referenceColumns?.filter((column) => column != null) ?? [],
        });
      }
      return refs.some((ref) => targets.some((target) => key(ref.table) === key(target.table)
        && (!ref.columns.length || !target.columns.length || ref.columns.some((column) => target.columns.some((other) => key(column) === key(other))))));
    });
    if (impacted) direct.add(asset.id);
  }
  const queue = [...direct];
  for (let i = 0; i < queue.length; i++) for (const id of reverse.get(queue[i]) ?? []) {
    if (!direct.has(id)) { direct.add(id); queue.push(id); }
  }
  return [...direct].sort(compare).map((id) => clone(records.get(id)));
}

/** Keep selected tables and every table on any shortest undirected FK path
 * between each selected pair. Equal-length alternate paths are retained too.
 * Disconnected selections remain present. Outbound FK metadata is preserved.
 * Throws SCHEMA_BUDGET_EXCEEDED with requiredTables/requiredCount/maxTables;
 * an oversized selection is rejected early with requiredCountIsLowerBound true.
 * throws SCHEMA_TABLE_NOT_FOUND for unknown selections. Neither input is changed.
 */
export function pruneSchema(snapshot, selectedTables, { maxTables = 50 } = {}) {
  if (!Number.isSafeInteger(maxTables) || maxTables < 0) throw new TypeError('maxTables must be a non-negative integer.');
  if (!(Array.isArray(selectedTables) || selectedTables instanceof Set)) throw new TypeError('Selected tables must be an array or Set.');
  const schema = normalizeSchema(snapshot), key = keyFor(schema.identifierCase);
  const tables = new Map(schema.tables.map((table) => [key(table.name), table]));
  const selected = [...new Set([...selectedTables].map((table) => key(name(table))))].sort(compare);
  const missing = selected.filter((table) => !tables.has(table));
  if (missing.length) {
    const error = new RangeError(`Unknown selected tables: ${missing.join(', ')}.`);
    error.code = 'SCHEMA_TABLE_NOT_FOUND'; error.tables = missing;
    throw error;
  }
  function failBudget(required, isLowerBound = false) {
    const error = new RangeError(`Schema needs ${isLowerBound ? 'at least ' : ''}${required.length} tables to retain selected FK paths; maxTables is ${maxTables}.`);
    error.code = 'SCHEMA_BUDGET_EXCEEDED'; error.maxTables = maxTables; error.requiredCount = required.length;
    error.requiredTables = [...required].sort(compare).map((id) => tables.get(id).name);
    error.requiredCountIsLowerBound = isLowerBound;
    throw error;
  }
  if (selected.length > maxTables) failBudget(selected, true);
  const graph = new Map([...tables.keys()].map((table) => [table, new Set()]));
  for (const [id, table] of tables) for (const fk of table.foreignKeys) {
    const target = key(fk.referenceTable);
    if (graph.has(target)) { graph.get(id).add(target); graph.get(target).add(id); }
  }
  function distances(start) {
    const result = new Map([[start, 0]]), queue = [start];
    for (let i = 0; i < queue.length; i++) for (const next of graph.get(queue[i])) {
      if (!result.has(next)) { result.set(next, result.get(queue[i]) + 1); queue.push(next); }
    }
    return result;
  }
  const required = new Set(selected), paths = selected.map(distances);
  for (let i = 0; i < selected.length; i++) for (let j = i + 1; j < selected.length; j++) {
    const length = paths[i].get(selected[j]);
    if (length === undefined) continue;
    for (const id of tables.keys()) if (paths[i].get(id) + paths[j].get(id) === length) required.add(id);
  }
  if (required.size > maxTables) failBudget([...required]);
  // Triggers follow their table. A view body is not parsed, so a view is kept
  // only when it was selected by name; pruning never invents a dependency.
  return normalizeSchema({ ...schema,
    tables: schema.tables.filter((table) => required.has(key(table.name))),
    views: schema.views.filter((view) => selected.includes(key(view.name))),
    triggers: schema.triggers.filter((trigger) => trigger.table != null && required.has(key(trigger.table))) });
}
