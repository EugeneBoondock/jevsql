import test from 'node:test';
import assert from 'node:assert/strict';
import { createPgJudgmentCache } from '../src/pg-cache.mjs';

test('overlapping flushes drain all writes and update stale cached answers', async () => {
  const calls = []; let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const cache = createPgJudgmentCache({ batchSize: 1, pool: { async query(sql, args) {
    calls.push({ sql, args }); if (calls.length === 1) await gate;
  } } });
  cache.set('a', { type: 'noul', noul: 0.1 });
  cache.set('b', { type: 'noul', noul: 0.9 });
  let done = false; const draining = cache.drain().then(() => { done = true; });
  await new Promise((r) => setImmediate(r));
  assert.equal(done, false); assert.equal(calls.length, 1);
  release(); await draining; assert.equal(calls.length, 2);
  assert.match(calls[0].sql, /answer = EXCLUDED.answer/);
});
test('bounded memory, chunked reads and unavailable storage preserve local decisions', async () => {
  const sizes = [];
  const cache = createPgJudgmentCache({ maxEntries: 3, batchSize: 2, pool: { async query(sql, args) {
    sizes.push(args[0].length);
    return { rows: args[0].map((key) => ({ key, answer: { noul: 0.9 } })) };
  } } });
  await cache.warm(['a', 'b', 'c', 'd']);
  assert.deepEqual(sizes, [2, 1]); assert.equal(cache.size, 3);
  cache.set('e', { noul: 0.4 }); assert.equal(cache.size, 3);
  const down = createPgJudgmentCache({ pool: { query() { throw new Error('secret'); } } });
  assert.equal(await down.warm(['x']), 0);
  down.set('x', { noul: 0.4 }); await down.drain();
  assert.equal(down.get('x').noul, 0.4);
});
