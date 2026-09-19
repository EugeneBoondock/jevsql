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
