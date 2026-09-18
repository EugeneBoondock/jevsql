// Deterministic operational evidence: lock waits, backup and recovery jobs,
// and replication health.
//
// The documents are consistent about the division here. Building a wait graph,
// deciding whether an RPO was met, and comparing a lag figure to a threshold are
// arithmetic and belong in code; naming the incident family and choosing the
// runbook is the judgement. So this module computes and buckets, and produces
// named features for a typed review. It never asks a model anything, never
// calculates a deadlock graph by inference, and never triggers a failover.

import { integer, nonNegative } from './validation.mjs';

const finite = (value) => typeof value === 'number' && Number.isFinite(value);
const text = (value, label) => {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${label} must be a non-empty string.`);
  return value;
};
const identity = (value, label) => {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value);
  return text(value, label);
};
const duration = (value, label) => {
  if (value == null) return null;
  return nonNegative(value, label);
};

/**
 * Build the wait-for graph from already-collected lock evidence.
 *
 * `waits` are edges: a waiter is blocked by a holder. Cycles are genuine
 * deadlocks in the supplied sample; a cycle is reported with the exact
 * participants rather than a claim about the cause. Chains are followed to
 * their root so an operator sees the one session actually holding everything up.
 *
 * @param {{waiterId, holderId, waiterQuery?, holderQuery?, relation?, lockMode?, waitedMs?}[]} waits
 */
export function buildLockGraph(waits) {
  if (!Array.isArray(waits)) throw new TypeError('waits must be an array.');
  const nodes = new Map();
  const edges = [];
  const node = (id, query) => {
    if (!nodes.has(id)) nodes.set(id, { id, query: query ?? null, waitingFor: [], blocking: [], waitedMs: null });
    const entry = nodes.get(id);
    if (entry.query === null && query != null) entry.query = query;
    return entry;
  };
  for (const [index, wait] of waits.entries()) {
    const waiterId = identity(wait?.waiterId, `waits[${index}].waiterId`);
    const holderId = identity(wait?.holderId, `waits[${index}].holderId`);
    if (waiterId === holderId) throw new TypeError(`waits[${index}] has a session waiting on itself.`);
    const waiter = node(waiterId, wait.waiterQuery), holder = node(holderId, wait.holderQuery);
    const waitedMs = duration(wait.waitedMs, `waits[${index}].waitedMs`);
    if (waitedMs !== null) waiter.waitedMs = Math.max(waiter.waitedMs ?? 0, waitedMs);
    waiter.waitingFor.push(holderId);
    holder.blocking.push(waiterId);
    edges.push({ waiterId, holderId, relation: wait.relation ?? null,
      lockMode: wait.lockMode ?? null, waitedMs });
  }

  // Depth-first search over the wait-for edges. Every cycle found is recorded by
  // its participants, deduplicated by its canonical rotation.
  const cycles = new Map();
  const colour = new Map();
  const stack = [];
  const visit = (id) => {
    colour.set(id, 'grey');
    stack.push(id);
    for (const next of nodes.get(id).waitingFor) {
      if (!nodes.has(next)) continue;
      if (colour.get(next) === 'grey') {
        const cycle = stack.slice(stack.indexOf(next));
        const lowest = cycle.indexOf([...cycle].sort()[0]);
        const canonical = [...cycle.slice(lowest), ...cycle.slice(0, lowest)];
        cycles.set(canonical.join('->'), canonical);
      } else if (!colour.has(next)) visit(next);
    }
    stack.pop();
    colour.set(id, 'black');
  };
  for (const id of nodes.keys()) if (!colour.has(id)) visit(id);

  const inCycle = new Set([...cycles.values()].flat());
  const roots = [...nodes.values()].filter((entry) => !entry.waitingFor.length && entry.blocking.length);
  const chainLength = (id, seen = new Set()) => {
    if (seen.has(id)) return 0;
    seen.add(id);
    const next = nodes.get(id)?.waitingFor ?? [];
    return next.length ? 1 + Math.max(...next.map((holder) => chainLength(holder, seen))) : 0;
  };
  const chains = [...nodes.keys()].map((id) => ({ id, depth: chainLength(id) })).sort((a, b) => b.depth - a.depth);
  const waitTimes = [...nodes.values()].map((entry) => entry.waitedMs).filter(finite);
  return {
    nodes: [...nodes.values()].sort((a, b) => a.id.localeCompare(b.id)),
    edges,
    cycles: [...cycles.values()],
    deadlocked: cycles.size > 0,
    rootBlockers: roots.map((entry) => ({ id: entry.id, blocking: entry.blocking.length, query: entry.query }))
      .sort((a, b) => b.blocking - a.blocking || a.id.localeCompare(b.id)),
    summary: {
      sessions: nodes.size, waits: edges.length, cycleCount: cycles.size,
      sessionsInCycle: inCycle.size, rootBlockerCount: roots.length,
      longestChain: chains[0]?.depth ?? 0,
      maxWaitMs: waitTimes.length ? Math.max(...waitTimes) : null,
      totalWaitMs: waitTimes.length ? waitTimes.reduce((sum, value) => sum + value, 0) : null,
      // A named bucket, because the rubric should compare against a category
      // rather than reason about a millisecond figure.
      contentionShape: cycles.size ? 'deadlock-cycle'
        : roots.length === 1 && nodes.size > 2 ? 'single-root-blocker'
          : chains[0]?.depth >= 3 ? 'long-wait-chain'
            : edges.length ? 'isolated-waits' : 'no-contention',
    },
  };
}

/**
 * Deterministic backup and point-in-time-recovery posture.
 *
 * Recovery-point and recovery-time objectives are compared here, in code,
 * because TypeSafe documents date arithmetic as unreliable. The result is a set
 * of named buckets a rubric can judge: whether the objective was met, how stale
 * the newest usable backup is, and whether restores have actually been drilled.
 */
export function summarizeBackups(jobs, { nowMs = Date.now(), rpoTargetMs = null, rtoTargetMs = null } = {}) {
  if (!Array.isArray(jobs)) throw new TypeError('jobs must be an array.');
  nonNegative(nowMs, 'nowMs');
  if (rpoTargetMs !== null) nonNegative(rpoTargetMs, 'rpoTargetMs');
  if (rtoTargetMs !== null) nonNegative(rtoTargetMs, 'rtoTargetMs');
  const entries = jobs.map((job, index) => {
    const completedAtMs = job?.completedAtMs ?? null;
    if (completedAtMs !== null) nonNegative(completedAtMs, `jobs[${index}].completedAtMs`);
    return { id: identity(job?.id, `jobs[${index}].id`),
      kind: job?.kind ?? 'full', succeeded: job?.succeeded === true,
      verified: job?.verified === true, restoreDrilled: job?.restoreDrilled === true,
      completedAtMs, durationMs: duration(job?.durationMs, `jobs[${index}].durationMs`),
      sizeBytes: duration(job?.sizeBytes, `jobs[${index}].sizeBytes`),
      ageMs: completedAtMs === null ? null : Math.max(0, nowMs - completedAtMs) };
  });
  const usable = entries.filter((entry) => entry.succeeded && entry.verified && entry.ageMs !== null);
  const newest = usable.sort((a, b) => a.ageMs - b.ageMs)[0] ?? null;
  const failures = entries.filter((entry) => !entry.succeeded);
  // Consecutive failures counted from the most recent job backwards.
  const ordered = entries.filter((entry) => entry.completedAtMs !== null).sort((a, b) => b.completedAtMs - a.completedAtMs);
  let failureStreak = 0;
  for (const entry of ordered) { if (entry.succeeded) break; failureStreak++; }
  const restoreDurations = entries.filter((entry) => entry.restoreDrilled && finite(entry.durationMs)).map((entry) => entry.durationMs);
  const slowestRestoreMs = restoreDurations.length ? Math.max(...restoreDurations) : null;
  const ageBucket = newest === null ? 'no-usable-backup'
    : rpoTargetMs === null ? 'no-objective-declared'
      : newest.ageMs <= rpoTargetMs ? 'within-objective'
        : newest.ageMs <= rpoTargetMs * 2 ? 'past-objective' : 'far-past-objective';
  return {
    jobs: entries.length, succeeded: entries.length - failures.length, failed: failures.length, failureStreak,
    verified: entries.filter((entry) => entry.verified).length,
    restoreDrills: entries.filter((entry) => entry.restoreDrilled).length,
    newestUsableBackup: newest === null ? null : { id: newest.id, ageMs: newest.ageMs, kind: newest.kind },
    recoveryPoint: { targetMs: rpoTargetMs, observedMs: newest?.ageMs ?? null, met: newest === null || rpoTargetMs === null ? null : newest.ageMs <= rpoTargetMs, bucket: ageBucket },
    recoveryTime: { targetMs: rtoTargetMs, slowestDrillMs: slowestRestoreMs,
      met: slowestRestoreMs === null || rtoTargetMs === null ? null : slowestRestoreMs <= rtoTargetMs,
      bucket: slowestRestoreMs === null ? 'never-drilled' : rtoTargetMs === null ? 'no-objective-declared'
        : slowestRestoreMs <= rtoTargetMs ? 'within-objective' : 'past-objective' },
    // The single fact an operator most needs: a backup nobody has restored is a
    // hypothesis, so it is reported separately from a backup that succeeded.
    posture: newest === null ? 'no-verified-backup'
      : restoreDurations.length === 0 ? 'verified-but-never-restored'
        : failureStreak > 0 ? 'recent-failures' : 'drilled',
  };
}

/** Deterministic replication posture from already-measured lag and errors. */
export function summarizeReplication(nodes, { nowMs = Date.now(), maxLagMs = null, maxTelemetryAgeMs = 60000 } = {}) {
  if (!Array.isArray(nodes)) throw new TypeError('nodes must be an array.');
  integer(maxTelemetryAgeMs, 'maxTelemetryAgeMs', 0);
  if (maxLagMs !== null) nonNegative(maxLagMs, 'maxLagMs');
  const entries = nodes.map((node, index) => {
    const observedAtMs = node?.telemetryAtMs ?? null;
    if (observedAtMs !== null) nonNegative(observedAtMs, `nodes[${index}].telemetryAtMs`);
    const telemetryAgeMs = observedAtMs === null ? null : Math.max(0, nowMs - observedAtMs);
    const lagMs = duration(node?.lagMs, `nodes[${index}].lagMs`);
    return { id: identity(node?.id, `nodes[${index}].id`), role: node?.role ?? 'replica',
      healthy: node?.healthy === true, lagMs, telemetryAgeMs,
      fresh: telemetryAgeMs !== null && telemetryAgeMs <= maxTelemetryAgeMs,
      conflicts: node?.conflicts ?? 0, errors: Array.isArray(node?.errors) ? node.errors.slice(0, 20) : [],
      lagBucket: lagMs === null ? 'unmeasured' : maxLagMs === null ? 'no-threshold-declared'
        : lagMs <= maxLagMs ? 'within-threshold' : lagMs <= maxLagMs * 10 ? 'past-threshold' : 'far-past-threshold' };
  });
  const replicas = entries.filter((entry) => entry.role !== 'primary');
  const measured = replicas.filter((entry) => entry.fresh && entry.lagMs !== null);
  const lags = measured.map((entry) => entry.lagMs);
  return { nodes: entries,
    summary: { total: entries.length, primaries: entries.length - replicas.length, replicas: replicas.length,
      healthy: entries.filter((entry) => entry.healthy).length,
      staleTelemetry: entries.filter((entry) => !entry.fresh).length,
      measuredReplicas: measured.length,
      maxLagMs: lags.length ? Math.max(...lags) : null,
      conflicts: entries.reduce((sum, entry) => sum + (finite(entry.conflicts) ? entry.conflicts : 0), 0),
      breachingReplicas: measured.filter((entry) => ['past-threshold', 'far-past-threshold'].includes(entry.lagBucket)).map((entry) => entry.id),
      // Unmeasured is its own state. A replica whose telemetry stopped is not a
      // healthy replica, and it is not a lagging one either.
      posture: !replicas.length ? 'no-replicas'
        : replicas.some((entry) => !entry.healthy) ? 'replica-down'
          : measured.length < replicas.length ? 'telemetry-stale'
            : lags.some((lag) => maxLagMs !== null && lag > maxLagMs) ? 'lag-breach' : 'healthy' } };
}
