import test from 'node:test';
import assert from 'node:assert/strict';
import { readCandidateWindow, pageDecisions } from '../src/window.mjs';

test('candidate window reads beyond output page and never invents exhaustion', async () => {
  const rows = Array.from({ length: 30 }, (_, id) => ({ id }));
  const out = await readCandidateWindow({ read: async ({ limit, offset }) => ({ rows: rows.slice(offset, offset + limit) }), maxCandidates: 20, candidateOffset: 5 });
  assert.equal(out.result.rows.length, 20);
  assert.equal(out.coverage.nextCandidateOffset, 25);
  assert.equal(out.coverage.completeness, 'bounded_window');
  const full = await readCandidateWindow({ read: async () => ({ rows, exhausted: true }) });
  assert.equal(full.coverage.completeness, 'reader_confirmed');
  assert.equal(full.coverage.nextCandidateOffset, null);
  const later = await readCandidateWindow({ read: async () => ({ rows: [], exhausted: true }), candidateOffset: 30 });
  assert.equal(later.coverage.completeness, 'bounded_window');
  const empty = await readCandidateWindow({ read: async () => ({ rows: [] }) });
  assert.equal(empty.coverage.exhausted, false);
  assert.equal(empty.coverage.nextCandidateOffset, null);
});

test('bad readers, invalid limits and aborts fail', async () => {
  await assert.rejects(readCandidateWindow(), /reader/);
  for (const opts of [{ maxCandidates: 0 }, { candidateOffset: -1 }, { maxCandidates: 401 }]) {
    await assert.rejects(readCandidateWindow({ read: async () => ({ rows: [] }), ...opts }));
  }
  for (const result of [{}, { rows: Array(401).fill({}) }]) {
    await assert.rejects(readCandidateWindow({ read: async () => result }), /bounded/);
  }
  const controller = new AbortController();
  await assert.rejects(readCandidateWindow({ signal: controller.signal, read: async () => { controller.abort(); return { rows: [] }; } }));
});

test('output paging retains source receipts and distinguishes fallback from matches', () => {
  const rows = [{ id: 8 }, { id: 11 }, { id: 20 }];
  const result = pageDecisions({ rows, mode: 'list', count: 3, semantic: { applied: true,
    decisions: rows.map((row, index) => ({ outputIndex: index, sourceIndex: row.id })) } }, { offset: 1, limit: 1 });
  assert.deepEqual(result.rows, [{ id: 11 }]);
  assert.equal(result.count, 1);
  assert.equal(result.semantic.matchedInWindow, 3);
  assert.equal(result.semantic.hasMoreInWindow, true);
  assert.deepEqual(result.semantic.decisions, [{ outputIndex: 0, sourceIndex: 11 }]);
  assert.equal(pageDecisions({ rows }).rows.length, 3);
  assert.equal(pageDecisions({ rows, semantic: { applied: false } }).semantic.matchedInWindow, undefined);
  assert.equal(pageDecisions({ rows, mode: 'count', count: 99 }).count, 99);
  assert.throws(() => pageDecisions({}));
  assert.throws(() => pageDecisions({ rows }, { limit: 0 }));
});
