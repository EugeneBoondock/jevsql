import test from 'node:test';
import assert from 'node:assert/strict';
import { JevSQL } from '../src/engine.mjs';
import { SQLiteAdapter } from '../src/adapters.mjs';
import { DecisionService } from '../src/decision-service.mjs';
import { GovernedQueries } from '../src/governed-queries.mjs';
import { compileTemplate, parameterValue } from '../src/query-compiler.mjs';
import { normalizeSchema } from '../src/schema.mjs';

const ACTOR = { id: 'analyst-a', roles: ['analyst'], tenantId: 'a' };
const TEMPLATE = { id: 'orders', version: '1', description: 'List tenant orders above a minimum total.', roles: ['analyst'],
  params: { minimum: { type: 'number', min: 0 } }, query: { from: 'orders',
    select: [{ column: 'id', as: 'id' }, { column: 'total', as: 'total' }],
    filters: [{ column: 'total', op: 'gte', param: 'minimum' }], orderBy: [{ column: 'id' }], limit: 10 } };

function fixture(t, options = {}) {
  const engine = new JevSQL();
  engine.exec(`CREATE TABLE orders(id INTEGER PRIMARY KEY, tenant_id TEXT NOT NULL, total REAL);
    INSERT INTO orders VALUES(1,'a',50),(2,'b',100),(3,'a',80);
    CREATE TABLE lines(id INTEGER PRIMARY KEY, tenant_id TEXT NOT NULL, order_id INTEGER REFERENCES orders(id), amount REAL);
    INSERT INTO lines VALUES(1,'a',1,30),(2,'a',1,20),(3,'b',1,500);`);
  const client = { model: 'jev-test-1', calls: 0, async evaluate(state, questions) {
    this.calls++;
    return { model: this.model, usage: { input_tokens: 10 }, answers: Object.fromEntries(Object.entries(questions).map(([id, q]) => [id,
      q.type === 'noul' ? { type: 'noul', noul: options.probability ?? 0.99 } : { type: 'choice', choice: 'routine_read', confidence: 0.99,
        probabilities: Object.fromEntries(Object.keys(q.criteria).map((label) => [label, label === 'routine_read' ? 0.98 : 0.01])) }])) };
  } };
  const service = new DecisionService({ client });
  const adapter = new SQLiteAdapter(engine);
  const gate = new GovernedQueries({ service, adapter, templates: [TEMPLATE], allowExecution: true, ...options });
  t.after(async () => { await service.close(); engine.close(); });
  return { engine, client, service, adapter, gate };
}
const prepare = (gate, extra = {}) => gate.prepare('orders', { request: 'Show orders with total at least 60', actor: ACTOR, params: { minimum: 60 }, ...extra });

test('typed request executes a bound, tenant-scoped read with a single-use permit', async (t) => {
  const { gate, client } = fixture(t);
  const result = await prepare(gate);
  assert.equal(result.decision, 'eligible'); assert.ok(result.permit);
  const read = await gate.execute(result.permit, { actor: ACTOR, params: { minimum: 60 } });
  assert.deepEqual(read.rows.map((row) => row.id), [3]);
  await assert.rejects(() => gate.execute(result.permit, { actor: ACTOR, params: { minimum: 60 } }), /consumed/);
  assert.equal(client.calls, 1);
});

test('wrong roles, missing tenants and invalid parameters stop before the model', async (t) => {
  const { gate, client } = fixture(t);
  await assert.rejects(() => prepare(gate, { actor: { ...ACTOR, roles: ['guest'] } }), /not allowed/);
  await assert.rejects(() => prepare(gate, { actor: { ...ACTOR, tenantId: null } }), /tenant/);
  await assert.rejects(() => prepare(gate, { params: { minimum: '0 OR 1=1' } }), /finite number/);
  await assert.rejects(() => prepare(gate, { params: { minimum: 0, extra: 3 } }), /Unknown parameter/);
  assert.equal(client.calls, 0);
});

test('permit is bound to caller, tenant, roles, parameters, expiry, and signature', async (t) => {
  let now = 1000;
  const { gate } = fixture(t, { now: () => now, permitTtlMs: 10 });
  const { permit } = await prepare(gate);
  for (const actor of [{ ...ACTOR, tenantId: 'b' }, { ...ACTOR, id: 'someone' }, { ...ACTOR, roles: ['admin'] }]) {
    await assert.rejects(() => gate.execute(permit, { actor, params: { minimum: 60 } }), /changed/);
  }
  await assert.rejects(() => gate.execute(permit, { actor: ACTOR, params: { minimum: 0 } }), /changed/);
  await assert.rejects(() => gate.execute({ ...permit, signature: '0'.repeat(64) }, { actor: ACTOR, params: { minimum: 60 } }), /Invalid/);
  now += 10;
  await assert.rejects(() => gate.execute(permit, { actor: ACTOR, params: { minimum: 60 } }), /expired/);
});

