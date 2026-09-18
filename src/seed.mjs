// A foreign-key-aware synthetic data factory.
//
// The cited failure is specific: when models were asked to generate seed data
// directly they broke down once the foreign-key graph got deep, leaving
// half-seeded, incoherent rows. So generation here is entirely deterministic —
// topological order, a seeded pseudo-random source, parent keys drawn from rows
// that already exist — and the model's only role, through the `realism` review,
// is to judge whether the result reads like a plausible business scenario.
//
// Deterministic also means reproducible: the same seed and schema always
// produce the same rows, which is what makes a fixture worth committing.

import { normalizeSchema } from './schema.mjs';
import { integer } from './validation.mjs';
import { quoteName } from './query-compiler.mjs';

/** A small, fast, fully deterministic 32-bit generator (mulberry32). */
function randomSource(seed) {
  let state = 0;
  for (const character of String(seed)) state = (state * 31 + character.charCodeAt(0)) >>> 0;
  state = (state + 0x6D2B79F5) >>> 0;
  return () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WORDS = ['alder', 'basalt', 'cedar', 'delta', 'ember', 'fjord', 'granite', 'harbour', 'indigo', 'juniper',
  'kestrel', 'lantern', 'meridian', 'nimbus', 'onyx', 'pergola', 'quarry', 'rowan', 'sable', 'thistle'];
const SURNAMES = ['Abara', 'Boateng', 'Chikate', 'Dlamini', 'Eriksen', 'Farooq', 'Gqola', 'Haddad', 'Iyer', 'Jansen',
  'Khumalo', 'Lindqvist', 'Mokoena', 'Ndlovu', 'Okafor', 'Pretorius', 'Quintero', 'Radebe', 'Sithole', 'Tadesse'];
const CITIES = ['Aberdeen', 'Bulawayo', 'Cork', 'Durban', 'Eindhoven', 'Faro', 'Gdansk', 'Harare', 'Ipswich', 'Jaipur'];

function typeFamily(declared) {
  const base = String(declared ?? '').toUpperCase();
  if (/INT|SERIAL/.test(base)) return 'integer';
  if (/REAL|FLOA|DOUB|DEC|NUM|MONEY/.test(base)) return 'number';
  if (/BOOL|^BIT$/.test(base)) return 'boolean';
  if (/DATETIME|TIMESTAMP/.test(base)) return 'timestamp';
  if (/^DATE$/.test(base)) return 'date';
  if (/^TIME/.test(base)) return 'time';
  if (/BLOB|BYTEA|BINARY/.test(base)) return 'binary';
  if (/JSON/.test(base)) return 'json';
  return 'text';
}

/** Column names carry most of the meaning available without a glossary. */
function valueFor(column, { random, index, table }) {
  const name = String(column.name).toLowerCase();
  const family = typeFamily(column.type);
  const pick = (list) => list[Math.floor(random() * list.length)];
  const digits = (count) => String(Math.floor(random() * 10 ** count)).padStart(count, '0');
  // A fixed epoch keeps generated fixtures reproducible across runs.
  const moment = () => new Date(Date.UTC(2026, 0, 1) + Math.floor(random() * 300) * 86400000
    + Math.floor(random() * 86400) * 1000).toISOString();
  if (family === 'text') {
    // SQLite stores timestamps in TEXT columns, so the declared type alone would
    // fill created_at with a word. The name is the only signal available.
    if (/(^|_)(at|on)$|date|timestamp|_time$/.test(name)) return moment().replace('T', ' ').slice(0, 19);
    if (/email/.test(name)) return `${pick(WORDS)}.${digits(3)}@example.test`;
    if (/(^|_)(phone|mobile|tel)/.test(name)) return `+27${digits(9)}`;
    if (/(^|_)(url|link|website)/.test(name)) return `https://example.test/${pick(WORDS)}/${digits(4)}`;
    if (/(first_?name|given)/.test(name)) return pick(WORDS).replace(/^./, (c) => c.toUpperCase());
    if (/(last_?name|surname|family)/.test(name)) return pick(SURNAMES);
    if (/(^|_)name$|title|label/.test(name)) return `${pick(WORDS).replace(/^./, (c) => c.toUpperCase())} ${pick(SURNAMES)}`;
    if (/city|town/.test(name)) return pick(CITIES);
    if (/country/.test(name)) return pick(['ZA', 'GB', 'NL', 'KE', 'PT', 'IN']);
    if (/status|state/.test(name)) return pick(['active', 'pending', 'closed']);
    if (/currency/.test(name)) return pick(['ZAR', 'EUR', 'GBP', 'USD']);
    if (/code|sku|reference|ref$/.test(name)) return `${pick(WORDS).slice(0, 3).toUpperCase()}-${digits(5)}`;
    if (/(description|note|comment|body|summary)/.test(name)) return `${pick(WORDS)} ${pick(WORDS)} for ${table} ${index + 1}`;
    if (/uuid|guid/.test(name)) return `${digits(8)}-${digits(4)}-${digits(4)}-${digits(4)}-${digits(12)}`;
    return `${pick(WORDS)}-${index + 1}`;
  }
  if (family === 'integer') {
    if (/quantity|count|qty/.test(name)) return 1 + Math.floor(random() * 20);
    if (/age/.test(name)) return 18 + Math.floor(random() * 60);
    if (/year/.test(name)) return 2020 + Math.floor(random() * 6);
    return index + 1;
  }
  if (family === 'number') {
    if (/rate|ratio|percent/.test(name)) return Math.round(random() * 10000) / 10000;
    return Math.round(random() * 100000) / 100;
  }
  if (family === 'boolean') return random() < 0.5 ? 0 : 1;
  if (family === 'date' || family === 'timestamp') {
    const iso = moment();
    return family === 'date' ? iso.slice(0, 10) : iso.replace('T', ' ').slice(0, 19);
  }
  if (family === 'time') return new Date(Math.floor(random() * 86400) * 1000).toISOString().slice(11, 19);
  if (family === 'json') return JSON.stringify({ [pick(WORDS)]: index + 1 });
  return `${pick(WORDS)}-${index + 1}`;
}

/** Kahn's algorithm over the foreign-key graph, reporting cycles explicitly. */
function topologicalOrder(tables, key) {
  const dependencies = new Map(tables.map((table) => [key(table.name), new Set()]));
  for (const table of tables) {
    for (const fk of table.foreignKeys) {
      const target = key(fk.referenceTable);
      // A self-reference is satisfied by nullable columns or by insertion order.
      if (target !== key(table.name) && dependencies.has(target)) dependencies.get(key(table.name)).add(target);
    }
  }
  const order = [], resolved = new Set();
  let progress = true;
  while (progress) {
    progress = false;
    for (const table of tables) {
      const id = key(table.name);
      if (resolved.has(id)) continue;
      if ([...dependencies.get(id)].every((dependency) => resolved.has(dependency))) {
        resolved.add(id); order.push(table); progress = true;
      }
    }
  }
  const cycle = tables.filter((table) => !resolved.has(key(table.name)));
  return { order, cycle };
}

/**
 * Generate rows for every table in dependency order.
 *
 * Foreign keys are satisfied from rows already generated for the parent; a
 * nullable key with no parent row becomes NULL rather than a dangling id, and a
 * required one is reported instead of being invented. Unique columns get
 * distinct values within the run. Nothing is written to any database here: the
 * result is data plus the statements that would insert it.
 *
 * @returns {{tables: object[], order: string[], cycles: string[], rows: object,
 *   statements: {sql: string, params: any[]}[], unsatisfied: object[], seed: string}}
 */
export function generateSeedData(snapshot, { rows = 5, seed = 'jevsql', perTable = {}, maxRows = 10000 } = {}) {
  const schema = normalizeSchema(snapshot);
  integer(rows, 'rows', 0, maxRows);
  const insensitive = schema.identifierCase === 'insensitive';
  const key = (value) => insensitive ? String(value).toLowerCase() : String(value);
  const random = randomSource(seed);
  const { order, cycle } = topologicalOrder(schema.tables, key);
  const generated = new Map();
  const unsatisfied = [];
  const statements = [];

  for (const table of [...order, ...cycle]) {
    const count = integer(perTable[table.name] ?? rows, `perTable.${table.name}`, 0, maxRows);
    const produced = [];
    const uniqueSeen = new Map();
    const uniqueColumns = new Set([
      ...table.columns.filter((column) => column.unique || column.primaryKey).map((column) => column.name),
      ...table.indexes.filter((index) => index.unique && !index.partial).flatMap((index) => (index.columns.length === 1 ? index.columns : [])),
    ].filter(Boolean));

    for (let index = 0; index < count; index++) {
      const row = {};
      const fkColumns = new Map();
      for (const fk of table.foreignKeys) {
        const parent = generated.get(key(fk.referenceTable));
        fk.columns.forEach((column, position) => {
          const referenced = fk.referenceColumns[position];
          if (key(fk.referenceTable) === key(table.name)) {
            // Self-reference: point at an earlier row, or nothing for the first.
            const earlier = produced[Math.floor(random() * produced.length)];
            fkColumns.set(key(column), earlier && referenced ? earlier[referenced] ?? null : null);
            return;
          }
          if (!parent?.length || !referenced) { fkColumns.set(key(column), null); return; }
          fkColumns.set(key(column), parent[Math.floor(random() * parent.length)][referenced] ?? null);
        });
      }
      for (const column of table.columns) {
        if (column.generated) continue;
        const id = key(column.name);
        if (fkColumns.has(id)) {
          const value = fkColumns.get(id);
          if (value === null && !column.nullable) {
            unsatisfied.push({ table: table.name, column: column.name, reason: 'required_foreign_key_has_no_parent_row' });
          }
          row[column.name] = value;
          continue;
        }
        if (column.autoIncrement || (column.primaryKey === 1 && typeFamily(column.type) === 'integer' && table.primaryKey.length === 1)) {
          row[column.name] = index + 1;
          continue;
        }
        if (column.nullable && random() < 0.1) { row[column.name] = null; continue; }
        let value = valueFor(column, { random, index, table: table.name });
        if (uniqueColumns.has(column.name)) {
          const seen = uniqueSeen.get(column.name) ?? new Set();
          let attempts = 0;
          while (seen.has(String(value)) && attempts++ < 50) value = valueFor(column, { random, index: index + attempts * 1000, table: table.name });
          if (seen.has(String(value))) {
            unsatisfied.push({ table: table.name, column: column.name, reason: 'could_not_generate_a_distinct_value' });
          }
          seen.add(String(value));
          uniqueSeen.set(column.name, seen);
        }
        row[column.name] = value;
      }
      produced.push(row);
    }
    generated.set(key(table.name), produced);
    const columns = table.columns.filter((column) => !column.generated).map((column) => column.name);
    const quote = (name) => quoteName(name, schema.dialect === 'mysql' ? 'mysql' : 'sqlite');
    for (const row of produced) {
      statements.push({ table: table.name,
        sql: `INSERT INTO ${quote(table.name)} (${columns.map(quote).join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
        params: columns.map((column) => row[column] ?? null) });
    }
  }

  return {
    tables: [...order, ...cycle].map((table) => ({ name: table.name, rows: generated.get(key(table.name)).length })),
    order: order.map((table) => table.name),
    cycles: cycle.map((table) => table.name),
    rows: Object.fromEntries([...generated].map(([id, values]) => [
      schema.tables.find((table) => key(table.name) === id).name, values])),
    statements, unsatisfied, seed: String(seed),
    note: 'Deterministic generation. Realism is a separate judgement; constraint satisfaction is proved by inserting these rows.',
  };
}

/** Insert generated rows into a SQLite connection, proving the data satisfies
 * the real constraints rather than only the ones this generator modelled. */
export function applySeedData(db, generatedData) {
  if (!db || typeof db.prepare !== 'function') throw new TypeError('A DatabaseSync connection is required.');
  const failures = [];
  db.exec('SAVEPOINT _jevsql_seed');
  try {
    for (const statement of generatedData.statements) {
      try { db.prepare(statement.sql).run(...statement.params); }
      catch (error) { failures.push({ table: statement.table, error: error.message }); }
    }
    if (failures.length) {
      db.exec('ROLLBACK TO _jevsql_seed');
      db.exec('RELEASE _jevsql_seed');
      return { inserted: 0, failures, applied: false };
    }
    db.exec('RELEASE _jevsql_seed');
    return { inserted: generatedData.statements.length, failures, applied: true };
  } catch (error) {
    db.exec('ROLLBACK TO _jevsql_seed');
    db.exec('RELEASE _jevsql_seed');
    throw error;
  }
}
