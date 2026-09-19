// A qualifier narrows the statement it belongs to, and no other.
//
// `filtered` and `limited` used to be a flat search of every word anywhere in
// the text. A writable CTE puts a whole separate statement inside parentheses,
// so a SELECT's WHERE answered for the DELETE that followed it and a statement
// that emptied a table reported destructive: false with no reasons at all.
//
// The README's own example survived only because it happens to contain no
// WHERE anywhere. These tests cover the sibling that did not.
import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyStatement } from '../src/sql-inspector.mjs';
import { DatabaseControl, DecisionService } from '../src/control-plane.mjs';

/** A provider that answers every question affirmatively, so the only thing
 *  deciding the outcome is the deterministic classification. */
const client = { model: 'jev-test-v1', async evaluate(state, questions) {
  return { model: this.model, usage: { input_tokens: 10 },
    answers: Object.fromEntries(Object.entries(questions).map(([id, question]) => {
      if (question.type === 'noul') return [id, { type: 'noul', noul: 0.99 }];
      const labels = question.type === 'choice' ? Object.keys(question.criteria) : question.criteria.map((_, i) => String(i));
      return [id, { type: question.type, [question.type === 'choice' ? 'choice' : 'score']: question.type === 'choice' ? labels[0] : 0,
        confidence: 0.99, probabilities: Object.fromEntries(labels.map((label, i) => [label, i === 0 ? 1 : 0])) }];
    })) };
} };

test('a WHERE inside a CTE does not qualify the DELETE that follows it', () => {
  const classified = classifyStatement(
    "WITH recent AS (SELECT id FROM orders WHERE created_at > '2020-01-01') DELETE FROM audit_log");
  assert.equal(classified.operation, 'delete');
  assert.equal(classified.filtered, false, 'the DELETE has no WHERE of its own');
  assert.equal(classified.destructive, true);
  assert.equal(classified.unbounded, true);
  assert.deepEqual(classified.reasons, ['deletes without a WHERE clause']);
});

test('a LIMIT inside a CTE does not bound the UPDATE that follows it', () => {
  const classified = classifyStatement('WITH top AS (SELECT id FROM t LIMIT 10) UPDATE users SET flag = 1');
  assert.equal(classified.limited, false);
  assert.equal(classified.unbounded, true);
});

test('a qualifier before the write does not count either', () => {
  // The CTE is the only place a qualifier can precede the write, and it is
  // exactly the case that was wrong. Position matters as well as depth.
  const classified = classifyStatement(
    'WITH picked AS (SELECT id FROM t WHERE flag = 1 LIMIT 5) DELETE FROM t');
  assert.equal(classified.filtered, false);
  assert.equal(classified.limited, false);
  assert.equal(classified.destructive, true);
});

test('the statement’s own qualifiers still count, however they are nested', () => {
  for (const [label, sql] of [
    ['a plain WHERE', 'DELETE FROM t WHERE id = 1'],
    ['a WHERE holding a subquery', 'DELETE FROM t WHERE id IN (SELECT id FROM u WHERE x = 1)'],
    ['an UPDATE with a scalar subquery before its WHERE', 'UPDATE t SET x = (SELECT max(y) FROM u) WHERE id = 1'],
    ['a CTE feeding a bounded delete', "WITH old AS (SELECT id FROM t WHERE ts < '2020-01-01') DELETE FROM t WHERE id IN (SELECT id FROM old)"],
  ]) {
    const classified = classifyStatement(sql);
    assert.equal(classified.filtered, true, label);
    assert.equal(classified.destructive, false, label);
    assert.equal(classified.unbounded, false, label);
  }
});

test('a LIMIT on the write itself still bounds it', () => {
  const classified = classifyStatement('DELETE FROM t ORDER BY id LIMIT 5');
  assert.equal(classified.limited, true);
  assert.equal(classified.unbounded, false);
});

