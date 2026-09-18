// Regression cases for defects found by auditing the project against the three
// research documents. Each one asserts on what actually leaves the process — the
// outbound request, the compiled SQL, the integrity log — not only on the rows a
// caller finally receives, because several of these defects were invisible there.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { JevSQL } from '../src/engine.mjs';
import { JevClient } from '../src/client.mjs';
import { DecisionService } from '../src/decision-service.mjs';
import { DatabaseControl } from '../src/control-plane.mjs';
import { GovernedQueries } from '../src/governed-queries.mjs';
import { SQLiteAdapter } from '../src/adapters.mjs';
import { ReceiptStore } from '../src/receipts.mjs';
import { compileTemplate } from '../src/query-compiler.mjs';
import { incidentPolicy, policyFor } from '../src/policies.mjs';
import { inspectQuery, classifyStatement } from '../src/sql-inspector.mjs';
import { relaxForCollect } from '../src/rewrite.mjs';
import { validateAnswer } from '../src/validation.mjs';
import { normalizeSchema, diffSchemas } from '../src/schema.mjs';
import { redactState } from '../src/privacy.mjs';
import { startMockServer } from './mock-server.mjs';

/** Everything any question was asked about, across every outbound request. */
function outboundText(calls) {
  return JSON.stringify(calls);
}

function provider(answerFor) {
  return { model: 'jev-test-v1', calls: [], async evaluate(state, questions) {
    this.calls.push({ state, questions });
    return { model: this.model, usage: { input_tokens: 10 },
      answers: Object.fromEntries(Object.entries(questions).map(([id, question]) => [id, answerFor(question, id)])) };
  } };
}

const yes = (question) => {
  if (question.type === 'noul') return { type: 'noul', noul: 0.99 };
  if (question.type === 'choice') {
    const labels = Object.keys(question.criteria);
    return { type: 'choice', choice: labels[0], confidence: 0.99,
      probabilities: Object.fromEntries(labels.map((label, i) => [label, i === 0 ? 1 : 0])) };
  }
  const levels = question.criteria;
  return { type: 'score', score: 0, confidence: 0.99,
    probabilities: Object.fromEntries(levels.map((_, i) => [String(i), i === 0 ? 1 : 0])) };
};

// F1: a grouped tenant predicate must keep filtering during the collect pass.
test('a grouped authorization predicate still narrows which rows are judged', async (t) => {
  const mock = await startMockServer();
  const engine = new JevSQL({ client: new JevClient({ apiKey: 'k', baseUrl: mock.baseUrl, model: 'jev-test' }) });
  t.after(async () => { engine.close(); await mock.close(); });
  engine.exec('CREATE TABLE notes(id INTEGER PRIMARY KEY, tenant_id INTEGER, body TEXT)');
  const insert = engine.prepare('INSERT INTO notes VALUES (?,?,?)');
  insert.run(1, 1, 'tenant one is furious about a refund');
  insert.run(2, 2, 'tenant two is furious about a refund');

  const sql = "SELECT id FROM notes WHERE (tenant_id = 1 AND jev_bool(body, 'Is this customer angry?') = 1)";
  const { rows, stats } = await engine.query(sql);
  assert.deepEqual(rows.map((row) => row.id), [1]);
  assert.deepEqual(stats.widened, [], 'Descending into the group must not widen anything');
  const sent = outboundText(mock.calls);
  assert.match(sent, /tenant one/);
  assert.doesNotMatch(sent, /tenant two/, 'Another tenant’s text must never reach the provider');
});

test('a clause that cannot be split is reported as widened and refused when strict', async (t) => {
  const mock = await startMockServer();
  const make = (options) => new JevSQL({ client: new JevClient({ apiKey: 'k', baseUrl: mock.baseUrl, model: 'jev-test' }), ...options });
  const engine = make({}), strict = make({ strictCollect: true });
  t.after(async () => { engine.close(); strict.close(); await mock.close(); });
  for (const db of [engine, strict]) {
    db.exec('CREATE TABLE notes(id INTEGER PRIMARY KEY, tenant_id INTEGER, body TEXT)');
    db.prepare('INSERT INTO notes VALUES (?,?,?)').run(1, 1, 'a furious refund request');
  }
  const sql = "SELECT id FROM notes WHERE tenant_id = 1 OR jev_bool(body, 'Is this customer angry?') = 1";
  const { stats } = await engine.query(sql);
  assert.deepEqual(stats.widened, ['WHERE']);
  await assert.rejects(strict.query(sql), /cannot be relaxed without also widening/);
});

