import { integer, probability, validateAnswer } from './validation.mjs';

function children(node) {
  return node && typeof node === 'object' && !Array.isArray(node) ? Object.keys(node) : [];
}

function criteriaFor(node) {
  return Object.fromEntries(Object.entries(node).map(([label, child]) => [label,
    typeof child === 'string' ? child : null]));
}

/**
 * Traverse a nested Choice taxonomy with beam search.
 * Branches are objects. Leaves are null or descriptive strings.
 */
export async function hierarchicalChoice({ client, state, question, hierarchy, beamWidth = 3,
  minProbability = 0, minMargin = 0, signal } = {}) {
  if (!client || typeof client.evaluate !== 'function') throw new TypeError('hierarchicalChoice needs a TypeSafe client.');
  if (!hierarchy || typeof hierarchy !== 'object' || Array.isArray(hierarchy) || children(hierarchy).length < 2) {
    throw new TypeError('Hierarchy root must contain at least two labels.');
  }
  integer(beamWidth, 'beamWidth', 1, 255);
  probability(minProbability, 'minProbability');
  probability(minMargin, 'minMargin');

  let frontier = [{ path: [], node: hierarchy, logProbability: 0, depth: 0 }];
  const leaves = [];
  let requests = 0;
  while (frontier.length) {
    signal?.throwIfAborted();
    const questions = {};
    const active = [];
    for (const candidate of frontier) {
      const labels = children(candidate.node);
      if (!labels.length) { leaves.push(candidate); continue; }
      if (labels.length < 2) throw new TypeError(`Hierarchy branch ${candidate.path.join(' > ') || 'root'} must contain at least two labels.`);
      const id = `q${active.length}`;
      active.push({ id, candidate, labels });
      questions[id] = {
        type: 'choice',
        instructions: {
          question,
          path: candidate.path,
          task: candidate.path.length
            ? 'Choose the best child under the supplied taxonomy path.'
            : 'Choose the best top-level taxonomy label.',
        },
        criteria: criteriaFor(candidate.node),
      };
    }
    if (!active.length) break;
    const response = await client.evaluate(state, questions, { signal });
    requests += 1;
    const expanded = [];
    for (const { id, candidate, labels } of active) {
      const judgment = { kind: 'choice', criteria: labels };
      const answer = validateAnswer(response.answers?.[id], judgment);
      for (const label of labels) {
        const chance = answer.probabilities[label];
        if (chance <= 0) continue;
        const node = candidate.node[label];
        const next = {
          path: [...candidate.path, label],
          node,
          logProbability: candidate.logProbability + Math.log(chance),
          depth: candidate.depth + 1,
        };
        if (children(node).length) expanded.push(next); else leaves.push(next);
      }
    }
    frontier = expanded
      .sort((a, b) => (b.logProbability / b.depth) - (a.logProbability / a.depth))
      .slice(0, beamWidth);
  }

  const ranked = leaves.map((candidate) => ({
    path: candidate.path,
    label: candidate.path.at(-1),
    probability: Math.exp(candidate.logProbability),
    normalizedProbability: Math.exp(candidate.logProbability / candidate.depth),
  })).sort((a, b) => b.normalizedProbability - a.normalizedProbability);
  if (!ranked.length) throw new Error('Hierarchy produced no leaf candidates.');
  const winner = ranked[0];
  const runnerUp = ranked[1] ?? null;
  const margin = runnerUp ? winner.normalizedProbability - runnerUp.normalizedProbability : winner.normalizedProbability;
  const reason = winner.normalizedProbability < minProbability ? 'probability'
    : margin < minMargin ? 'margin' : null;
  return {
    label: reason ? null : winner.label,
    path: reason ? null : winner.path,
    review: Boolean(reason),
    reason,
    probability: winner.probability,
    normalizedProbability: winner.normalizedProbability,
    margin,
    runnerUp,
    candidates: ranked.slice(0, beamWidth),
    requests,
  };
}
