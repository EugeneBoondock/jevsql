// JevSQL engine: SQL in, rows out, with jev_* functions resolved by TypeSafe.
//
// SQLite's user-defined functions are synchronous and Jev is an HTTP call, so the
// query cannot call the API mid-scan. Instead the query runs more than once:
//
//   1. Collect pass  - jev_* functions record what they were asked and return a
//                      placeholder. Filters mentioning jev_ are relaxed (rewrite.mjs)
//                      so no candidate row is filtered out before it is judged.
//   2. Resolve       - every distinct judgment is packed into as few requests as
//                      possible (planner.mjs) and cached by content hash.
//   3. Final pass    - the original query runs again, now reading resolved answers.
//                      Any judgment still missing triggers another resolve and rerun,
//                      bounded by maxRounds; unresolved work fails explicitly.
import './quiet.mjs';
import { DatabaseSync } from 'node:sqlite';
import { JEV_FUNCTIONS, judgmentFor, judgmentKey, placeholderFor } from './functions.mjs';
import { JudgmentCache } from './cache.mjs';
import { JevClient, USD_PER_INPUT_TOKEN } from './client.mjs';
import { packBatches, batchRequest, estimateTokens } from './planner.mjs';
import { relaxForCollect } from './rewrite.mjs';
import { findCandidates } from './decisions.mjs';
import { bindAll, readQuery } from './sql.mjs';
import { integer, nonNegative, validateAnswer } from './validation.mjs';
import { materialize, refresh, decisionTables, changeHistory, check } from './workflows.mjs';
import { compareRowModes, evaluatePredictions } from './evaluation.mjs';

export class JevSQL {
  /**
   * @param {object} options
   * @param {string} [options.db] SQLite file (default in-memory)
   * @param {string} [options.cacheFile] where to persist judgments
   * @param {number} [options.maxJudgments] refuse to spend more than this per query
   * @param {'packed'|'isolated'} [options.rowMode] whether unrelated rows may share request state
   */
  constructor({ db = ':memory:', cacheFile = null, maxJudgments = 1000, client, cache, limits = {}, rowMode = 'packed', maxRounds = 8,
    concurrency = 4, maxEstimatedCostUsd = null, cacheNamespace = '', strictCollect = false, ...clientOptions } = {}) {
    integer(maxJudgments, 'maxJudgments', 0);
    integer(maxRounds, 'maxRounds');
    integer(concurrency, 'concurrency', 1, 32);
    if (maxEstimatedCostUsd != null) nonNegative(maxEstimatedCostUsd, 'maxEstimatedCostUsd');
    if (!['packed', 'isolated'].includes(rowMode)) throw new TypeError('rowMode must be packed or isolated.');
    const effectiveLimits = rowMode === 'isolated' ? { ...limits, maxRowsPerRequest: 1 } : limits;
    packBatches([], effectiveLimits);
    this.model = clientOptions.model ?? client?.model ?? process.env.TYPESAFE_DEFAULT_MODEL ?? 'jev-latest';
    if (client?.model && client.model !== this.model) throw new Error('Engine model and client model must match.');
    this.db = new DatabaseSync(db);
    this.cache = cache ?? new JudgmentCache(cacheFile);
    this.client = client ?? null;
    this.clientOptions = clientOptions;
    this.maxJudgments = maxJudgments;
    this.maxRounds = maxRounds;
    this.limits = effectiveLimits;
    this.rowMode = rowMode;
    this.concurrency = concurrency;
    this.maxEstimatedCostUsd = maxEstimatedCostUsd;
    this.cacheNamespace = cacheNamespace;
    this.strictCollect = Boolean(strictCollect);

    this.#pending = new Map();  // key -> judgment, waiting to be resolved
    this.#resolved = new Map(); // key -> answer, for this process
    this.#registerFunctions();
  }

  #pending; #resolved; #served = 0;
  #seen = new Set();    // distinct judgments this query needed
  #fetched = new Set(); // of those, the ones this query paid for
  #busy = false; #closed = false; #audit = false; #trace = new Map(); #signal;