test('relaxForCollect keeps non-judgment conditions inside nested groups', () => {
  const { sql, widened } = relaxForCollect("SELECT id FROM t WHERE (a = 1 AND (b = 2 AND jev_noul(x, 'q') > 0.5))");
  assert.deepEqual(widened, []);
  assert.match(sql, /a = 1/);
  assert.match(sql, /b = 2/);
  assert.match(sql, /OR 1=1/);
});

// F2: an unrecognised tenant column must refuse, not silently drop the predicate.
test('an unclassified table refuses to compile for a tenant-scoped actor', () => {
  const schema = normalizeSchema({ dialect: 'sqlite', tables: [
    { name: 'invoices', columns: [{ name: 'id', type: 'INTEGER', primaryKey: 1 }, { name: 'account_id', type: 'INTEGER' }, { name: 'total', type: 'REAL' }] },
  ] });
  const template = { id: 'totals', version: '1', description: 'Invoice totals', roles: ['analyst'],
    params: { minimum: { type: 'number' } },
    query: { from: 'invoices', select: [{ column: 'id', as: 'id' }], filters: [{ column: 'total', op: 'gte', param: 'minimum' }] } };
  const actor = { id: 'a', roles: ['analyst'], tenantId: 'tenant-a' };
  assert.throws(() => compileTemplate(template, schema, { actor, params: { minimum: 0 } }),
    /has no tenant classification/);
  const scoped = compileTemplate(template, schema, { actor, params: { minimum: 0 }, tenantColumns: { invoices: 'account_id' } });
  assert.match(scoped.sql, /"account_id" = \?/);
  assert.deepEqual(scoped.tenantScopedTables, ['invoices']);
  const shared = compileTemplate(template, schema, { actor, params: { minimum: 0 }, tenantColumns: { invoices: null } });
  assert.doesNotMatch(shared.sql, /account_id/);
  assert.deepEqual(shared.sharedTables, ['invoices']);
});

test('a tenant column is recognised however the catalog cases it', () => {
  const schema = normalizeSchema({ dialect: 'sqlite', tables: [
    { name: 'notes', columns: [{ name: 'id', type: 'INTEGER', primaryKey: 1 }, { name: 'TENANT_ID', type: 'TEXT' }, { name: 'body', type: 'TEXT' }] },
  ] });
  const compiled = compileTemplate({ id: 'n', version: '1', description: 'Notes', roles: ['analyst'],
    params: { id: { type: 'integer' } },
    query: { from: 'notes', select: [{ column: 'body', as: 'body' }], filters: [{ column: 'id', op: 'eq', param: 'id' }] } },
  schema, { actor: { id: 'a', roles: ['analyst'], tenantId: 't1' }, params: { id: 1 } });
  assert.deepEqual(compiled.tenantScopedTables, ['notes']);
  assert.match(compiled.sql, /"TENANT_ID" = \?/);
});

// F3: question text reaches the provider exactly like state does.
test('runbook descriptions are redacted before they reach the provider or a receipt', async () => {
  const client = provider(yes), store = new ReceiptStore();
  const service = new DecisionService({ client, store });
  const runbooks = [{ id: 'restore', description: 'Reconnect with password=hunter2 and notify oncall@corp.example' },
    { id: 'failover', description: 'Promote the standby' }];
  const receipt = await service.review(incidentPolicy(runbooks), { evidence: 'replica lag rising' }, { includeEvidence: true });
  const exposed = JSON.stringify([client.calls, store.get(receipt.id)]);
  assert.doesNotMatch(exposed, /hunter2|oncall@corp\.example/);
  assert.ok(receipt.privacy.questionRedactions >= 1);
  // The option labels are part of the answer contract and must survive intact.
  assert.deepEqual(Object.keys(client.calls[0].questions.runbook.criteria).sort(), ['failover', 'restore', 'unknown']);
  await service.close(); store.close();
});

