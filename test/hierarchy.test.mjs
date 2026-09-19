import test from 'node:test';
import assert from 'node:assert/strict';
import { hierarchicalChoice } from '../src/hierarchy.mjs';

const hierarchy = {
  support: { billing: 'Invoices and refunds', technical: 'Errors and outages' },
  sales: { new_business: 'New customer', renewal: 'Existing customer renewal' },
};

function clientFor(distributions) {
  let call = 0;
  return {
    async evaluate(_state, questions) {
      const current = distributions[call++];
      return { answers: Object.fromEntries(Object.entries(questions).map(([id, value], index) => {
        const probabilities = current[index];
        const choice = Object.entries(probabilities).sort((a, b) => b[1] - a[1])[0][0];
        return [id, { type: 'choice', choice, probabilities, confidence: 0.8 }];
      })) };
    },
  };
}

test('hierarchical Choice keeps likely branches and ranks leaves by normalized path probability', async () => {
  const client = clientFor([
    [{ support: 0.7, sales: 0.3 }],
    [{ billing: 0.2, technical: 0.8 }, { new_business: 0.9, renewal: 0.1 }],
  ]);
  const result = await hierarchicalChoice({ client, state: { ticket: 'API outage' }, question: 'Where should this go?', hierarchy, beamWidth: 2 });
  assert.deepEqual(result.path, ['support', 'technical']);
  assert.equal(result.label, 'technical');
  assert.equal(result.requests, 2);
  assert.ok(Math.abs(result.probability - 0.56) < 1e-12);
  assert.equal(result.review, false);
});

test('hierarchical Choice routes close rivals to review and validates its taxonomy', async () => {
  const client = clientFor([
    [{ support: 0.51, sales: 0.49 }],
    [{ billing: 0.51, technical: 0.49 }, { new_business: 0.51, renewal: 0.49 }],
  ]);
  const result = await hierarchicalChoice({ client, state: 'ambiguous', question: 'Route?', hierarchy, beamWidth: 2, minMargin: 0.02 });
  assert.equal(result.review, true);
  assert.equal(result.reason, 'margin');
  assert.equal(result.path, null);
  await assert.rejects(() => hierarchicalChoice({ client, state: '', question: '', hierarchy: { only: null } }), /at least two/);
});
