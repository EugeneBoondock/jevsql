import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { JevSQL } from '../src/engine.mjs';
import { JevClient } from '../src/client.mjs';
import { loadEnvFiles } from '../src/env.mjs';
import { DatabaseControl, DecisionService, ReceiptStore, GovernedQueries, SQLiteAdapter, compareReads } from '../src/control-plane.mjs';
import { summarizeWorkload, routeReplica } from '../src/telemetry.mjs';
import { evaluateBinary, qualifyRelease } from '../src/metrics.mjs';

export const REVENUE_TEMPLATE = {
  id: 'paid-revenue', version: '1', description: 'Sum order revenue for the current tenant, filtered by the supplied order status.',
  roles: ['analyst'], params: { status: { type: 'string', enum: ['paid', 'pending'], maxLength: 10 } },
  query: { from: 'orders', select: [{ aggregate: 'sum', column: 'total', as: 'revenue' }],
    filters: [{ column: 'status', op: 'eq', param: 'status' }], limit: 1 },
};

export function scriptedControlClient() {
  return { model: 'jevsql-scripted-control-v1', calls: [], async evaluate(state, questions) {
    this.calls.push({ state, questions });
    const answers = Object.fromEntries(Object.entries(questions).map(([id, question]) => {
      if (question.type === 'noul') return [id, { type: 'noul', noul: /risk|breaks|overscoped|loses|contradictory|missing|sensitive|surprising|stale/.test(id) ? 0.01 : 0.99 }];
      const labels = question.type === 'choice' ? Object.keys(question.criteria) : question.criteria.map((_, index) => String(index));
      const probabilities = Object.fromEntries(labels.map((label, index) => [label, index ? 0.01 / (labels.length - 1) : 0.99]));
      return [id, { type: question.type, confidence: 0.99, probabilities,
        ...(question.type === 'choice' ? { choice: labels[0] } : { score: labels.reduce((sum, label) => sum + Number(label) * probabilities[label], 0) }) }];
    }));
    return { model: this.model, usage: { input_tokens: 0, output_tokens: 0 }, answers };
  } };
}

export function seedControlData(engine) {
  engine.exec(`CREATE TABLE orders(id INTEGER PRIMARY KEY,tenant_id TEXT NOT NULL,total REAL NOT NULL,status TEXT NOT NULL);
    INSERT INTO orders VALUES(1,'tenant-a',120,'paid'),(2,'tenant-b',900,'paid'),(3,'tenant-a',40,'pending');`);
}

