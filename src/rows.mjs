import { JevClient, USD_PER_INPUT_TOKEN } from './client.mjs';
import { judgmentFor, judgmentKey } from './functions.mjs';
import { packBatches, batchRequest, estimateTokens } from './planner.mjs';
import { integer, nonNegative, probability, stableJson, validateAnswer } from './validation.mjs';

async function interruptible(work, signal) {
  signal?.throwIfAborted();
  if (!signal) return work();
  let onAbort;
  const aborted = new Promise((_, reject) => {
    onAbort = () => reject(signal.reason ?? new Error('Cancelled'));
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try { return await Promise.race([Promise.resolve().then(work), aborted]); }
  finally { signal.removeEventListener('abort', onAbort); }
}

/** Typed decisions over an already authorized database result, without SQLite.
 * Projection is mandatory: only explicitly selected fields leave the process.
 * Results retain input identity and order, including duplicate rows.
 */
export async function evaluateRows({ rows, project, questions, namespace, client, cache,
  model = client?.model ?? 'jev-1.13.0', maxRows = 400, maxJudgments = 800,
  maxEstimatedCostUsd = 0.05, concurrency = 4, rowMode = 'isolated', limits = {},
  signal, dryRun = false } = {}) {
  if (!Array.isArray(rows)) throw new TypeError('rows must be an array.');
  if (typeof project !== 'function') throw new TypeError('An explicit row projection is required.');
  if (typeof namespace !== 'string' || !namespace.trim()) throw new TypeError('A tenant and purpose namespace is required.');
  if (typeof model !== 'string' || !/^jev-\d+\.\d+\.\d+$/.test(model)) throw new TypeError('Row decisions require a pinned Jev model.');
  if (client?.model && client.model !== model) throw new TypeError('Client and row model must match.');
  integer(maxRows, 'maxRows'); integer(maxJudgments, 'maxJudgments', 0);
  integer(concurrency, 'concurrency', 1, 32); nonNegative(maxEstimatedCostUsd, 'maxEstimatedCostUsd');
  if (!['isolated', 'packed'].includes(rowMode)) throw new TypeError('Invalid rowMode.');
  if (rows.length > maxRows) throw new RangeError('Too many rows; filter in SQL first.');
  if (!questions || typeof questions !== 'object' || Array.isArray(questions) || !Object.keys(questions).length) {
    throw new TypeError('Named questions are required.');
  }
  const definitions = Object.entries(questions).map(([id, spec]) => {
    const fn = { noul: 'jev_noul', choice: 'jev_choice', score: 'jev_score' }[spec?.type];
    if (!fn) throw new TypeError('Question type must be noul, choice, or score.');
    const judgment = judgmentFor(fn, ['', spec.instructions, spec.criteria]);
    return [id, judgment];
  });
  const effectiveLimits = { ...limits, ...(rowMode === 'isolated' ? { maxRowsPerRequest: 1 } : {}) };
  packBatches([], effectiveLimits);
  signal?.throwIfAborted();
  const unique = new Map();
  const records = rows.map((row, index) => {
    const projected = project(row, index);
    if (projected == null) throw new TypeError('Projected row state is required.');
    const state = stableJson(projected);
    if (state === undefined) throw new TypeError('Projected state must be JSON serializable.');
    return { row, index, refs: definitions.map(([id, base]) => {
      const judgment = { ...base, state };
      const key = judgmentKey(model, judgment, namespace);
      unique.set(key, judgment);
      return { id, key };
    }) };
  });
  // Validate every payload before any provider request, even when the cache is warm.
  packBatches([...unique].map(([key, judgment]) => ({ key, judgment })), effectiveLimits);
  if (!dryRun) { try { await interruptible(() => cache?.warm?.([...unique.keys()]), signal); } catch { /* cache miss */ } }
  signal?.throwIfAborted();
  const answers = new Map();
  const sources = new Map();
  const pending = [];
  for (const [key, judgment] of unique) {
    let answer;
    try {
      answer = cache?.get(key);
      if (answer) {
        validateAnswer(answer, judgment);
        if (answer._jevsql?.model !== model) answer = null;
      }
    } catch { answer = null; }
    if (answer) { answers.set(key, answer); sources.set(key, 'cache'); }
    else pending.push({ key, judgment });
  }
  if (pending.length > maxJudgments) throw new RangeError('Row judgment budget exceeded.');
  const batches = packBatches(pending, effectiveLimits);
  // Provider-side question framing is not visible in serialized payload size.
  // Pad per judgment; this remains an estimate, never a billing guarantee.
  const estimatedInputTokens = estimateTokens(batches) + pending.length * 256;
  const estimatedCostUsd = estimatedInputTokens * USD_PER_INPUT_TOKEN;
  if (estimatedCostUsd > maxEstimatedCostUsd) throw new RangeError('Row cost estimate exceeds budget.');
  const stats = { model, rowMode, considered: rows.length, judgments: pending.length,
    cacheHits: answers.size, requests: 0, inputTokens: 0, estimatedInputTokens, estimatedCostUsd, costUsd: 0 };
  if (dryRun) return { records: [], stats: { ...stats, requests: batches.length, estimated: true } };
  const provider = pending.length ? client ?? new JevClient({ model }) : null;
  const controller = new AbortController();
  const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  const queue = [...batches];
  let failure;
  await Promise.allSettled(Array.from({ length: Math.min(concurrency, batches.length) }, async () => {
    while (queue.length && !failure) {
      try {
        combined.throwIfAborted();
        const batch = queue.shift();
        const request = batchRequest(batch);
        const response = await interruptible(() => provider.evaluate(request.state, request.questions, { signal: combined }), combined);
        combined.throwIfAborted();
        if (response?.model !== model) throw new Error('Provider returned a different model.');
        for (const item of batch.items) validateAnswer(response.answers?.[item.questionId], item.judgment);
        stats.requests += 1;
        const tokens = response.usage?.input_tokens ?? 0;
        nonNegative(tokens, 'input_tokens'); stats.inputTokens += tokens;
        for (const item of batch.items) {
          answers.set(item.key, { ...response.answers[item.questionId],
            _jevsql: { model, evaluatedAt: new Date().toISOString() } });
          sources.set(item.key, 'api');
        }
      } catch (error) { failure ??= error; controller.abort(error); }
    }
  }));
  if (failure) throw failure;
  signal?.throwIfAborted();
  // Commit only a complete, validated result to the optional cache.
  try {
    for (const { key } of pending) cache?.set(key, answers.get(key));
    await interruptible(() => cache?.flush?.(), signal);
    await interruptible(() => cache?.drain?.(), signal);
  } catch { /* cache failure does not invalidate the decisions */ }
  signal?.throwIfAborted();
  stats.costUsd = stats.inputTokens * USD_PER_INPUT_TOKEN;
  return { stats, records: records.map(({ row, index, refs }) => ({ row, index,
    answers: Object.fromEntries(refs.map(({ id, key }) => [id, answers.get(key)])),
    receipts: Object.fromEntries(refs.map(({ id, key }) => [id, { key, source: sources.get(key),
      model, evaluatedAt: answers.get(key)._jevsql.evaluatedAt }])) })) };
}

/** Noul uncertainty is explicit; review is never treated as a negative. */
export function partitionRows(records, questionId, { low = 0.2, high = 0.8 } = {}) {
  probability(low, 'low'); probability(high, 'high');
  if (low >= high) throw new TypeError('low must be below high.');
  const result = { accepted: [], rejected: [], review: [] };
  for (const record of records) {
    const answer = record.answers?.[questionId];
    validateAnswer(answer, { kind: 'noul' });
    result[answer.noul > high ? 'accepted' : answer.noul < low ? 'rejected' : 'review'].push(record);
  }
  return result;
}
