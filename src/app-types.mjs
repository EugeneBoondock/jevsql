// Application types versus the live schema.
//
// The documents make the same point twice: in an AI-paired codebase the agent
// reads types as truth, so a type that disagrees with the database makes the
// agent confidently ship wrong code. The comparison itself is deterministic and
// belongs here; only the genuinely ambiguous residue is worth a typed judgement.
//
// No source file is parsed. The caller supplies a declared model, because a
// parser that guesses at TypeScript or Pydantic would introduce exactly the kind
// of silent wrongness this module exists to catch.

import { normalizeSchema } from './schema.mjs';
import { digest } from './privacy.mjs';

const LANGUAGES = new Set(['typescript', 'javascript', 'python', 'go', 'java', 'csharp', 'ruby', 'php', 'rust', 'other']);

// Families are deliberately coarse. Two declarations in the same family can
// still disagree on width or precision, which the width check handles below.
const APP_FAMILIES = {
  string: 'text', str: 'text', text: 'text', varchar: 'text', uuid: 'text', char: 'text',
  number: 'number', float: 'number', double: 'number', decimal: 'number', numeric: 'number',
  int: 'integer', integer: 'integer', bigint: 'integer', long: 'integer', short: 'integer', smallint: 'integer',
  bool: 'boolean', boolean: 'boolean',
  date: 'date', datetime: 'timestamp', timestamp: 'timestamp', time: 'time',
  bytes: 'binary', buffer: 'binary', blob: 'binary',
  json: 'json', object: 'json', dict: 'json', array: 'json', list: 'json', record: 'json',
  any: 'unknown', unknown: 'unknown', null: 'unknown',
};

const SQL_FAMILIES = [
  [/^(?:BIG|SMALL|TINY|MEDIUM)?INT(?:EGER)?\d*$/, 'integer'],
  [/^(?:SERIAL|BIGSERIAL|SMALLSERIAL)$/, 'integer'],
  [/^(?:DECIMAL|NUMERIC|REAL|DOUBLE(?: PRECISION)?|FLOAT|MONEY)/, 'number'],
  [/^(?:BOOL|BOOLEAN|BIT)$/, 'boolean'],
  [/^(?:TIMESTAMP|DATETIME)/, 'timestamp'],
  [/^DATE$/, 'date'],
  [/^TIME(?:TZ)?$/, 'time'],
  [/^(?:BYTEA|BLOB|VARBINARY|BINARY)/, 'binary'],
  [/^(?:JSON|JSONB)$/, 'json'],
  [/^(?:CHAR|VARCHAR|TEXT|CHARACTER|CLOB|NCHAR|NVARCHAR|CITEXT|UUID|ENUM|NAME)/, 'text'],
];

const INTEGER_WIDTHS = { TINYINT: 8, SMALLINT: 16, SMALLSERIAL: 16, INT2: 16, MEDIUMINT: 24, INT: 32, INTEGER: 32, INT4: 32, SERIAL: 32, BIGINT: 64, INT8: 64, BIGSERIAL: 64, LONG: 64 };
const APP_INTEGER_WIDTHS = { short: 16, smallint: 16, int: 32, integer: 32, long: 64, bigint: 64 };

