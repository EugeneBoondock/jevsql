import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { JevSQL } from '../src/engine.mjs';
import { compareRowModes, evaluatePredictions } from '../src/evaluation.mjs';
import { fixture, routeSql } from './helpers.mjs';

test('decision table refresh pays only for changed inputs and logs added, updated, removed rows', async (t) => {
  const { engine } = await fixture(t);
  const first = await engine.materialize('routes', routeSql);
  assert.equal(first.changes.added.length, 3);
  assert.equal(first.stats.judgments, 3);
  assert.equal(first.decisions.length, 3);
  const second = await engine.refresh('routes');
  assert.equal(second.stats.requests, 0); assert.equal(second.changes.unchanged, 3);
  engine.exec("UPDATE records SET body='technical outage urgent' WHERE id=1; DELETE FROM records WHERE id=2; INSERT INTO records VALUES (4,'sales help','sales')");
  const third = await engine.refresh('routes');
  assert.equal(third.stats.judgments, 2);
  assert.equal(third.changes.updated.length, 1);
  assert.equal(third.changes.added.length, 1);
  assert.equal(third.changes.removed.length, 1);
  assert.deepEqual(engine.prepare('SELECT id FROM routes ORDER BY id').all().map((row) => row.id), [1, 3, 4]);
  assert.deepEqual(engine.changes('routes', { revision: 3 }).map((row) => row.type).sort(), ['added', 'removed', 'updated']);
  const receipt = engine.prepare('SELECT decisions_json FROM _jevsql_runs WHERE revision=3').get();
  assert.equal(JSON.parse(receipt.decisions_json).length, 3);
});

test('failed refresh rolls back without damaging a previous table or its history', async (t) => {
  const { engine } = await fixture(t);
  await engine.materialize('routes', routeSql);
  const before = engine.prepare('SELECT * FROM routes').all();
  await assert.rejects(() => engine.materialize('routes', 'SELECT 1 AS id, body AS team, 0 AS confidence FROM records'), /Duplicate/);
  assert.deepEqual(engine.prepare('SELECT * FROM routes').all(), before);
  assert.equal(engine.tables()[0].revision, 1);
  assert.equal(engine.changes('routes').length, 3);
});

test('dry-run materialization creates no metadata or tables', async (t) => {
  const { engine, mock } = await fixture(t);
  const result = await engine.materialize('routes', routeSql, { dryRun: true });
  assert.equal(result.dryRun, true); assert.equal(result.stats.judgments, 3);
  assert.equal(mock.requestCount, 0); assert.deepEqual(engine.tables(), []);
  assert.equal(engine.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name LIKE '_jevsql_%' OR name='routes'").get().n, 0);
});

test('saved table and refresh definition survive a process restart', async (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), 'jevsql-save-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'data.db');
  const engine = new JevSQL({ db: file, model: 'jev-test' });
  engine.exec("CREATE TABLE source(id INTEGER, text TEXT); INSERT INTO source VALUES(1,'first')");
  await engine.materialize('saved', 'SELECT * FROM source');
  engine.close();
  const reopened = new JevSQL({ db: file, model: 'jev-test' });
  try {
    reopened.exec("UPDATE source SET text='second' WHERE id=1");
    const result = await reopened.refresh('saved');
    assert.equal(result.changes.updated[0].after.text, 'second');
    assert.equal(result.revision, 2);
  } finally { reopened.close(); }
});

