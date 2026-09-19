import { integer } from './validation.mjs';

/** Bound candidate retrieval independently of output pagination.
 * The reader must enforce authorization and database filters on every call.
 * Exhaustion is never inferred from a short page: readers may impose hidden caps.
 */
export async function readCandidateWindow({ read, maxCandidates = 100, candidateOffset = 0, signal } = {}) {
  if (typeof read !== 'function') throw new TypeError('An authorized reader is required.');
  integer(maxCandidates, 'maxCandidates', 1, 400);
  integer(candidateOffset, 'candidateOffset', 0);
  signal?.throwIfAborted();
  const result = await read({ limit: maxCandidates, offset: candidateOffset, signal });
  signal?.throwIfAborted();
  if (!Array.isArray(result?.rows) || result.rows.length > maxCandidates) {
    throw new TypeError('Reader must return a bounded rows array.');
  }
  return { result, coverage: {
    candidateOffset, candidateLimit: maxCandidates, examined: result.rows.length,
    exhausted: result.exhausted === true,
    nextCandidateOffset: result.exhausted === true || result.rows.length === 0 ? null : candidateOffset + result.rows.length,
    completeness: result.exhausted === true && candidateOffset === 0 ? 'reader_confirmed' : 'bounded_window',
  } };
}

/** Apply output pagination only AFTER semantic selection/ranking. */
export function pageDecisions(result, { offset = 0, limit = 20 } = {}) {
  integer(offset, 'offset', 0); integer(limit, 'limit', 1, 400);
  if (!Array.isArray(result?.rows)) throw new TypeError('rows must be an array.');
  const rows = result.rows.slice(offset, offset + limit);
  const decisions = result.semantic?.decisions?.slice(offset, offset + limit)
    .map((decision, outputIndex) => ({ ...decision, outputIndex }));
  return { ...result, rows, rowCount: rows.length,
    ...(Object.hasOwn(result, 'count') && result.mode !== 'count' ? { count: rows.length } : {}),
    ...(result.semantic ? { semantic: { ...result.semantic, returned: rows.length,
      ...(result.semantic.applied ? { matchedInWindow: result.rows.length } : {}),
      outputOffset: offset,
      hasMoreInWindow: offset + limit < result.rows.length,
      ...(decisions ? { decisions } : {}) } } : {}) };
}
