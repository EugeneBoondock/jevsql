import { createHash } from 'node:crypto';
import { integer } from './validation.mjs';

const keyOf = (key) => /^[a-f0-9]{64}$/.test(String(key)) ? String(key)
  : createHash('sha256').update(String(key)).digest('hex');

/** Existing jev_judgment_cache table; never creates schema during a request. */
export function createPgJudgmentCache({ pool, purpose = 'jevsql', maxEntries = 2000,
  batchSize = 200, log = () => {} } = {}) {
  integer(maxEntries, 'maxEntries'); integer(batchSize, 'batchSize', 1, 1000);
  const memory = new Map();
  const unsaved = new Map();
  let writing = Promise.resolve();
  const usable = typeof pool?.query === 'function';
  const remember = (key, answer) => {
    memory.delete(key); memory.set(key, answer);
    if (memory.size > maxEntries) memory.delete(memory.keys().next().value);
  };
  return {
    hits: 0, misses: 0,
    get size() { return memory.size; },
    get(key) {
      const answer = memory.get(keyOf(key));
      if (answer) this.hits++; else this.misses++;
      return answer;
    },
    has(key) { return memory.has(keyOf(key)); },
    set(key, answer) {
      const id = keyOf(key);
      remember(id, answer); unsaved.set(id, answer);
      if (unsaved.size >= batchSize) this.flush();
    },
    async warm(keys = []) {
      const wanted = [...new Set(keys.map(keyOf))].filter((key) => !memory.has(key)).slice(0, maxEntries);
      let filled = 0;
      if (!usable) return filled;
      try {
        for (let start = 0; start < wanted.length; start += batchSize) {
          const ids = wanted.slice(start, start + batchSize);
          const { rows } = await pool.query(
            'SELECT key, answer FROM jev_judgment_cache WHERE key = ANY($1::text[])', [ids]);
          for (const row of rows) {
            if (ids.includes(row.key)) { remember(row.key, row.answer); filled++; }
          }
        }
      } catch { log('JevSQL cache warm failed'); }
      return filled;
    },
    flush() {
      if (!usable) { unsaved.clear(); return writing; }
      const entries = [...unsaved]; unsaved.clear();
      if (!entries.length) return writing;
      writing = writing.then(async () => {
        for (let start = 0; start < entries.length; start += batchSize) {
          const batch = entries.slice(start, start + batchSize);
          try {
            await pool.query(
              `INSERT INTO jev_judgment_cache (key, answer, purpose)
               SELECT * FROM unnest($1::text[], $2::jsonb[], $3::text[])
               ON CONFLICT (key) DO UPDATE SET answer = EXCLUDED.answer, last_used_at = now()`,
              [batch.map(([key]) => key), batch.map(([, answer]) => JSON.stringify(answer)), batch.map(() => purpose)]);
          } catch { log('JevSQL cache write failed'); }
        }
      }).catch(() => {});
      return writing;
    },
    async drain() {
      await this.flush();
      let current;
      do { current = writing; await current; } while (current !== writing);
    },
  };
}
