// Data lineage and catalogue enrichment.
//
// Raw lineage says what ran, not what the data means. The documents suggest
// adding domain, sensitivity and purpose labels on top, and flagging edges that
// look surprising against declared ownership. The graph, the reachability and
// the classification propagation are all deterministic and live here; only the
// genuinely ambiguous edges are worth a typed judgement.
//
// Propagation is the part that earns its keep: if a column carrying personal
// data flows into a dataset nobody classified, that dataset is carrying personal
// data whatever its catalogue entry says.

import { stableJson } from './validation.mjs';
import { digest, jsonData } from './privacy.mjs';

const SENSITIVITY = ['public', 'internal', 'personal', 'sensitive', 'restricted'];
const rank = (level) => SENSITIVITY.indexOf(level);

const text = (value, label) => {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${label} must be a non-empty string.`);
  return value;
};

/**
 * Build a lineage graph from job records.
 *
 * A job record is `{job, inputs: [name | {name, columns}], outputs: [...],
 * columnMapping?: [{from: {dataset, column}, to: {dataset, column}}]}`. The
 * shape matches what an OpenLineage-style collector already emits, so a caller
 * feeds this from their existing job metadata rather than restating it.
 */
export function buildLineage(jobs, { datasets = [] } = {}) {
  if (!Array.isArray(jobs)) throw new TypeError('jobs must be an array.');
  const nodes = new Map();
  const declared = new Map(datasets.map((dataset) => [text(dataset?.name, 'dataset.name'), jsonData(dataset)]));
  const node = (name) => {
    if (!nodes.has(name)) {
      const record = declared.get(name) ?? {};
      nodes.set(name, { name, domain: record.domain ?? null, owner: record.owner ?? null,
        sensitivity: record.sensitivity ?? null, purpose: record.purpose ?? null,
        declared: declared.has(name), upstream: new Set(), downstream: new Set(), producedBy: new Set(), readBy: new Set() });
    }
    return nodes.get(name);
  };
  for (const dataset of declared.keys()) node(dataset);
  const edges = [], columnEdges = [];
  for (const [index, record] of jobs.entries()) {
    const job = text(record?.job, `jobs[${index}].job`);
    const inputs = (record.inputs ?? []).map((item) => text(typeof item === 'string' ? item : item?.name, 'input name'));
    const outputs = (record.outputs ?? []).map((item) => text(typeof item === 'string' ? item : item?.name, 'output name'));
    for (const output of outputs) {
      const target = node(output);
      target.producedBy.add(job);
      for (const input of inputs) {
        const source = node(input);
        source.readBy.add(job);
        source.downstream.add(output);
        target.upstream.add(input);
        edges.push({ job, from: input, to: output });
      }
    }
    for (const mapping of record.columnMapping ?? []) {
      columnEdges.push({ job,
        from: { dataset: text(mapping?.from?.dataset, 'mapping.from.dataset'), column: text(mapping?.from?.column, 'mapping.from.column') },
        to: { dataset: text(mapping?.to?.dataset, 'mapping.to.dataset'), column: text(mapping?.to?.column, 'mapping.to.column') } });
    }
  }
  return {
    nodes: [...nodes.values()].map((entry) => ({ ...entry,
      upstream: [...entry.upstream].sort(), downstream: [...entry.downstream].sort(),
      producedBy: [...entry.producedBy].sort(), readBy: [...entry.readBy].sort() })).sort((a, b) => a.name.localeCompare(b.name)),
    edges, columnEdges,
    roots: [...nodes.values()].filter((entry) => !entry.upstream.size).map((entry) => entry.name).sort(),
    leaves: [...nodes.values()].filter((entry) => !entry.downstream.size).map((entry) => entry.name).sort(),
    hash: digest(stableJson(edges)),
  };
}

/**
 * Propagate sensitivity downstream and report where the catalogue disagrees.
 *
 * A dataset's effective sensitivity is at least the highest of anything that
 * flows into it. When a declared label is lower than what reaches it, that is a
 * contradiction worth a human, not a number to average. Cycles are handled by
 * running to a fixed point rather than recursing.
 */
export function propagateSensitivity(graph) {
  const byName = new Map(graph.nodes.map((node) => [node.name, node]));
  const effective = new Map(graph.nodes.map((node) => [node.name, node.sensitivity ?? null]));
  let changed = true, passes = 0;
  while (changed && passes++ < byName.size + 2) {
    changed = false;
    for (const edge of graph.edges) {
      const from = effective.get(edge.from), to = effective.get(edge.to);
      if (from === null) continue;
      if (to === null || rank(from) > rank(to)) { effective.set(edge.to, from); changed = true; }
    }
  }
  const findings = [];
  for (const node of graph.nodes) {
    const inherited = effective.get(node.name);
    if (inherited === null) {
      findings.push({ level: 'info', code: 'unclassified_dataset', dataset: node.name,
        detail: `${node.name} has no declared sensitivity and inherits none.` });
      continue;
    }
    if (node.sensitivity === null) {
      findings.push({ level: 'review', code: 'inherits_undeclared_sensitivity', dataset: node.name,
        declared: null, effective: inherited,
        detail: `${node.name} is undeclared but receives ${inherited} data from upstream.` });
    } else if (rank(inherited) > rank(node.sensitivity)) {
      findings.push({ level: 'review', code: 'declared_below_inherited', dataset: node.name,
        declared: node.sensitivity, effective: inherited,
        detail: `${node.name} is catalogued as ${node.sensitivity} but receives ${inherited} data.` });
    }
  }
  return { effective: Object.fromEntries([...effective].sort(([a], [b]) => a.localeCompare(b))), findings,
    contradictions: findings.filter((finding) => finding.code === 'declared_below_inherited').length };
}

/**
 * Edges that look wrong against declared ownership, so a reviewer sees the
 * handful worth judging rather than the whole graph. Nothing here is a verdict:
 * a cross-domain flow is often exactly what a pipeline is for.
 */
export function surprisingEdges(graph, { allowedCrossDomain = [] } = {}) {
  const byName = new Map(graph.nodes.map((node) => [node.name, node]));
  const allowed = new Set(allowedCrossDomain.map((pair) => stableJson([pair.from, pair.to])));
  const surprises = [];
  for (const edge of graph.edges) {
    const from = byName.get(edge.from), to = byName.get(edge.to);
    if (!from || !to) continue;
    if (from.domain && to.domain && from.domain !== to.domain && !allowed.has(stableJson([from.domain, to.domain]))) {
      surprises.push({ code: 'cross_domain_flow', job: edge.job, from: edge.from, to: edge.to,
        fromDomain: from.domain, toDomain: to.domain });
    }
    if (from.owner && to.owner && from.owner !== to.owner) {
      surprises.push({ code: 'cross_owner_flow', job: edge.job, from: edge.from, to: edge.to,
        fromOwner: from.owner, toOwner: to.owner });
    }
    if (from.sensitivity && to.sensitivity && rank(from.sensitivity) > rank(to.sensitivity)) {
      surprises.push({ code: 'sensitivity_downgrade', job: edge.job, from: edge.from, to: edge.to,
        fromSensitivity: from.sensitivity, toSensitivity: to.sensitivity });
    }
  }
  return surprises;
}

/**
 * Discover candidate lineage from workload statements alone, for a catalogue
 * that has no job metadata yet. A statement that reads some tables and writes
 * another is an edge. This is a lexical reading, so every edge is marked
 * `discovered` and should be confirmed before it is treated as fact.
 */
export function discoverLineage(statements, { job = 'discovered' } = {}) {
  if (!Array.isArray(statements)) throw new TypeError('statements must be an array.');
  const reference = '(?:[A-Za-z_][A-Za-z0-9_$]*\\.)?[A-Za-z_][A-Za-z0-9_$]*';
  const jobs = [];
  for (const [index, entry] of statements.entries()) {
    const sql = typeof entry === 'string' ? entry : entry?.sql;
    if (typeof sql !== 'string' || !sql.trim()) continue;
    const name = typeof entry === 'object' && entry?.job ? entry.job : `${job}-${index + 1}`;
    const strip = (value) => value.replace(/^[`"[]|[`"\]]$/g, '');
    const outputs = [...sql.matchAll(new RegExp(`\\b(?:INSERT\\s+INTO|UPDATE|MERGE\\s+INTO|CREATE\\s+(?:TABLE|VIEW)(?:\\s+IF\\s+NOT\\s+EXISTS)?|REPLACE\\s+INTO)\\s+(${reference})`, 'gi'))]
      .map((match) => strip(match[1]));
    const inputs = [...sql.matchAll(new RegExp(`\\b(?:FROM|JOIN)\\s+(${reference})`, 'gi'))]
      .map((match) => strip(match[1])).filter((table) => !outputs.includes(table));
    if (!outputs.length || !inputs.length) continue;
    jobs.push({ job: name, inputs: [...new Set(inputs)], outputs: [...new Set(outputs)], discovered: true });
  }
  return jobs;
}
