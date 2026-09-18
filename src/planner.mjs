// Packing judgments into requests.
//
// A judgment is one (state, question) pair. TypeSafe evaluates every question in a
// request in parallel against one shared state, so the cheapest shape is a matrix:
// put many rows in the state, then ask each row's questions in the same request.
// Each row's text is sent once no matter how many questions it answers.
import { questionBody } from './functions.mjs';
import { integer, structured } from './validation.mjs';

export const DEFAULTS = {
  maxRowsPerRequest: 25,
  maxQuestionsPerRequest: 120,
  maxCharsPerRequest: 60_000, // serialized UTF-8 bytes, not a tokenizer limit
  maxStateQuestionChars: 60_000,
};

/**
 * Group pending judgments into request-sized batches.
 * @param {Array<{key: string, judgment: object}>} pending
 * @returns {Array<{rows: Map<string,string>, items: Array<{key, judgment, rowId, questionId}>}>}
 */
export function packBatches(pending, limits = {}) {
  const opts = { ...DEFAULTS, ...limits };
  for (const [name, value] of Object.entries(opts)) integer(value, name);

  // One entry per distinct state; a state answering several questions is sent once.
  const byState = new Map();
  for (const item of pending) {
    if (!byState.has(item.judgment.state)) byState.set(item.judgment.state, []);
    byState.get(item.judgment.state).push(item);
  }

  const batches = [];
  let current = { rows: new Map(), items: [] };
  const add = (batch, state, item) => {
    const rows = new Map(batch.rows);
    let rowId = [...rows].find(([, text]) => text === state)?.[0];
    if (!rowId) { rowId = `r${rows.size}`; rows.set(rowId, state); }
    return { rows, items: [...batch.items, { ...item, rowId, questionId: `q${batch.items.length}` }] };
  };
  const fits = (batch) => {
    const size = payloadSize(batch);
    return batch.rows.size <= opts.maxRowsPerRequest && batch.items.length <= opts.maxQuestionsPerRequest
      && size.total <= opts.maxCharsPerRequest && size.longest <= opts.maxStateQuestionChars;
  };

  for (const [state, items] of byState) {
    for (const item of items) {
      let next = add(current, state, item);
      if (!fits(next)) {
        if (current.items.length) batches.push(current);
        current = { rows: new Map(), items: [] };
        next = add(current, state, item);
        if (!fits(next)) throw new RangeError('A single state and question exceed the request budget. Shorten the text or rubric.');
      }
      current = next;
    }
  }
  if (current.items.length) batches.push(current);
  return batches;
}

/** Build the request body for one packed batch. */
export function batchRequest(batch) {
  const state = { rows: Object.fromEntries([...batch.rows].map(([id, text]) => [id, structured(text)])) };
  const questions = {};
  for (const item of batch.items) {
    questions[item.questionId] = questionBody(item.judgment, `rows.${item.rowId}`);
  }
  return { state, questions };
}

/** Rough token estimate for dry runs (TypeSafe bills input tokens only). */
export function estimateTokens(batches) {
  return batches.reduce((total, batch) => total + Math.ceil(payloadSize(batch).total / 4), 0);
}

function payloadSize(batch) {
  const request = batchRequest(batch);
  const bytes = (value) => Buffer.byteLength(JSON.stringify(value), 'utf8');
  return {
    total: bytes(request),
    longest: bytes(request.state) + Math.max(0, ...Object.values(request.questions).map(bytes)),
  };
}
