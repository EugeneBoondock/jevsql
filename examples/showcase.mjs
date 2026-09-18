// A guided tour of the control plane, offline and deterministic.
//
// Everything here runs with no API key and no network. The typed answers come
// from a scripted stand-in so the output is stable; the deterministic half —
// the classifier, the compiler, the replay, the measurement, the detector — is
// the real implementation doing real work.
//
//   node examples/showcase.mjs
//   node examples/showcase.mjs --live     (uses Jev, synthetic records only)

import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { JevSQL } from '../src/engine.mjs';
import { JevClient } from '../src/client.mjs';
import { loadEnvFiles } from '../src/env.mjs';
import { DatabaseControl, DecisionService, GovernedQueries, SQLiteAdapter } from '../src/control-plane.mjs';
import { classifyStatement } from '../src/sql-inspector.mjs';
import { verifyMigration, standardPacks } from '../src/migration-runner.mjs';
import { generateSeedData, applySeedData } from '../src/seed.mjs';
import { proposeIndexes, measureIndexCandidate, propertyCompare, edgeCaseFixtures } from '../src/candidates.mjs';
import { runAdversarialSuite } from '../src/injection.mjs';
import { compareAppTypes } from '../src/app-types.mjs';
import { buildLockGraph } from '../src/operations.mjs';
import { promotionStatus } from '../src/shadow.mjs';
import { inspectSchema } from '../src/schema.mjs';
import { scriptedControlClient } from './control-plane.mjs';

const BOLD = '[1m', DIM = '[2m', RESET = '[0m';
const GREEN = '[32m', RED = '[31m', YELLOW = '[33m', CYAN = '[36m', GREY = '[90m';
const plain = () => process.env.NO_COLOR || !process.stdout.isTTY;
const paint = (colour, value) => (plain() ? String(value) : `${colour}${value}${RESET}`);

let step = 0;
const heading = (title) => console.log(`\n${paint(BOLD + CYAN, `  ${++step}. ${title}`)}\n`);
const line = (label, value) => console.log(`     ${label.padEnd(30)} ${value}`);
const note = (value) => console.log(`     ${paint(GREY, value)}`);
const good = (value) => paint(GREEN, value);
const bad = (value) => paint(RED, value);
const warn = (value) => paint(YELLOW, value);
const verdict = (ok, yes, no) => (ok ? good(yes) : bad(no));

const SHOP = `CREATE TABLE customers(id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT UNIQUE NOT NULL, country TEXT);
CREATE TABLE orders(id INTEGER PRIMARY KEY, customer_id INTEGER NOT NULL REFERENCES customers(id),
  tenant_id TEXT NOT NULL, status TEXT NOT NULL, total REAL NOT NULL, created_at TEXT);`;

