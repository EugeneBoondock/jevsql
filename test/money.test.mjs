import test from 'node:test';
import assert from 'node:assert/strict';
import { aggregateMoney, aggregatePgMoney } from '../src/money.mjs';
const options = rows => ({ amount: r => r.amount, currency: r => r.currency,
  readPage: async () => ({ rows, done: true }) });
test('exact decimal sums preserve precision, signs, zero and currency boundaries', async () => {
  const out = await aggregateMoney(options([
    { amount: '9007199254740993.10', currency: 'usd' }, { amount: '0.20', currency: 'USD' },
    { amount: '-0.1', currency: 'USD' }, { amount: 0, currency: 'USD' },
    { amount: '-2.005', currency: 'EUR' }, { amount: '+1.00', currency: 'EUR' },
  ]));
  assert.equal(out.totals[0].total, '9007199254740993.20');
  assert.equal(out.totals[1].total, '-1.005');
  assert.equal(out.moneyComplete, true);
  assert.equal(out.scanned, 6);
});
test('missing and malformed values never become a complete zero total', async () => {
  const out = await aggregateMoney(options([null, '', 'garbage', '1,200', Infinity, Number.MAX_SAFE_INTEGER + 1, {}, '1e3', '0.' + '1'.repeat(31), '1'.repeat(121)]
    .map(amount => ({ amount, currency: 'USD' }))));
  assert.equal(out.missingAmounts, 2); assert.equal(out.invalidAmounts, 8);
  assert.equal(out.totals[0].total, null); assert.equal(out.moneyComplete, false);
  const unknown = await aggregateMoney(options([{ amount: '1' }]));
  assert.equal(unknown.totals[0].currency, null); assert.equal(unknown.moneyComplete, false);
  assert.deepEqual((await aggregateMoney(options([]))).totals, []);
});
test('streaming uses all pages, including short nonterminal pages', async () => {
  let calls = 0;
  const out = await aggregateMoney({ ...options([]), pageSize: 2,
    include: r => r.amount !== '9', decode: rows => rows,
    readPage: async ({ cursor, limit }) => {
      assert.equal(limit, 2); calls++;
      if (cursor === null) return { rows: [{ amount: '0.1', currency: 'USD' }], done: false, nextCursor: 1 };
      return { rows: [{ amount: '0.2', currency: 'USD' }, { amount: '9', currency: 'USD' }], done: true };
    } });
  assert.equal(calls, 2); assert.equal(out.totals[0].total, '0.3'); assert.equal(out.matched, 2);
});
test('bad pages, stalled cursors, failed decode and exhausted budgets refuse totals', async () => {
  for (const page of [{}, { rows: [], done: false }, { rows: [{}], done: false, nextCursor: null },
    { rows: [{}, {}], done: true }]) {
    await assert.rejects(aggregateMoney({ ...options([]), pageSize: 1, readPage: async () => page }));
  }
  await assert.rejects(aggregateMoney({ ...options([{}]), decode: () => [] }), /preserve/);
  await assert.rejects(aggregateMoney({ ...options([{}, {}]), maxRows: 1 }), /Row budget/);
  await assert.rejects(aggregateMoney({ ...options([]), maxPages: 1,
    readPage: async () => ({ rows: [{}], done: false, nextCursor: 1 }) }), /Page budget/);
  await assert.rejects(aggregateMoney({ ...options([]),
    readPage: async () => ({ rows: [{}], done: false, nextCursor: 1 }) }), /advance/);
  await assert.rejects(aggregateMoney({ ...options([{ currency: 'USD' }, { currency: 'EUR' }]), maxCurrencies: 1 }), /Currency budget/);
  await assert.rejects(aggregateMoney({ ...options([]), readPage: async () => { throw new Error('read failed'); } }), /read failed/);
  const c = new AbortController(); c.abort();
  await assert.rejects(aggregateMoney({ ...options([]), signal: c.signal }));
  await assert.rejects(aggregateMoney());
  await assert.rejects(aggregateMoney({ ...options([]), pageSize: 0 }));
});
test('PG adapter uses a read-only snapshot, bounded fetches, and releases on success or failure', async () => {
  for (const fail of [false, true]) {
    const calls = []; let batches = 0, released;
    const client = { async query(sql, values) {
      calls.push({ sql, values });
      if (sql.startsWith('FETCH')) {
        if (fail) throw new Error('fetch failed');
        return { rows: batches++ === 0 ? [{ amount: '0.10', currency: 'USD' }] : [] };
      }
      return { rows: [] };
    }, release(value) { released = value; } };
    const request = aggregatePgMoney({ pool: { connect: async () => client }, sql: 'SELECT amount FROM deals WHERE tenant = $1',
      values: ['authorized'], amount: r => r.amount, currency: r => r.currency });
    if (fail) await assert.rejects(request, /fetch failed/);
    else assert.equal((await request).totals[0].total, '0.10');
    assert.equal(calls[0].sql, 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    assert.deepEqual(calls[2].values, ['authorized']);
    assert.equal(calls.at(-1).sql, 'ROLLBACK'); assert.equal(released, false);
  }
  await assert.rejects(aggregatePgMoney({}));
  let released;
  await assert.rejects(aggregatePgMoney({ pool: { connect: async () => ({
    query: async () => { throw new Error('broken'); }, release: value => { released = value; },
  }) }, sql: 'SELECT 1' }), /broken/);
  assert.equal(released, true);
});