test('decision tables reject collisions, missing keys, null keys, and changed column shapes', async (t) => {
  const { engine } = await fixture(t);
  await assert.rejects(() => engine.materialize('records', routeSql), /overwrite/);
  await assert.rejects(() => engine.materialize('bad', 'SELECT body FROM records'), /key column/);
  await assert.rejects(() => engine.materialize('bad', 'SELECT NULL AS id'), /non-null/);
  await assert.rejects(() => engine.materialize('bad', 'SELECT 1 AS id, 2 AS id'), /distinct/);
  assert.equal(engine.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name='bad'").get().n, 0);
  await engine.materialize('routes', routeSql);
  await assert.rejects(() => engine.materialize('routes', 'SELECT id, body FROM records'), /columns changed/);
});

test('empty decision tables retain their query columns and accept later rows', async (t) => {
  const { engine } = await fixture(t);
  await engine.materialize('later', 'SELECT id, body FROM records WHERE id > 10');
  assert.equal(engine.prepare('SELECT COUNT(*) AS n FROM later').get().n, 0);
  engine.exec("INSERT INTO records VALUES(11,'new','sales')");
  const result = await engine.refresh('later');
  assert.equal(result.changes.added[0].id, 11);
});

test('data checks report violations and route dry runs without deciding a pass', async (t) => {
  const { engine, mock } = await fixture(t);
  const rules = [
    { name: 'No uncertain routes', sql: "SELECT id FROM records WHERE jev_choice(body,'Which team?','billing,technical,sales',0.8) IS NULL" },
    { name: 'No missing text', sql: 'SELECT id FROM records WHERE body IS NULL' },
  ];
  const preview = await engine.check(rules, { dryRun: true });
  assert.equal(preview.ok, null); assert.equal(mock.requestCount, 0);
  const result = await engine.check(rules);
  assert.equal(result.ok, false); assert.equal(result.checks[0].violations, 1); assert.equal(result.checks[1].passed, true);
  assert.equal(result.checks[0].examples[0].id, 3);
});

test('evaluation reports exact coverage and accuracy, with null when none accepted', () => {
  const report = evaluatePredictions([
    { expected: 'a', prediction: 'a', confidence: 0.9 },
    { expected: 'a', prediction: 'b', confidence: 0.6 },
    { expected: 'b', prediction: null },
  ], { thresholds: [0, 0.8, 1] });
  assert.equal(report.thresholds[0].accuracy, 0.5);
  assert.equal(report.thresholds[1].accuracy, 1);
  assert.equal(report.thresholds[1].coverage, 1 / 3);
  assert.equal(report.thresholds[2].accuracy, null);
  assert.equal(report.thresholds[2].review, 3);
  assert.throws(() => evaluatePredictions([{ prediction: 'a', confidence: 1 }]), /ground truth/);
  assert.throws(() => evaluatePredictions([]), /labeled/);
});

test('row-mode comparison reports disagreements, probability movement, and request costs', () => {
  const packed = { rows: [{ id: 1, label: 'a', probability: 0.8 }, { id: 2, label: 'b', probability: 0.6 }],
    stats: { requests: 1, inputTokens: 100, costUsd: 0.01, wallMs: 10 } };
  const isolated = { rows: [{ id: 2, label: 'a', probability: 0.55 }, { id: 1, label: 'a', probability: 0.8 }],
    stats: { requests: 2, inputTokens: 140, costUsd: 0.014, wallMs: 12 } };
  const report = compareRowModes(packed, isolated);
  assert.equal(report.rows, 2);
  assert.equal(report.compared, 4);
  assert.equal(report.fieldDisagreements, 2);
  assert.equal(report.differingRows, 1);
  assert.equal(report.agreementRate, 0.5);
  assert.ok(Math.abs(report.maxNumericDelta - 0.05) < 1e-12);
  assert.equal(report.stats.isolated.requests, 2);
  assert.throws(() => compareRowModes(packed, { rows: [{ id: 3, label: 'a' }] }), /same row keys/);
  assert.throws(() => compareRowModes({ rows: [{ id: 1 }, { id: 1 }] }, { rows: [] }), /unique/);
});

test('SQL evaluation sweeps thresholds without additional model requests', async (t) => {
  const { engine, mock } = await fixture(t);
  const result = await engine.evaluate(`SELECT expected, jev_choice(body,'Which team?','billing,technical,sales') AS prediction,
    jev_choice_conf(body,'Which team?','billing,technical,sales') AS confidence FROM records`);
  assert.equal(mock.requestCount, 1);
  assert.equal(result.thresholds.find((row) => row.threshold === 0.8).accuracy, 1);
  assert.equal(result.total, 3);
});
