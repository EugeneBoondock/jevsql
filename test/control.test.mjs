import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { DecisionService } from '../src/decision-service.mjs';
import { ReceiptStore } from '../src/receipts.mjs';
import { redactState } from '../src/privacy.mjs';
import { inspectQuery, sqlMetadata } from '../src/sql-inspector.mjs';

const POLICY = { id: 'read-review', version: '1', questions: { matches: { type: 'noul', instructions: 'Does the query answer the request?' } }, accept: [{ question: 'matches', min: 0.9 }] };
function fixture({ fail = false, malformed = false } = {}) {
  return { model: 'jev-test-v1', calls: [], async evaluate(state, questions) {
    this.calls.push({ state, questions });
    if (fail) throw new Error('secret external response');
    return { model: this.model, answers: Object.fromEntries(Object.keys(questions).map((id) => [id, { type: 'noul', noul: malformed ? 9 : 0.98 }])), usage: { input_tokens: 100 } };
  } };
}

test('review policy, schema, model and expiry all participate in cache identity', async () => {
  const client = fixture(); let now = 1000;
  const service = new DecisionService({ client, now: () => now, cacheTtlMs: 50 });
  const a = await service.review(POLICY, { sql: 'select total' }, { context: { schemaVersion: '1' } });
  assert.equal(a.decision, 'eligible'); assert.equal(a.source, 'api');
  assert.equal((await service.review(POLICY, { sql: 'select total' }, { context: { schemaVersion: '1' } })).source, 'cache');
  await service.review(POLICY, { sql: 'select total' }, { context: { schemaVersion: '2' } });
  await service.review({ ...POLICY, version: '2' }, { sql: 'select total' });
  now += 51;
  await service.review(POLICY, { sql: 'select total' }, { context: { schemaVersion: '1' } });
  assert.equal(client.calls.length, 4);
  await service.close();
});

test('privacy minimisation happens before network and stored evidence', async () => {
  const client = fixture(), store = new ReceiptStore();
  const service = new DecisionService({ client, store });
  const receipt = await service.review(POLICY, { email: 'private@corp.example', log: 'Bearer abcdef send to person@corp.example', nested: { password: 'TOP_SECRET' } }, { includeEvidence: true });
  const data = JSON.stringify([client.calls, store.get(receipt.id)]);
  assert.doesNotMatch(data, /private@|person@|abcdef|TOP_SECRET/);
  assert.ok(receipt.privacy.redactions >= 3);
  await service.close(); store.close();
});

test('denied rules and dry runs never invoke the model or append receipts', async () => {
  const client = fixture(), store = new ReceiptStore(), service = new DecisionService({ client, store });
  const preview = await service.review(POLICY, { request: 'total' }, { dryRun: true });
  assert.equal(preview.decision, null); assert.equal(store.list().length, 0);
  const denied = await service.review(POLICY, {}, { findings: [{ level: 'block', code: 'denied' }] });
  assert.equal(denied.decision, 'block'); assert.equal(client.calls.length, 0);
  await service.close(); store.close();
});

test('provider faults and circuit opening route to review without leaking error text', async () => {
  const client = fixture({ fail: true }); let now = 1000;
  const service = new DecisionService({ client, now: () => now, circuitFailures: 2, circuitCooldownMs: 100 });
  for (let i = 0; i < 3; i++) {
    const receipt = await service.review(POLICY, {});
    assert.equal(receipt.decision, 'review'); assert.doesNotMatch(JSON.stringify(receipt), /secret external/);
  }
  assert.equal(client.calls.length, 2); assert.equal(service.status.circuitOpen, true);
  now += 101; await service.review(POLICY, {}); assert.equal(client.calls.length, 3);
  await service.close();
});

test('malformed answers, zero budgets and moving aliases cannot become eligible', async () => {
  const client = fixture({ malformed: true }), service = new DecisionService({ client });
  assert.equal((await service.review(POLICY, {})).decision, 'review');
  assert.equal(service.cache.size, 0);
  const budget = new DecisionService({ client, maxEstimatedCostUsd: 0 });
  const calls = client.calls.length;
  assert.equal((await budget.review(POLICY, {})).decision, 'review'); assert.equal(client.calls.length, calls);
  assert.throws(() => new DecisionService({ model: 'jev-latest' }), /versioned model/);
  await service.close(); await budget.close();
});

test('receipts preserve original decisions and feedback uses revision checks', async () => {
  const store = new ReceiptStore(), service = new DecisionService({ client: fixture(), store });
  const receipt = await service.review({ ...POLICY, accept: [] }, {});
  assert.equal(store.queue().length, 1);
  store.feedback(receipt.id, { reviewer: 'reviewer-1', label: false, reason: 'Wrong grain' });
  assert.equal(store.queue().length, 0); assert.equal(store.get(receipt.id).decision, 'review');
  assert.throws(() => store.feedback(receipt.id, { reviewer: 'reviewer-2', label: true }), /changed/);
  store.feedback(receipt.id, { reviewer: 'reviewer-2', label: true, expectedRevision: 1 });
  assert.equal(store.labels(receipt.id).length, 2); assert.equal(store.verify().ok, true);
  store.db.prepare('UPDATE _jevsql_receipts SET payload=? WHERE id=?').run('{}', receipt.id);
  assert.equal(store.verify().ok, false);
  await service.close(); store.close();
});

test('compiler inspection sees through views and does not run candidate functions', () => {
  const db = new DatabaseSync(':memory:'); let called = 0;
  db.exec('CREATE TABLE orders(id INTEGER PRIMARY KEY, total REAL); CREATE VIEW report AS SELECT id,total FROM orders; INSERT INTO orders VALUES (1,10)');
  db.function('untrusted', () => { called++; return 1; });
  const allowed = inspectQuery(db, 'WITH q AS (SELECT * FROM report) SELECT SUM(total) FROM q', { allowedTables: ['orders'] });
  assert.equal(allowed.valid, true); assert.deepEqual(allowed.tables, ['main.orders']); assert.equal(allowed.findings.length, 0);
  assert.ok(inspectQuery(db, 'SELECT * FROM report', { allowedTables: [] }).findings.some((f) => f.code === 'table_not_allowed'));
  assert.ok(inspectQuery(db, 'SELECT untrusted()').findings.some((f) => f.code === 'unapproved_function')); assert.equal(called, 0);
  assert.ok(inspectQuery(db, 'WITH q AS (SELECT 1) DELETE FROM orders RETURNING id').findings.some((f) => f.code === 'mutation'));
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM orders').get().n, 1);
  db.close();
});

test('SQL metadata removes comments, literals, dollar strings and embedded secrets', () => {
  const pg = sqlMetadata("SELECT $tag$private@corp.example$tag$, 123 /* outer /* inner */ data */ FROM orders", { dialect: 'postgresql' });
  assert.doesNotMatch(pg.sql, /private|123|outer|inner/); assert.equal(pg.literalsRemoved, 2);
  const mysql = sqlMetadata('SELECT "private", ? FROM `orders` # hidden', { dialect: 'mysql' });
  assert.doesNotMatch(mysql.sql, /private|hidden/); assert.match(mysql.sql, /`orders`/);
  assert.deepEqual(redactState({ visible: 'ok', hidden: 'bad' }, { allowFields: ['visible'] }).state, { visible: 'ok' });
});