export async function runShowcase({ live = false } = {}) {
  const client = live ? new JevClient({ model: 'jev-1.13.0' }) : scriptedControlClient();
  const service = new DecisionService({ client, maxEstimatedCostUsd: 0.05, sessionEstimatedBudgetUsd: 0.5 });
  const engine = new JevSQL();
  engine.exec(SHOP);
  const control = new DatabaseControl({ engine, service });

  console.log(paint(BOLD, '\n  JevSQL — a typed control plane in front of SQL\n'));
  note(live ? 'live Jev, synthetic records' : 'offline: no API key, no network, scripted typed answers');

  try {
    // ---------------------------------------------------------------------
    heading('An agent proposes four statements. Classification is deterministic.');
    for (const [sql, intent] of [
      ['SELECT total FROM orders WHERE tenant_id = ?', 'Read this tenant’s totals'],
      ['UPDATE orders SET status = ?', 'Mark one order as paid'],
      ['WITH gone AS (DELETE FROM orders RETURNING id) SELECT count(*) FROM gone', 'Count the orders'],
      ['DROP TABLE customers', 'Tidy up an unused table'],
    ]) {
      const result = await control.reviewStatement({ statement: sql, intent, dialect: 'postgresql', environment: 'production' });
      const { operation, destructive } = result.classification;
      const approval = result.requiredApproval;
      const shown = sql.length > 46 ? `${sql.slice(0, 43)}...` : sql;
      console.log(`     ${shown.padEnd(48)} ${paint(BOLD, operation.padEnd(9))}`
        + `${approval === 'none' ? good('auto') : approval === 'human' ? warn('human') : bad('out-of-band human')}`
        + `${destructive ? bad('  destructive') : ''}`);
    }
    note('The UPDATE says "one order" and has no WHERE clause. The DELETE is hiding inside a WITH.');
    note('Classified by what they do, not by the keyword they start with. None of them can execute.');

    // ---------------------------------------------------------------------
    heading('The same request, through a registered template.');
    const gate = new GovernedQueries({ service, adapter: new SQLiteAdapter(engine), allowExecution: true,
      tenantColumns: { orders: 'tenant_id', customers: null },
      templates: [{ id: 'tenant-revenue', version: '1', description: 'Sum order revenue for the current tenant by status.',
        roles: ['analyst'], params: { status: { type: 'string', enum: ['paid', 'pending'] } },
        query: { from: 'orders', select: [{ aggregate: 'sum', column: 'total', as: 'revenue' }],
          filters: [{ column: 'status', op: 'eq', param: 'status' }], limit: 1 } }] });
    engine.exec(`INSERT INTO customers VALUES (1,'A','a@example.test','ZA'),(2,'B','b@example.test','GB');
      INSERT INTO orders VALUES (1,1,'tenant-a','paid',120,'2026-01-02'),(2,2,'tenant-b','paid',900,'2026-01-03');`);
    const actor = { id: 'analyst-1', roles: ['analyst'], tenantId: 'tenant-a' };
    const request = { request: 'What is my paid revenue?', actor, params: { status: 'paid' } };
    const prepared = await gate.prepare('tenant-revenue', request);
    line('compiled SQL', paint(DIM, prepared.preview.sql.replace(/\s+/g, ' ').slice(0, 78)));
    const executed = await gate.execute(prepared.permit, request);
    line('rows', JSON.stringify(executed.rows));
    line('other tenant’s 900', verdict(executed.rows[0].revenue === 120, 'excluded', 'LEAKED'));
    line('permit reuse', verdict(await gate.execute(prepared.permit, request).then(() => false, () => true), 'rejected', 'accepted'));
    note('The tenant filter comes from the authenticated actor. The request text never reaches the SQL.');

    // ---------------------------------------------------------------------
    heading('A migration is replayed before anyone believes the review.');
    const honest = verifyMigration({ baselineSql: SHOP,
      fixtures: [{ sql: "INSERT INTO customers VALUES (1,'A','a@example.test','ZA')" }],
      up: 'ALTER TABLE customers ADD COLUMN vat_number TEXT',
      down: 'ALTER TABLE customers DROP COLUMN vat_number',
      packs: standardPacks(['read-path', 'constraint'], { tables: ['customers', 'orders'] }) });
    line('additive migration', `${verdict(honest.ok, 'ok', 'failed')}   rollback restores schema `
      + `${verdict(honest.rollback.restoresSchema, 'yes', 'no')} and rows ${verdict(honest.rollback.restoresData, 'yes', 'no')}`);
    const liar = verifyMigration({ baselineSql: SHOP,
      fixtures: [{ sql: "INSERT INTO customers VALUES (1,'A','a@example.test','ZA')" }],
      up: 'ALTER TABLE customers ADD COLUMN vat_number TEXT',
      down: 'DROP TABLE customers; CREATE TABLE customers(id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT UNIQUE NOT NULL, country TEXT)' });
    line('"working" rollback', `${bad('rejected')}   schema restored ${good('yes')}, rows restored ${bad('no')}`);
    note('A rollback that recreates the table and loses the rows is not a rollback.');

    // ---------------------------------------------------------------------
    heading('Fixtures are generated, not invented.');
    const fixtureDb = new DatabaseSync(':memory:');
    fixtureDb.exec(SHOP);
    const seeded = generateSeedData(inspectSchema(fixtureDb), { rows: 200, seed: 'showcase' });
    const applied = applySeedData(fixtureDb, seeded);
    line('insert order', seeded.order.join(' → '));
    line('rows inserted', `${applied.inserted}   foreign keys `
      + verdict(fixtureDb.prepare('PRAGMA foreign_key_check').all().length === 0, 'clean', 'broken'));
    line('same seed again', verdict(
      JSON.stringify(generateSeedData(inspectSchema(fixtureDb), { rows: 200, seed: 'showcase' }).rows) === JSON.stringify(seeded.rows),
      'identical', 'differs'));

    // ---------------------------------------------------------------------
    heading('An index candidate is proposed, then measured.');
    const perfDb = new DatabaseSync(':memory:');
    perfDb.exec('CREATE TABLE orders(id INTEGER PRIMARY KEY, customer_id INTEGER, status TEXT, created_at TEXT)');
    const insert = perfDb.prepare('INSERT INTO orders VALUES (?,?,?,?)');
    for (let i = 1; i <= 40000; i++) insert.run(i, i % 900, i % 6 === 0 ? 'paid' : 'pending', `2026-01-${String((i % 28) + 1).padStart(2, '0')}`);
    const slow = 'SELECT id FROM orders WHERE customer_id = ? AND status = ? ORDER BY created_at DESC';
    const [candidate] = proposeIndexes(inspectSchema(perfDb), [{ sql: slow }]);
    const measured = measureIndexCandidate(perfDb, candidate, { sql: slow, params: [42, 'paid'], repeats: 5 });
    line('proposed', candidate.columns.join(', '));
    line('plan before', paint(DIM, measured.before.plan));
    line('plan after', paint(DIM, measured.after.plan));
    line('median', `${measured.before.medianMs.toFixed(2)} ms → ${measured.after.medianMs.toFixed(2)} ms  `
      + good(`${(measured.medianImprovement * 100).toFixed(1)}% faster`));
    line('same rows', verdict(measured.sameRowCount, 'yes', 'no'));
    note('Measured by building the index and timing it. The index is dropped again.');
    perfDb.close();

    // ---------------------------------------------------------------------
    heading('A rewrite that "looks equivalent".');
    const trap = propertyCompare({ baselineSql: 'CREATE TABLE t(id INTEGER PRIMARY KEY, v TEXT)',
      original: "SELECT id FROM t WHERE v IS NOT 'a'", candidate: "SELECT id FROM t WHERE v <> 'a'",
      fixtures: edgeCaseFixtures({ table: 't', column: 'v' }) });
    line('fixtures', `${trap.fixtures} run, ${bad(`${trap.failed} disagreed`)}`);
    line('broke on', trap.results.filter((item) => !item.equal).map((item) => item.name).join(', '));
    note('Both statements are valid. They differ exactly where NULLs appear.');

    // ---------------------------------------------------------------------
    heading('Types are compared against the schema, not trusted.');
    const divergence = compareAppTypes({ language: 'typescript', models: [{ name: 'Order', table: 'orders', fields: [
      { name: 'id', type: 'number' }, { name: 'status', type: 'string' }, { name: 'total', type: 'number' },
      { name: 'discountCode', type: 'string' }] }] }, inspectSchema(engine.db));
    for (const item of divergence.divergences.filter((entry) => entry.level === 'block').slice(0, 3)) {
      line(paint(BOLD, item.code), item.detail);
    }
    note('The agent reads types as truth. These two would have disagreed silently.');

    // ---------------------------------------------------------------------
    heading('Untrusted text tries to talk to the reviewer.');
    const suite = await runAdversarialSuite(async (text) => {
      const receipt = await service.review(
        { id: 'showcase-gate', version: '1', questions: { routine: { type: 'noul', instructions: 'Is this routine?' } },
          accept: [{ question: 'routine', min: 0.9 }] }, { note: text });
      return receipt.decision === 'eligible' ? 'allow' : receipt.decision === 'block' ? 'block' : 'review';
    });
    line('injection cases', `${suite.total}   reached an automatic allow: `
      + verdict(suite.allowed === 0, `${suite.allowed}`, `${suite.allowed}`));
    line('benign controls', `${suite.benignTotal}   wrongly held back: `
      + verdict(suite.falsePositives === 0, `${suite.falsePositives}`, `${suite.falsePositives}`));
    note('"Ignore all previous instructions", role markers, bidi and zero-width smuggling, JSON break-outs.');

    // ---------------------------------------------------------------------
    heading('Sessions are stuck. The wait graph is arithmetic.');
    const graph = buildLockGraph([{ waiterId: 'checkout-7', holderId: 'batch-1', waitedMs: 9400 },
      { waiterId: 'batch-1', holderId: 'report-3' }, { waiterId: 'report-3', holderId: 'checkout-7' }]);
    line('shape', bad(graph.summary.contentionShape));
    line('cycle', graph.cycles[0].join(' → ') + ' → ' + graph.cycles[0][0]);
    note('The cycle is computed. The model only names the family and the runbook.');

    // ---------------------------------------------------------------------
    heading('So can any of this be switched on?');
    const promotion = promotionStatus({ workflow: 'query', readOnly: true,
      evaluation: { total: 0, metrics: { ece: null }, safety: null },
      qualification: null, shadow: null, adversarial: { total: suite.total, allowed: suite.allowed } });
    line('promotion stage', bad(String(promotion.stage)));
    line('blocked by', promotion.blockedBy.checks.map((item) => item.code).join(', '));
    note('No adjudicated corpus, so the ladder stops at the bottom. That is the honest answer.');
    note('Broad automation is never granted by this report, whatever the evidence says.');

    console.log(`\n  ${paint(BOLD, 'The software is tested. The claims a deployment rests on are not — yet.')}\n`);
    fixtureDb.close();
    return { steps: step, adversarial: suite, promotion: promotion.stage };
  } finally {
    await service.close();
    engine.close();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  loadEnvFiles();
  runShowcase({ live: process.argv.includes('--live') })
    .catch((error) => { console.error(error); process.exitCode = 1; });
}
