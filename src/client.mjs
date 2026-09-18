// TypeSafe System One HTTP client: one request carries many rows and many
// questions, with retries on the transient statuses the API documents.
const DEFAULT_BASE_URL = 'https://api.typesafe.ai';
const RETRYABLE = new Set([408, 429, 500, 502, 503, 504, 529]);

export const USD_PER_INPUT_TOKEN = 0.042 / 1e6; // TypeSafe's published rate; output tokens are free

export class JevClient {
  constructor({ apiKey = process.env.TYPESAFE_API_KEY, baseUrl, model, timeoutMs = 20000, maxAttempts = 3, fetchImpl = fetch } = {}) {
    if (!apiKey) throw new Error('No TypeSafe API key. Set TYPESAFE_API_KEY (see .env.example).');
    this.apiKey = apiKey;
    this.baseUrl = (baseUrl ?? process.env.TYPESAFE_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/$/, '');
    this.model = model ?? process.env.TYPESAFE_DEFAULT_MODEL ?? 'jev-latest';
    this.timeoutMs = timeoutMs;
    this.maxAttempts = maxAttempts;
    this.fetch = fetchImpl;
    this.stats = { requests: 0, questions: 0, inputTokens: 0, outputTokens: 0, latencyMs: 0, retries: 0 };
  }

  get costUsd() { return this.stats.inputTokens * USD_PER_INPUT_TOKEN; }

  /** Evaluate one state against a map of questions. */
  async evaluate(state, questions) {
    const body = JSON.stringify({ model: this.model, state, questions });
    const started = performance.now();
    let lastError;

    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      try {
        const res = await this.fetch(`${this.baseUrl}/v1/systemone`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
          body,
          signal: AbortSignal.timeout(this.timeoutMs),
        });
        if (res.ok) {
          const data = await res.json();
          this.stats.requests += 1;
          this.stats.questions += Object.keys(questions).length;
          this.stats.inputTokens += data.usage?.input_tokens ?? 0;
          this.stats.outputTokens += data.usage?.output_tokens ?? 0;
          this.stats.latencyMs += Math.round(performance.now() - started);
          return data;
        }
        lastError = new Error(`TypeSafe ${res.status}: ${(await res.text()).slice(0, 200)}`);
        if (!RETRYABLE.has(res.status)) throw lastError;
      } catch (err) {
        lastError = err;
        const transient = err.name === 'TimeoutError' || err.name === 'AbortError' || err.name === 'TypeError'
          || /TypeSafe (408|429|5\d\d)/.test(err.message);
        if (!transient) throw err;
      }
      if (attempt < this.maxAttempts) {
        this.stats.retries += 1;
        await new Promise((r) => setTimeout(r, 400 * 2 ** (attempt - 1)));
      }
    }
    throw lastError;
  }
}