test('the review of a CTE-hidden delete asks for a person out of band', async (t) => {
  // classifyStatement feeds requiredApproval. Before this, the CTE's WHERE
  // took the same statement down to `human`.
  const service = new DecisionService({ client });
  t.after(async () => { await service.close(); });
  const control = new DatabaseControl({ service });
  const review = await control.reviewStatement({
    statement: "WITH recent AS (SELECT id FROM orders WHERE created_at > '2020-01-01') DELETE FROM audit_log",
    intent: 'Remove orders that are no longer needed.',
  });
  assert.equal(review.classification.destructive, true);
  assert.equal(review.requiredApproval, 'out_of_band_human');
});

test('the keyword bag is read from the dialect-aware mask', () => {
  // maskSql knows nothing about PostgreSQL dollar-quoting, so the words inside
  // $$...$$ used to land in the keyword bag: a plain read came back as
  // operation: schema, destructive: true, and a legitimate query was escalated
  // to a person. sqlMetadata already handles it, and the reviewer is shown its
  // output, so the classification has to agree with what the reviewer reads.
  const benign = classifyStatement('SELECT $$ drop table users $$::text', { dialect: 'postgresql' });
  assert.equal(benign.operation, 'read');
  assert.equal(benign.destructive, false);
  assert.equal(benign.changesSchema, false);

  // And the same masking must not hide a real write behind quoted text.
  const hidden = classifyStatement(
    'WITH gone AS (DELETE FROM users RETURNING id, $$where$$ AS note) SELECT count(*) FROM gone',
    { dialect: 'postgresql' });
  assert.equal(hidden.operation, 'delete');
  assert.equal(hidden.filtered, false, 'a quoted "where" is text, not a qualifier');
  assert.equal(hidden.destructive, true);
});

test('SQL nobody can parse is unknown and unsafe, not an exception', () => {
  // The contract in the doc comment is that anything unresolvable is unknown
  // and never auto-runs. It threw instead, so an unclosed quote — routine in
  // text a model wrote — crashed the review rather than being refused by it.
  for (const sql of ["SELECT * FROM t WHERE a = 'x", 'SELECT "col FROM t', 'SELECT * FROM t /* open']) {
    const classified = classifyStatement(sql);
    assert.equal(classified.operation, 'unknown', sql);
    assert.equal(classified.destructive, true, 'unparseable is not evidence of harmless');
    assert.equal(classified.unbounded, true, sql);
    assert.match(classified.reasons[0], /could not be parsed/);
    assert.equal(classified.sql, null, 'there is no masked text to show a reviewer');
  }
});

test('a review of unparseable SQL is refused rather than thrown', async (t) => {
  const service = new DecisionService({ client });
  t.after(async () => { await service.close(); });
  const control = new DatabaseControl({ service });
  const review = await control.reviewStatement({ statement: "SELECT * FROM t WHERE a = 'x", intent: 'Read a row.' });
  assert.equal(review.classification.operation, 'unknown');
  assert.ok(review.findings.some((finding) => finding.code === 'unclassified_operation'));
  assert.notEqual(review.requiredApproval, 'none');
});

test('a denied column is denied however it was written', async (t) => {
  // Resolved reads are always three parts. Only the two-part form was
  // completed, so `deniedColumns: ['salary']` matched nothing and protected
  // nothing — silently. A control that quietly does nothing is worse than an
  // absent one, because it is in the policy and gets believed.
  const { DatabaseSync } = await import('node:sqlite');
  const { inspectQuery } = await import('../src/sql-inspector.mjs');
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec('CREATE TABLE people(id INTEGER PRIMARY KEY, name TEXT, salary REAL)');

  const blocks = (deniedColumns) => inspectQuery(db, 'SELECT salary FROM people',
    { deniedColumns, allowedTables: ['people'] }).findings.some((finding) => finding.code === 'column_not_allowed');

  for (const form of [['salary'], ['people.salary'], ['main.people.salary']]) {
    assert.equal(blocks(form), true, JSON.stringify(form));
  }
  assert.equal(blocks(['name']), false, 'a column the query never reads is not a finding');
  assert.throws(() => blocks(['a.b.c.d']), TypeError, 'an unusable shape is refused, not ignored');
  assert.throws(() => blocks(['   ']), TypeError);
});