/** Synthetic records only. Offline answers demonstrate plumbing, not accuracy. */
export async function runControlDemo({ live = false } = {}) {
  const engine = new JevSQL(), store = new ReceiptStore();
  seedControlData(engine);
  const client = live ? new JevClient({ model: 'jev-1.13.0' }) : scriptedControlClient();
  const service = new DecisionService({ client, store, maxEstimatedCostUsd: 0.02, sessionEstimatedBudgetUsd: 0.05 });
  const control = new DatabaseControl({ engine, service });
  const gate = new GovernedQueries({ service, adapter: new SQLiteAdapter(engine), templates: [REVENUE_TEMPLATE], allowExecution: true });
  const actor = { id: 'demo-analyst', roles: ['analyst'], tenantId: 'tenant-a' };
  const request = { request: 'Show paid order revenue for my tenant', actor, params: { status: 'paid' } };
  try {
    const first = await gate.prepare('paid-revenue', request);
    const result = first.permit ? await gate.execute(first.permit, request) : null;
    const warm = await gate.prepare('paid-revenue', request);
    const before = control.schema(), after = structuredClone(before);
    after.tables[0].columns = after.tables[0].columns.filter((column) => column.name !== 'total');
    const migration = await control.reviewMigration({ before, after, intent: 'Remove order totals',
      assets: [{ id: 'paid-revenue', columns: [{ table: 'orders', column: 'total' }], testPacks: ['revenue-reconciliation'] }] });
    let stalePermitRejected = null;
    if (warm.permit) {
      engine.exec('ALTER TABLE orders ADD COLUMN notes TEXT');
      try { await gate.execute(warm.permit, request); stalePermitRejected = false; }
      catch (error) { stalePermitRejected = /Schema changed/.test(error.message); }
    }
    const triage = await control.triagePlan({ dialect: 'postgresql', plan: [{ Plan: {
      'Node Type': 'Seq Scan', 'Relation Name': 'orders', 'Plan Rows': 10000,
      'Actual Rows': 2, 'Actual Loops': 1, 'Shared Read Blocks': 1000, 'Shared Hit Blocks': 10,
    } }], context: { workload: 'A newly deployed revenue lookup has become slow.' } });
    const now = Date.now();
    const replica = routeReplica([
      { id: 'primary', role: 'primary', healthy: true, telemetryAtMs: now, capacity: 20, inFlight: 4 },
      { id: 'replica-current', role: 'replica', healthy: true, telemetryAtMs: now, capacity: 20, inFlight: 2, lagMs: 50, lagObservedAtMs: now },
      { id: 'replica-stale', role: 'replica', healthy: true, telemetryAtMs: now - 60000, capacity: 20, inFlight: 0, lagMs: 0, lagObservedAtMs: now - 60000 },
    ], { consistency: 'bounded', maxLagMs: 100, nowMs: now, maxTelemetryAgeMs: 5000 });
    const workload = summarizeWorkload([1, 2, 3].map((id) => ({ requestId: 'checkout-1', dialect: 'sqlite', sql: `SELECT total FROM orders WHERE id=${id}`, durationMs: id * 10 })));
    const comparison = await compareReads(engine, { original: 'SELECT total FROM orders ORDER BY id', candidate: 'SELECT total FROM orders ORDER BY id DESC' });
    const labels = [
      { caseId: 'a', split: 'holdout', expected: true, probability: 0.99, decision: 'block', dialect: 'sqlite' },
      { caseId: 'b', split: 'holdout', expected: false, probability: 0.01, decision: 'allow', dialect: 'sqlite' },
    ];
    const calibration = evaluateBinary(labels, { unsafeLabel: true });
    const qualification = qualifyRelease(labels, { unsafeLabel: true, tuningCaseIds: [] });
    store.feedback(triage.id, { reviewer: 'demo-reviewer', label: 'cardinality', reason: 'A fixture label supplied by the demo author.' });
    const receipts = store.list({ limit: 100 });
    return {
      mode: live ? 'live Jev, synthetic records, not an accuracy benchmark' : 'offline scripted responses, no API key or network, not an accuracy benchmark',
      governedRead: { decision: first.decision, rows: result?.rows ?? [], model: first.receipt.resolvedModel,
        answers: first.receipt.answers, reasons: first.receipt.reasons,
        otherTenantExcluded: result ? result.rows[0].revenue === 120 : null, warmRequests: warm.receipt.stats.requests },
      stalePermitRejected,
      migration: { decision: migration.decision, affectedAssets: migration.affectedAssets.map(({ id }) => id),
        requiredTestPacks: migration.requiredTestPacks, executed: migration.migrationExecuted },
      triage: { cause: triage.answers?.cause ?? null, symptoms: triage.analysis.symptoms, actionExecuted: triage.actionExecuted },
      replica, repeatedQueries: workload.nPlusOneCandidates, comparison,
      calibration: calibration.metrics, qualification: { status: qualification.status, checks: qualification.checks },
      audit: { ...store.verify(), feedbackRevisions: store.labels(triage.id).length },
      usage: { requests: live ? receipts.reduce((sum, receipt) => sum + (receipt.stats?.requests ?? 0), 0) : 0,
        fixtureEvaluations: live ? 0 : client.calls.length,
        inputTokens: receipts.reduce((sum, receipt) => sum + (receipt.stats?.inputTokens ?? 0), 0),
        costUsd: receipts.reduce((sum, receipt) => sum + (receipt.stats?.costUsd ?? 0), 0) },
    };
  } finally { await service.close(); store.close(); engine.close(); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  loadEnvFiles();
  runControlDemo({ live: process.argv.includes('--live') }).then((report) => console.log(JSON.stringify(report, null, 2)))
    .catch((error) => { console.error(error.message); process.exitCode = 1; });
}
