import test from 'node:test';
import assert from 'node:assert/strict';
import { relaxForCollect, mentionsJev } from '../src/rewrite.mjs';
import { packBatches } from '../src/planner.mjs';
import { parseList, judgmentFor, judgmentKey } from '../src/functions.mjs';
import { parseCsv } from '../src/csv.mjs';
import { JudgmentCache } from '../src/cache.mjs';
import { JevClient } from '../src/client.mjs';
import { startMockServer } from './mock-server.mjs';

test('relax keeps ordinary filters and neutralises jev conjuncts', () => {
  const { sql, relaxed } = relaxForCollect(
    "SELECT id FROM t WHERE status = 'open' AND jev_bool(body, 'q') = 1 ORDER BY id",
  );
  assert.match(sql, /WHERE\s+status = 'open'/);
  assert.match(sql, /\(jev_bool\(body, 'q'\) = 1 OR 1=1\)/, 'still evaluated, never filtering');
  assert.match(sql, /ORDER BY id/);
  assert.deepEqual(relaxed, ['WHERE']);
});

test('relax neutralises a lone judgment filter', () => {
  const { sql } = relaxForCollect("SELECT id FROM t WHERE jev_noul(body, 'q') > 0.5");
  assert.match(sql, /\(jev_noul\(body, 'q'\) > 0\.5 OR 1=1\)/);
});

test('relax wraps a top-level OR as a whole', () => {
  const { sql } = relaxForCollect("SELECT id FROM t WHERE a = 1 OR jev_noul(body, 'q') > 0.5");
  assert.match(sql, /\(a = 1 OR jev_noul\(body, 'q'\) > 0\.5 OR 1=1\)/);
});

test('relax leaves a jev-free query alone', () => {
  const sql = "SELECT id FROM t WHERE status = 'open' LIMIT 3";
  assert.equal(relaxForCollect(sql).sql, sql);
  assert.equal(mentionsJev(sql), false);
});

test('relax drops LIMIT when the ordering depends on a judgment', () => {
  const { sql, relaxed } = relaxForCollect("SELECT id FROM t ORDER BY jev_score(body,'q','a,b') DESC LIMIT 5");
  assert.doesNotMatch(sql, /LIMIT/);
  assert.ok(relaxed.includes('LIMIT'));
});

test('relax ignores jev_ inside a string literal', () => {
  const sql = "SELECT id FROM t WHERE note = 'call jev_noul(x) later'";
  assert.equal(relaxForCollect(sql).sql, sql);
});

// The collect pass depends on SQLite evaluating the left side of `(<predicate> OR 1=1)`
// for every row. If a future SQLite folds that away, collection would silently stop
// finding judgments, so this guards the assumption directly.
test('SQLite evaluates a function inside (predicate OR 1=1)', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE t(id INTEGER)');
  for (let i = 0; i < 4; i++) db.prepare('INSERT INTO t VALUES (?)').run(i);
  let calls = 0;
  db.function('probe', { varargs: true, deterministic: true }, (x) => { calls += 1; return x; });
  const rows = db.prepare('SELECT id FROM t WHERE (probe(id) > 2 OR 1=1)').all();
  assert.equal(calls, 4, 'called once per row');
  assert.equal(rows.length, 4, 'and filters nothing out');
  db.close();
});

test('batches respect the row limit and reuse one state per row', () => {
  const pending = [];
  for (let i = 0; i < 30; i++) {
    pending.push({ key: `k${i}`, judgment: { kind: 'noul', state: `row ${i}`, question: 'q?', criteria: null } });
    pending.push({ key: `k${i}b`, judgment: { kind: 'noul', state: `row ${i}`, question: 'other?', criteria: null } });
  }
  const batches = packBatches(pending, { maxRowsPerRequest: 10 });
  assert.equal(batches.length, 3);
  assert.equal(batches[0].rows.size, 10);
  assert.equal(batches[0].items.length, 20, 'two questions per row share the row text');
});