// F4: a uniqueness proof only holds under the collation that enforces it.
test('a collation mismatch makes a join multiplicative instead of aggregable', () => {
  const schema = normalizeSchema({ dialect: 'sqlite', tables: [
    { name: 'orders', columns: [{ name: 'id', type: 'INTEGER', primaryKey: 1 },
      { name: 'code', type: 'TEXT', collation: 'NOCASE' }, { name: 'amount', type: 'REAL' }],
      foreignKeys: [{ columns: ['code'], referenceTable: 'customers', referenceColumns: ['code'] }] },
    { name: 'customers', columns: [{ name: 'code', type: 'TEXT', unique: true }],
      indexes: [{ name: 'customers_code', columns: ['code'], unique: true, terms: [{ column: 'code', collation: 'BINARY' }] }] },
  ] });
  const template = (aggregate) => ({ id: 'sum', version: '1', description: 'Order totals', roles: ['analyst'],
    params: { id: { type: 'integer' } },
    query: { from: 'orders', joins: [{ table: 'customers', on: [['orders.code', 'customers.code']] }],
      select: aggregate ? [{ column: 'orders.amount', as: 'total', aggregate: 'sum' }] : [{ column: 'orders.amount', as: 'amount' }],
      filters: [{ column: 'orders.id', op: 'eq', param: 'id' }] } });
  const actor = { id: 'a', roles: ['analyst'] };
  assert.throws(() => compileTemplate(template(true), schema, { actor, params: { id: 1 } }),
    /can multiply aggregate rows/);
  // A plain projection is unaffected; only the aggregate needed the proof.
  assert.match(compileTemplate(template(false), schema, { actor, params: { id: 1 } }).sql, /SELECT/);
});

