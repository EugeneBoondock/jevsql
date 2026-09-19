import test from 'node:test';
import assert from 'node:assert/strict';
import { relaxForCollect, mentionsJev } from '../src/rewrite.mjs';
import { packBatches } from '../src/planner.mjs';
import { parseList, judgmentFor, judgmentKey } from '../src/functions.mjs';
import { parseCsv } from '../src/csv.mjs';
import { JudgmentCache } from '../src/cache.mjs';
import { JevClient } from '../src/client.mjs';
import { integer, nonNegative, probability, quoteIdentifier, validateAnswer } from '../src/validation.mjs';
import { startMockServer } from './mock-server.mjs';

test('shared validators enforce exact boundaries and SQL identifier escaping', () => {
  assert.equal(probability(0), 0); assert.equal(probability(1), 1);
  for (const value of [-Number.EPSILON, 1 + Number.EPSILON, NaN, Infinity, '0']) assert.throws(() => probability(value));
  assert.equal(integer(2, 'n', 2, 3), 2); assert.equal(integer(3, 'n', 2, 3), 3);
  for (const value of [1, 4, 2.5, NaN]) assert.throws(() => integer(value, 'n', 2, 3));
  assert.equal(nonNegative(0, 'n'), 0); assert.throws(() => nonNegative(-Number.EPSILON, 'n'));
  assert.throws(() => nonNegative(Infinity, 'n')); assert.throws(() => nonNegative('0', 'n'));
  assert.equal(quoteIdentifier('a"b'), '"a""b"');
  for (const value of ['', '  ', 1, 'a\0b']) assert.throws(() => quoteIdentifier(value));
});

test('answer validation rejects each malformed answer dimension', () => {
  assert.throws(() => validateAnswer(null, { kind: 'noul' }), /type/);
  assert.throws(() => validateAnswer({ type: 'choice' }, { kind: 'noul' }), /type/);
  assert.equal(validateAnswer({ type: 'noul', noul: 0 }, { kind: 'noul' }).noul, 0);
  const choice = { kind: 'choice', criteria: ['a', 'b'] };
  const base = { type: 'choice', choice: 'a', confidence: 1, probabilities: { a: 0.6, b: 0.4 } };
  assert.equal(validateAnswer(base, choice).choice, 'a');
  assert.throws(() => validateAnswer({ ...base, confidence: 2 }, choice));
  assert.throws(() => validateAnswer({ ...base, probabilities: null }, choice));
  assert.throws(() => validateAnswer({ ...base, probabilities: [] }, choice));
  assert.throws(() => validateAnswer({ ...base, probabilities: { a: 0.6 } }, choice));
  assert.throws(() => validateAnswer({ ...base, probabilities: { a: 0.7, b: 0.4 } }, choice));
  assert.throws(() => validateAnswer({ ...base, choice: 'c' }, choice));
  assert.throws(() => validateAnswer({ ...base, choice: 'b' }, choice));
  const score = { kind: 'score', criteria: ['low', 'high'] };
  assert.equal(validateAnswer({ type: 'score', score: 0.4, confidence: 1, probabilities: { 0: 0.6, 1: 0.4 } }, score).score, 0.4);
  for (const value of [-1, 2, NaN, '0.4']) assert.throws(() => validateAnswer(
    { type: 'score', score: value, confidence: 1, probabilities: { 0: 0.6, 1: 0.4 } }, score));
});

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
    sleepImpl: async () => {},
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

test('client honors retry headers for 429 and 529 without real waits', async () => {
  const waits = [];
  const now = Date.parse('2026-09-19T10:00:00Z');
  const responses = [
    new Response('limited', { status: 429, headers: { 'Retry-After': '2.5' } }),
    new Response('busy', { status: 529, headers: { 'Retry-After': 'Sat, 19 Sep 2026 10:00:04 GMT' } }),
    new Response(JSON.stringify({ answers: { q: { type: 'noul', noul: 1 } } }), { status: 200 }),
  ];
  const client = new JevClient({ apiKey: 'k', baseUrl: 'http://example.invalid', maxAttempts: 3,
    now: () => now, sleepImpl: async (ms) => waits.push(ms), fetchImpl: async () => responses.shift() });
  await client.evaluate({}, { q: { type: 'noul', instructions: 'q' } });
  assert.deepEqual(waits, [2500, 4000]);
  assert.equal(client.stats.retries, 2);
});

test('client rejects malformed JSON, missing ids, and exhausted timeouts', async () => {
  let malformedCalls = 0;
  const malformed = new JevClient({ apiKey: 'k', maxAttempts: 3, sleepImpl: async () => {},
    fetchImpl: async () => { malformedCalls++; return new Response('{', { status: 200 }); } });
  await assert.rejects(() => malformed.evaluate({}, { q: {} }), SyntaxError);
  assert.equal(malformedCalls, 1);

  const missing = new JevClient({ apiKey: 'k', fetchImpl: async () => new Response(JSON.stringify({ answers: {} }), { status: 200 }) });
  await assert.rejects(() => missing.evaluate({}, { q: {} }), /answer ids/);

  let timeoutCalls = 0;
  const timed = new JevClient({ apiKey: 'k', maxAttempts: 2, sleepImpl: async () => {},
    fetchImpl: async () => { timeoutCalls++; throw new DOMException('timed out', 'TimeoutError'); } });
  await assert.rejects(() => timed.evaluate({}, {}), /timed out/);
  assert.equal(timeoutCalls, 2);
  assert.equal(timed.stats.retries, 1);
});

test('client lists models with an authenticated GET', async () => {
  let observed;
  const client = new JevClient({ apiKey: 'secret', baseUrl: 'https://typesafe.invalid', fetchImpl: async (url, init) => {
    observed = { url, init };
    return new Response(JSON.stringify({ data: [{ id: 'jev-1.13.0' }] }), { status: 200 });
  } });
  const models = await client.listModels();
  assert.equal(models.data[0].id, 'jev-1.13.0');
  assert.equal(observed.url, 'https://typesafe.invalid/v1/models');
  assert.equal(observed.init.method, 'GET');
  assert.equal(observed.init.headers.Authorization, 'Bearer secret');
  assert.equal('body' in observed.init, false);
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
