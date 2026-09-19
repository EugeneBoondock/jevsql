import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateRows, partitionRows } from '../src/rows.mjs';

const model = 'jev-1.13.0';
test('abort interrupts stalled providers and cache reads', async () => {
  for (const stage of ['provider', 'cache']) {
    const controller = new AbortController();
    const { options } = setup({ signal: controller.signal });
    const stall = () => new Promise(() => { controller.abort(new Error('stopped')); });
    if (stage === 'provider') options.client.evaluate = stall;
    else options.cache = { warm: stall };
    await assert.rejects(evaluateRows(options), /stopped/);
  }
});
const questions = { relevant: { type: 'noul', instructions: 'Does this show a failed workflow?' } };
function setup(overrides = {}) {
  const seen = [];
  const client = { model, async evaluate(state, qs) {
    seen.push({ state, qs });
    return { model, answers: Object.fromEntries(Object.keys(qs).map((id) => [id, { type: 'noul', noul: 0.9 }])) };
  } };
  return { seen, options: { rows: [{ id: 1, title: 'Failed', secret: 'private' }],
    project: (row) => ({ title: row.title }), namespace: 'tenant-a:work', questions, client, ...overrides } };
}

test('projects explicitly, retains row identity, and deduplicates duplicate state', async () => {
  const { seen, options } = setup(); options.rows.push({ ...options.rows[0], id: 2 });
  const result = await evaluateRows(options);
  assert.equal(result.stats.judgments, 1); assert.equal(result.records.length, 2);
  assert.equal(result.records[1].row, options.rows[1]);
  assert.ok(!JSON.stringify(seen).includes('private'));
  assert.equal(result.records[0].receipts.relevant.source, 'api');
});
test('namespaces isolate tenants and question changes invalidate cache', async () => {
  const cache = new Map(); const { options, seen } = setup({ cache });
  await evaluateRows(options); await evaluateRows(options);
  assert.equal(seen.length, 1);
  await evaluateRows({ ...options, namespace: 'tenant-b:work' });
  await evaluateRows({ ...options, questions: { relevant: { type: 'noul', instructions: 'Is this resolved?' } } });
  assert.equal(seen.length, 3);
});
test('malformed cache is replaced and malformed API answers never enter cache', async () => {
  const { options } = setup();
  const cache = { get: () => ({ type: 'noul', noul: null }), set() { throw new Error('cache down'); } };
  assert.equal((await evaluateRows({ ...options, cache })).records.length, 1);
  let writes = 0;
  options.client.evaluate = async () => ({ model, answers: { q0: { type: 'noul', noul: 4 } } });
  await assert.rejects(evaluateRows({ ...options, cache: { set() { writes++; } } }), /0 to 1/);
  assert.equal(writes, 0);
});
test('budgets, invalid projections, and cancellation prevent provider work', async () => {
  const { options, seen } = setup();
  for (const changes of [{ maxJudgments: 0 }, { maxEstimatedCostUsd: 0 }, { project: null },
    { namespace: '' }, { model: 'jev-latest' }, { rowMode: 'bad' }, { project: () => null }]) {
    await assert.rejects(evaluateRows({ ...options, ...changes }));
  }
  const controller = new AbortController(); controller.abort();
  await assert.rejects(evaluateRows({ ...options, signal: controller.signal }));
  assert.equal(seen.length, 0);
  assert.equal((await evaluateRows({ ...options, dryRun: true })).stats.estimated, true);
  assert.equal(seen.length, 0);
});
test('isolated requests keep other rows out, packed mode is explicit', async () => {
  const { options, seen } = setup({ rows: [{ title: 'one' }, { title: 'two' }] });
  await evaluateRows(options);
  assert.equal(seen.length, 2);
  assert.ok(seen.every(({ state }) => Object.keys(state.rows).length === 1));
  seen.length = 0;
  await evaluateRows({ ...options, rowMode: 'packed' });
  assert.equal(seen.length, 1);
});
test('review includes both probability boundaries', () => {
  const records = [0.1, 0.2, 0.5, 0.8, 0.9].map((noul) => ({ answers: { relevant: { type: 'noul', noul } } }));
  const result = partitionRows(records, 'relevant');
  assert.equal(result.accepted.length, 1); assert.equal(result.rejected.length, 1); assert.equal(result.review.length, 3);
  assert.throws(() => partitionRows(records, 'relevant', { low: 0.9, high: 0.1 }));
});
test('classifies and scores in the same request with complete distributions', async () => {
  const { options } = setup({ questions: {
    category: { type: 'choice', instructions: 'Kind?', criteria: { failed: 'Failed', healthy: 'Healthy' } },
    severity: { type: 'score', instructions: 'Impact?', criteria: ['Low', 'High'] },
  } });
  options.client.evaluate = async () => ({ model, answers: {
    q0: { type: 'choice', choice: 'failed', confidence: 0.9, probabilities: { failed: 0.9, healthy: 0.1 } },
    q1: { type: 'score', score: 0.8, confidence: 0.8, probabilities: { 0: 0.2, 1: 0.8 } },
  } });
  const result = await evaluateRows(options);
  assert.equal(result.records[0].answers.category.choice, 'failed');
  assert.equal(result.records[0].answers.severity.score, 0.8);
});
test('wrong model and missing answers fail without partial output', async () => {
  const { options } = setup();
  options.client.evaluate = async () => ({ model: 'jev-1.12.0', answers: {} });
  await assert.rejects(evaluateRows(options), /different model/);
  options.client.evaluate = async () => ({ model, answers: {} });
  await assert.rejects(evaluateRows(options), /answer type/);
});
