import test from 'node:test';
import assert from 'node:assert/strict';
import { routeApprovedFunction } from '../src/function-router.mjs';

function client(selections) {
  let call = 0;
  return { async evaluate(_state, questions) {
    const current = selections[call++];
    return { answers: Object.fromEntries(Object.entries(questions).map(([id, question]) => {
      const labels = Object.keys(question.criteria);
      const choice = current[id];
      const rest = 0.05 / (labels.length - 1);
      return [id, { type: 'choice', choice, confidence: 0.9,
        probabilities: Object.fromEntries(labels.map((label) => [label, label === choice ? 0.95 : rest])) }];
    })) };
  } };
}

const registry = (calls) => ({
  notify: {
    description: 'Send a registered notification.',
    sideEffect: true,
    args: {
      channel: { options: ['email', 'sms'], default: 'email' },
      urgency: { options: ['normal', 'urgent'], default: 'normal' },
    },
    run: async (args) => { calls.push(args); return 'sent'; },
  },
  lookup: { description: 'Read an existing record.', args: { table: { options: ['orders', 'customers'] } } },
});

test('function router uses closed arguments and registered defaults', async () => {
  const result = await routeApprovedFunction({
    client: client([{ function: 'notify' }, { channel: '__default__', urgency: 'urgent' }]),
    state: 'Please send an urgent notification.', request: 'Notify the customer.', functions: registry([]),
  });
  assert.deepEqual(result, { status: 'confirmation_required', function: 'notify', args: { channel: 'email', urgency: 'urgent' } });
});

test('side effects cannot run without affirmative code confirmation', async () => {
  const calls = [];
  const denied = await routeApprovedFunction({
    client: client([{ function: 'notify' }, { channel: 'sms', urgency: '__default__' }]),
    state: 'Notify by SMS.', request: 'Notify.', functions: registry(calls), execute: true,
  });
  assert.equal(denied.status, 'confirmation_required');
  assert.equal(calls.length, 0);

  const allowed = await routeApprovedFunction({
    client: client([{ function: 'notify' }, { channel: 'sms', urgency: '__default__' }]),
    state: 'Notify by SMS.', request: 'Notify.', functions: registry(calls), execute: true, confirm: async () => true,
  });
  assert.equal(allowed.status, 'executed');
  assert.equal(allowed.output, 'sent');
  assert.deepEqual(calls, [{ channel: 'sms', urgency: 'normal' }]);
});

test('unsupported functions and missing arguments go to review', async () => {
  const none = await routeApprovedFunction({
    client: client([{ function: '__unknown__' }]), state: '', request: 'Delete everything.', functions: registry([]),
  });
  assert.equal(none.reason, 'no_function');
  const missing = await routeApprovedFunction({
    client: client([{ function: 'lookup' }, { table: '__unknown__' }]), state: '', request: 'Look it up.', functions: registry([]),
  });
  assert.equal(missing.reason, 'missing_argument:table');
});
