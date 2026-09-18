import { integer } from './validation.mjs';
import { digest, jsonData } from './privacy.mjs';

const OPERATORS = { eq: '=', ne: '<>', lt: '<', lte: '<=', gt: '>', gte: '>=', like: 'LIKE' };
const AGGREGATES = new Set(['sum', 'avg', 'count', 'min', 'max']);
const DIALECTS = new Set(['sqlite', 'postgresql', 'mysql']);
const COMPILED = new WeakSet();
export const isCompiledQuery = (value) => COMPILED.has(value);
function keys(value, allowed, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${name} must be an object.`);
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new TypeError(`Unsupported ${name} field: ${key}.`);
}
function named(value, name) {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0')) throw new TypeError(`${name} must be a name.`);
  return value;
}
export function quoteName(value, dialect = 'sqlite') {
  named(value, 'identifier');
  return dialect === 'mysql' ? `\`${value.replaceAll('`', '``')}\`` : `"${value.replaceAll('"', '""')}"`;
}

export function actorIdentity(input) {
  const actor = jsonData(input);
  named(actor.id, 'actor.id');
  if (!Array.isArray(actor.roles) || !actor.roles.length || actor.roles.some((role) => typeof role !== 'string' || !role)) throw new TypeError('An authenticated actor needs roles.');
  if (actor.tenantId != null && !['string', 'number'].includes(typeof actor.tenantId)) throw new TypeError('tenantId must be a scalar identifier.');
  return { id: actor.id, roles: [...new Set(actor.roles)].sort(), tenantId: actor.tenantId ?? null };
}

export function parameterValue(value, spec, name) {
  keys(spec, ['type', 'nullable', 'enum', 'maxLength', 'min', 'max', 'items', 'maxItems', 'default'], 'parameter');
  const types = ['string', 'integer', 'number', 'boolean', 'date', 'timestamp', 'array'];
  if (!types.includes(spec.type)) throw new TypeError(`Unknown parameter type for ${name}.`);
  if (value === null && spec.nullable === true) return null;
  if (spec.type === 'array') {
    if (!Array.isArray(value) || !value.length || value.length > integer(spec.maxItems ?? 100, 'maxItems', 1, 1000) || !spec.items) throw new TypeError(`${name} needs a bounded, non-empty array.`);
    return value.map((item) => parameterValue(item, spec.items, name));
  }
  if (['string', 'date', 'timestamp'].includes(spec.type)) {
    if (typeof value !== 'string' || value.length > integer(spec.maxLength ?? 4096, 'maxLength', 1, 100000)) throw new TypeError(`${name} needs a bounded string.`);
    if (spec.type === 'date' && (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value)) throw new TypeError(`${name} must be a real ISO date.`);
    if (spec.type === 'timestamp' && (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)
      || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 19) !== value.slice(0, 19))) throw new TypeError(`${name} must be a UTC ISO timestamp.`);
  } else if (spec.type === 'boolean') {
    if (typeof value !== 'boolean') throw new TypeError(`${name} must be boolean.`);
  } else {
    if (typeof value !== 'number' || !Number.isFinite(value) || (spec.type === 'integer' && !Number.isSafeInteger(value))) throw new TypeError(`${name} must be a finite ${spec.type}.`);
    if (spec.min !== undefined && (typeof spec.min !== 'number' || !Number.isFinite(spec.min) || value < spec.min)) throw new RangeError(`${name} is below its minimum.`);
    if (spec.max !== undefined && (typeof spec.max !== 'number' || !Number.isFinite(spec.max) || value > spec.max)) throw new RangeError(`${name} exceeds its maximum.`);
  }
  if (spec.enum !== undefined && (!Array.isArray(spec.enum) || !spec.enum.includes(value))) throw new TypeError(`${name} is outside its allowed values.`);
  return value;
}

/** Compile a small relational query grammar into bound SQL. No SQL fragments,
 * dynamic expressions, arbitrary functions, or model-generated values are accepted.
 * The server supplies actor and tenantColumns independently from the request text.
 */
export function compileTemplate(input, schema, { params = {}, actor, tenantColumns = {}, maxRows = 500 } = {}) {
  const template = jsonData(input), identity = actorIdentity(actor);
  named(template.id, 'template.id'); named(template.version, 'template.version');
  named(template.description, 'template.description');
  if (!Array.isArray(template.roles) || !template.roles.length || !template.roles.some((role) => identity.roles.includes(role))) throw new Error('Actor is not allowed to use this query template.');
  const dialect = schema.dialect ?? 'sqlite';
  if (!DIALECTS.has(dialect)) throw new TypeError('Unsupported database dialect.');
  integer(maxRows, 'maxRows', 1, 100000);
  const query = template.query;
  keys(query, ['from', 'select', 'joins', 'filters', 'groupBy', 'orderBy', 'limit'], 'query');
  const declarations = template.params ?? {};
  if (!params || typeof params !== 'object' || Array.isArray(params)) throw new TypeError('params must be an object.');
  for (const key of Object.keys(params)) if (!Object.hasOwn(declarations, key)) throw new TypeError(`Unknown parameter ${key}.`);
  const validated = {};
  for (const [key, spec] of Object.entries(declarations)) {
    named(key, 'parameter name');
    const value = Object.hasOwn(params, key) ? params[key] : spec.default;
    if (value === undefined) throw new TypeError(`Missing parameter ${key}.`);
    Object.defineProperty(validated, key, { enumerable: true, value: parameterValue(value, spec, key) });
  }
  if (!Array.isArray(schema.tables)) throw new TypeError('A schema snapshot with tables is required.');
  const available = new Map(schema.tables.map((table) => [table.name, table]));
  const used = new Map(), values = [], consumed = new Set(), tenantScopedTables = new Set(), sharedTables = new Set();
  const caseless = schema.identifierCase ? schema.identifierCase === 'insensitive' : dialect === 'sqlite';
  const key = (value) => caseless ? String(value).toLowerCase() : String(value);
  for (const [table, column] of Object.entries(tenantColumns)) {
    if (column !== null && (typeof column !== 'string' || !column.trim())) {
      throw new TypeError(`tenantColumns.${table} must be a column name, or null to declare the table shared.`);
    }
  }
  const quote = (name) => quoteName(name, dialect);
  const relation = (name) => dialect === 'sqlite' ? quote(name) : name.split('.').map(quote).join('.');
  const bind = (value) => {
    if (value === undefined || Array.isArray(value) || (value !== null && typeof value === 'object')) throw new TypeError('A bound value must be scalar.');
    values.push(typeof value === 'boolean' && dialect !== 'postgresql' ? Number(value) : value);
    return dialect === 'postgresql' ? `$${values.length}` : '?';
  };
  const addTable = (name) => {
    named(name, 'table');
    const table = available.get(name);
    if (!table || !Array.isArray(table.columns)) throw new Error(`Unknown table ${name}.`);
    if (used.has(name)) throw new Error('Repeated table references require a separate approved template.');
    used.set(name, { ...table, alias: `t${used.size}` });
    return used.get(name);
  };
  const resolve = (ref) => {
    let name, column;
    if (ref && typeof ref === 'object' && !Array.isArray(ref)) {
      keys(ref, ['table', 'column'], 'column reference'); name = ref.table; column = ref.column;
    } else if (typeof ref === 'string') {
      const qualified = [...used.keys()].sort((a, b) => b.length - a.length).find((table) => ref.startsWith(`${table}.`));
      if (qualified) { name = qualified; column = ref.slice(qualified.length + 1); }
      else {
        const matches = [...used.values()].filter((table) => table.columns.some((c) => c.name === ref));
        if (matches.length !== 1) throw new Error(`Column ${ref} must identify exactly one source.`);
        name = matches[0].name; column = ref;
      }
    } else throw new TypeError('A column reference is required.');
    const table = used.get(name);
    if (!table?.columns.some((item) => item.name === column)) throw new Error(`Unknown column ${name}.${column}.`);
    return { table, column, key: `${name}.${column}`, sql: `${quote(table.alias)}.${quote(column)}` };
  };
  // Every table a tenant-scoped actor touches must be classified, because an
  // unrecognised tenant column silently produces a query with no tenant
  // predicate while the review evidence still describes an enforced scope.
  // A classification is a column name, or an explicit null meaning shared.
  const classify = (table) => {
    const mapped = Object.keys(tenantColumns).find((name) => key(name) === key(table.name));
    if (mapped !== undefined) return tenantColumns[mapped];
    if (table.tenantColumn !== undefined) return table.tenantColumn;
    const column = table.columns.find((entry) => key(entry.name) === 'tenant_id');
    return column ? column.name : undefined;
  };
  const tenantPredicate = (table) => {
    const column = classify(table);
    if (column === undefined) {
      if (identity.tenantId == null) return null;
      throw new Error(`Table ${table.name} has no tenant classification. Map it to its tenant column, or to null to declare it shared.`);
    }
    if (column === null) { sharedTables.add(table.name); return null; }
    if (identity.tenantId == null || identity.tenantId === '') throw new Error('This template needs an authenticated tenant scope.');
    tenantScopedTables.add(table.name);
    return `${resolve({ table: table.name, column }).sql} = ${bind(identity.tenantId)}`;
  };
  const base = addTable(query.from);
  const joinSql = [], multiplicative = [];
  if (query.joins !== undefined && !Array.isArray(query.joins)) throw new TypeError('joins must be an array.');
  for (const join of query.joins ?? []) {
    keys(join, ['table', 'on', 'type'], 'join');
    const previous = new Set(used.keys()), next = addTable(join.table);
    const pairs = Array.isArray(join.on?.[0]) ? join.on : [join.on];
    if (!pairs.length || pairs.some((pair) => !Array.isArray(pair) || pair.length !== 2)) throw new TypeError('Joins need pairs of columns.');
    const resolved = pairs.map(([left, right]) => [resolve(left), resolve(right)]);
    if (resolved.some(([left, right]) => !previous.has(left.table.name) || right.table.name !== next.name)
      || new Set(resolved.map(([left]) => left.table.name)).size !== 1) throw new Error('A join must link an earlier table to the new table.');
    const leftTable = resolved[0][0].table;
    const leftCols = resolved.map(([left]) => left.column), rightCols = resolved.map(([, right]) => right.column);
    const same = (a, b) => Array.isArray(a) && a.length === b.length && a.every((v, i) => v === b[i]);
    const declared = (leftTable.foreignKeys ?? []).some((fk) => fk.referenceTable === next.name && same(fk.columns, leftCols) && same(fk.referenceColumns, rightCols))
      || (next.foreignKeys ?? []).some((fk) => fk.referenceTable === leftTable.name && same(fk.columns, rightCols) && same(fk.referenceColumns, leftCols));
    if (!declared) throw new Error('Joins must follow a declared foreign-key relationship.');
    const primary = next.columns.filter((column) => column.primaryKey).sort((a, b) => Number(a.primaryKey) - Number(b.primaryKey)).map((column) => column.name);
    // A uniqueness guarantee only holds under the collation that enforces it.
    // SQLite compares with the left operand's collation, falling back to the
    // right's, so a NOCASE key joined to a BINARY UNIQUE column can still match
    // several rows and multiply an aggregate. Prove the collations agree or
    // treat the join as multiplicative.
    const collationOf = (value) => (value ?? 'BINARY').toUpperCase();
    const columnOf = (table, column) => table.columns.find((entry) => entry.name === column);
    const comparisonCollations = resolved.map(([left, right]) =>
      collationOf(columnOf(left.table, left.column)?.collation ?? columnOf(next, right.column)?.collation));
    const matches = (enforced) => enforced.every((collation, i) => collation === comparisonCollations[i]);
    const unique = (same(primary, rightCols) && matches(rightCols.map((column) => collationOf(columnOf(next, column)?.collation))))
      || (next.indexes ?? []).some((index) => index.unique && !index.partial && same(index.columns, rightCols)
        && matches(rightCols.map((column, i) => collationOf(index.terms?.[i]?.collation ?? columnOf(next, column)?.collation))));
    if (!unique) multiplicative.push(next.name);
    const kind = (join.type ?? 'inner').toLowerCase();
    if (!['inner', 'left'].includes(kind)) throw new Error('Only explicit inner and left joins are supported.');
    const conditions = resolved.map(([left, right]) => `${left.sql} = ${right.sql}`);
    const tenant = tenantPredicate(next); if (tenant) conditions.push(tenant);
    joinSql.push(`${kind.toUpperCase()} JOIN ${relation(next.name)} AS ${quote(next.alias)} ON ${conditions.join(' AND ')}`);
  }
  if (!Array.isArray(query.select) || !query.select.length) throw new Error('Select explicit columns or aggregates.');
  const aliases = new Set(), plainColumns = [], aggregates = [];
  const select = query.select.map((entry) => {
    keys(entry, ['column', 'as', 'aggregate', 'distinct'], 'selection');
    named(entry.as, 'selection alias');
    if (aliases.has(entry.as.toLowerCase())) throw new Error('Selection aliases must be distinct.');
    aliases.add(entry.as.toLowerCase());
    let expression;
    if (entry.aggregate !== undefined) {
      if (!AGGREGATES.has(entry.aggregate)) throw new Error('Unsupported aggregate.');
      const ref = entry.column === '*' && entry.aggregate === 'count' ? null : resolve(entry.column);
      if (entry.distinct && !ref) throw new Error('COUNT DISTINCT needs a column.');
      expression = `${entry.aggregate.toUpperCase()}(${entry.distinct ? 'DISTINCT ' : ''}${ref?.sql ?? '*'})`;
      aggregates.push(entry);
    } else {
      if (entry.distinct !== undefined) throw new Error('distinct is only supported on an aggregate.');
      const ref = resolve(entry.column); expression = ref.sql; plainColumns.push(ref.key);
    }
    return `${expression} AS ${quote(entry.as)}`;
  });
  if (aggregates.length && multiplicative.length) throw new Error('This join can multiply aggregate rows. Start from the detail table or use a separate approved metric.');
  const groups = (query.groupBy ?? []).map(resolve);
  if (aggregates.length && plainColumns.some((column) => !groups.some((group) => group.key === column))) throw new Error('Every non-aggregate selection must be in groupBy.');
  const where = [];
  const baseTenant = tenantPredicate(base); if (baseTenant) where.push(baseTenant);
  for (const filter of query.filters ?? []) {
    keys(filter, ['column', 'op', 'param'], 'filter');
    const column = resolve(filter.column).sql;
    if (['isNull', 'isNotNull'].includes(filter.op)) {
      if (filter.param !== undefined) throw new Error('Null checks do not accept a parameter.');
      where.push(`${column} IS ${filter.op === 'isNotNull' ? 'NOT ' : ''}NULL`); continue;
    }
    if (!Object.hasOwn(validated, filter.param)) throw new Error(`Undeclared parameter ${filter.param}.`);
    consumed.add(filter.param);
    const value = validated[filter.param];
    if (value === null) throw new TypeError('Use an explicit isNull or isNotNull filter for null values.');
    if (filter.op === 'in') {
      if (!Array.isArray(value)) throw new Error('IN requires an array parameter.');
      where.push(`${column} IN (${value.map(bind).join(', ')})`);
    } else {
      if (!Object.hasOwn(OPERATORS, filter.op)) throw new Error('Unsupported filter operator.');
      where.push(`${column} ${OPERATORS[filter.op]} ${bind(value)}`);
    }
  }
  for (const name of Object.keys(declarations)) if (!consumed.has(name)) throw new Error(`Parameter ${name} is declared but never used.`);
  const order = (query.orderBy ?? []).map((entry) => {
    keys(entry, ['column', 'direction'], 'ordering');
    const direction = (entry.direction ?? 'asc').toLowerCase();
    if (!['asc', 'desc'].includes(direction)) throw new Error('Ordering must be asc or desc.');
    if (!aliases.has(String(entry.column).toLowerCase())) throw new Error('Order by a selected output alias.');
    return `${quote(entry.column)} ${direction.toUpperCase()}`;
  });
  const limit = integer(query.limit ?? 100, 'query limit', 1, maxRows);
  const sql = `SELECT ${select.join(', ')} FROM ${relation(base.name)} AS ${quote(base.alias)}`
    + (joinSql.length ? ` ${joinSql.join(' ')}` : '') + (where.length ? ` WHERE ${where.join(' AND ')}` : '')
    + (groups.length ? ` GROUP BY ${groups.map((group) => group.sql).join(', ')}` : '')
    + (order.length ? ` ORDER BY ${order.join(', ')}` : '') + ` LIMIT ${bind(limit)}`;
  const result = { sql, values: Object.freeze(values), dialect, maxRows: limit, columns: Object.freeze(query.select.map((entry) => entry.as)),
    tables: [...used.keys()], tenantScopedTables: Object.freeze([...tenantScopedTables]),
    sharedTables: Object.freeze([...sharedTables]), templateId: template.id, templateVersion: template.version,
    templateHash: digest(template), schemaHash: schema.hash ?? digest(schema), actorHash: digest(identity), paramsHash: digest(params) };
  Object.freeze(result.tables); Object.freeze(result); COMPILED.add(result);
  return result;
}
