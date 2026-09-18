import test from 'node:test';
import assert from 'node:assert/strict';
import { JevSQL } from '../src/engine.mjs';
import { DecisionService, DatabaseControl, compareReads } from '../src/control-plane.mjs';
import { POLICY_KINDS, policyFor } from '../src/policies.mjs';
import { definePolicy } from '../src/decision-service.mjs';

function fixture(t) {
  const engine = new JevSQL();
  engine.exec(`CREATE TABLE orders(id INTEGER PRIMARY KEY, total REAL); INSERT INTO orders VALUES(1,10),(2,10);`);
  const client = { model: 'jev-test-1', calls: [], async evaluate(state, questions) {
    this.calls.push({ state, questions });
    return { model: this.model, usage: { input_tokens: 10 }, answers: Object.fromEntries(Object.entries(questions).map(([id, q]) => {
      if (q.type === 'noul') return [id, { type: 'noul', noul: id.includes('risk') || id === 'overscoped' ? 0.01 : 0.99 }];
      const labels = q.type === 'choice' ? Object.keys(q.criteria) : q.criteria.map((_, index) => String(index));
      return [id, { type: q.type, confidence: 0.99, probabilities: Object.fromEntries(labels.map((label, index) => [label, index ? 0 : 1])),
        ...(q.type === 'choice' ? { choice: labels[0] } : { score: 0 }) }];
    })) };
  } };
  const service = new DecisionService({ client });
  const control = new DatabaseControl({ engine, service });
  t.after(async () => { await service.close(); engine.close(); });
  return { engine, client, control };
}

test('every domain preset is a valid typed policy with an advisory default', () => {
  for (const kind of POLICY_KINDS) assert.equal(definePolicy(policyFor(kind)).id, `database-${kind}`);
});

test('SQL review enforces compiled table boundaries and removes private literals before inference', async (t) => {
  const { control, client } = fixture(t);
  const blocked = await control.reviewQuery({ request: 'Read orders', sql: 'SELECT * FROM orders', policy: { allowedTables: [] } });
  assert.equal(blocked.decision, 'block'); assert.equal(client.calls.length, 0);
  const result = await control.reviewQuery({ request: 'Read matching orders', sql: "SELECT id FROM orders WHERE total=123456789", policy: { allowedTables: ['orders'] } });
  assert.equal(result.executionAllowed, false);
  assert.doesNotMatch(JSON.stringify(client.calls), /123456789/);
});

test('migration packet records deterministic breakers, affected consumers and test packs without applying DDL', async (t) => {
  const { control, client, engine } = fixture(t);
  const before = control.schema(), after = structuredClone(before);
  after.tables[0].columns = after.tables[0].columns.filter((column) => column.name !== 'total');
  const result = await control.reviewMigration({ before, after, intent: 'Remove obsolete totals', sql: 'ALTER TABLE orders DROP COLUMN total',
    assets: [{ id: 'report', columns: [{ table: 'orders', column: 'total' }], testPacks: ['reporting'] }, { id: 'dashboard', dependsOn: ['report'] }] });
  assert.equal(result.decision, 'block'); assert.equal(result.migrationExecuted, false);
  assert.deepEqual(result.affectedAssets.map((asset) => asset.id), ['dashboard', 'report']);
  assert.ok(result.requiredTestPacks.includes('reporting')); assert.equal(client.calls.length, 0);
  assert.equal(engine.prepare('SELECT SUM(total) AS n FROM orders').get().n, 20);
});

test('plan and incident review return measured evidence and a bounded runbook without actions', async (t) => {
  const { control } = fixture(t);
  const result = await control.triagePlan({ plan: [{ Plan: { 'Node Type': 'Seq Scan', 'Plan Rows': 1000, 'Actual Rows': 1, 'Actual Loops': 1 } }] });
  assert.equal(result.actionExecuted, false); assert.ok(result.analysis.symptoms.length);
  const incident = await control.triageIncident({ evidence: { symptom: 'Replication stopped after source schema changed' },
    runbooks: [{ id: 'replication', description: 'Inspect replication compatibility and consumers' }] });
  assert.equal(incident.suggestedRunbook, 'replication'); assert.equal(incident.actionExecuted, false);
});

test('query comparison preserves duplicates and only ignores ordering when requested', async (t) => {
  const { engine } = fixture(t);
  assert.equal((await compareReads(engine, { original: 'SELECT total FROM orders', candidate: 'SELECT DISTINCT total FROM orders' })).equal, false);
  assert.equal((await compareReads(engine, { original: 'SELECT id FROM orders ORDER BY id', candidate: 'SELECT id FROM orders ORDER BY id DESC' })).equal, true);
  assert.equal((await compareReads(engine, { original: 'SELECT id FROM orders ORDER BY id', candidate: 'SELECT id FROM orders ORDER BY id DESC', ordered: true })).equal, false);
  await assert.rejects(() => compareReads(engine, { original: 'SELECT id FROM orders', candidate: 'DELETE FROM orders RETURNING id' }), /pure read/);
  await assert.rejects(() => compareReads(engine, { original: 'SELECT id FROM orders', candidate: 'SELECT id FROM orders', maxRows: 1 }), /row limit/);
  assert.equal(engine.prepare('SELECT COUNT(*) AS n FROM orders').get().n, 2);
});
