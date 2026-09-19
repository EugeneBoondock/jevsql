import { integer, probability, validateAnswer } from './validation.mjs';

function dateOnly(value, name = 'referenceDate') {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new TypeError(`${name} must be a valid date.`);
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function result(date, extra = {}) {
  return { status: 'resolved', date: date.toISOString().slice(0, 10), ...extra };
}

/** Resolve model-selected date parts with calendar arithmetic in code. */
export function resolveDateParts(parts, { referenceDate = new Date(), maxRelative = 31 } = {}) {
  integer(maxRelative, 'maxRelative', 0, 253);
  const reference = dateOnly(referenceDate);
  if (!parts || typeof parts !== 'object') return { status: 'review', date: null, reason: 'missing_parts' };
  if (parts.mode === 'none') return { status: 'none', date: null, reason: null };
  if (parts.mode === 'absolute') {
    const year = Number(parts.year), month = Number(parts.month), day = Number(parts.day);
    if (![year, month, day].every(Number.isInteger)) return { status: 'review', date: null, reason: 'missing_absolute_part' };
    const date = new Date(Date.UTC(year, month - 1, day));
    if (year < 1 || year > 9999 || date.getUTCFullYear() !== year
        || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
      return { status: 'review', date: null, reason: 'invalid_calendar_date' };
    }
    return result(date, { mode: 'absolute' });
  }
  if (parts.mode !== 'relative') return { status: 'review', date: null, reason: 'invalid_mode' };
  const amount = Number(parts.amount);
  if (!Number.isInteger(amount) || amount < 0 || amount > maxRelative
      || !['day', 'week', 'month', 'year'].includes(parts.unit)
      || !['past', 'future'].includes(parts.direction)) {
    return { status: 'review', date: null, reason: 'missing_relative_part' };
  }
  const signed = parts.direction === 'future' ? amount : -amount;
  if (parts.unit === 'day' || parts.unit === 'week') {
    const date = new Date(reference);
    date.setUTCDate(date.getUTCDate() + signed * (parts.unit === 'week' ? 7 : 1));
    return result(date, { mode: 'relative' });
  }
  const originalDay = reference.getUTCDate();
  const targetMonth = reference.getUTCMonth() + (parts.unit === 'month' ? signed : signed * 12);
  const first = new Date(Date.UTC(reference.getUTCFullYear(), targetMonth, 1));
  const lastDay = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  first.setUTCDate(Math.min(originalDay, lastDay));
  return result(first, { mode: 'relative' });
}

function choiceQuestion(question, task, labels) {
  return {
    type: 'choice',
    instructions: { question, task, scope: 'Select only from the supplied labels. Use unknown when the requested part is unstated.' },
    criteria: Object.fromEntries(labels.map((label) => [label, null])),
  };
}

/** Select bounded date parts with TypeSafe, then resolve them deterministically. */
export async function extractDate({ client, state, question = 'What date is stated?', referenceDate = new Date(),
  yearSpan = 5, maxRelative = 31, minProbability = 0.6, signal } = {}) {
  if (!client || typeof client.evaluate !== 'function') throw new TypeError('extractDate needs a TypeSafe client.');
  integer(yearSpan, 'yearSpan', 0, 126);
  integer(maxRelative, 'maxRelative', 0, 253);
  probability(minProbability, 'minProbability');
  const reference = dateOnly(referenceDate);
  const year = reference.getUTCFullYear();
  const labels = {
    mode: ['absolute', 'relative', 'none'],
    year: [...Array.from({ length: yearSpan * 2 + 1 }, (_, index) => String(year - yearSpan + index)), 'unknown'],
    month: [...Array.from({ length: 12 }, (_, index) => String(index + 1)), 'unknown'],
    day: [...Array.from({ length: 31 }, (_, index) => String(index + 1)), 'unknown'],
    unit: ['day', 'week', 'month', 'year', 'unknown'],
    amount: [...Array.from({ length: maxRelative + 1 }, (_, index) => String(index)), 'unknown'],
    direction: ['past', 'future', 'unknown'],
  };
  const tasks = {
    mode: 'Choose absolute for a calendar date, relative for an offset from the reference date, or none when no date is stated.',
    year: 'Choose the stated absolute year.',
    month: 'Choose the stated absolute month number.',
    day: 'Choose the stated absolute day of month.',
    unit: 'Choose the stated relative time unit.',
    amount: 'Choose the stated relative amount. Today is 0 days.',
    direction: 'Choose whether the relative date is before or after the reference date.',
  };
  const questions = Object.fromEntries(Object.keys(labels).map((part) => [part,
    choiceQuestion({ request: question, referenceDate: reference.toISOString().slice(0, 10) }, tasks[part], labels[part])]));
  const response = await client.evaluate(state, questions, { signal });
  const parts = {};
  const probabilities = {};
  for (const [part, partLabels] of Object.entries(labels)) {
    const answer = validateAnswer(response.answers?.[part], { kind: 'choice', criteria: partLabels });
    probabilities[part] = answer.probabilities[answer.choice];
    parts[part] = probabilities[part] >= minProbability ? answer.choice : 'unknown';
  }
  if (parts.mode === 'unknown') return { status: 'review', date: null, reason: 'low_probability_mode', parts, probabilities };
  const needed = parts.mode === 'absolute' ? ['year', 'month', 'day']
    : parts.mode === 'relative' ? ['unit', 'amount', 'direction'] : [];
  if (needed.some((part) => parts[part] === 'unknown')) {
    return { status: 'review', date: null, reason: 'missing_or_low_probability_part', parts, probabilities };
  }
  const resolved = resolveDateParts(parts, { referenceDate: reference, maxRelative });
  return { ...resolved, parts, probabilities };
}
