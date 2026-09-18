// Content-addressed cache of judgments. Jev is self-consistent for a fixed input,
// so the same row + question never needs paying for twice. Survives restarts.
import { mkdirSync, readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs';
import path from 'node:path';

export class JudgmentCache {
  #entries = new Map();
  #dirty = false;

  constructor(file = null) {
    this.file = file;
    this.hits = 0;
    this.misses = 0;
    if (file && existsSync(file)) {
      try {
        const raw = JSON.parse(readFileSync(file, 'utf8'));
        for (const [key, value] of Object.entries(raw.judgments ?? {})) this.#entries.set(key, value);
      } catch { /* a corrupt cache is not worth failing a query over */ }
    }
  }

  get(key) {
    const hit = this.#entries.get(key);
    if (hit) this.hits += 1; else this.misses += 1;
    return hit;
  }

  has(key) { return this.#entries.has(key); }

  set(key, answer) {
    this.#entries.set(key, answer);
    this.#dirty = true;
  }

  get size() { return this.#entries.size; }

  /** Atomic write so a killed process cannot leave a half-written cache. */
  flush() {
    if (!this.file || !this.#dirty) return;
    mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify({ version: 1, judgments: Object.fromEntries(this.#entries) }));
    renameSync(tmp, this.file);
    this.#dirty = false;
  }
}
