import test from 'node:test';
import assert from 'node:assert/strict';
import { judgmentFor, judgmentKey, questionBody } from '../src/functions.mjs';
import { findCandidates } from '../src/decisions.mjs';
import { validateAnswer } from '../src/validation.mjs';
import { fixture } from './helpers.mjs';

test('abstention keeps both boundary probabilities in review and shares the noul answer', () => {
  const decision = judgmentFor('jev_decide', ['text', 'question', 0.2, 0.8]);
  assert.deepEqual([0, 0.2, 0.5, 0.8, 1].map((noul) => decision.read({ noul })), [0, null, null, null, 1]);
  assert.equal(judgmentKey('model', decision), judgmentKey('model', judgmentFor('jev_noul', ['text', 'question'])));
  assert.throws(() => judgmentFor('jev_decide', ['text', 'question', 0.8, 0.2]), /below/);
});

test('JSON option descriptions and structured levels reach the provider intact', () => {
  const criteria = { billing: { covers: ['invoices', 'refunds'] }, technical: 'Outages and errors' };
  const judgment = judgmentFor('jev_choice', ['text', JSON.stringify({ task: 'route' }), JSON.stringify(criteria)]);
  assert.deepEqual(questionBody(judgment, 'rows.r0').criteria, criteria);
  assert.deepEqual(judgment.question, { task: 'route' });
  const levels = [{ condition: 'Healthy' }, { condition: 'Blocking outage' }];
  assert.deepEqual(judgmentFor('jev_score', ['text', 'Severity?', JSON.stringify(levels)]).criteria, levels);
});

test('structured Noul criteria reach the provider and remain part of judgment identity', () => {
  const criteria = { true: { all: ['same legal entity', 'compatible address'] }, false: 'Different entities' };
  const raw = JSON.stringify(criteria);
  const noul = judgmentFor('jev_noul', ['text', 'question', raw]);
  assert.deepEqual(questionBody(noul, 'rows.r0').criteria, criteria);
  assert.equal(judgmentKey('m', noul), judgmentKey('m', judgmentFor('jev_bool', ['text', 'question', 0.7, raw])));
  assert.notEqual(judgmentKey('m', noul), judgmentKey('m', judgmentFor('jev_noul', ['text', 'question'])));
  assert.deepEqual(judgmentFor('jev_decide', ['text', 'question', 0.2, 0.8, raw]).criteria, criteria);
  assert.deepEqual(judgmentFor('jev_match', ['left', 'right', 'same?', raw]).criteria, criteria);
  for (const bad of ['{}', '{"true":"yes"}', '[]', 'plain text', '{bad']) {
    assert.throws(() => judgmentFor('jev_noul', ['text', 'question', bad]), /criteria/);
  }
});

test('normalized score and probability projections reuse their original judgment', () => {
  const args = ['text', 'severity', 'calm,frustrated,angry'];
  const score = judgmentFor('jev_score_norm', args);
  assert.equal(score.read({ score: 1.5 }), 0.75);
  assert.equal(judgmentKey('m', score), judgmentKey('m', judgmentFor('jev_score', args)));
  const distribution = judgmentFor('jev_choice_probs', args);
  assert.deepEqual(JSON.parse(distribution.read({ probabilities: { calm: 1, frustrated: 0, angry: 0 } })), { calm: 1, frustrated: 0, angry: 0 });
});

test('winning Choice probability can be read and used as the abstention gate', () => {
  const args = ['text', 'team', 'billing,technical'];
  const answer = { choice: 'technical', confidence: 0.99, probabilities: { billing: 0.35, technical: 0.65 } };
  const top = judgmentFor('jev_choice_top_prob', args);
  assert.equal(top.read(answer), 0.65);
  assert.equal(judgmentFor('jev_choice_prob_gate', [...args, 0.6]).read(answer), 'technical');
  assert.equal(judgmentFor('jev_choice_prob_gate', [...args, 0.7]).read(answer), null);
  assert.equal(judgmentKey('m', top), judgmentKey('m', judgmentFor('jev_choice', args)));
});

