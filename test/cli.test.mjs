import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startMockServer } from './mock-server.mjs';
import { runWorkflows } from '../examples/workflows.mjs';
import { JevSQL } from '../src/engine.mjs';

const execute = promisify(execFile);
const bin = fileURLToPath(new URL('../bin/jevsql.mjs', import.meta.url));

async function cliFixture(t) {
  const cwd = mkdtempSync(path.join(tmpdir(), 'jevsql-cli-'));
  const mock = await startMockServer();
  t.after(async () => { await mock.close(); rmSync(cwd, { recursive: true, force: true }); });
  const env = { ...process.env, TYPESAFE_API_KEY: 'test-only', TYPESAFE_BASE_URL: mock.baseUrl, TYPESAFE_DEFAULT_MODEL: 'jev-test' };
  writeFileSync(path.join(cwd, 'data.csv'), 'id,body\n1,urgent refund\n2,no hurry\n');
  const run = async (...args) => {
    try { return { ...(await execute(process.execPath, [bin, ...args], { cwd, env })), code: 0 }; }
    catch (error) { return { stdout: error.stdout, stderr: error.stderr, code: error.code }; }
  };
  return { cwd, run, mock };
}

test('CLI SQL files, named params, JSON receipts and warm cache work together', async (t) => {
  const { cwd, run, mock } = await cliFixture(t);
  writeFileSync(path.join(cwd, 'query.sql'), 'SELECT id, jev_noul(body,:q) AS p FROM data ORDER BY p DESC LIMIT :n;');
  const args = ['query', '--file', 'query.sql', '--params', JSON.stringify({ q: 'Is this urgent?', n: 1 }), '--csv', 'data.csv', '--audit', '--quiet'];
  const first = await run(...args);
  assert.equal(first.code, 0, first.stderr);
  const receipt = JSON.parse(first.stdout);
  assert.equal(receipt.rows[0].id, '1'); assert.equal(receipt.decisions.length, 2);
  const second = await run(...args);
  assert.equal(second.code, 0, second.stderr);
  assert.equal(JSON.parse(second.stdout).stats.requests, 0); assert.equal(mock.requestCount, 1);
});

test('CLI explain is machine-readable and makes no requests', async (t) => {
  const { run, mock } = await cliFixture(t);
  const result = await run('explain', "SELECT jev_noul(body,'q') FROM data", '--csv', 'data.csv', '--json');
  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).judgments, 2); assert.equal(mock.requestCount, 0);
});

test('CLI saved tables refresh across processes and expose recorded changes', async (t) => {
  const { run, mock } = await cliFixture(t);
  const saved = await run('materialize', 'decisions', "SELECT id, jev_noul(body,'Is this urgent?') AS p FROM data", '--csv', 'data.csv', '--db', 'data.db', '--quiet');
  assert.equal(saved.code, 0, saved.stderr);
  const refreshed = await run('refresh', 'decisions', '--db', 'data.db');
  assert.equal(refreshed.code, 0, refreshed.stderr);
  assert.equal(JSON.parse(refreshed.stdout).changes.unchanged, 2);
  const changes = await run('changes', 'decisions', '--db', 'data.db', '--revision', '1');
  assert.equal(changes.code, 0, changes.stderr); assert.equal(JSON.parse(changes.stdout).length, 2);
  const tables = await run('tables', '--db', 'data.db', '--json');
  assert.equal(JSON.parse(tables.stdout)[0].revision, 2); assert.equal(mock.requestCount, 1);
});

test('CLI checks exit 2 for violations, 0 for pass, 1 for usage errors', async (t) => {
  const { cwd, run, mock } = await cliFixture(t);
  writeFileSync(path.join(cwd, 'fail.json'), JSON.stringify([{ name: 'Nothing urgent', sql: "SELECT * FROM data WHERE jev_bool(body,'Is this urgent?')=1" }]));
  const failed = await run('check', 'fail.json', '--csv', 'data.csv');
  assert.equal(failed.code, 2); assert.equal(JSON.parse(failed.stdout).checks[0].violations, 1);
  writeFileSync(path.join(cwd, 'pass.json'), JSON.stringify([{ name: 'No missing text', sql: 'SELECT * FROM data WHERE body IS NULL' }]));
  const passed = await run('check', 'pass.json', '--csv', 'data.csv');
  assert.equal(passed.code, 0); assert.equal(JSON.parse(passed.stdout).ok, true);
  const before = mock.requestCount;
  for (const args of [['query', 'SELECT 1', '--max-judgments', '-2'], ['query', 'SELECT 1', '--file'],
    ['materialize', 'x', 'SELECT 1 AS id'], ['query', 'SELECT 1', '--unknown']]) {
    assert.equal((await run(...args)).code, 1);
  }
  assert.equal(mock.requestCount, before);
});

test('CLI zero judgment guard is honored', async (t) => {
  const { run, mock } = await cliFixture(t);
  const result = await run('query', "SELECT jev_noul(body,'q') FROM data", '--csv', 'data.csv', '--max-judgments', '0');
  assert.equal(result.code, 1); assert.match(result.stderr, /limit of 0/); assert.equal(mock.requestCount, 0);
});

test('offline workflow tour exercises every recipe and preserves a normal SQLite output', async (t) => {
  const cwd = mkdtempSync(path.join(tmpdir(), 'jevsql-tour-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const db = path.join(cwd, 'tour.db');
  const tour = await runWorkflows({ db, log() {} });
  assert.equal(tour.first.stats.judgments, 3);
  assert.equal(tour.extraction.rows[0].invoice_email, 'billing@acme.example');
  assert.equal(tour.extraction.rows[1].invoice_email, null);
  assert.equal(tour.matches.rows.length, 2);
  assert.equal(tour.matches.rows[0].match_probability, 0.97);
  assert.equal(tour.ranking.rows.length, 1);
  assert.ok(tour.ranking.rows[0].answer_probability > 0.5);
  assert.equal(tour.warm.stats.requests, 0);
  assert.equal(tour.changed.stats.judgments, 1);
  assert.equal(tour.changed.changes.updated[0].after.prediction, 'contradicted');
  assert.equal(tour.checks.ok, false);
  const engine = new JevSQL({ db });
  try { assert.equal((await engine.query('SELECT COUNT(*) AS n FROM evidence_decisions')).rows[0].n, 3); }
  finally { engine.close(); }
});
