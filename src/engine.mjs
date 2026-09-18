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
//                      bounded by maxRounds, so a partial rewrite is never a wrong answer.
import './quiet.mjs';
import { DatabaseSync } from 'node:sqlite';
import { JEV_FUNCTIONS, judgmentFor, judgmentKey, placeholderFor } from './functions.mjs';
import { JudgmentCache } from './cache.mjs';
import { JevClient, USD_PER_INPUT_TOKEN } from './client.mjs';
import { packBatches, batchRequest, estimateTokens } from './planner.mjs';
import { relaxForCollect, mentionsJev } from './rewrite.mjs';

export class JevSQL {
  /**
   * @param {object} options
   * @param {string} [options.db] SQLite file (default in-memory)
   * @param {string} [options.cacheFile] where to persist judgments
   * @param {number} [options.maxJudgments] refuse to spend more than this per query
   */
  constructor({ db = ':memory:', cacheFile = null, maxJudgments = 1000, client, cache, limits = {}, maxRounds = 4, ...clientOptions } = {}) {
    this.db = new DatabaseSync(db);
    this.cache = cache ?? new JudgmentCache(cacheFile);
    this.client = client ?? null;
    this.clientOptions = clientOptions;
    this.maxJudgments = maxJudgments;
    this.maxRounds = maxRounds;
    this.limits = limits;
    this.model = clientOptions.model ?? process.env.TYPESAFE_DEFAULT_MODEL ?? 'jev-latest';

    this.#pending = new Map();  // key -> judgment, waiting to be resolved
    this.#resolved = new Map(); // key -> answer, for this process
    this.#registerFunctions();
  }

  #pending; #resolved; #collecting = false; #served = 0;
  #seen = new Set();    // distinct judgments this query needed
  #fetched = new Set(); // of those, the ones this query paid for

  /** Lazily built so EXPLAIN and cached queries need no API key at all. */
  #client() {
    if (!this.client) this.client = new JevClient({ model: this.model, ...this.clientOptions });
    return this.client;
  }

  #registerFunctions() {
    for (const name of JEV_FUNCTIONS) {
      this.db.function(name, { varargs: true, deterministic: true }, (...args) => {
        const judgment = judgmentFor(name, args);
        const key = judgmentKey(this.model, judgment);

        const answer = this.#resolved.get(key) ?? this.cache.get(key);
        if (answer) {
          // Count each distinct judgment once: needed by this query, already known.
          if (!this.#seen.has(key)) {
            this.#seen.add(key);
            if (!this.#fetched.has(key)) this.#served += 1;
          }
          this.#resolved.set(key, answer);
          const value = judgment.read(answer);
          return value === undefined ? null : value;
        }
        if (!this.#collecting) this.#pending.set(key, judgment); // a miss in the final pass
        else this.#pending.set(key, judgment);
        return placeholderFor(judgment.kind);
      });
    }
  }

  /** Run any non-jev SQL (CREATE TABLE, INSERT, ...). */
  exec(sql) { this.db.exec(sql); return this; }

  prepare(sql) { return this.db.prepare(sql); }

  /**
   * Execute a query, resolving any jev_* calls it contains.
   * @returns {Promise<{rows: any[], stats: object}>}
   */
  async query(sql, { dryRun = false } = {}) {
    const started = performance.now();
    const stats = { rounds: 0, judgments: 0, cacheHits: 0, requests: 0, inputTokens: 0, costUsd: 0, relaxed: [], apiMs: 0 };

    if (!mentionsJev(sql)) {
      const rows = this.db.prepare(sql).all();
      stats.wallMs = Math.round(performance.now() - started);
      return { rows, stats };
    }

    const { sql: collectSql, relaxed } = relaxForCollect(sql);
    stats.relaxed = relaxed;
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
      this.#pending.clear();
      this.#collecting = round === 1;
      const result = this.db.prepare(round === 1 ? collectSql : sql).all();
      if (round > 1) rows = result; // this run used the real query, so its rows count
      stats.rounds = round;
      if (this.#pending.size === 0) break;

      const pending = [...this.#pending].map(([key, judgment]) => ({ key, judgment }));
      stats.judgments += pending.length;
      if (stats.judgments > this.maxJudgments) {
        throw new Error(
          `JevSQL stopped: this query needs ${stats.judgments} judgments, over the limit of ${this.maxJudgments}. `
          + 'Add a WHERE/LIMIT, or raise maxJudgments (--max-judgments) if you mean it.',
        );
      }

      const batches = packBatches(pending, this.limits);
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

    rows ??= this.db.prepare(sql).all(); // only needed when everything was already cached
    this.cache.flush();

    if (this.client) {
      stats.requests = this.client.stats.requests - before.requests;
      stats.inputTokens = this.client.stats.inputTokens - before.inputTokens;
      stats.costUsd = stats.inputTokens * USD_PER_INPUT_TOKEN;
      stats.apiMs = this.client.stats.latencyMs - before.latencyMs;
    }
    stats.cacheHits = this.#served;
    stats.wallMs = Math.round(performance.now() - started);
    return { rows, stats };
  }

  /** What a query would cost, without calling the API. */
  async explain(sql) {
    const { stats } = await this.query(sql, { dryRun: true });
    return stats;
  }

  async #resolveBatches(batches) {
    const client = this.#client();
    // Requests are independent; a little concurrency without hammering the API.
    const queue = [...batches];
    const workers = Array.from({ length: Math.min(4, queue.length) }, async () => {
      while (queue.length) {
        const batch = queue.shift();
        const { state, questions } = batchRequest(batch);
        const data = await client.evaluate(state, questions);
        for (const item of batch.items) {
          const answer = data.answers?.[item.questionId];
          if (!answer) throw new Error(`TypeSafe returned no answer for ${item.questionId}`);
          this.#resolved.set(item.key, answer);
          this.#fetched.add(item.key);
          this.cache.set(item.key, answer);
        }
      }
    });
    await Promise.all(workers);
  }

  close() { this.cache.flush(); this.db.close(); }
}

export { USD_PER_INPUT_TOKEN };
