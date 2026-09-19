import test from 'node:test';
import assert from 'node:assert/strict';
import { extractDate, resolveDateParts } from '../src/date-extraction.mjs';

function answer(labels, selected, winning = 0.9) {
  const remainder = (1 - winning) / (labels.length - 1);
  return { type: 'choice', choice: selected, confidence: 0.8,
    probabilities: Object.fromEntries(labels.map((label) => [label, label === selected ? winning : remainder])) };
}

function dateClient(selections, probability = 0.9) {
  return { async evaluate(_state, questions) {
    return { answers: Object.fromEntries(Object.entries(questions).map(([part, value]) => {
      const labels = Object.keys(value.criteria);
      return [part, answer(labels, selections[part], probability)];
    })) };
  } };
}

test('date resolver validates absolute dates and applies calendar-safe relative arithmetic', () => {
  assert.deepEqual(resolveDateParts({ mode: 'absolute', year: '2028', month: '2', day: '29' }),
    { status: 'resolved', date: '2028-02-29', mode: 'absolute' });
  assert.equal(resolveDateParts({ mode: 'absolute', year: '2027', month: '2', day: '29' }).reason, 'invalid_calendar_date');
  assert.equal(resolveDateParts({ mode: 'relative', amount: '1', unit: 'month', direction: 'future' },
    { referenceDate: '2026-01-31' }).date, '2026-02-28');
  assert.equal(resolveDateParts({ mode: 'relative', amount: '2', unit: 'week', direction: 'past' },
    { referenceDate: '2026-09-19' }).date, '2026-09-05');
});

test('date extraction selects bounded parts and resolves them in code', async () => {
  const absolute = await extractDate({
    client: dateClient({ mode: 'absolute', year: '2027', month: '4', day: '5', unit: 'unknown', amount: 'unknown', direction: 'unknown' }),
    state: 'The renewal is due April 5, 2027.', referenceDate: '2026-09-19', question: 'When is renewal due?',
  });
  assert.equal(absolute.date, '2027-04-05');
  assert.equal(absolute.status, 'resolved');

  const relative = await extractDate({
    client: dateClient({ mode: 'relative', year: 'unknown', month: 'unknown', day: 'unknown', unit: 'day', amount: '3', direction: 'future' }),
    state: 'Follow up in three days.', referenceDate: '2026-09-19',
  });
  assert.equal(relative.date, '2026-09-22');
});

test('date extraction sends uncertain or incomplete selections to review', async () => {
  const low = await extractDate({
    client: dateClient({ mode: 'absolute', year: '2027', month: '4', day: '5', unit: 'unknown', amount: 'unknown', direction: 'unknown' }, 0.55),
    state: 'Maybe April 5, 2027.', referenceDate: '2026-09-19', minProbability: 0.6,
  });
  assert.equal(low.status, 'review');
  assert.equal(low.reason, 'low_probability_mode');
});
