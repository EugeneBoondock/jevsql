// The cascading tier.
//
// The third document's economic argument is that a cheap decision model should
// settle most cases and an expensive generative model should see only the ones
// it cannot. That is worth building, but the claimed percentages are vendor
// figures, so nothing here assumes them: the router measures what each tier
// actually handled and what it actually cost.
//
// The important property is the direction of escalation. A confident answer can
// settle a case; an unconfident one can only move it to a more expensive tier or
// to a human. No tier can lower the approval another tier already required.

import { probability, nonNegative, integer } from './validation.mjs';

const text = (value, label) => {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${label} must be a non-empty string.`);
  return value;
};

/**
 * Route work through tiers, stopping at the first that settles it.
 *
 * Each tier is `{name, handle(input, context), costPerCallUsd?}`. A handler
 * returns `{settled: boolean, decision?, confidence?, ...}`. A tier that throws
 * escalates rather than failing the request, because an unavailable cheap tier
 * should cost money, not correctness — except for the last tier, whose failure
 * is the caller's to handle.
 */
export class CascadingRouter {
  #tiers;

  constructor({ tiers, minConfidence = 0.9, maxEscalationRate = 1, now = Date.now } = {}) {
    if (!Array.isArray(tiers) || !tiers.length) throw new TypeError('At least one tier is required.');
    this.#tiers = tiers.map((tier, index) => {
      text(tier?.name, `tiers[${index}].name`);
      if (typeof tier.handle !== 'function') throw new TypeError(`tiers[${index}].handle must be a function.`);
      return { name: tier.name, handle: tier.handle,
        costPerCallUsd: nonNegative(tier.costPerCallUsd ?? 0, 'costPerCallUsd'),
        minConfidence: tier.minConfidence === undefined ? null : probability(tier.minConfidence, 'tier.minConfidence') };
    });
    this.minConfidence = probability(minConfidence, 'minConfidence');
    this.maxEscalationRate = probability(maxEscalationRate, 'maxEscalationRate');
    this.now = now;
    this.stats = { handled: 0, escalations: 0, unsettled: 0,
      byTier: Object.fromEntries(this.#tiers.map((tier) => [tier.name, { calls: 0, settled: 0, failures: 0, costUsd: 0, wallMs: 0 }])) };
  }

  get tiers() { return this.#tiers.map(({ name, costPerCallUsd }) => ({ name, costPerCallUsd })); }

  async route(input, context = {}) {
    const trail = [];
    for (const [index, tier] of this.#tiers.entries()) {
      const record = this.stats.byTier[tier.name];
      const started = performance.now();
      record.calls++;
      record.costUsd += tier.costPerCallUsd;
      let result, failure = null;
      try {
        result = await tier.handle(input, { ...context, tier: tier.name, previous: trail.slice() });
      } catch (error) {
        failure = error;
        record.failures++;
      }
      record.wallMs += Math.round(performance.now() - started);
      const threshold = tier.minConfidence ?? this.minConfidence;
      const confident = result != null && (result.confidence === undefined || result.confidence >= threshold);
      const settled = Boolean(result?.settled) && confident && failure === null;
      trail.push({ tier: tier.name, settled, confidence: result?.confidence ?? null,
        decision: result?.decision ?? null, threshold,
        reason: failure ? 'tier_failed' : settled ? 'settled' : result == null ? 'no_result' : !confident ? 'below_confidence' : 'not_settled',
        error: failure ? 'tier failed; escalated' : null });
      if (settled) {
        this.stats.handled++;
        record.settled++;
        return { settled: true, tier: tier.name, result, trail, escalations: index,
          costUsd: trail.reduce((sum, step) => sum + this.#tiers.find((entry) => entry.name === step.tier).costPerCallUsd, 0) };
      }
      if (index === this.#tiers.length - 1) {
        this.stats.unsettled++;
        if (failure) throw failure;
        return { settled: false, tier: tier.name, result, trail, escalations: index,
          costUsd: trail.reduce((sum, step) => sum + this.#tiers.find((entry) => entry.name === step.tier).costPerCallUsd, 0) };
      }
      this.stats.escalations++;
    }
    return { settled: false, tier: null, trail, escalations: trail.length };
  }

  /** What each tier actually handled, against the escalation budget. */
  report() {
    const total = this.stats.handled + this.stats.unsettled;
    const byTier = Object.entries(this.stats.byTier).map(([name, record]) => ({ name, ...record,
      settledShare: total ? record.settled / total : null,
      meanWallMs: record.calls ? record.wallMs / record.calls : null }));
    const first = byTier[0];
    const escalationRate = first?.calls ? (first.calls - first.settled) / first.calls : null;
    return { total, settled: this.stats.handled, unsettled: this.stats.unsettled, byTier,
      escalationRate, costUsd: byTier.reduce((sum, tier) => sum + tier.costUsd, 0),
      costPerCaseUsd: total ? byTier.reduce((sum, tier) => sum + tier.costUsd, 0) / total : null,
      withinEscalationBudget: escalationRate === null ? null : escalationRate <= this.maxEscalationRate,
      note: 'Shares and costs are measured from this run, not projected from vendor figures.' };
  }
}

/**
 * A tier backed by a typed review. It settles on an eligible or blocked verdict
 * and escalates anything routed to review, which is the intended division: the
 * cheap tier resolves the clear cases and hands over the ambiguous ones.
 */
export function decisionTier({ service, policy, buildState, name = 'typed-decision', costPerCallUsd = 0, minConfidence }) {
  if (!service?.review) throw new TypeError('A decision service is required.');
  if (typeof buildState !== 'function') throw new TypeError('buildState(input) is required.');
  return { name, costPerCallUsd, minConfidence,
    async handle(input, context) {
      const receipt = await service.review(policy, await buildState(input), { signal: context?.signal });
      const decision = receipt.decision;
      return { settled: decision !== 'review', decision, receipt,
        // A review verdict carries no confidence to compare; an eligible one
        // reports the weakest gate it passed, so a marginal pass still escalates.
        confidence: decision === 'review' ? 0 : Math.min(1, ...Object.values(receipt.answers ?? {})
          .map((answer) => answer.confidence ?? answer.noul ?? 1), 1) };
    } };
}

/** A terminal tier that never settles, so unresolved work reaches a person. */
export function humanTier({ name = 'human-review', queue } = {}) {
  return { name, costPerCallUsd: 0,
    async handle(input, context) {
      if (typeof queue === 'function') await queue(input, context);
      return { settled: false, decision: 'review', reason: 'escalated_to_human' };
    } };
}

/**
 * Measure whether a cheap-first cascade actually pays, from observed counts.
 * Compares the blended cost against sending everything to the expensive tier.
 */
export function cascadeEconomics({ cases, cheapCostUsd, expensiveCostUsd, escalationRate, humanMinutesSaved = 0, humanCostPerHourUsd = 0 }) {
  integer(cases, 'cases', 0);
  nonNegative(cheapCostUsd, 'cheapCostUsd');
  nonNegative(expensiveCostUsd, 'expensiveCostUsd');
  probability(escalationRate, 'escalationRate');
  nonNegative(humanMinutesSaved, 'humanMinutesSaved');
  nonNegative(humanCostPerHourUsd, 'humanCostPerHourUsd');
  const blended = cases * cheapCostUsd + cases * escalationRate * expensiveCostUsd;
  const baseline = cases * expensiveCostUsd;
  const labour = (humanMinutesSaved / 60) * humanCostPerHourUsd;
  return { cases, blendedCostUsd: blended, expensiveOnlyCostUsd: baseline,
    inferenceSavingUsd: baseline - blended,
    ratio: blended > 0 ? baseline / blended : null,
    labourSavingUsd: labour, totalSavingUsd: (baseline - blended) + labour,
    worthwhile: blended < baseline,
    note: 'Arithmetic over supplied measurements. Accuracy differences between tiers are not modelled here.' };
}
