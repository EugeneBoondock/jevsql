import { randomUUID } from 'node:crypto';
import { JevClient, USD_PER_INPUT_TOKEN } from './client.mjs';
import { JudgmentCache } from './cache.mjs';
import { integer, nonNegative, probability, validateAnswer } from './validation.mjs';
import { digest, jsonData, redactState } from './privacy.mjs';

const bytes = (value) => Buffer.byteLength(JSON.stringify(value), 'utf8');
const text = (value, name) => {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${name} must be a non-empty string.`);
  return value;
};

export function definePolicy(input) {
  const policy = jsonData(input);
  text(policy.id, 'policy.id'); text(policy.version, 'policy.version');
  if (!policy.questions || typeof policy.questions !== 'object' || Array.isArray(policy.questions) || !Object.keys(policy.questions).length) {
    throw new TypeError('A policy needs a map of typed questions.');
  }
  for (const [id, question] of Object.entries(policy.questions)) {
    text(id, 'question id');
    if (!question || !['noul', 'choice', 'score'].includes(question.type)) throw new TypeError('Unknown question type.');
    if (question.instructions == null || !JSON.stringify(question.instructions).replace(/[\s{}\[\]"]/g, '')) throw new TypeError('Question instructions are required.');
    if (question.type === 'choice') {
      if (!question.criteria || typeof question.criteria !== 'object' || Array.isArray(question.criteria)) throw new TypeError('Choice criteria must be an option map.');
      integer(Object.keys(question.criteria).length, 'Choice options', 2, 255);
      for (const label of Object.keys(question.criteria)) text(label, 'Choice label');
    } else if (question.type === 'score') {
      if (!Array.isArray(question.criteria)) throw new TypeError('Score criteria must be ordered levels.');
      integer(question.criteria.length, 'Score levels', 2, 10);
    } else if (question.criteria != null && (typeof question.criteria !== 'object' || Array.isArray(question.criteria)
      || Object.keys(question.criteria).some((key) => !['true', 'false'].includes(key)))) throw new TypeError('Noul criteria may describe true and false.');
  }
  if (policy.accept !== undefined && !Array.isArray(policy.accept)) throw new TypeError('policy.accept must be an array of checks.');
  for (const rule of policy.accept ?? []) {
    const question = policy.questions[rule.question];
    if (!question) throw new TypeError('A gate refers to an unknown question.');
    if (question.type === 'noul') {
      if (rule.min === undefined && rule.max === undefined) throw new TypeError('A Noul gate needs min or max.');
      if (rule.min !== undefined) probability(rule.min, 'gate.min');
      if (rule.max !== undefined) probability(rule.max, 'gate.max');
      if (rule.min !== undefined && rule.max !== undefined && rule.min > rule.max) throw new TypeError('Gate min must not exceed max.');
    } else if (question.type === 'choice') {
      if (!Object.hasOwn(question.criteria, rule.equals)) throw new TypeError('A Choice gate must name an option.');
      probability(rule.minConfidence ?? 0, 'gate.minConfidence');
    } else throw new TypeError('Use Noul or Choice for accept gates; a rubric score is not a probability.');
  }
  return policy;
}

function decide(policy, answers, findings) {
  if (findings.some((item) => item.level === 'block')) return { decision: 'block', reasons: findings.filter((item) => item.level === 'block').map((item) => item.code) };
  const reasons = findings.filter((item) => item.level === 'review').map((item) => item.code);
  if (!policy.accept?.length) reasons.push('advisory_policy');
  for (const rule of policy.accept ?? []) {
    const answer = answers[rule.question];
    const good = answer?.type === 'noul'
      ? (rule.min === undefined || answer.noul >= rule.min) && (rule.max === undefined || answer.noul <= rule.max)
      : answer?.type === 'choice' && answer.choice === rule.equals && answer.confidence >= (rule.minConfidence ?? 0);
    if (!good) reasons.push(`gate:${rule.question}`);
  }
  return { decision: reasons.length ? 'review' : 'eligible', reasons };
}

/** Typed reviews for any database event. Eligibility never grants database access.
 * Cache identity includes policy content, model, schema/context and redacted state.
 * Budgets are estimates; returned usage records the actual input-token charge.
 */
export class DecisionService {
  #client; #active = 0; #failures = 0; #openUntil = 0; #reserved = 0; #spent = 0; #closed = false;

  constructor({ client, model, cache = new JudgmentCache(), store = null, privacy = {},
    maxJudgments = 1000, maxRequestBytes = 60000, maxQuestionsPerRequest = 120,
    maxEstimatedCostUsd = 0.10, sessionEstimatedBudgetUsd = 1, concurrency = 4,
    cacheTtlMs = 86400000, circuitFailures = 3, circuitCooldownMs = 30000,
    requirePinnedModel = true, inputTokenPrice = USD_PER_INPUT_TOKEN, now = Date.now, ...clientOptions } = {}) {
    this.model = text(model ?? client?.model ?? 'jev-1.13.0', 'model');
    if (requirePinnedModel && /(?:latest|preview)$/i.test(this.model)) throw new Error('Use a versioned model for qualified database reviews.');
    if (client?.model && client.model !== this.model) throw new Error('Service and client models must match.');
    this.#client = client; this.clientOptions = clientOptions;
    this.cache = cache; this.store = store; this.privacy = jsonData(privacy);
    this.maxJudgments = integer(maxJudgments, 'maxJudgments', 0);
    this.maxRequestBytes = integer(maxRequestBytes, 'maxRequestBytes');
    this.maxQuestionsPerRequest = integer(maxQuestionsPerRequest, 'maxQuestionsPerRequest');
    this.maxEstimatedCostUsd = nonNegative(maxEstimatedCostUsd, 'maxEstimatedCostUsd');
    this.sessionEstimatedBudgetUsd = nonNegative(sessionEstimatedBudgetUsd, 'sessionEstimatedBudgetUsd');
    this.concurrency = integer(concurrency, 'concurrency', 1, 32);
    this.cacheTtlMs = integer(cacheTtlMs, 'cacheTtlMs', 0);
    this.circuitFailures = integer(circuitFailures, 'circuitFailures');
    this.circuitCooldownMs = integer(circuitCooldownMs, 'circuitCooldownMs');
    this.inputTokenPrice = nonNegative(inputTokenPrice, 'inputTokenPrice');
    this.requirePinnedModel = Boolean(requirePinnedModel); this.now = now;
  }

  get status() { return { active: this.#active, failures: this.#failures, circuitOpen: this.now() < this.#openUntil, estimatedSpentUsd: this.#spent }; }

  async review(inputPolicy, inputState, { context = {}, findings = [], dryRun = false, signal, includeEvidence = false, cacheTtlMs = this.cacheTtlMs } = {}) {
    if (this.#closed) throw new Error('Decision service is closed.');
    signal?.throwIfAborted();
    const policy = definePolicy(inputPolicy);
    const safeContext = redactState(context, { privateFields: this.privacy.privateFields ?? [] }).state;
    const safeFindings = redactState(findings, { privateFields: this.privacy.privateFields ?? [] }).state;
    if (!Array.isArray(safeFindings) || safeFindings.some((item) => !item || !['info', 'review', 'block'].includes(item.level) || typeof item.code !== 'string')) {
      throw new TypeError('Findings need a code and info, review, or block level.');
    }
    integer(cacheTtlMs, 'cacheTtlMs', 0);
    const { state, redactions, omittedFields } = redactState(inputState, this.privacy);
    const started = performance.now(), createdAt = new Date(this.now()).toISOString();
    const policyHash = digest(policy), stateHash = digest(state);
    const key = digest(['jevsql-review-v1', this.model, policyHash, stateHash, safeContext]);
    const stats = { judgments: 0, requests: 0, cacheHits: 0, inputTokens: 0, costUsd: 0, estimatedCostUsd: 0, wallMs: 0 };
    const finish = async (answers, source, resolvedModel, forcedReason) => {
      const outcome = forcedReason ? { decision: 'review', reasons: [forcedReason] } : decide(policy, answers, safeFindings);
      if (safeFindings.some((item) => item.level === 'block')) Object.assign(outcome, decide(policy, {}, safeFindings));
      stats.wallMs = Math.round(performance.now() - started);
      const receipt = { id: randomUUID(), kind: policy.id, policyVersion: policy.version, policyHash,
        requestedModel: this.model, resolvedModel: resolvedModel ?? null, stateHash, context: safeContext,
        createdAt, source, ...outcome, answers, findings: safeFindings, privacy: { redactions, omittedFields }, stats,
        ...(includeEvidence ? { evidence: state, questions: policy.questions } : {}) };
      if (this.store) await this.store.append(receipt);
      return receipt;
    };
    if (safeFindings.some((item) => item.level === 'block')) {
      if (dryRun) return { dryRun: true, decision: 'block', findings: safeFindings, stats };
      return finish({}, 'rules', null);
    }
    const questionCount = Object.keys(policy.questions).length;
    if (questionCount > this.maxJudgments) throw new RangeError('Review exceeds maxJudgments.');
    const cached = this.cache.get(key);
    if (cached && cacheTtlMs > 0 && this.now() - cached.at >= 0 && this.now() - cached.at < cacheTtlMs
      && cached.model === this.model && cached.policyHash === policyHash) {
      try {
        for (const [id, q] of Object.entries(policy.questions)) validateAnswer(cached.answers[id], { kind: q.type, criteria: q.criteria });
        stats.cacheHits = questionCount;
        if (dryRun) return { dryRun: true, stats, decision: null, policyHash, stateHash };
        return finish(cached.answers, 'cache', cached.model);
      } catch { /* Re-fetch invalid stored answers. */ }
    }
    const batches = []; let current = {};
    for (const [id, q] of Object.entries(policy.questions)) {
      let candidate = { ...current, [id]: q };
      if (Object.keys(candidate).length > this.maxQuestionsPerRequest || bytes({ model: this.model, state, questions: candidate }) > this.maxRequestBytes) {
        if (Object.keys(current).length) batches.push(current);
        current = {}; candidate = { [id]: q };
        if (bytes({ model: this.model, state, questions: candidate }) > this.maxRequestBytes) throw new RangeError('One state and question exceed the review request budget.');
      }
      current = candidate;
    }
    if (Object.keys(current).length) batches.push(current);
    const estimatedTokens = batches.reduce((sum, questions) => sum + Math.ceil(bytes({ model: this.model, state, questions }) / 4), 0);
    const estimate = estimatedTokens * this.inputTokenPrice;
    stats.estimatedCostUsd = estimate;
    if (dryRun) return { dryRun: true, decision: null, policyHash, stateHash,
      stats: { ...stats, judgments: questionCount, requests: batches.length, estimatedInputTokens: estimatedTokens } };
    if (estimate > this.maxEstimatedCostUsd || this.#spent + this.#reserved + estimate > this.sessionEstimatedBudgetUsd) return finish({}, 'rules', null, 'estimated_budget_exceeded');
    if (this.now() < this.#openUntil) return finish({}, 'unavailable', null, 'circuit_open');
    if (this.#active >= this.concurrency) return finish({}, 'unavailable', null, 'review_capacity_exceeded');

    this.#active++; this.#reserved += estimate;
    const answers = {};
    let attempted = false, resolvedModel = null;
    try {
      this.#client ??= new JevClient({ ...this.clientOptions, model: this.model });
      for (const questions of batches) {
        signal?.throwIfAborted(); attempted = true; stats.requests++;
        const data = await this.#client.evaluate(state, questions, { signal });
        signal?.throwIfAborted();
        if (typeof data.model !== 'string' || !data.model || (this.requirePinnedModel && data.model !== this.model)) throw new Error('Returned model does not match the qualified version.');
        if (resolvedModel && resolvedModel !== data.model) throw new Error('A review cannot mix model versions.');
        resolvedModel = data.model;
        integer(data.usage?.input_tokens, 'usage.input_tokens', 0);
        stats.inputTokens += data.usage.input_tokens;
        stats.costUsd = stats.inputTokens * this.inputTokenPrice;
        if (!data.answers || Object.keys(data.answers).length !== Object.keys(questions).length) throw new Error('Provider returned the wrong question set.');
        for (const [id, q] of Object.entries(questions)) {
          const answer = validateAnswer(data.answers[id], { kind: q.type, criteria: q.criteria });
          answers[id] = jsonData(answer); stats.judgments++;
        }
      }
      this.#failures = 0; this.#openUntil = 0;
      if (cacheTtlMs > 0) {
        this.cache.set(key, { answers, model: resolvedModel, policyHash, at: this.now() });
        await this.cache.flush();
      }
    } catch (error) {
      signal?.throwIfAborted();
      this.#failures++;
      if (this.#failures >= this.circuitFailures) this.#openUntil = this.now() + this.circuitCooldownMs;
      // Provider messages may echo private inputs. Persist a fixed reason instead.
      return await finish({}, 'unavailable', resolvedModel, 'provider_review_failed');
    } finally {
      this.#active--; this.#reserved -= estimate;
      if (attempted) this.#spent += Math.max(estimate, stats.costUsd);
    }
    return finish(answers, 'api', resolvedModel);
  }

  async close() {
    if (this.#active) throw new Error('Await active reviews before closing.');
    if (this.#closed) return;
    await this.cache.flush(); this.#closed = true;
  }
}