  /** Lazily built so EXPLAIN and cached queries need no API key at all. */
  #client() {
    if (!this.client) this.client = new JevClient({ model: this.model, ...this.clientOptions });
    return this.client;
  }

  #registerFunctions() {
    this.db.function('jev_candidates', { varargs: true, deterministic: true }, (text, kind) => JSON.stringify(findCandidates(text, kind ?? 'email')));
    for (const name of JEV_FUNCTIONS) {
      this.db.function(name, { varargs: true, deterministic: true }, (...args) => {
        if (!this.#busy) throw new Error('Use await engine.query() to evaluate Jev functions.');
        if (args[0] == null || (name === 'jev_match' && args[1] == null)) return null;
        const judgment = judgmentFor(name, args);
        if (!judgment) return null;
        const key = judgmentKey(this.model, judgment, this.cacheNamespace);

        const answer = this.#resolved.get(key) ?? this.cache.get(key);
        if (answer) {
          validateAnswer(answer, judgment);
          // Count each distinct judgment once: needed by this query, already known.
          if (!this.#seen.has(key)) {
            this.#seen.add(key);
            if (!this.#fetched.has(key)) this.#served += 1;
          }
          this.#resolved.set(key, answer);
          if (this.#audit && !this.#trace.has(key)) this.#trace.set(key, {
            key, kind: judgment.kind, question: judgment.question, criteria: judgment.criteria,
            requestedModel: this.model, model: answer._jevsql?.model ?? null,
            evaluatedAt: answer._jevsql?.evaluatedAt ?? null, source: this.#fetched.has(key) ? 'api' : 'cache',
            answer: Object.fromEntries(Object.entries(answer).filter(([field]) => field !== '_jevsql')),
          });
          const value = judgment.read(answer);
          return value === undefined ? null : value;
        }
        this.#pending.set(key, judgment);
        return placeholderFor(judgment.kind);
      });
    }
  }

  /** Run any non-jev SQL (CREATE TABLE, INSERT, ...). */
  exec(sql) {
    if (this.#busy) throw new Error('A query is active. Await it before changing this database.');
    this.db.exec(sql); return this;
  }

  prepare(sql) { return this.db.prepare(sql); }

  /**
   * Execute a query, resolving any jev_* calls it contains.
   * @returns {Promise<{rows: any[], stats: object}>}
   */
  async query(sql, options = {}) {
    if (this.#closed) throw new Error('This JevSQL engine is closed.');
    if (this.#busy) throw new Error('A query is active. Await it before starting another query on this engine.');
    sql = readQuery(sql);
    const queryOnly = this.db.prepare('PRAGMA query_only').get().query_only;
    this.db.exec('PRAGMA query_only = ON');
    this.#busy = true;
    try { return await this.#query(sql, options); }
    finally {
      this.db.exec(`PRAGMA query_only = ${queryOnly ? 'ON' : 'OFF'}`);
      this.#busy = false; this.#signal = undefined;
    }
  }

  async #query(sql, { dryRun = false, params = [], audit = false, signal } = {}) {
    signal?.throwIfAborted();
    this.#signal = signal; this.#audit = audit; this.#trace = new Map();
    const started = performance.now();
    const stats = { rounds: 0, judgments: 0, cacheHits: 0, requests: 0, inputTokens: 0, costUsd: 0, relaxed: [], widened: [], apiMs: 0, estimatedCostUsd: 0, model: this.model, rowMode: this.rowMode };

    const { sql: collectSql, relaxed, widened } = relaxForCollect(sql);
    stats.relaxed = relaxed;
    stats.widened = widened;
    // Widening only affects which rows are judged, never which rows are returned.
    // It still decides which rows leave the process, so a query carrying an
    // authorization predicate should refuse rather than collect beyond it.
    if (widened.length && this.strictCollect) {
      throw new Error(
        `JevSQL refused this query: the ${widened.join(' and ')} clause cannot be relaxed without also widening a condition that is not a judgment, `
        + 'so rows the query excludes would be sent for judgment. Filter the authorized rows in a subquery or CTE, or set strictCollect: false.',
      );
    }
    this.#served = 0;
    this.#seen = new Set();
    this.#fetched = new Set();
    // Client counters are cumulative for the process; report this query's share.
    const before = this.client
      ? { ...this.client.stats }
      : { requests: 0, inputTokens: 0, outputTokens: 0, latencyMs: 0 };

    // Round 1: collect on the relaxed query. Later rounds: the real query, which can
    // still surface a judgment the relaxed pass did not reach.
    let rows = null;
    for (let round = 1; round <= this.maxRounds; round++) {
      signal?.throwIfAborted();
      this.#pending.clear();
      const result = bindAll(this.db.prepare(round === 1 ? collectSql : sql), params,
        { removedLimit: round === 1 && relaxed.includes('LIMIT') });
      if (round > 1 || collectSql === sql) rows = result;
      stats.rounds = round;
      // Even a fully cached collect pass can have a different GROUP BY shape.
      // Verify the real statement before accepting rows or reporting success.
      if (this.#pending.size === 0 && rows == null) rows = bindAll(this.db.prepare(sql), params);
      if (this.#pending.size === 0) break;

      let pending = [...this.#pending].map(([key, judgment]) => ({ key, judgment }));

      // A shared cache — Postgres, Redis, another process — cannot answer the
      // synchronous get() during a scan, so a file is the only store the cache
      // interface could really support. Give it one asynchronous chance to
      // supply the keys this round needs before any of them are paid for.
      // Anything it fills is resolved here and never reaches the API.
      if (typeof this.cache.warm === 'function') {
        try {
          await this.cache.warm(pending.map((item) => item.key));
          pending = pending.filter(({ key }) => {
            const answer = this.cache.get(key);
            if (!answer) return true;
            this.#resolved.set(key, answer);
            this.#seen.add(key);
            this.#served += 1;
            return false;
          });
        } catch { /* a cold cache is a cost, never a failure */ }
        if (pending.length === 0) continue; // the next round runs on what it gave us
      }

      stats.judgments += pending.length;
      if (stats.judgments > this.maxJudgments) {
        throw new Error(
          `JevSQL stopped: this query needs ${stats.judgments} judgments, over the limit of ${this.maxJudgments}. `
          + 'Narrow the source query or explicitly raise maxJudgments (--max-judgments).',
        );
      }

      const batches = packBatches(pending, this.limits);
      stats.estimatedCostUsd += estimateTokens(batches) * USD_PER_INPUT_TOKEN;
      if (!dryRun && this.maxEstimatedCostUsd != null && stats.estimatedCostUsd > this.maxEstimatedCostUsd) {
        throw new Error(`Estimated cost $${stats.estimatedCostUsd.toFixed(6)} exceeds maxEstimatedCostUsd. No further requests were sent.`);
      }
      if (dryRun) {
        stats.requests += batches.length;
        stats.inputTokens += estimateTokens(batches);
        stats.costUsd = stats.inputTokens * USD_PER_INPUT_TOKEN;
        stats.estimated = true;
        stats.wallMs = Math.round(performance.now() - started);
        stats.cacheHits = this.#served;
        return { rows: [], stats };
      }

      await this.#resolveBatches(batches);
    }

    if (this.#pending.size > 0) {
      throw new Error(`JevSQL could not resolve ${this.#pending.size} judgment(s) after ${this.maxRounds} rounds.`);
    }

    await this.cache.flush();

    if (this.client) {
      stats.requests = this.client.stats.requests - before.requests;
      stats.inputTokens = this.client.stats.inputTokens - before.inputTokens;
      stats.costUsd = stats.inputTokens * USD_PER_INPUT_TOKEN;
      stats.apiMs = this.client.stats.latencyMs - before.latencyMs;
    }
    stats.cacheHits = this.#served;
    stats.wallMs = Math.round(performance.now() - started);
    if (dryRun) stats.estimated = true;
    return { rows: dryRun ? [] : rows, stats, ...(audit ? { decisions: [...this.#trace.values()] } : {}) };
  }

  /** What a query would cost, without calling the API. */
  async explain(sql, options = {}) {
    const { stats } = await this.query(sql, { ...options, dryRun: true });
    return stats;
  }

  materialize(name, sql, options) {
    if (this.#busy) throw new Error('Await the active query before saving a decision table.');
    return materialize(this, name, sql, options);
  }

  refresh(name, options) {
    if (this.#busy) throw new Error('Await the active query before refreshing a decision table.');
    return refresh(this, name, options);
  }

  tables() { return decisionTables(this); }
  changes(name, options) { return changeHistory(this, name, options); }
  check(rules, options) { return check(this, rules, options); }

  async evaluate(sql, options = {}) {
    const { rows, stats } = await this.query(sql, options);
    return { ...evaluatePredictions(rows, options), stats };
  }

  async #resolveBatches(batches) {
    const client = this.#client();
    // Requests are independent; a little concurrency without hammering the API.
    const queue = [...batches];
    const controller = new AbortController();
    const signal = this.#signal ? AbortSignal.any([this.#signal, controller.signal]) : controller.signal;
    let failure;
    const workers = Array.from({ length: Math.min(this.concurrency, queue.length) }, async () => {
      while (queue.length && !failure) {
        try {
          signal.throwIfAborted();
          const batch = queue.shift();
          const { state, questions } = batchRequest(batch);
          const data = await client.evaluate(state, questions, { signal });
          // Validate the whole batch before allowing any answer into the cache.
          for (const item of batch.items) validateAnswer(data.answers?.[item.questionId], item.judgment);
          for (const item of batch.items) {
            const answer = { ...data.answers[item.questionId], _jevsql: { model: data.model ?? this.model, evaluatedAt: new Date().toISOString() } };
            this.#resolved.set(item.key, answer);
            this.#fetched.add(item.key);
            this.cache.set(item.key, answer);
          }
        } catch (error) { failure ??= error; controller.abort(error); }
      }
    });
    await Promise.allSettled(workers);
    if (failure) throw failure;
  }

  close() {
    if (this.#busy) throw new Error('Await the active query before closing this engine.');
    if (this.#closed) return;
    this.cache.flush(); this.db.close(); this.#closed = true;
  }
}

export { USD_PER_INPUT_TOKEN };
export { compareRowModes, evaluatePredictions };