test('schema and template changes invalidate reviewed reads', async (t) => {
  const { gate, engine } = fixture(t);
  const first = await prepare(gate);
  engine.exec('ALTER TABLE orders ADD COLUMN notes TEXT');
  await assert.rejects(() => gate.execute(first.permit, { actor: ACTOR, params: { minimum: 60 } }), /Schema changed/);
  const second = await prepare(gate);
  assert.throws(() => gate.register({ ...TEMPLATE, description: 'Changed' }), /new version/);
  gate.register({ ...TEMPLATE, version: '2' });
  await assert.rejects(() => gate.execute(second.permit, { actor: ACTOR, params: { minimum: 60 } }), /Template changed/);
});

test('advisory mode, ambiguity and dry runs never yield an execution permit', async (t) => {
  const { gate, client } = fixture(t, { allowExecution: false });
  assert.equal((await prepare(gate, { dryRun: true })).permit, null); assert.equal(client.calls, 0);
  assert.equal((await prepare(gate)).permit, null);
  const other = fixture(t, { probability: 0.5 });
  assert.equal((await prepare(other.gate)).permit, null);
  assert.equal((await other.gate.route('Different question', { actor: ACTOR, params: { minimum: 60 } })).decision, 'review');
});

test('compiler guards aggregate grain and scopes right-side tenant checks inside left joins', (t) => {
  const { adapter } = fixture(t), schema = adapter.snapshot();
  const bad = { ...TEMPLATE, params: {}, query: { from: 'orders', select: [{ aggregate: 'sum', column: 'orders.total', as: 'total' }],
    joins: [{ table: 'lines', on: ['orders.id', 'lines.order_id'] }] } };
  assert.throws(() => compileTemplate(bad, schema, { actor: ACTOR }), /multiply aggregate/);
  const good = { ...TEMPLATE, params: {}, query: { from: 'lines', select: [{ aggregate: 'sum', column: 'lines.amount', as: 'total' }],
    joins: [{ table: 'orders', on: ['lines.order_id', 'orders.id'], type: 'left' }] } };
  const compiled = compileTemplate(good, schema, { actor: ACTOR });
  assert.match(compiled.sql, /LEFT JOIN.*ON.*tenant_id.*WHERE/);
  assert.equal(adapter.read(compiled).rows[0].total, 50);
});

test('compiler produces dialect-specific bindings and cannot accept raw SQL or forged compiler output', (t) => {
  const { adapter } = fixture(t);
  for (const dialect of ['postgresql', 'mysql', 'sqlite']) {
    const schema = normalizeSchema({ ...adapter.snapshot(), dialect });
    const query = compileTemplate(TEMPLATE, schema, { actor: ACTOR, params: { minimum: 60 } });
    assert.deepEqual(query.values, ['a', 60, 10]);
    assert.match(query.sql, dialect === 'postgresql' ? /\$1.*\$2.*\$3/ : /\?.*\?.*\?/);
    assert.ok(Object.isFrozen(query)); assert.ok(Object.isFrozen(query.values));
  }
  assert.throws(() => compileTemplate({ ...TEMPLATE, query: { ...TEMPLATE.query, raw: 'DROP TABLE orders' } }, adapter.snapshot(), { actor: ACTOR, params: { minimum: 0 } }), /Unsupported query field/);
  assert.throws(() => adapter.read({ dialect: 'sqlite', sql: 'DROP TABLE orders' }), /unchanged query/);
  assert.throws(() => parameterValue('2026-02-30', { type: 'date' }, 'date'), /real ISO date/);
});

test('concurrent attempts cannot reuse a permit while the adapter is awaiting IO', async (t) => {
  const { gate, adapter } = fixture(t);
  const original = adapter.read.bind(adapter);
  let unblock; const pending = new Promise((resolve) => { unblock = resolve; });
  adapter.read = async (...args) => { await pending; return original(...args); };
  const { permit } = await prepare(gate);
  const first = gate.execute(permit, { actor: ACTOR, params: { minimum: 60 } });
  await assert.rejects(() => gate.execute(permit, { actor: ACTOR, params: { minimum: 60 } }), /consumed/);
  unblock(); assert.equal((await first).rows.length, 1);
});
