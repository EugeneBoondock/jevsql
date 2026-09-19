// Run: node --env-file=.env.local examples/large-money-total.mjs --live
// Requires the development pg dependency. No application tables are read or written.
import assert from 'node:assert/strict';
import pg from 'pg';
import { aggregatePgMoney } from '../src/money.mjs';
if (!process.argv.includes('--live')) throw new Error('Pass --live for the read-only PostgreSQL check.');
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }, max: 1, connectionTimeoutMillis: 8000 });
try {
  const started = performance.now();
  const result = await aggregatePgMoney({
    pool, sql: "SELECT '0.10' AS amount, 'USD' AS currency FROM generate_series(1, $1::int)",
    values: [100001], pageSize: 1000, amount: row => row.amount, currency: row => row.currency,
    signal: AbortSignal.timeout(45000),
  });
  assert.equal(result.scanned, 100001);
  assert.equal(result.totals[0].total, '10000.10');
  assert.equal(result.complete, true);
  console.log(JSON.stringify({ rows: result.scanned, batches: result.pages,
    total: result.totals[0].total, currency: 'USD',
    latencyMs: Math.round(performance.now() - started), consistency: result.consistency, writes: 0 }));
} finally { await pool.end(); }
