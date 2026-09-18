// Packing judgments into requests.
//
// A judgment is one (state, question) pair. TypeSafe evaluates every question in a
// request in parallel against one shared state, so the cheapest shape is a matrix:
// put many rows in the state, then ask each row's questions in the same request.
// Each row's text is sent once no matter how many questions it answers.
import { questionBody } from './functions.mjs';

export const DEFAULTS = {
  maxRowsPerRequest: 25,
  maxQuestionsPerRequest: 120,
  maxCharsPerRequest: 60_000, // ~15k tokens, well inside the ~32k budget
};

/**
 * Group pending judgments into request-sized batches.
 * @param {Array<{key: string, judgment: object}>} pending
 * @returns {Array<{rows: Map<string,string>, items: Array<{key, judgment, rowId, questionId}>}>}
 */
export function packBatches(pending, limits = {}) {
  const { maxRowsPerRequest, maxQuestionsPerRequest, maxCharsPerRequest } = { ...DEFAULTS, ...limits };

  // One entry per distinct state; a state answering several questions is sent once.
  const byState = new Map();
  for (const item of pending) {
    if (!byState.has(item.judgment.state)) byState.set(item.judgment.state, []);
    byState.get(item.judgment.state).push(item);
  }

  const batches = [];
  let current = null;
  const startBatch = () => { current = { rows: new Map(), items: [], chars: 0 }; batches.push(current); };
  startBatch();

  for (const [state, items] of byState) {
    const stateChars = state.length;
    const wouldOverflow = current.rows.size >= maxRowsPerRequest
      || current.items.length + items.length > maxQuestionsPerRequest
      || (current.chars + stateChars > maxCharsPerRequest && current.rows.size > 0);
    if (wouldOverflow) startBatch();

    const rowId = `r${current.rows.size}`;
    current.rows.set(rowId, state);
    current.chars += stateChars;
    items.forEach((item, i) => {
      current.items.push({ ...item, rowId, questionId: `${rowId}_q${i}` });
    });
  }

  return batches.filter((b) => b.items.length > 0);
}

/** Build the request body for one packed batch. */
export function batchRequest(batch) {
  const state = { rows: Object.fromEntries(batch.rows) };
  const questions = {};
  for (const item of batch.items) {
    questions[item.questionId] = questionBody(item.judgment, `rows.${item.rowId}`);
  }
  return { state, questions };
}

/** Rough token estimate for dry runs (TypeSafe bills input tokens only). */
export function estimateTokens(batches) {
  let chars = 0;
  for (const batch of batches) {
    for (const state of batch.rows.values()) chars += state.length;
    for (const item of batch.items) {
      chars += (item.judgment.question?.length ?? 0) + JSON.stringify(item.judgment.criteria ?? '').length + 40;
    }
  }
  return Math.ceil(chars / 4);
}
