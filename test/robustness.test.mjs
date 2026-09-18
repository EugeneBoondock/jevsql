import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { packBatches, batchRequest } from '../src/planner.mjs';
import { JudgmentCache } from '../src/cache.mjs';
import { JevSQL } from '../src/engine.mjs';
import { JevClient } from '../src/client.mjs';
import { judgmentFor, judgmentKey } from '../src/functions.mjs';
import { fixture } from './helpers.mjs';

test('one state with hundreds of questions splits without losing or duplicating items', () => {
  const pending = Array.from({ length: 257 }, (_, i) => ({ key: `k${i}`, judgment: judgmentFor('jev_noul', ['one row', `question ${i}`]) }));
  const batches = packBatches(pending);
  assert.deepEqual(batches.map((batch) => batch.items.length), [120, 120, 17]);
  assert.equal(new Set(batches.flatMap((batch) => batch.items.map((item) => item.key))).size, 257);
  for (const batch of batches) assert.equal(Object.keys(batchRequest(batch).state.rows).length, 1);
});

test('request budgets include rubrics, questions, and UTF-8 bytes', () => {
  const item = { key: 'k', judgment: judgmentFor('jev_noul', ['é'.repeat(150), 'q'.repeat(100)]) };
  assert.throws(() => packBatches([item], { maxCharsPerRequest: 300 }), /exceed/);
  const rubric = { yes: 'long description'.repeat(300), no: 'none' };
  assert.throws(() => packBatches([{ key: 'k', judgment: judgmentFor('jev_choice', ['small', 'q', rubric]) }], { maxStateQuestionChars: 500 }), /exceed/);
  assert.throws(() => packBatches([], { maxQuestionsPerRequest: 0 }), /integer/);
});

test('query and explain reject writes and multi-statements without changing data', async (t) => {
  const { engine, mock } = await fixture(t);
  for (const sql of ['DELETE FROM records RETURNING *', 'SELECT 1; DELETE FROM records', 'PRAGMA query_only=OFF',
    'WITH ids AS (SELECT id FROM records) DELETE FROM records WHERE id IN (SELECT id FROM ids) RETURNING id']) {
    await assert.rejects(() => engine.query(sql));
    await assert.rejects(() => engine.explain(sql));
  }
  assert.equal(engine.prepare('SELECT COUNT(*) AS n FROM records').get().n, 3);
  assert.equal(mock.requestCount, 0);
  engine.exec("INSERT INTO records VALUES(4,'still writable','sales')");
});

test('ordering by a judgment alias with bound LIMIT and OFFSET judges the full candidate set', async (t) => {
  const { engine } = await fixture(t);
  const sql = `SELECT id, jev_noul(body, ?) AS urgency FROM records WHERE id >= ? ORDER BY urgency DESC, id LIMIT ? OFFSET ?`;
  const result = await engine.query(sql, { params: ['Is this urgent?', 1, 1, 0] });
  assert.equal(result.rows[0].id, 1); assert.equal(result.stats.judgments, 3);
  const named = await engine.query(`SELECT id, jev_noul(body, :question) AS p FROM records ORDER BY p DESC, id LIMIT :take`,
    { params: { question: 'Is this urgent?', take: 1 } });
  assert.equal(named.rows[0].id, 1); assert.equal(named.stats.requests, 0);
});

test('quoted function identifiers and functions inside views are resolved', async (t) => {
  const { engine } = await fixture(t);
  const quoted = await engine.query(`SELECT id, "jev_noul"(body,'Is this urgent?') AS p FROM records ORDER BY p DESC LIMIT 1`);
  assert.equal(quoted.rows[0].id, 1); assert.equal(quoted.stats.judgments, 3);
  engine.exec("CREATE VIEW routed AS SELECT id, jev_choice(body,'Which team?','billing,technical,sales') AS team FROM records");
  const view = await engine.query('SELECT * FROM routed ORDER BY id');
  assert.equal(view.rows[0].team, 'billing'); assert.equal(view.stats.judgments, 3);
  assert.throws(() => engine.prepare("SELECT jev_noul('text','q')").get(), /engine.query/);
});

test('Unicode, BETWEEN, OR precedence and comments preserve SQL meaning', async (t) => {
  const { engine } = await fixture(t);
  const result = await engine.query(`SELECT id, 'straße' AS label FROM records
    WHERE id=2 OR id BETWEEN 1 AND 1 AND jev_bool(body,'Is this urgent?')=1 -- keep this comment
    ORDER BY id LIMIT 2;`);
  assert.deepEqual(result.rows.map((row) => row.id), [1, 2]);
  const literal = await engine.query("SELECT 'jev_noul(x)' AS text /* jev_noul(x) */");
  assert.equal(literal.stats.judgments, 0);
});

