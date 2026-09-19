// TypeSafe System One HTTP client: one request carries many rows and many
// questions, with retries on the transient statuses the API documents.
import { setTimeout as delay } from 'node:timers/promises';
import { integer } from './validation.mjs';
const DEFAULT_BASE_URL = 'https://api.typesafe.ai';
const RETRYABLE = new Set([408, 429, 500, 502, 503, 504, 529]);

export const USD_PER_INPUT_TOKEN = 0.042 / 1e6; // TypeSafe's published rate; output tokens are free

export class JevClient {
  constructor({ apiKey = process.env.TYPESAFE_API_KEY, baseUrl, model, timeoutMs = 20000, maxAttempts = 3,
    fetchImpl = fetch, sleepImpl = (ms, signal) => delay(ms, undefined, { signal }), now = Date.now } = {}) {
    if (!apiKey) throw new Error('No TypeSafe API key. Set TYPESAFE_API_KEY (see .env.example).');
    this.apiKey = apiKey;
    this.baseUrl = (baseUrl ?? process.env.TYPESAFE_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/$/, '');
    this.model = model ?? process.env.TYPESAFE_DEFAULT_MODEL ?? 'jev-latest';
    this.timeoutMs = integer(timeoutMs, 'timeoutMs');
    this.maxAttempts = integer(maxAttempts, 'maxAttempts', 1, 10);
    this.fetch = fetchImpl;
    this.sleep = sleepImpl;
    this.now = now;
    this.stats = { requests: 0, questions: 0, inputTokens: 0, outputTokens: 0, latencyMs: 0, retries: 0 };
  }

  get costUsd() { return this.stats.inputTokens * USD_PER_INPUT_TOKEN; }

  /** Evaluate one state against a map of questions. */
  async evaluate(state, questions, { signal } = {}) {
    const body = JSON.stringify({ model: this.model, state, questions });
    const data = await this.#request('/v1/systemone', { method: 'POST', body }, signal);
    const ids = Object.keys(questions);
    if (!data || !data.answers || typeof data.answers !== 'object' || Array.isArray(data.answers)
        || ids.some((id) => !Object.hasOwn(data.answers, id))) {
      throw new Error('TypeSafe response is missing one or more requested answer ids.');
    }
    this.stats.questions += ids.length;
    this.stats.inputTokens += data.usage?.input_tokens ?? 0;
    this.stats.outputTokens += data.usage?.output_tokens ?? 0;
    return data;
  }

  /** Read the models exposed by the documented TypeSafe endpoint. */
  async listModels({ signal } = {}) {
    return this.#request('/v1/models', { method: 'GET' }, signal);
  }

  async #request(path, { method, body }, signal) {
    const started = performance.now();
    let lastError;

    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      signal?.throwIfAborted();
      let retryDelay = Math.min(30000, 400 * 2 ** (attempt - 1));
      try {
        const res = await this.fetch(`${this.baseUrl}${path}`, {
          method,
          headers: { Authorization: `Bearer ${this.apiKey}`, ...(body == null ? {} : { 'Content-Type': 'application/json' }) },
          ...(body == null ? {} : { body }),
          signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(this.timeoutMs)]) : AbortSignal.timeout(this.timeoutMs),
        });
        if (res.ok) {
          const data = await res.json();
          this.stats.requests += 1;
          this.stats.latencyMs += Math.round(performance.now() - started);
          return data;
        }
        lastError = new Error(`TypeSafe ${res.status}: ${(await res.text()).slice(0, 200)}`);
        if (!RETRYABLE.has(res.status)) throw lastError;
        const retryAfter = res.headers.get('retry-after');
        if (retryAfter != null) {
          const wait = /^\d+(\.\d+)?$/.test(retryAfter) ? Number(retryAfter) * 1000 : Date.parse(retryAfter) - this.now();
          if (Number.isFinite(wait)) retryDelay = Math.max(retryDelay, Math.min(30000, Math.max(0, wait)));
        }
      } catch (err) {
        signal?.throwIfAborted();
        lastError = err;
        const transient = err.name === 'TimeoutError' || err.name === 'AbortError' || err.name === 'TypeError'
          || /TypeSafe (408|429|5\d\d)/.test(err.message);
        if (!transient) throw err;
      }
      if (attempt < this.maxAttempts) {
        this.stats.retries += 1;
        await this.sleep(retryDelay, signal);
      }
    }
    throw lastError;
  }
}
