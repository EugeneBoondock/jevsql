import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { JevSQL } from '../src/engine.mjs';
import { REVENUE_TEMPLATE, seedControlData, scriptedControlClient, runControlDemo } from '../examples/control-plane.mjs';

const exec = promisify(execFile), bin = fileURLToPath(new URL('../bin/jevsql.mjs', import.meta.url));
async function setup(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'jevsql-control-'));
  const client = scriptedControlClient();
  const server = http.createServer(async (req, res) => {
    try {
      let text = ''; for await (const chunk of req) text += chunk;
      const input = JSON.parse(text);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(await client.evaluate(input.state, input.questions)));
    } catch { res.writeHead(500); res.end('{}'); }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const db = path.join(dir, 'data.sqlite'), engine = new JevSQL({ db });
  seedControlData(engine); engine.close();
  const json = (name, data) => { const file = path.join(dir, `${name}.json`); writeFileSync(file, JSON.stringify(data)); return file; };
  const run = async (...args) => {
    const env = { ...process.env, TYPESAFE_API_KEY: 'fixture-only', TYPESAFE_DEFAULT_MODEL: client.model, TYPESAFE_BASE_URL: `http://127.0.0.1:${server.address().port}` };
    try { const result = await exec(process.execPath, [bin, 'control', ...args, '--model', client.model], { cwd: dir, env, maxBuffer: 3e6 }); return { ...result, code: 0 }; }
    catch (error) { return { stdout: error.stdout, stderr: error.stderr, code: error.code }; }
  };
  t.after(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); rmSync(dir, { recursive: true, force: true }); });
  return { dir, db, json, run, client };
}

test('control CLI executes an allowed typed read and reuses cached judgments across processes', async (t) => {
  const { dir, db, json, run, client } = await setup(t);
  const input = json('request', { request: 'Show paid revenue for my tenant', templates: [REVENUE_TEMPLATE], templateId: REVENUE_TEMPLATE.id,
    actor: { id: 'analyst', roles: ['analyst'], tenantId: 'tenant-a' }, params: { status: 'paid' } });
  const cache = path.join(dir, 'cache.json'), store = path.join(dir, 'receipts.sqlite');
  for (let i = 0; i < 2; i++) {
    const result = await run('run', input, '--db', db, '--cache', cache, '--store', store);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).rows[0].revenue, 120);
  }
  assert.equal(client.calls.length, 1);
  const verified = await run('verify', '--store', store);
  assert.equal(JSON.parse(verified.stdout).ok, true);
  assert.equal(JSON.parse(verified.stdout).count, 4);
});

test('control CLI dry run needs no model calls and creates no receipt database', async (t) => {
  const { dir, json, run, client } = await setup(t);
  const input = json('event', { kind: 'catalog', state: { table: 'customers', description: 'Customer account records' } });
  const store = path.join(dir, 'dry.sqlite');
  const result = await run('review', input, '--dry-run', '--store', store);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).dryRun, true);
  assert.equal(client.calls.length, 0); assert.equal(existsSync(store), false);
});

test('control CLI returns review exit status and stores feedback without overwriting the decision', async (t) => {
  const { dir, json, run } = await setup(t);
  const store = path.join(dir, 'audit.sqlite');
  const reviewed = await run('review', json('quality', { kind: 'quality', state: { status: 'closed', body: 'Still failing' } }), '--store', store);
  assert.equal(reviewed.code, 2, reviewed.stderr);
  const receipt = JSON.parse(reviewed.stdout);
  assert.equal(JSON.parse((await run('queue', '--store', store)).stdout).length, 1);
  const label = await run('feedback', json('label', { receiptId: receipt.id, reviewer: 'human-1', label: true }), '--store', store);
  assert.equal(label.code, 0, label.stderr);
  assert.equal(JSON.parse((await run('queue', '--store', store)).stdout).length, 0);
  const receipts = JSON.parse((await run('receipts', '--store', store)).stdout);
  assert.equal(receipts[0].decision, 'review');
});

test('control CLI qualifies holdout evidence conservatively and reports metadata without inference', async (t) => {
  const { db, json, run, client } = await setup(t);
  const schema = await run('schema', '--db', db);
  assert.equal(schema.code, 0, schema.stderr); assert.equal(JSON.parse(schema.stdout).tables[0].name, 'orders');
  const qualified = await run('qualify', json('labels', { cases: [
    { caseId: 'only-one', split: 'holdout', expected: true, probability: 0.99, decision: 'block' },
  ], options: { unsafeLabel: true, tuningCaseIds: [] } }));
  assert.equal(qualified.code, 2, qualified.stderr); assert.equal(JSON.parse(qualified.stdout).status, 'review');
  assert.equal(client.calls.length, 0);
  const error = await run('schema', '--db', `${db}.missing`); assert.equal(error.code, 1);
});

test('offline control demo exercises tenant isolation, stale permits, drift, telemetry and held-out limits', async () => {
  const report = await runControlDemo();
  assert.equal(report.usage.requests, 0);
  assert.equal(report.governedRead.otherTenantExcluded, true);
  assert.equal(report.governedRead.warmRequests, 0);
  assert.equal(report.stalePermitRejected, true);
  assert.equal(report.migration.executed, false);
  assert.equal(report.replica.nodeId, 'replica-current');
  assert.equal(report.qualification.status, 'review');
  assert.equal(report.audit.ok, true);
});