test('a run discovers candidates beyond early rejected rows with a LIMIT', async (t) => {
  const { engine } = await fixture(t);
  engine.exec("UPDATE records SET body='no hurry' WHERE id<3; UPDATE records SET body='urgent refund' WHERE id=3");
  const result = await engine.query("SELECT id FROM records WHERE jev_bool(body,'Is this urgent?')=1 ORDER BY id LIMIT 1");
  assert.deepEqual(result.rows.map((row) => row.id), [3]);
});

test('a malformed answer rejects the whole batch without poisoning cache', async (t) => {
  const { engine, mock } = await fixture(t, {}, { answerFor: (_, state) => ({ type: 'noul', noul: state.includes('ambiguous') ? 4 : 0.7 }) });
  await assert.rejects(() => engine.query("SELECT jev_noul(body,'q') FROM records"), /0 to 1/);
  assert.equal(mock.requestCount, 1); assert.equal(engine.cache.size, 0);
  assert.equal((await engine.query('SELECT COUNT(*) AS n FROM records')).rows[0].n, 3);
});

test('zero cost budgets and oversized requests stop before the network', async (t) => {
  const { engine, mock } = await fixture(t, { maxEstimatedCostUsd: 0 });
  await assert.rejects(() => engine.query("SELECT jev_noul(body,'q') FROM records"), /Estimated cost/);
  assert.equal(mock.requestCount, 0);
  assert.equal((await engine.explain("SELECT jev_noul(body,'q') FROM records")).judgments, 3);
});

test('shared cache warming preserves the existing extension and counts hits once', async (t) => {
  const backing = new Map();
  for (const body of ['billing refund needed urgently', 'technical docs question, no rush', 'ambiguous request']) {
    backing.set(judgmentKey('jev-test', judgmentFor('jev_noul', [body, 'q'])), { type: 'noul', noul: 0.8 });
  }
  const cache = new JudgmentCache();
  cache.warm = async (keys) => { for (const key of keys) if (backing.has(key)) cache.set(key, backing.get(key)); };
  const { engine, mock } = await fixture(t, { cache });
  const result = await engine.query("SELECT jev_noul(body,'q') AS p FROM records", { audit: true });
  assert.equal(result.stats.cacheHits, 3); assert.equal(result.stats.judgments, 0); assert.equal(mock.requestCount, 0);
  assert.equal(result.decisions.length, 3);
});

test('concurrent queries are refused until active work has settled', async (t) => {
  const { engine } = await fixture(t, {}, { latencyMs: 40 });
  const running = engine.query("SELECT jev_noul(body,'q') FROM records");
  await assert.rejects(() => engine.query('SELECT 1'), /active/);
  assert.throws(() => engine.close(), /active/);
  assert.throws(() => engine.exec('DELETE FROM records'), /active/);
  await running;
  assert.equal((await engine.query('SELECT 1 AS n')).rows[0].n, 1);
});

test('cancellation aborts requests, settles workers, and leaves the engine reusable', async (t) => {
  const { engine, mock } = await fixture(t, { limits: { maxRowsPerRequest: 1 }, concurrency: 2 }, { latencyMs: 150 });
  const controller = new AbortController();
  const running = engine.query("SELECT jev_noul(body,'q') FROM records", { signal: controller.signal });
  const rejected = assert.rejects(running, /cancelled/);
  await delay(20); controller.abort(new Error('cancelled')); await rejected;
  const requests = mock.requestCount;
  await engine.query('SELECT 1');
  await delay(160);
  assert.equal(mock.requestCount, requests); assert.equal(engine.cache.size, 0);
});

test('client cancellation is not retried', async () => {
  const controller = new AbortController();
  let calls = 0;
  const client = new JevClient({ apiKey: 'test', fetchImpl: async (_, { signal }) => {
    calls++; await delay(200, undefined, { signal });
  } });
  const running = client.evaluate({}, {}, { signal: controller.signal });
  controller.abort(new Error('stopped'));
  await assert.rejects(running, /stopped/);
  assert.equal(calls, 1); assert.equal(client.stats.retries, 0);
});

test('cache namespaces separate policies and model conflicts fail locally', async (t) => {
  const cache = new JudgmentCache();
  const { engine, mock } = await fixture(t, { cache, cacheNamespace: 'policy-a' });
  const sql = "SELECT jev_noul(body,'q') FROM records";
  await engine.query(sql);
  engine.cacheNamespace = 'policy-b';
  const result = await engine.query(sql);
  assert.equal(result.stats.judgments, 3); assert.equal(mock.requestCount, 2);
  assert.throws(() => new JevSQL({ model: 'wrong', client: { model: 'right' } }), /must match/);
});