test('bad rubric sizes, labels and thresholds fail locally', () => {
  for (const options of ['a', 'a,a', '["a",]', JSON.stringify(Array.from({ length: 256 }, (_, i) => String(i)))]) {
    assert.throws(() => judgmentFor('jev_choice', ['t', 'q', options]));
  }
  for (const levels of ['a', JSON.stringify(Array(11).fill('level'))]) assert.throws(() => judgmentFor('jev_score', ['t', 'q', levels]));
  for (const threshold of [-1, 2, NaN, Infinity, '0.5']) assert.throws(() => judgmentFor('jev_bool', ['t', 'q', threshold]));
  assert.throws(() => judgmentFor('jev_prob', ['t', 'q', 'a,b', 'c']), /supplied option/);
});

test('candidate discovery is exact, deduplicated and bounded', () => {
  const body = 'Send to billing@example.com, not old@example.com. billing@example.com';
  assert.deepEqual(findCandidates(body), ['billing@example.com', 'old@example.com']);
  assert.deepEqual(findCandidates('Total USD 42.00; earlier $10.50', 'money'), ['USD 42.00', '$10.50']);
  assert.deepEqual(findCandidates(null), []);
  assert.throws(() => findCandidates('anything', 'constructor'), /Candidate kind/);
  assert.throws(() => findCandidates(Array.from({ length: 255 }, (_, i) => `a${i}@example.com`).join(' ')), /254/);
});

test('pick returns a verbatim span, abstains, and cannot accept invented candidates', () => {
  const args = ['Receipt to new@example.com; old@example.com is obsolete.', 'Where should the receipt go?', '["new@example.com","old@example.com"]'];
  const pick = judgmentFor('jev_pick', args);
  assert.equal(pick.read({ choice: 'c0', confidence: 0.9 }), 'new@example.com');
  assert.equal(pick.read({ choice: 'none', confidence: 0.9 }), null);
  assert.equal(pick.read({ choice: 'c0', confidence: 0.7 }), null);
  assert.equal(judgmentKey('m', pick), judgmentKey('m', judgmentFor('jev_pick_conf', args)));
  assert.throws(() => judgmentFor('jev_pick', ['source', 'q', '["invented"]']), /exact spans/);
  assert.equal(judgmentFor('jev_pick', ['source', 'q', '[]']), null);
});

test('semantic join state preserves both structured records', async (t) => {
  const { engine, mock } = await fixture(t);
  await engine.query(`SELECT jev_match(json_object('name', 'Acme'), json_object('name', 'Acme Ltd')) AS p`);
  assert.deepEqual(Object.values(mock.calls[0].state.rows)[0], { left: { name: 'Acme' }, right: { name: 'Acme Ltd' } });
});

test('empty candidates and SQL NULL never spend a model question', async (t) => {
  const { engine, mock } = await fixture(t);
  const { rows } = await engine.query(`SELECT jev_pick('no email here', 'receipt email', jev_candidates('no email here','email')) AS picked,
    jev_noul(NULL, 'urgent?') AS missing, jev_match('left', NULL) AS unmatched`);
  assert.equal(rows[0].picked, null); assert.equal(rows[0].missing, null); assert.equal(rows[0].unmatched, null);
  assert.equal(mock.requestCount, 0);
});

test('SQL pick and confidence share one response with the closed candidate set', async (t) => {
  const { engine, mock } = await fixture(t, {}, {
    answerFor: (q) => q.type === 'choice' ? { type: 'choice', choice: 'c0', probabilities: { c0: 0.95, none: 0.05 }, confidence: 0.9 } : undefined,
  });
  const { rows } = await engine.query(`SELECT jev_pick(?, 'Receipt email?', '["new@example.com"]') AS email,
    jev_pick_conf(?, 'Receipt email?', '["new@example.com"]') AS confidence`, { params: ['Use new@example.com', 'Use new@example.com'] });
  assert.equal(rows[0].email, 'new@example.com'); assert.equal(rows[0].confidence, 0.9);
  assert.equal(Object.keys(mock.calls[0].questions).length, 1);
});

test('answer validation rejects malformed types, missing probabilities and out-of-range values', () => {
  const noul = { kind: 'noul' };
  assert.throws(() => validateAnswer({ type: 'noul', noul: 4 }, noul));
  const choice = { kind: 'choice', criteria: ['a', 'b'] };
  assert.throws(() => validateAnswer({ type: 'choice', choice: 'invented', confidence: 1, probabilities: { a: 1, b: 0 } }, choice));
  assert.throws(() => validateAnswer({ type: 'choice', choice: 'a', confidence: 1, probabilities: { a: 1 } }, choice));
  assert.throws(() => validateAnswer({ type: 'choice', choice: 'a', confidence: 1, probabilities: { a: 1, b: 1 } }, choice));
});