test('a huge row starts its own batch rather than blowing the token budget', () => {
  const pending = [
    { key: 'a', judgment: { kind: 'noul', state: 'x'.repeat(50_000), question: 'q', criteria: null } },
    { key: 'b', judgment: { kind: 'noul', state: 'y'.repeat(50_000), question: 'q', criteria: null } },
  ];
  const batches = packBatches(pending, { maxCharsPerRequest: 60_000 });
  assert.equal(batches.length, 2);
});

test('option lists parse as JSON, comma or pipe', () => {
  assert.deepEqual(parseList('["a","b"]'), ['a', 'b']);
  assert.deepEqual(parseList('a, b ,c'), ['a', 'b', 'c']);
  assert.deepEqual(parseList('a|b'), ['a', 'b']);
  assert.deepEqual(parseList(''), []);
});

test('the same judgment from different functions shares one key', () => {
  const a = judgmentFor('jev_choice', ['text', 'Which team?', 'billing,tech']);
  const b = judgmentFor('jev_choice_conf', ['text', 'Which team?', 'billing,tech']);
  assert.equal(judgmentKey('jev-latest', a), judgmentKey('jev-latest', b));
  const other = judgmentFor('jev_choice', ['text', 'Which team?', 'billing,tech,sales']);
  assert.notEqual(judgmentKey('jev-latest', a), judgmentKey('jev-latest', other));
});

test('jev_bool thresholds the probability', () => {
  const j = judgmentFor('jev_bool', ['t', 'q', 0.8]);
  assert.equal(j.read({ noul: 0.9 }), 1);
  assert.equal(j.read({ noul: 0.7 }), 0);
});

test('csv parses quoted fields and embedded commas', () => {
  const rows = parseCsv('id,body\n1,"hello, world"\n2,"say ""hi"""\n');
  assert.deepEqual(rows, [['id', 'body'], ['1', 'hello, world'], ['2', 'say "hi"']]);
});

test('cache counts hits and misses', () => {
  const cache = new JudgmentCache(null);
  assert.equal(cache.get('k'), undefined);
  cache.set('k', { noul: 1 });
  assert.deepEqual(cache.get('k'), { noul: 1 });
  assert.equal(cache.hits, 1);
  assert.equal(cache.misses, 1);
});

test('client retries a 503 and then succeeds', async () => {
  let attempts = 0;
  const client = new JevClient({
    apiKey: 'k',
    baseUrl: 'http://example.invalid',
    maxAttempts: 3,
    fetchImpl: async () => {
      attempts += 1;
      if (attempts < 3) return new Response('busy', { status: 503 });
      return new Response(JSON.stringify({ answers: { a: { type: 'noul', noul: 1 } }, usage: { input_tokens: 5, output_tokens: 1 } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    },
  });
  const data = await client.evaluate({ rows: {} }, { a: { type: 'noul', instructions: 'q' } });
  assert.equal(data.answers.a.noul, 1);
  assert.equal(attempts, 3);
  assert.equal(client.stats.retries, 2);
});

test('client does not retry an auth failure', async () => {
  let attempts = 0;
  const client = new JevClient({
    apiKey: 'bad', baseUrl: 'http://example.invalid', maxAttempts: 3,
    fetchImpl: async () => { attempts += 1; return new Response('nope', { status: 401 }); },
  });
  await assert.rejects(() => client.evaluate({}, {}), /401/);
  assert.equal(attempts, 1);
});

test('client refuses to start without a key', () => {
  const saved = process.env.TYPESAFE_API_KEY;
  delete process.env.TYPESAFE_API_KEY;
  assert.throws(() => new JevClient({}), /No TypeSafe API key/);
  if (saved) process.env.TYPESAFE_API_KEY = saved;
});

test('mock server rejects an unauthenticated request', async () => {
  const mock = await startMockServer();
  const res = await fetch(`${mock.baseUrl}/v1/systemone`, { method: 'POST', body: '{}' });
  assert.equal(res.status, 401);
  await mock.close();
});
