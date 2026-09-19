// A LIMIT without a definite ordering returns an arbitrary window. The rows
// are whichever ones the plan reached first, so the same approved template can
// answer with a different set after an index appears — no error, no warning.
//
// These tests pin the analysis and, in the last one, the defect itself: two
// disjoint answers from one compiled statement.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { compileTemplate } from '../src/query-compiler.mjs';
import { inspectSchema } from '../src/schema.mjs';

const ACTOR = { id: 'analyst-a', roles: ['analyst'], tenantId: 'a' };

function fixture(t, ddl = '') {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE orders(id INTEGER PRIMARY KEY, tenant_id TEXT NOT NULL, status TEXT, total REAL);
    CREATE TABLE lines(id INTEGER PRIMARY KEY, tenant_id TEXT NOT NULL, order_id INTEGER REFERENCES orders(id), amount REAL);
    CREATE TABLE codes(code TEXT, tenant_id TEXT NOT NULL, label TEXT);
    CREATE UNIQUE INDEX codes_code ON codes(code);
    ${ddl}`);
  t.after(() => db.close());
  return db;
}

const compile = (db, query, options = {}) => compileTemplate(
  { id: 'page', version: '1', description: 'A page of orders.', roles: ['analyst'], params: {}, query },
  inspectSchema(db), { actor: ACTOR, params: {}, ...options },
);

test('a limit with no ordering reports an arbitrary window and names the remedy', (t) => {
  const db = fixture(t);
  const compiled = compile(db, { from: 'orders', select: [{ column: 'id', as: 'id' }], limit: 3 });
  assert.equal(compiled.ordering.total, false);
  assert.deepEqual(compiled.ordering.missing, [['orders.id']]);
});

test('ordering by a non-unique column is still an arbitrary window', (t) => {
  const db = fixture(t);
  const compiled = compile(db, { from: 'orders', limit: 3,
    select: [{ column: 'id', as: 'id' }, { column: 'status', as: 'status' }], orderBy: [{ column: 'status' }] });
  assert.equal(compiled.ordering.total, false, 'an ORDER BY that leaves ties settles nothing');
});

test('ordering by the primary key is total', (t) => {
  const db = fixture(t);
  const compiled = compile(db, { from: 'orders', select: [{ column: 'id', as: 'id' }], orderBy: [{ column: 'id' }], limit: 3 });
  assert.equal(compiled.ordering.total, true);
  assert.deepEqual(compiled.ordering.missing, []);
});

test('a unique index counts as a key, and a nullable one does not', (t) => {
  // SQLite treats every NULL in a unique index as distinct, so a nullable
  // unique column admits any number of rows and orders none of them.
  const db = fixture(t);
  const compiled = compile(db, { from: 'codes', select: [{ column: 'code', as: 'code' }], orderBy: [{ column: 'code' }], limit: 3 });
  assert.equal(compiled.ordering.total, false, 'codes.code is unique but nullable');

  const tightened = fixture(t, 'DROP TABLE codes; CREATE TABLE codes(code TEXT NOT NULL, tenant_id TEXT NOT NULL, label TEXT); CREATE UNIQUE INDEX codes_code ON codes(code);');
  const strict = compile(tightened, { from: 'codes', select: [{ column: 'code', as: 'code' }], orderBy: [{ column: 'code' }], limit: 3 });
  assert.equal(strict.ordering.total, true, 'the same index over a NOT NULL column is a key');
});

test('an aggregate with no grouping is one row, so anything orders it', (t) => {
  const db = fixture(t);
  const compiled = compile(db, { from: 'orders', select: [{ column: '*', as: 'n', aggregate: 'count' }], limit: 3 });
  assert.equal(compiled.ordering.total, true);
  assert.equal(compiled.ordering.reason, 'single-row aggregate');
});

test('a grouped query is ordered by its groups, not by its aggregate', (t) => {
  const db = fixture(t);
  const select = [{ column: 'status', as: 'status' }, { column: '*', as: 'n', aggregate: 'count' }];
  const byGroup = compile(db, { from: 'orders', select, groupBy: ['status'], orderBy: [{ column: 'status' }], limit: 3 });
  assert.equal(byGroup.ordering.total, true);

  // "Top N by count" is the most common shape of this bug: two groups with the
  // same count swap places between runs, so the tenth row is whichever one the
  // plan reached first.
  const byCount = compile(db, { from: 'orders', select, groupBy: ['status'], orderBy: [{ column: 'n', direction: 'desc' }], limit: 3 });
  assert.equal(byCount.ordering.total, false);
  assert.deepEqual(byCount.ordering.missing, [['orders.status']]);
});

test('a multiplicative join needs a key from both sides', (t) => {
  const db = fixture(t);
  const query = { from: 'orders', limit: 3,
    select: [{ column: 'orders.id', as: 'oid' }, { column: 'lines.id', as: 'lid' }],
    joins: [{ table: 'lines', on: [['orders.id', 'lines.order_id']], type: 'inner' }] };
  const baseOnly = compile(db, { ...query, orderBy: [{ column: 'oid' }] });
  assert.equal(baseOnly.ordering.total, false, 'one order can match many lines');
  assert.deepEqual(baseOnly.ordering.missing, [['lines.id']]);

  const both = compile(db, { ...query, orderBy: [{ column: 'oid' }, { column: 'lid' }] });
  assert.equal(both.ordering.total, true);
});

test('requireTotalOrder refuses, and says what would settle it', (t) => {
  const db = fixture(t);
  assert.throws(() => compile(db, { from: 'orders', select: [{ column: 'id', as: 'id' }], limit: 3 }, { requireTotalOrder: true }),
    /arbitrary window.*Order by orders\.id/s);
  const compiled = compile(db, { from: 'orders', select: [{ column: 'id', as: 'id' }], orderBy: [{ column: 'id' }], limit: 3 }, { requireTotalOrder: true });
  assert.equal(compiled.ordering.total, true);
});

test('the window it warns about is real: one statement, two disjoint answers', (t) => {
  const db = fixture(t);
  db.exec(`INSERT INTO orders VALUES (1,'a','open',60),(2,'a','open',50),(3,'a','open',40),
    (4,'a','open',30),(5,'a','open',20),(6,'a','open',10);`);
  const compiled = compile(db, { from: 'orders', limit: 3,
    select: [{ column: 'id', as: 'id' }, { column: 'status', as: 'status' }], orderBy: [{ column: 'status' }] });
  assert.equal(compiled.ordering.total, false);

  const answer = () => db.prepare(compiled.sql).all(...compiled.values).map((row) => row.id).join(',');
  const before = answer();
  // An index the planner will use. Ties inside `status` now come out in index
  // order rather than rowid order, and the window moves to the other end.
  db.exec('CREATE INDEX orders_cov ON orders(tenant_id, status, total);');
  const after = answer();

  assert.notEqual(before, after, 'the same approved SQL returned the same rows; the fixture no longer demonstrates the defect');
  assert.deepEqual(before.split(',').filter((id) => after.split(',').includes(id)), [],
    'the two answers should share no rows at all');
});