test('a matching collation still proves a join cannot multiply an aggregate', () => {
  const schema = normalizeSchema({ dialect: 'sqlite', tables: [
    { name: 'orders', columns: [{ name: 'id', type: 'INTEGER', primaryKey: 1 },
      { name: 'code', type: 'TEXT', collation: 'BINARY' }, { name: 'amount', type: 'REAL' }],
      foreignKeys: [{ columns: ['code'], referenceTable: 'customers', referenceColumns: ['code'] }] },
    { name: 'customers', columns: [{ name: 'code', type: 'TEXT', collation: 'BINARY', primaryKey: 1 }] },
  ] });
  const compiled = compileTemplate({ id: 'sum', version: '1', description: 'Order totals', roles: ['analyst'],
    params: { id: { type: 'integer' } },
    query: { from: 'orders', joins: [{ table: 'customers', on: [['orders.code', 'customers.code']] }],
      select: [{ column: 'orders.amount', as: 'total', aggregate: 'sum' }],
      filters: [{ column: 'orders.id', op: 'eq', param: 'id' }] } },
  schema, { actor: { id: 'a', roles: ['analyst'] }, params: { id: 1 } });
  assert.match(compiled.sql, /SUM\(/);
});

// F5: a denied column must be detected whatever physical layout it is read from.
test('denied columns are detected through rowid aliases and WITHOUT ROWID layouts', () => {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE ri(id INTEGER PRIMARY KEY, other TEXT)');
  db.exec('CREATE TABLE wr(a TEXT, secret TEXT, b TEXT, PRIMARY KEY(b,a)) WITHOUT ROWID');
  const blocked = (sql, denied) => inspectQuery(db, sql, { deniedColumns: denied })
    .findings.some((finding) => finding.code === 'column_not_allowed');

  assert.equal(blocked('SELECT id FROM ri', ['ri.id']), true, 'An INTEGER PRIMARY KEY is read as a rowid');
  assert.equal(blocked('SELECT other FROM ri', ['ri.id']), false);
  assert.equal(blocked('SELECT secret FROM wr', ['wr.secret']), true, 'WITHOUT ROWID rows are stored key-first');
  assert.equal(blocked('SELECT secret FROM wr', ['wr.b']), false, 'The old layout named wr.b for this read');
  assert.deepEqual(inspectQuery(db, 'SELECT secret FROM wr').columns, ['main.wr.secret']);
  db.close();
});

// F6: a contradictory Choice answer must not be able to satisfy a gate.
test('a choice that is not its own highest-probability option is rejected', () => {
  const question = { kind: 'choice', criteria: { routine_read: 'ok', ambiguous: 'unclear' } };
  assert.throws(() => validateAnswer({ type: 'choice', choice: 'routine_read', confidence: 1,
    probabilities: { routine_read: 0, ambiguous: 1 } }, question), /highest-probability/);
  // A tie within tolerance stays acceptable.
  assert.doesNotThrow(() => validateAnswer({ type: 'choice', choice: 'routine_read', confidence: 0.5,
    probabilities: { routine_read: 0.5, ambiguous: 0.5 } }, question));
});

// F7: a human label decides what a receipt meant, so edits to it must be detected.
test('the integrity log covers human labels as well as receipts', () => {
  const store = new ReceiptStore();
  const receipt = { id: 'r1', kind: 'test', decision: 'review', createdAt: new Date().toISOString() };
  store.append(receipt);
  store.feedback('r1', { reviewer: 'dba', label: 'unsafe', reason: 'cross tenant' });
  const before = store.verify();
  assert.equal(before.ok, true);
  assert.equal(before.feedbackCount, 1);

  store.db.exec("UPDATE _jevsql_feedback SET label = '\"safe\"', reviewer = 'someone-else'");
  assert.equal(store.verify().ok, false, 'An edited label must break verification');
  store.close();
});

test('a label appended straight to the table, bypassing the log, is detected', () => {
  const store = new ReceiptStore();
  store.append({ id: 'r1', kind: 'test', decision: 'review', createdAt: new Date().toISOString() });
  store.db.prepare('INSERT INTO _jevsql_feedback VALUES (?,?,?,?,?,?,?)')
    .run('f-forged', 'r1', 1, 'ghost', '"safe"', '', new Date().toISOString());
  const result = store.verify();
  assert.equal(result.ok, false);
  assert.deepEqual(result.unlogged, { kind: 'feedback', id: 'f-forged' });
  store.close();
});

// F8: a reordered catalog must not hash identically to the original.
test('remote-style snapshots keep column positions, so reordering is a change', () => {
  const columns = [{ name: 'id', type: 'integer', primaryKey: 1, position: 0 },
    { name: 'email', type: 'text', position: 1 }];
  const before = { dialect: 'postgresql', tables: [{ name: 'public.users', columns }] };
  const after = { dialect: 'postgresql', tables: [{ name: 'public.users',
    columns: [{ ...columns[1], position: 0 }, { ...columns[0], position: 1 }] }] };
  assert.notEqual(normalizeSchema(before).hash, normalizeSchema(after).hash);
  assert.ok(diffSchemas(before, after).some((change) => change.kind === 'column_order_changed'));
});

// The guardrail proposed as the highest-value pattern in the first document.
test('the statement guardrail classifies deterministically and never permits execution', async () => {
  // A cooperative provider: the statement looks safe and matches its intent, so
  // only the deterministic classification decides what needs approval.
  const risky = ['destructive', 'affects_shared_data', 'unexpected_for_actor'];
  const client = provider((question, id) => question.type === 'noul'
    ? { type: 'noul', noul: risky.includes(id) ? 0.01 : 0.99 } : yes(question));
  const service = new DecisionService({ client });
  const control = new DatabaseControl({ service });

  const read = await control.reviewStatement({ statement: 'SELECT id FROM orders WHERE id = 1',
    intent: 'Read one order', dialect: 'postgresql', environment: 'staging' });
  assert.equal(read.classification.operation, 'read');
  assert.equal(read.requiredApproval, 'none');
  assert.equal(read.executionAllowed, false);
  assert.equal(read.decision, 'eligible');

  const destructive = await control.reviewStatement({ statement: 'DROP TABLE customers',
    intent: 'Remove an unused table', dialect: 'postgresql', environment: 'production' });
  assert.equal(destructive.classification.operation, 'schema');
  assert.equal(destructive.classification.destructive, true);
  assert.equal(destructive.requiredApproval, 'out_of_band_human');
  assert.equal(destructive.decision, 'review', 'A confident model answer cannot make this eligible');
  assert.equal(destructive.statementExecuted, false);

  const hidden = await control.reviewStatement({ statement: 'WITH gone AS (DELETE FROM orders RETURNING id) SELECT count(*) FROM gone',
    intent: 'Count orders', dialect: 'postgresql', environment: 'production' });
  assert.equal(hidden.classification.operation, 'delete', 'A writable CTE is not a read');
  assert.equal(hidden.requiredApproval, 'out_of_band_human');

  const batch = await control.reviewStatement({ statement: 'INSERT INTO audit(id) VALUES (1); DROP TABLE t',
    intent: 'Record an audit row', dialect: 'postgresql' });
  assert.equal(batch.decision, 'block');
  assert.equal(batch.requiredApproval, 'refused');
  assert.equal(batch.source, 'rules', 'A refused batch costs no model request');
  await service.close();
});

test('every named review preset defines usable typed questions', () => {
  for (const kind of ['statement', 'orm', 'cost', 'secrets']) {
    const policy = policyFor(kind);
    assert.ok(Object.keys(policy.questions).length > 0, kind);
    for (const question of Object.values(policy.questions)) {
      assert.ok(['noul', 'choice', 'score'].includes(question.type));
    }
  }
});

test('a governed read still reports the scope it actually enforced', async (t) => {
  const engine = new JevSQL({});
  t.after(() => engine.close());
  engine.exec('CREATE TABLE notes(id INTEGER PRIMARY KEY, tenant_id TEXT, body TEXT)');
  engine.prepare('INSERT INTO notes VALUES (?,?,?)').run(1, 'a', 'first');
  engine.prepare('INSERT INTO notes VALUES (?,?,?)').run(2, 'b', 'second');
  const client = provider(yes);
  const service = new DecisionService({ client });
  const gate = new GovernedQueries({ service, adapter: new SQLiteAdapter(engine), allowExecution: true,
    templates: [{ id: 'notes', version: '1', description: 'Notes for the current tenant', roles: ['analyst'],
      params: { id: { type: 'integer' } },
      query: { from: 'notes', select: [{ column: 'body', as: 'body' }], filters: [{ column: 'id', op: 'gte', param: 'id' }] } }] });
  const actor = { id: 'user-a', roles: ['analyst'], tenantId: 'a' };
  const prepared = await gate.prepare('notes', { request: 'Show my notes', actor, params: { id: 0 } });
  assert.deepEqual(client.calls.at(-1).state.enforced_scope.tenantFilteredTables, ['notes']);
  const { rows } = await gate.execute(prepared.permit, { actor, params: { id: 0 } });
  assert.deepEqual(rows.map((row) => row.body), ['first']);
  await service.close();
});

test('card numbers are redacted, and numbers that only look like cards are not', () => {
  const { state, redactions } = redactState({
    note: 'Card 4111 1111 1111 1111 declined', dashed: 'try 4111-1111-1111-1111',
    amex: '378282246310005', order: 'Order number 1234567890123456 shipped',
    invoice: 'invoice 2026001234567 is overdue',
  });
  assert.match(state.note, /Card \[card removed\] declined/);
  assert.match(state.dashed, /\[card removed\]/);
  assert.equal(state.amex, '[card removed]');
  // A Luhn check keeps identifiers of the same length intact.
  assert.equal(state.order, 'Order number 1234567890123456 shipped');
  assert.equal(state.invoice, 'invoice 2026001234567 is overdue');
  assert.equal(redactions, 3);
});