const text = (value, label) => {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${label} must be a non-empty string.`);
  return value;
};

function sqlFamily(declared) {
  const base = String(declared ?? '').toUpperCase().replace(/\s*\(.*$/, '').trim();
  if (!base) return 'unknown';
  for (const [pattern, family] of SQL_FAMILIES) if (pattern.test(base)) return family;
  return 'unknown';
}

function appFamily(declared) {
  const base = String(declared ?? '').toLowerCase().replace(/\s*[|?].*$/, '').replace(/\[\]$/, '').trim();
  return APP_FAMILIES[base] ?? 'unknown';
}

/** Normalise a declared application model. Field-to-column mapping is explicit
 * where given and by matching name otherwise. */
export function normalizeAppModel(input) {
  if (!input || typeof input !== 'object') throw new TypeError('An application type model is required.');
  const language = String(input.language ?? 'other').toLowerCase();
  if (!LANGUAGES.has(language)) throw new TypeError(`Unsupported language ${language}.`);
  if (!Array.isArray(input.models) || !input.models.length) throw new TypeError('A model needs at least one declared type.');
  const names = new Set();
  const models = input.models.map((model) => {
    text(model?.name, 'model.name');
    text(model?.table, 'model.table');
    if (names.has(model.name)) throw new TypeError(`Duplicate model name ${model.name}.`);
    names.add(model.name);
    if (!Array.isArray(model.fields) || !model.fields.length) throw new TypeError(`Model ${model.name} needs fields.`);
    const fieldNames = new Set();
    const fields = model.fields.map((field) => {
      text(field?.name, 'field.name');
      text(field?.type, 'field.type');
      if (fieldNames.has(field.name)) throw new TypeError(`Duplicate field ${model.name}.${field.name}.`);
      fieldNames.add(field.name);
      return { name: field.name, type: field.type, column: field.column ?? field.name,
        optional: Boolean(field.optional), readOnly: Boolean(field.readOnly),
        family: appFamily(field.type), ...(field.maxLength === undefined ? {} : { maxLength: field.maxLength }) };
    });
    return { name: model.name, table: model.table, fields,
      writes: model.writes !== false, reads: model.reads !== false, testPacks: model.testPacks ?? [] };
  });
  return { language, models, hash: digest({ language, models }) };
}

/**
 * Compare a declared application model against a schema snapshot.
 *
 * Every finding is derived from the two declarations alone, with no model call
 * and no sampled rows. `level` is `block` when the mismatch will fail at
 * runtime, `review` when it depends on data or intent, `info` when it is only
 * worth knowing. Unknown type families never produce a block: an unrecognised
 * declaration is a gap in this table, not evidence of a defect.
 *
 * @returns {{divergences: object[], coverage: object, appHash: string, schemaHash: string}}
 */
export function compareAppTypes(appModel, snapshot) {
  const app = normalizeAppModel(appModel);
  const schema = normalizeSchema(snapshot);
  const insensitive = schema.identifierCase === 'insensitive';
  const key = (value) => insensitive ? String(value).toLowerCase() : String(value);
  const tables = new Map(schema.tables.map((table) => [key(table.name), table]));
  const divergences = [];
  const add = (level, code, detail, extra) => divergences.push({ level, code, detail, ...extra });
  let mappedFields = 0, mappedTables = 0;

  for (const model of app.models) {
    const table = tables.get(key(model.table));
    if (!table) {
      add('block', 'missing_table', `The application type ${model.name} maps to ${model.table}, which the schema does not contain.`,
        { model: model.name, table: model.table });
      continue;
    }
    mappedTables++;
    const columns = new Map(table.columns.map((column) => [key(column.name), column]));
    const claimed = new Set();
    for (const field of model.fields) {
      const column = columns.get(key(field.column));
      if (!column) {
        add('block', 'missing_column', `${model.name}.${field.name} maps to ${model.table}.${field.column}, which does not exist.`,
          { model: model.name, table: model.table, field: field.name, column: field.column });
        continue;
      }
      claimed.add(key(column.name));
      mappedFields++;
      const dbFamily = sqlFamily(column.type);
      const common = { model: model.name, table: model.table, field: field.name, column: column.name,
        appType: field.type, databaseType: column.type };
      if (field.family !== 'unknown' && dbFamily !== 'unknown' && field.family !== dbFamily) {
        // A number reading an integer column is widening and safe; the reverse
        // silently truncates, which is why direction matters here.
        const widening = field.family === 'number' && dbFamily === 'integer';
        add(widening ? 'info' : 'block', widening ? 'type_widened' : 'type_mismatch',
          `${model.name}.${field.name} is declared ${field.type} but ${column.name} is ${column.type}.`, common);
      } else if (field.family === 'unknown' || dbFamily === 'unknown') {
        add('review', 'type_unrecognised',
          `${model.name}.${field.name} (${field.type}) and ${column.name} (${column.type}) cannot be compared by declaration alone.`, common);
      } else if (field.family === 'integer') {
        const appWidth = APP_INTEGER_WIDTHS[String(field.type).toLowerCase()] ?? null;
        const dbWidth = INTEGER_WIDTHS[String(column.type).toUpperCase().replace(/\s*\(.*$/, '')] ?? null;
        if (appWidth && dbWidth && appWidth < dbWidth) {
          add('block', 'integer_narrower_than_column',
            `${model.name}.${field.name} holds ${appWidth} bits but ${column.name} stores ${dbWidth}.`, { ...common, appWidth, dbWidth });
        }
      } else if (field.family === 'text' && field.maxLength !== undefined) {
        // Normalised types are tokenised, so the limit reads as `VARCHAR ( 20 )`.
        const limit = /\(\s*(\d+)/.exec(String(column.type))?.[1];
        if (limit && Number(field.maxLength) > Number(limit)) {
          add('block', 'text_longer_than_column',
            `${model.name}.${field.name} allows ${field.maxLength} characters but ${column.name} stores ${limit}.`,
            { ...common, appMaxLength: Number(field.maxLength), databaseMaxLength: Number(limit) });
        }
      }
      if (field.optional && !column.nullable) {
        add('review', 'optional_field_required_column',
          `${model.name}.${field.name} is optional but ${column.name} is NOT NULL, so an omitted value fails at write time.`, common);
      }
      if (!field.optional && column.nullable) {
        add('review', 'required_field_nullable_column',
          `${model.name}.${field.name} is required but ${column.name} accepts NULL, so a stored NULL breaks a read.`, common);
      }
      if (field.readOnly && column.generated === null && !column.autoIncrement) {
        add('info', 'read_only_writable_column', `${model.name}.${field.name} is read-only but ${column.name} is an ordinary writable column.`, common);
      }
    }
    for (const column of table.columns) {
      if (claimed.has(key(column.name)) || column.generated || column.autoIncrement || column.hidden) continue;
      const missingDefault = column.defaultValue === null || column.defaultValue === undefined;
      if (!column.nullable && missingDefault && model.writes) {
        add('block', 'unmapped_required_column',
          `${model.table}.${column.name} is required with no default, and ${model.name} never supplies it.`,
          { model: model.name, table: model.table, column: column.name, databaseType: column.type });
      } else {
        add('info', 'unmapped_column', `${model.table}.${column.name} has no field in ${model.name}.`,
          { model: model.name, table: model.table, column: column.name, databaseType: column.type });
      }
    }
  }
  const covered = new Set(app.models.map((model) => key(model.table)));
  for (const table of schema.tables) {
    if (!covered.has(key(table.name))) {
      add('info', 'unmodelled_table', `${table.name} has no application type in this model.`, { table: table.name });
    }
  }
  return {
    divergences: divergences.sort((a, b) => (a.table ?? '').localeCompare(b.table ?? '')
      || (a.column ?? '').localeCompare(b.column ?? '') || a.code.localeCompare(b.code)),
    coverage: { models: app.models.length, mappedTables, mappedFields,
      schemaTables: schema.tables.length, unmodelledTables: schema.tables.length - covered.size },
    appHash: app.hash, schemaHash: schema.hash, language: app.language,
  };
}

/** Turn a declared application model into migration consumer assets, so a
 * schema change can resolve which types break without restating the mapping. */
export function assetsFromAppTypes(appModel) {
  const app = normalizeAppModel(appModel);
  return app.models.map((model) => ({
    id: `app:${model.name}`,
    columns: model.fields.map((field) => ({ table: model.table, column: field.column })),
    testPacks: [...new Set([...model.testPacks, model.writes ? 'write-path' : null, model.reads ? 'read-path' : null].filter(Boolean))],
  }));
}
