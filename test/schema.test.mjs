import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { inspectSchema, normalizeSchema, diffSchemas, affectedAssets, pruneSchema } from '../src/schema.mjs';

function database(t, ddl = '') {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  if (ddl) db.exec(ddl);
  return db;
}
const column = (name, values = {}) => ({ name, type: 'TEXT', nullable: true, defaultValue: null, primaryKey: 0, ...values });
const table = (name, columns = [column('id')], values = {}) => ({ name, columns, foreignKeys: [], indexes: [], ...values });
const snapshot = (tables, dialect = 'sqlite') => ({ dialect, tables });
const fk = (target, columns = ['id'], referenceColumns = ['id']) => ({ columns, referenceTable: target, referenceColumns });
const names = (schema) => schema.tables.map((entry) => entry.name);
function freeze(value) {
  if (value && typeof value === 'object') { Object.freeze(value); for (const item of Object.values(value)) freeze(item); }
  return value;
}

test('inspection reads metadata only, excludes system tables and ignores data changes', (t) => {
  const db = database(t, `CREATE TABLE people(id INTEGER PRIMARY KEY, email TEXT NOT NULL DEFAULT 'a  b');
    CREATE TABLE _jevsql_private(value TEXT); CREATE TABLE _JEVSQL_caps(value TEXT);
    CREATE TABLE numbered(id INTEGER PRIMARY KEY AUTOINCREMENT); CREATE VIEW people_view AS SELECT * FROM people;`);
  const reads = [];
  const metadataOnly = { prepare(text) {
    reads.push(text);
    assert.match(text, /^(PRAGMA main\.(schema_version|table_list)|SELECT .* FROM (main\.sqlite_schema|pragma_(table_xinfo|foreign_key_list|index_list|index_xinfo)\())/);
    return db.prepare(text);
  } };
  const before = inspectSchema(metadataOnly);
  assert.deepEqual(names(before), ['numbered', 'people']);
  assert.equal(before.version, 1);
  assert.match(before.hash, /^[0-9a-f]{64}$/);
  assert.ok(reads.length > 5);
  const people = before.tables.find((entry) => entry.name === 'people');
  assert.equal(people.columns.find((entry) => entry.name === 'id').nullable, false);
  assert.equal(people.columns.find((entry) => entry.name === 'email').defaultValue, "'a  b'");
  db.exec(`INSERT INTO people(email) VALUES ('private row'); CREATE TABLE _jevsql_later(value BLOB);`);
  assert.deepEqual(inspectSchema(db), before);
  assert.deepEqual(names(inspectSchema(db, { includeSystem: true })), ['_JEVSQL_caps', '_jevsql_later', '_jevsql_private', 'numbered', 'people']);
});

test('inspection preserves quoted names, compound foreign keys and compound indexes', (t) => {
  const db = database(t, `CREATE TABLE "par'ent"("left" TEXT, "right" INTEGER, PRIMARY KEY("right", "left"));
    CREATE TABLE "child\"\"; DROP TABLE nope; --"("a\"\"b" INTEGER, "x'y" TEXT,
      CONSTRAINT "fk name" FOREIGN KEY("a\"\"b", "x'y") REFERENCES "par'ent"
      ON DELETE CASCADE ON UPDATE RESTRICT DEFERRABLE INITIALLY DEFERRED);
    CREATE UNIQUE INDEX "ix\"\"quoted" ON "child\"\"; DROP TABLE nope; --"("x'y" COLLATE NOCASE DESC, "a\"\"b");`);
  const child = inspectSchema(db).tables.find((entry) => entry.name.startsWith('child'));
  assert.equal(child.name, 'child"; DROP TABLE nope; --');
  assert.deepEqual(child.foreignKeys[0], { name: 'fk name', columns: ['a"b', "x'y"], referenceTable: "par'ent",
    referenceColumns: ['right', 'left'], onDelete: 'CASCADE', onUpdate: 'RESTRICT', match: 'NONE', deferrable: true, initially: 'DEFERRED' });
  assert.deepEqual(child.indexes[0].columns, ["x'y", 'a"b']);
  assert.equal(child.indexes[0].unique, true);
  assert.equal(child.indexes[0].terms[0].descending, true);
  assert.equal(child.indexes[0].terms[0].collation, 'NOCASE');
});

test('inspection handles rowid primary keys, DESC keys, STRICT and WITHOUT ROWID', (t) => {
  const db = database(t, `CREATE TABLE ordinary(id TEXT PRIMARY KEY);
    CREATE TABLE descending(id INTEGER PRIMARY KEY DESC);
    CREATE TABLE strict_table(id TEXT PRIMARY KEY) STRICT;
    CREATE TABLE no_rowid(a TEXT, b INTEGER, PRIMARY KEY(a,b)) WITHOUT ROWID;`);
  const schema = inspectSchema(db);
  assert.equal(schema.tables.find((entry) => entry.name === 'ordinary').columns[0].nullable, true);
  assert.equal(schema.tables.find((entry) => entry.name === 'descending').columns[0].nullable, true);
  assert.equal(schema.tables.find((entry) => entry.name === 'strict_table').columns[0].nullable, false);
  assert.ok(schema.tables.find((entry) => entry.name === 'no_rowid').columns.every((entry) => !entry.nullable));
});

test('inspection preserves CHECK, generated expressions, conflict policy and expression indexes', (t) => {
  const db = database(t, `CREATE TABLE metrics(id INTEGER PRIMARY KEY AUTOINCREMENT,
    label TEXT COLLATE NOCASE UNIQUE ON CONFLICT IGNORE,
    value REAL CHECK(value > 0 AND label <> 'CHECK(fake),  keep'),
    doubled REAL GENERATED ALWAYS AS (value * 2) STORED, CHECK(length(label) > 1));
    CREATE INDEX computed ON metrics(lower(label), value DESC) WHERE value > 10;`);
  const metrics = inspectSchema(db).tables[0];
  assert.equal(metrics.columns.find((entry) => entry.name === 'id').autoIncrement, true);
  assert.equal(metrics.columns.find((entry) => entry.name === 'label').collation, 'NOCASE');
  assert.deepEqual(metrics.columns.find((entry) => entry.name === 'doubled').generated,
    { expression: 'VALUE * 2', storage: 'stored' });
  assert.equal(metrics.constraints.filter((entry) => entry.kind === 'check').length, 2);
  assert.equal(metrics.constraints.filter((entry) => entry.kind === 'conflict').length, 1);
  const index = metrics.indexes.find((entry) => entry.name === 'computed');
  assert.deepEqual(index.columns, [null, 'value']);
  assert.equal(index.partial, true);
  assert.equal(index.terms[0].expression, 'LOWER ( LABEL )');
  assert.match(index.definition, /WHERE VALUE > 10$/);
});

test('inspection does not disturb a caller transaction and rejects a torn schema read', (t) => {
  const db = database(t, 'CREATE TABLE items(id INTEGER)');
  db.exec('BEGIN; INSERT INTO items VALUES (1)');
  inspectSchema(db);
  db.exec('ROLLBACK');
  assert.equal(db.prepare('SELECT count(*) AS n FROM items').get().n, 0);
  let versionReads = 0;
  assert.throws(() => inspectSchema({ prepare(text) {
    if (text === 'PRAGMA main.schema_version') return { all: () => [{ schema_version: versionReads++ }] };
    return db.prepare(text);
  } }), { code: 'SCHEMA_CHANGED_DURING_INSPECTION' });
});

test('normalization is deterministic, idempotent and does not mutate nested inputs', () => {
  const source = freeze(snapshot([table('Z', [column('b'), column('a')], {
    indexes: [{ name: 'z_index', columns: ['b', 'a'], unique: true }], foreignKeys: [fk('A', ['b', 'a'], ['x', 'y'])],
  }), table('A', [column('y'), column('x')])]));
  const copy = structuredClone(source);
  const normalized = normalizeSchema(source);
  assert.deepEqual(normalizeSchema(normalized), normalized);
  const shuffled = structuredClone(source);
  shuffled.tables.reverse(); shuffled.tables[1].columns.reverse();
  assert.deepEqual(normalizeSchema(shuffled), normalized);
  assert.deepEqual(source, copy);
  normalized.tables[1].indexes[0].columns.reverse();
  assert.deepEqual(source, copy);
});

test('SQLite names ignore ASCII case while quoted PostgreSQL catalog names retain it', () => {
  const a = snapshot([table('People', [column('Email', { type: 'text' })])]);
  const b = snapshot([table('people', [column('email')])]);
  assert.deepEqual(diffSchemas(a, b), []);
  assert.equal(normalizeSchema(a).hash, normalizeSchema(b).hash);
  assert.deepEqual(diffSchemas({ ...a, dialect: 'postgresql' }, { ...b, dialect: 'postgresql' }).map((entry) => entry.kind).sort(),
    ['table_added', 'table_removed']);
  assert.equal(diffSchemas(snapshot([table('Ä')]), snapshot([table('ä')])).length, 2);
  assert.throws(() => normalizeSchema(snapshot([table('a'), table('A')])), /Duplicate table/);
  assert.throws(() => normalizeSchema(snapshot([table('a', [column('x'), column('X')])])), /Duplicate column/);
});

test('drift reports removed tables and columns and classifies required additions', () => {
  const before = snapshot([table('removed'), table('users', [column('old'), column('name')])]);
  const after = snapshot([table('users', [column('name'), column('optional'),
    column('required', { nullable: false }), column('null_default', { nullable: false, defaultValue: '((NULL))' }),
    column('constant', { nullable: false, defaultValue: 0 }), column('text_null', { nullable: false, defaultValue: "'NULL'" }),
    column('dynamic', { nullable: false, defaultValue: "(strftime('%s', 'now'))" })]), table('new')]);
  const changes = diffSchemas(before, after);
  const change = (kind, name) => changes.find((entry) => entry.kind === kind && (entry.column ?? entry.table) === name);
  assert.equal(change('table_removed', 'removed').severity, 'block');
  assert.equal(change('column_removed', 'old').severity, 'block');
  assert.equal(change('table_added', 'new').severity, 'safe');
  assert.equal(change('column_added', 'optional').severity, 'safe');
  assert.equal(change('column_added', 'required').severity, 'block');
  assert.equal(change('column_added', 'null_default').severity, 'block');
  assert.equal(change('column_added', 'constant').severity, 'safe');
  assert.equal(change('column_added', 'text_null').severity, 'safe');
  assert.equal(change('column_added', 'dynamic').severity, 'review');
  assert.deepEqual(diffSchemas(before, after), changes);
  assert.equal(new Set(changes.map((entry) => entry.id)).size, changes.length);
});

test('type changes distinguish known narrowing and widening from unproven conversions', () => {
  const cases = [
    ['postgresql', 'BIGINT', 'INTEGER', 'block'], ['postgresql', 'INT', 'BIGINT', 'safe'],
    ['postgresql', 'VARCHAR(200)', 'VARCHAR (20)', 'block'], ['postgresql', 'VARCHAR(20)', 'VARCHAR(200)', 'safe'],
    ['postgresql', 'TEXT', 'VARCHAR(20)', 'block'], ['postgresql', 'VARCHAR(20)', 'TEXT', 'safe'],
    ['postgresql', 'NUMERIC(12,4)', 'NUMERIC(12,2)', 'block'], ['postgresql', 'NUMERIC(12,2)', 'NUMERIC(12,4)', 'block'],
    ['postgresql', 'NUMERIC(12,2)', 'NUMERIC(15,3)', 'safe'],
    ['postgresql', 'INTEGER', 'UUID', 'review'], ['mysql', 'DATE', 'JSON', 'review'],
    ['other', 'INTEGER', 'BIGINT', 'review'], ['sqlite', 'VARCHAR(200)', 'VARCHAR(20)', 'review'],
    ['sqlite', 'INTEGER', 'TEXT', 'review'], ['sqlite', 'CUSTOM_A', 'CUSTOM_B', 'review'],
  ];
  for (const [dialect, before, after, severity] of cases) {
    const changes = diffSchemas(snapshot([table('t', [column('v', { type: before })])], dialect),
      snapshot([table('t', [column('v', { type: after })])], dialect));
    assert.equal(changes[0].severity, severity, `${dialect}: ${before} to ${after}`);
  }
});

test('drift catches nullable, default, primary key, FK, index and constraint changes', () => {
  const a = snapshot([table('a', [column('id', { primaryKey: 1 }), column('v')], {
    foreignKeys: [fk('parent', ['v'])], indexes: [{ name: 'unique_v', columns: ['v'], unique: true }],
    constraints: [{ kind: 'check', columns: ['v'], expression: 'v > 0' }],
  })]);
  const b = structuredClone(a);
  b.tables[0].columns[0].primaryKey = 0;
  b.tables[0].columns[1].primaryKey = 1;
  b.tables[0].columns[1].nullable = false;
  b.tables[0].columns[1].defaultValue = '1';
  b.tables[0].foreignKeys[0].onDelete = 'CASCADE';
  b.tables[0].indexes[0].unique = false;
  b.tables[0].constraints[0].expression = 'v > 10';
  const changes = diffSchemas(a, b);
  for (const kind of ['column_nullable_changed', 'column_defaultValue_changed', 'primary_key_changed', 'foreign_key_changed', 'index_changed', 'constraint_changed']) {
    assert.ok(changes.some((entry) => entry.kind === kind), kind);
  }
  assert.equal(changes.find((entry) => entry.kind === 'index_changed').severity, 'block');
  assert.equal(changes.find((entry) => entry.kind === 'column_nullable_changed').severity, 'block');
});

test('index removal and additions distinguish uniqueness and ordinary indexes', () => {
  const a = snapshot([table('t', undefined, { indexes: [{ name: 'unique_id', columns: ['id'], unique: true },
    { name: 'plain_id', columns: ['id'] }] })]);
  const b = snapshot([table('t')]);
  assert.deepEqual(diffSchemas(a, b).map((entry) => entry.severity).sort(), ['block', 'review']);
  assert.deepEqual(diffSchemas(b, a).map((entry) => entry.severity).sort(), ['review', 'safe']);
});

test('real SQLite drift detects partial predicates, CHECK and generated expressions', (t) => {
  const make = (limit, multiplier, predicate) => inspectSchema(database(t, `CREATE TABLE t(x INTEGER CHECK(x > ${limit}),
    y INTEGER AS (x * ${multiplier})); CREATE INDEX ix ON t(x) WHERE x > ${predicate};`));
  const changes = diffSchemas(make(0, 2, 1), make(1, 3, 10));
  assert.ok(changes.some((entry) => entry.kind === 'constraint_changed'));
  assert.ok(changes.some((entry) => entry.kind === 'column_generated_changed'));
  assert.ok(changes.some((entry) => entry.kind === 'index_changed'));
  assert.ok(changes.every((entry) => entry.severity !== 'safe'));
});

test('SQL normalization preserves literal case and spacing while ignoring comments', (t) => {
  const a = inspectSchema(database(t, `CREATE TABLE t(x TEXT DEFAULT 'a  B', CHECK(x <> 'C'))`));
  const b = inspectSchema(database(t, `create table t ( x text /* note */ default 'a  B', check ( x <> 'C' ) )`));
  assert.equal(a.hash, b.hash);
  assert.deepEqual(diffSchemas(a, b), []);
  const c = inspectSchema(database(t, `CREATE TABLE t(x TEXT DEFAULT 'a B', CHECK(x <> 'c'))`));
  assert.notEqual(a.hash, c.hash);
  assert.equal(diffSchemas(a, c).length, 2);
});

test('asset impacts follow column references and reverse dependencies through cycles', () => {
  const changes = diffSchemas(snapshot([table('orders', [column('amount'), column('note')])]),
    snapshot([table('orders', [column('note')])]));
  const assets = freeze([
    { id: 'root', references: [{ table: 'ORDERS', columns: ['AMOUNT'] }], dependsOn: ['cycle'] },
    { id: 'cycle', dependsOn: ['report'] }, { id: 'report', dependencies: [{ assetId: 'root' }] },
    { id: 'all', tables: ['orders'] }, { id: 'notes', references: [{ table: 'orders', column: 'note' }] },
    { id: 'unrelated', dependsOn: ['external'] }, { id: 'same-name', references: [{ table: 'other', column: 'amount' }] },
  ]);
  const result = affectedAssets(freeze(changes), assets);
  assert.deepEqual(result.map((entry) => entry.id), ['all', 'cycle', 'report', 'root']);
  result.find((entry) => entry.id === 'root').references[0].columns.push('new');
  assert.deepEqual(assets[0].references[0].columns, ['AMOUNT']);
  assert.deepEqual(affectedAssets([], assets), []);
});

test('asset impacts honor dialect case, whole-table removals and parent FK references', () => {
  const a = snapshot([table('Orders', [column('Id')])], 'postgresql');
  const changes = diffSchemas(a, snapshot([], 'postgresql'));
  const assets = [{ id: 'match', references: [{ table: 'Orders', column: 'Id' }] },
    { id: 'other', references: [{ table: 'orders', column: 'Id' }] }];
  assert.deepEqual(affectedAssets(changes, assets).map((entry) => entry.id), ['match']);
  const foreign = diffSchemas(snapshot([table('child', undefined, { foreignKeys: [fk('parent')] })]), snapshot([table('child')]));
  assert.equal(affectedAssets(foreign, [{ id: 'parent-query', columns: [{ table: 'parent', column: 'id' }] }]).length, 1);
  assert.equal(affectedAssets(diffSchemas(a, { ...a, dialect: 'sqlite' }), assets).length, 2);
});

test('pruning preserves bridge tables, alternate shortest paths, cycles and disconnected choices', () => {
  const source = freeze(snapshot([
    table('a', undefined, { foreignKeys: [fk('left'), fk('right')] }),
    table('left', undefined, { foreignKeys: [fk('z')] }), table('right', undefined, { foreignKeys: [fk('z')] }),
    table('z', undefined, { foreignKeys: [fk('z')] }), table('leaf', undefined, { foreignKeys: [fk('a')] }), table('island'),
  ]));
  const before = structuredClone(source);
  assert.deepEqual(names(pruneSchema(source, ['z', 'A'])), ['a', 'left', 'right', 'z']);
  assert.deepEqual(pruneSchema(source, ['a', 'z']), pruneSchema(source, ['Z', 'a', 'a']));
  assert.deepEqual(names(pruneSchema(source, new Set(['a', 'island']))), ['a', 'island']);
  assert.deepEqual(names(pruneSchema(source, ['z'])), ['z']);
  assert.deepEqual(names(pruneSchema(source, [], { maxTables: 0 })), []);
  assert.deepEqual(source, before);
});

test('pruning follows multi-hop compound FKs in either direction and retains exact metadata', () => {
  const source = snapshot([table('customers'), table('orders', undefined, { foreignKeys: [fk('customers')] }),
    table('lines', [column('order_id'), column('tenant')], { foreignKeys: [fk('orders', ['order_id', 'tenant'], ['id', 'tenant']), fk('products')] }),
    table('products'), table('unrelated')]);
  const result = pruneSchema(source, ['products', 'customers']);
  assert.deepEqual(names(result), ['customers', 'lines', 'orders', 'products']);
  assert.deepEqual(result.tables.find((entry) => entry.name === 'lines').foreignKeys,
    normalizeSchema(source).tables.find((entry) => entry.name === 'lines').foreignKeys);
});

test('pruning reports a deterministic budget failure without losing join context', () => {
  const source = snapshot([table('a', undefined, { foreignKeys: [fk('bridge')] }), table('bridge', undefined, { foreignKeys: [fk('z')] }), table('z')]);
  for (const selected of [['a', 'z'], ['z', 'a']]) {
    assert.throws(() => pruneSchema(source, selected, { maxTables: 2 }), (error) => {
      assert.equal(error.code, 'SCHEMA_BUDGET_EXCEEDED');
      assert.equal(error.requiredCount, 3); assert.equal(error.maxTables, 2);
      assert.deepEqual(error.requiredTables, ['a', 'bridge', 'z']);
      return true;
    });
  }
  assert.throws(() => pruneSchema(source, ['missing']), { code: 'SCHEMA_TABLE_NOT_FOUND' });
  assert.throws(() => pruneSchema(source, ['a'], { maxTables: -1 }), /maxTables/);
});

test('all pure operations accept frozen inputs and return independent records', () => {
  const before = freeze(snapshot([table('t', [column('a'), column('b')])]));
  const after = freeze(snapshot([table('t', [column('a', { nullable: false })])]));
  const original = structuredClone({ before, after });
  const changes = diffSchemas(before, after);
  normalizeSchema(before); pruneSchema(before, ['t']);
  changes.find((entry) => entry.kind === 'column_removed').before.name = 'changed';
  assert.deepEqual({ before, after }, original);
});

test('quoted keyword columns do not hide table constraints', (t) => {
  const db = database(t, `CREATE TABLE t("check" TEXT, "constraint" INTEGER,
    CHECK(length("check") > 0), CONSTRAINT valid_number CHECK("constraint" > 0));`);
  const constraints = inspectSchema(db).tables[0].constraints;
  assert.equal(constraints.length, 2);
  assert.ok(constraints.some((entry) => entry.name === 'valid_number'));
});

test('repeated FK source columns retain the correct names, actions and timing', (t) => {
  const db = database(t, `CREATE TABLE parent(id INTEGER PRIMARY KEY, other INTEGER UNIQUE);
    CREATE TABLE child(x INTEGER,
      CONSTRAINT first FOREIGN KEY(x) REFERENCES parent(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
      CONSTRAINT second FOREIGN KEY(x) REFERENCES parent(id) ON DELETE RESTRICT NOT DEFERRABLE,
      CONSTRAINT third FOREIGN KEY(x) REFERENCES parent(other) ON DELETE CASCADE NOT DEFERRABLE);`);
  const keys = inspectSchema(db).tables.find((entry) => entry.name === 'child').foreignKeys;
  const first = keys.find((entry) => entry.name === 'first');
  assert.equal(first.onDelete, 'CASCADE');
  assert.equal(first.deferrable, true);
  assert.equal(first.initially, 'DEFERRED');
  assert.deepEqual(first.referenceColumns, ['id']);
  const second = keys.find((entry) => entry.name === 'second');
  assert.equal(second.onDelete, 'RESTRICT');
  assert.equal(second.deferrable, false);
  assert.deepEqual(keys.find((entry) => entry.name === 'third').referenceColumns, ['other']);
});

test('foreign-key and constraint sorting uses the dialect name rules', () => {
  const a = snapshot([table('child', [column('a'), column('B')], {
    foreignKeys: [fk('p', ['a']), fk('p', ['B'])],
    constraints: [{ kind: 'custom', columns: ['a'] }, { kind: 'custom', columns: ['B'] }],
  })]);
  const b = snapshot([table('CHILD', [column('A'), column('b')], {
    foreignKeys: [fk('P', ['A']), fk('P', ['b'])],
    constraints: [{ kind: 'custom', columns: ['A'] }, { kind: 'custom', columns: ['b'] }],
  })]);
  assert.equal(normalizeSchema(a).hash, normalizeSchema(b).hash);
  assert.deepEqual(diffSchemas(a, b), []);
});

test('dialect-specific aliases and custom type names are never assumed portable', () => {
  for (const dialect of ['sqlserver', 'other']) {
    for (const type of ['INT2', 'INT4', 'INT8']) {
      const changes = diffSchemas(snapshot([table('t', [column('x', { type })])], dialect),
        snapshot([table('t', [column('x', { type: 'BIGINT' })])], dialect));
      assert.equal(changes[0].severity, 'review', `${dialect} ${type}`);
    }
  }
});

test('expression and partial-index changes include consumers of non-key columns', () => {
  const a = snapshot([table('t', [column('id'), column('enabled')], {
    indexes: [{ name: 'ix', columns: ['id'], partial: true, definition: '(id) WHERE enabled = 1' }],
    constraints: [{ kind: 'check', columns: ['id'], expression: 'id > enabled' }],
  })]);
  const b = structuredClone(a);
  b.tables[0].indexes[0].definition = '(id) WHERE enabled = 2';
  b.tables[0].constraints[0].expression = 'id > enabled + 1';
  const asset = { id: 'enabled-query', references: [{ table: 't', column: 'enabled' }] };
  const changes = diffSchemas(a, b);
  for (const change of changes) assert.deepEqual(affectedAssets([change], [asset]), [asset], change.kind);
});

test('unknown dialect labels remain strings even when they match object property names', () => {
  for (const dialect of ['constructor', '__proto__']) {
    assert.equal(normalizeSchema(snapshot([], dialect)).dialect, dialect);
  }
});

test('typed defaults and added expression indexes need review', () => {
  for (const dialect of ['sqlite', 'postgresql']) {
    const before = snapshot([table('t', undefined, { strict: dialect === 'sqlite' })], dialect);
    const after = structuredClone(before);
    after.tables[0].columns.push(column('amount', { type: 'INTEGER', nullable: false, defaultValue: "'bad'" }));
    assert.equal(diffSchemas(before, after)[0].severity, 'review');
  }
  const before = snapshot([table('t')]);
  for (const index of [
    { name: 'ix', columns: [null], terms: [{ column: null, expression: 'json_extract(id, \'$.a\')' }] },
    { name: 'ix', columns: ['id'], partial: true, definition: '(id) WHERE json_valid(id)' },
  ]) {
    const after = snapshot([table('t', undefined, { indexes: [index] })]);
    assert.equal(diffSchemas(before, after)[0].severity, 'review');
  }
});

test('the default pruning budget rejects a 51-table bridge and oversized selections', () => {
  const tables = Array.from({ length: 51 }, (_, i) => table(`t${String(i).padStart(2, '0')}`, undefined,
    { foreignKeys: i < 50 ? [fk(`t${String(i + 1).padStart(2, '0')}`)] : [] }));
  const source = snapshot(tables);
  assert.throws(() => pruneSchema(source, ['t00', 't50']), (error) => {
    assert.equal(error.code, 'SCHEMA_BUDGET_EXCEEDED');
    assert.equal(error.maxTables, 50);
    assert.equal(error.requiredCount, 51);
    assert.deepEqual(error.requiredTables, tables.map((entry) => entry.name));
    return true;
  });
  assert.throws(() => pruneSchema(source, tables.map((entry) => entry.name)), { code: 'SCHEMA_BUDGET_EXCEEDED' });
});
