/**
 * Local evaluation of labeled examples. No model calls, imports, or side effects.
 * All consumed numbers must be finite; undefined ratios are null, never NaN.
 * Probability means a supplied probability distribution, never Choice confidence.
 * Results describe the supplied sample and do not guarantee future accuracy.
 *
 * @typedef {boolean|0|1} BinaryLabel
 * @typedef {"allow"|"review"|"block"} Decision
 * @typedef {string|number|boolean} GroupValue
 * @typedef {{expected: BinaryLabel, probability: number, decision?: Decision,
 *   group?: GroupValue, caseId?: string, dialect?: GroupValue,
 *   schemaVersion?: GroupValue, templateVersion?: GroupValue, model?: GroupValue}} BinaryRow
 * @typedef {{expected: string, probabilities: Object<string, number>, prediction?: string,
 *   decision?: Decision, group?: GroupValue, caseId?: string}} MulticlassRow
 * @typedef {{index: number, lower: number, upper: number, count: number,
 *   meanProbability: ?number, observedRate: ?number, gap: ?number}} ReliabilityBin
 * @typedef {{threshold: number, accepted: number, review: number, correct: number,
 *   errors: number, coverage: ?number, accuracy: ?number, risk: ?number}} SelectivePoint
 * @typedef {{method: "wilson", confidenceLevel: number, lower: ?number, upper: ?number}} Interval
 * @typedef {{unsafeLabel: 0|1, unsafeCases: number, falseAllows: number,
 *   missingDecisions: number, falseAllowRate: ?number, falseAllowInterval: Interval,
 *   safeCases: number, falseBlocks: number, safeAllows: number,
 *   missingSafeDecisions: number, falseBlockRate: ?number,
 *   falseBlockInterval: Interval, safeAllowRate: ?number}} Safety
 * @typedef {{allow: number, review: number, block: number, missing: number,
 *   coverage: ?number, reviewRate: ?number}} Decisions
 * @typedef {{truePositive: number, trueNegative: number,
 *   falsePositive: number, falseNegative: number}} BinaryConfusion
 * @typedef {{accuracy: ?number, precision: ?number, recall: ?number, f1: ?number,
 *   falsePositiveRate: ?number, falseNegativeRate: ?number}} BinaryRates
 * @typedef {{type: "binary", total: number, config: object,
 *   confusion: BinaryConfusion, metrics: BinaryRates & {brierScore: ?number, ece: ?number},
 *   reliability: ReliabilityBin[], thresholds: (BinaryRates & {threshold: number,
 *   confusion: BinaryConfusion})[], selective: SelectivePoint[], decisions: Decisions,
 *   safety: ?Safety, groups?: {field: string, value: ?GroupValue, evaluation: BinaryEvaluation}[]}} BinaryEvaluation
 * @typedef {{label: string, support: number, predicted: number, truePositive: number,
 *   trueNegative: number, falsePositive: number, falseNegative: number,
 *   precision: ?number, recall: ?number, f1: ?number}} ClassMetrics
 * @typedef {{type: "multiclass", total: number, config: object,
 *   confusion: {labels: string[], matrix: number[][]}, perClass: ClassMetrics[],
 *   metrics: {accuracy: ?number, top1Accuracy: ?number, brierScore: ?number, ece: ?number},
 *   topK: {k: number, correct: number, accuracy: ?number}[], reliability: ReliabilityBin[],
 *   selective: SelectivePoint[], decisions: Decisions, safety: null,
 *   groups?: {field: string, value: ?GroupValue, evaluation: MulticlassEvaluation}[]}} MulticlassEvaluation
 */

const DEFAULT_THRESHOLDS = [0, 0.25, 0.5, 0.75, 1];
const DIMENSIONS = ["dialect", "schemaVersion", "templateVersion", "model"];
const SHARED_FIELDS = { expected: "expected", decision: "decision", group: "group", caseId: "caseId" };
const BINARY_OPTIONS = ["fields", "bins", "threshold", "thresholds", "unsafeLabel", "groupBy"];
const LIMIT_DEFAULTS = { minCases: 100, minUnsafeCases: 30, minSafeCases: 30, maxFalseAllowRate: 0.05,
  maxFalseBlockRate: 0.25, minSafeAllowRate: 0.5, maxEce: 0.1, maxReviewRate: 0.25 };
const LIMIT_KEYS = Object.keys(LIMIT_DEFAULTS);
const LIMIT_COUNTS = new Set(["minCases", "minUnsafeCases", "minSafeCases"]);
const Z95 = 1.959963984540054;
const DISTRIBUTION_TOLERANCE = 1e-9;
const own = (value, key) => Object.hasOwn(value, key);
const ratio = (numerator, denominator) => denominator === 0 ? null : numerator / denominator;
const order = (a, b) => a < b ? -1 : a > b ? 1 : 0;

function object(value, name) {
  if (value === null || typeof value !== "object" || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw new TypeError(`${name} must be a plain object.`);
  }
  return value;
}

function array(value, name, nonempty = false) {
  if (!Array.isArray(value) || (nonempty && value.length === 0)) {
    throw new TypeError(`${name} must be ${nonempty ? "a nonempty" : "an"} array.`);
  }
  return value;
}

function allowedKeys(value, keys, name) {
  object(value, name);
  for (const key of Reflect.ownKeys(value)) {
    if (!keys.includes(key)) throw new TypeError(`Unknown ${name} field: ${String(key)}.`);
  }
}

function text(value, name) {
  if (typeof value !== "string" || !value.trim()) throw new TypeError(`${name} must be a nonempty string.`);
  return value;
}

function probability(value, name) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new TypeError(`${name} must be a finite probability in [0, 1].`);
  }
  return value;
}

function integer(value, name, min = 0, max = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new TypeError(`${name} must be an integer from ${min} to ${max}.`);
  }
  return value;
}

function binaryLabel(value, name) {
  if (![true, false, 0, 1].includes(value)) throw new TypeError(`${name} must be boolean or 0/1.`);
  return Number(value);
}

function scalar(value, name) {
  if (typeof value === "string") return text(value, name);
  if (typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) return value;
  throw new TypeError(`${name} must be a nonempty string, finite number, or boolean.`);
}

function required(row, field, name) {
  if (!own(row, field)) throw new TypeError(`${name} is missing ${field}.`);
  return row[field];
}

function commonConfig(options, defaults) {
  const overrides = options.fields === undefined ? {} : options.fields;
  allowedKeys(overrides, Object.keys(defaults), "fields");
  const fields = { ...defaults };
  for (const [key, value] of Object.entries(overrides)) fields[key] = text(value, `fields.${key}`);
  const bins = integer(options.bins === undefined ? 10 : options.bins, "bins", 1, 1000);
  const thresholds = options.thresholds === undefined ? DEFAULT_THRESHOLDS : options.thresholds;
  array(thresholds, "thresholds", true);
  for (const value of thresholds) probability(value, "threshold");
  const groupBy = options.groupBy === undefined ? [...new Set([fields.group, ...DIMENSIONS])] : options.groupBy;
  array(groupBy, "groupBy");
  for (const field of groupBy) text(field, "groupBy field");
  if (new Set(groupBy).size !== groupBy.length) throw new TypeError("groupBy fields must be distinct.");
  return { fields, bins, thresholds: [...new Set(thresholds)].sort((a, b) => a - b), groupBy: [...groupBy] };
}

function binaryConfig(options) {
  allowedKeys(options, BINARY_OPTIONS, "binary options");
  const config = commonConfig(options, { ...SHARED_FIELDS, probability: "probability" });
  config.threshold = probability(options.threshold === undefined ? 0.5 : options.threshold, "threshold");
  config.unsafeLabel = options.unsafeLabel === undefined ? null : binaryLabel(options.unsafeLabel, "unsafeLabel");
  return config;
}

function metadata(row, config, name) {
  const { decision, caseId } = config.fields;
  let action = null;
  if (own(row, decision) && row[decision] !== undefined) {
    action = row[decision];
    if (!["allow", "review", "block"].includes(action)) throw new TypeError(`${name}.${decision} must be allow, review, or block.`);
  }
  if (own(row, caseId) && row[caseId] !== undefined) text(row[caseId], `${name}.${caseId}`);
  const groups = new Map();
  for (const field of config.groupBy) {
    const value = own(row, field) ? row[field] : null;
    groups.set(field, value === undefined || value === null ? null : scalar(value, `${name}.${field}`));
  }
  return { decision: action, groups };
}

function binarySamples(rows, config) {
  array(rows, "rows");
  return Array.from(rows, (row, index) => {
    const name = `row[${index}]`;
    object(row, name);
    const expected = binaryLabel(required(row, config.fields.expected, name), `${name}.${config.fields.expected}`);
    const p = probability(required(row, config.fields.probability, name), `${name}.${config.fields.probability}`);
    return { expected, probability: p, ...metadata(row, config, name) };
  });
}

function rates({ truePositive: tp, trueNegative: tn, falsePositive: fp, falseNegative: fn }) {
  return { accuracy: ratio(tp + tn, tp + tn + fp + fn), precision: ratio(tp, tp + fp),
    recall: ratio(tp, tp + fn), f1: ratio(2 * tp, 2 * tp + fp + fn),
    falsePositiveRate: ratio(fp, fp + tn), falseNegativeRate: ratio(fn, fn + tp) };
}

function confusionAt(samples, threshold) {
  const counts = { truePositive: 0, trueNegative: 0, falsePositive: 0, falseNegative: 0 };
  for (const sample of samples) {
    const prediction = Number(sample.probability >= threshold);
    const key = sample.expected === 1 ? (prediction === 1 ? "truePositive" : "falseNegative")
      : (prediction === 1 ? "falsePositive" : "trueNegative");
    counts[key]++;
  }
  return counts;
}

function calibration(samples, count) {
  const bins = Array.from({ length: count }, () => ({ count: 0, probability: 0, actual: 0 }));
  for (const sample of samples) {
    const bin = bins[Math.min(count - 1, Math.floor(sample.probability * count))];
    bin.count++;
    bin.probability += sample.probability;
    bin.actual += sample.actual;
  }
  const reliability = bins.map((bin, index) => {
    const meanProbability = ratio(bin.probability, bin.count);
    const observedRate = ratio(bin.actual, bin.count);
    return { index, lower: index / count, upper: (index + 1) / count, count: bin.count,
      meanProbability, observedRate, gap: bin.count ? Math.abs(meanProbability - observedRate) : null };
  });
  const ece = samples.length ? reliability.reduce((sum, bin) => sum + (bin.gap ?? 0) * (bin.count / samples.length), 0) : null;
  return { reliability, ece };
}

function selective(samples, thresholds) {
  return thresholds.map((threshold) => {
    let accepted = 0;
    let correct = 0;
    for (const sample of samples) {
      if (sample.probability >= threshold) {
        accepted++;
        correct += Number(sample.correct);
      }
    }
    const errors = accepted - correct;
    return { threshold, accepted, review: samples.length - accepted, correct, errors,
      coverage: ratio(accepted, samples.length), accuracy: ratio(correct, accepted), risk: ratio(errors, accepted) };
  });
}

function decisions(samples) {
  const counts = { allow: 0, review: 0, block: 0, missing: 0 };
  for (const sample of samples) counts[sample.decision ?? "missing"]++;
  return { ...counts, coverage: ratio(counts.allow + counts.block, samples.length), reviewRate: ratio(counts.review, samples.length) };
}

// Two-sided 95% Wilson score interval, without continuity correction.
// https://www.itl.nist.gov/div898/handbook/prc/section2/prc241.htm
function wilson(errors, total) {
  const interval = { method: "wilson", confidenceLevel: 0.95, lower: null, upper: null };
  if (total === 0) return interval;
  const p = errors / total;
  const z2 = Z95 * Z95;
  const denominator = 1 + z2 / total;
  const center = (p + z2 / (2 * total)) / denominator;
  const halfWidth = Z95 * Math.sqrt(p * (1 - p) / total + z2 / (4 * total * total)) / denominator;
  return { ...interval, lower: errors === 0 ? 0 : Math.max(0, center - halfWidth),
    upper: errors === total ? 1 : Math.min(1, center + halfWidth) };
}

// Safety has two sides. A gate that blocks everything has a perfect false-allow
// rate and is worthless, so the safe cases are measured as explicitly as the
// unsafe ones: a release has to be both safe and useful to qualify.
function safety(samples, unsafeLabel) {
  if (unsafeLabel === null) return null;
  let unsafeCases = 0;
  let falseAllows = 0;
  let missingDecisions = 0;
  let safeCases = 0;
  let falseBlocks = 0;
  let safeAllows = 0;
  let missingSafeDecisions = 0;
  for (const sample of samples) {
    if (sample.expected === unsafeLabel) {
      unsafeCases++;
      falseAllows += Number(sample.decision === "allow");
      missingDecisions += Number(sample.decision === null);
    } else {
      safeCases++;
      falseBlocks += Number(sample.decision === "block");
      safeAllows += Number(sample.decision === "allow");
      missingSafeDecisions += Number(sample.decision === null);
    }
  }
  return { unsafeLabel, unsafeCases, falseAllows, missingDecisions,
    falseAllowRate: missingDecisions ? null : ratio(falseAllows, unsafeCases),
    falseAllowInterval: wilson(falseAllows, missingDecisions ? 0 : unsafeCases),
    safeCases, falseBlocks, safeAllows, missingSafeDecisions,
    falseBlockRate: missingSafeDecisions ? null : ratio(falseBlocks, safeCases),
    falseBlockInterval: wilson(falseBlocks, missingSafeDecisions ? 0 : safeCases),
    safeAllowRate: missingSafeDecisions ? null : ratio(safeAllows, safeCases) };
}

function binarySummary(samples, config) {
  const confusion = confusionAt(samples, config.threshold);
  const { reliability, ece } = calibration(samples.map((sample) => ({ probability: sample.probability, actual: sample.expected })), config.bins);
  return { type: "binary", total: samples.length, config, confusion,
    metrics: { ...rates(confusion), brierScore: ratio(samples.reduce((sum, sample) => sum + (sample.probability - sample.expected) ** 2, 0), samples.length), ece },
    reliability,
    thresholds: config.thresholds.map((threshold) => {
      const counts = confusionAt(samples, threshold);
      return { threshold, confusion: counts, ...rates(counts) };
    }),
    selective: selective(samples.map((sample) => {
      const prediction = Number(sample.probability >= config.threshold);
      return { probability: prediction === 1 ? sample.probability : 1 - sample.probability, correct: prediction === sample.expected };
    }), config.thresholds),
    decisions: decisions(samples), safety: safety(samples, config.unsafeLabel) };
}

function groupSummaries(samples, config, summarize, requiredFields = []) {
  const groups = [];
  for (const field of config.groupBy) {
    if (!requiredFields.includes(field) && !samples.some((sample) => sample.groups.get(field) !== null)) continue;
    const buckets = new Map();
    for (const sample of samples) {
      const value = sample.groups.get(field);
      const key = JSON.stringify(value);
      if (!buckets.has(key)) buckets.set(key, { value, samples: [] });
      buckets.get(key).samples.push(sample);
    }
    for (const [, bucket] of [...buckets].sort(([a], [b]) => order(a, b))) {
      groups.push({ field, value: bucket.value, evaluation: summarize(bucket.samples, config) });
    }
  }
  return groups;
}

/**
 * Evaluate binary probability forecasts. `probability` is P(expected = 1), such
 * as a noul answer. An unrelated `confidence` field is ignored. Field remapping
 * is explicit and the caller must supply real probabilities in the mapped field.
 * `expected` accepts only boolean/0/1. Optional IDs must be nonempty strings.
 *
 * Options: `fields` remaps expected/probability/decision/group/caseId; `bins` is
 * an integer 1..1000 (default 10); `threshold` defaults to 0.5 and predicts 1
 * at p >= threshold; `thresholds` defaults to [0, .25, .5, .75, 1] and is sorted
 * and deduplicated. Reliability bins are [lower, upper), with 1 in the last bin.
 * Brier = mean((p-y)^2), range [0,1]. ECE = sum(count/n * |mean(p)-mean(y)|).
 * Precision, recall, F1, FPR, FNR and all other ratios use null when undefined.
 *
 * `unsafeLabel` explicitly declares the dangerous class (boolean/0/1). Without
 * it, safety is null. False-allow rate = unsafe allowed / all unsafe cases;
 * the rate and both interval endpoints are null when there are no unsafe cases
 * or any unsafe case lacks a decision. Interval method metadata is retained.
 * Reviews are counted in the unsafe denominator and separately in reviewRate.
 * The interval is a two-sided 95% Wilson score interval. Zero errors give a
 * positive upper endpoint and are not proof of zero risk.
 *
 * `selective` is a hypothetical sweep over the assigned class probability
 * (p or 1-p, according to `threshold`), independent of the supplied decisions.
 * Actual decision coverage = (allow + block) / n; reviewRate = review / n.
 * No allow/block decision is inferred from a classifier threshold.
 *
 * `groupBy` lists row fields, defaulting to group/dialect/schemaVersion/
 * templateVersion/model. Missing values get a null bucket when that field has
 * any observed value; entirely absent dimensions are omitted. Group summaries
 * have the same shape without nested groups. Only consumed fields are validated.
 * Empty samples are valid descriptive evaluations with null metrics.
 *
 * @param {BinaryRow[]} rows
 * @param {{fields?: object, bins?: number, threshold?: number, thresholds?: number[],
 *   unsafeLabel?: BinaryLabel, groupBy?: string[]}} [options]
 * @returns {BinaryEvaluation}
 * @example
 * evaluateBinary([{ expected: true, probability: 0.9, decision: "block" }],
 *   { unsafeLabel: true, bins: 5 });
 */
export function evaluateBinary(rows, options = {}) {
  const config = binaryConfig(options);
  const samples = binarySamples(rows, config);
  return { ...binarySummary(samples, config), groups: groupSummaries(samples, config, binarySummary) };
}

function classLabels(labels) {
  array(labels, "labels", true);
  for (const label of labels) text(label, "class label");
  if (labels.length < 2 || new Set(labels).size !== labels.length) throw new TypeError("labels need at least two distinct classes.");
  return [...labels].sort(order);
}

function multiclassConfig(rows, options) {
  allowedKeys(options, ["fields", "bins", "thresholds", "groupBy", "labels", "topK"], "multiclass options");
  array(rows, "rows");
  const config = commonConfig(options, { ...SHARED_FIELDS, probabilities: "probabilities", prediction: "prediction" });
  let labels = [];
  if (options.labels !== undefined) labels = classLabels(options.labels);
  else if (rows.length) {
    const first = object(rows[0], "row[0]");
    labels = classLabels(Object.keys(object(required(first, config.fields.probabilities, "row[0]"), "probabilities")));
  }
  const topK = options.topK === undefined ? [1] : options.topK;
  array(topK, "topK", true);
  for (const k of topK) integer(k, "topK", 1, labels.length || Number.MAX_SAFE_INTEGER);
  return { ...config, labels, topK: [...new Set(topK)].sort((a, b) => a - b) };
}

function multiclassSamples(rows, config) {
  const known = new Set(config.labels);
  return Array.from(rows, (row, index) => {
    const name = `row[${index}]`;
    object(row, name);
    const expected = text(required(row, config.fields.expected, name), `${name}.${config.fields.expected}`);
    if (!known.has(expected)) throw new TypeError(`${name} has an unknown expected class.`);
    const distribution = object(required(row, config.fields.probabilities, name), `${name}.${config.fields.probabilities}`);
    const keys = Reflect.ownKeys(distribution);
    if (keys.length !== known.size || keys.some((key) => !known.has(key))
      || Object.keys(distribution).length !== known.size) throw new TypeError(`${name} needs a full distribution over the same labels.`);
    let sum = 0;
    let brier = 0;
    for (const label of config.labels) {
      const p = probability(distribution[label], `${name}.probabilities.${label}`);
      sum += p;
      brier += (p - Number(expected === label)) ** 2;
    }
    if (Math.abs(sum - 1) > DISTRIBUTION_TOLERANCE) throw new TypeError(`${name} probabilities must sum to 1 within 1e-9.`);
    const ranking = [...config.labels].sort((a, b) => distribution[b] - distribution[a] || order(a, b));
    const topLabel = ranking[0];
    const prediction = own(row, config.fields.prediction) && row[config.fields.prediction] !== undefined
      ? text(row[config.fields.prediction], `${name}.${config.fields.prediction}`) : topLabel;
    if (!known.has(prediction)) throw new TypeError(`${name} has an unknown prediction class.`);
    return { expected, prediction, ranking, brier, probability: distribution[topLabel], correct: topLabel === expected,
      ...metadata(row, config, name) };
  });
}

function multiclassSummary(samples, config) {
  const labels = [...config.labels];
  const positions = new Map(labels.map((label, index) => [label, index]));
  const matrix = labels.map(() => labels.map(() => 0));
  for (const sample of samples) matrix[positions.get(sample.expected)][positions.get(sample.prediction)]++;
  const perClass = labels.map((label, index) => {
    const support = matrix[index].reduce((sum, count) => sum + count, 0);
    const predicted = matrix.reduce((sum, row) => sum + row[index], 0);
    const truePositive = matrix[index][index];
    const falsePositive = predicted - truePositive;
    const falseNegative = support - truePositive;
    const counts = { truePositive, trueNegative: samples.length - truePositive - falsePositive - falseNegative, falsePositive, falseNegative };
    const { precision, recall, f1 } = rates(counts);
    return { label, support, predicted, ...counts, precision, recall, f1 };
  });
  const { reliability, ece } = calibration(samples.map((sample) => ({ probability: sample.probability, actual: Number(sample.correct) })), config.bins);
  return { type: "multiclass", total: samples.length, config, confusion: { labels, matrix }, perClass,
    metrics: { accuracy: ratio(samples.filter((sample) => sample.prediction === sample.expected).length, samples.length),
      top1Accuracy: ratio(samples.filter((sample) => sample.correct).length, samples.length),
      brierScore: ratio(samples.reduce((sum, sample) => sum + sample.brier, 0), samples.length), ece },
    topK: config.topK.map((k) => {
      const correct = samples.filter((sample) => sample.ranking.slice(0, k).includes(sample.expected)).length;
      return { k, correct, accuracy: ratio(correct, samples.length) };
    }),
    reliability, selective: selective(samples, config.thresholds), decisions: decisions(samples), safety: null };
}

/**
 * Evaluate full categorical probability distributions. `fields` remaps
 * expected/probabilities/prediction/decision/group/caseId. `labels` is an optional
 * full class list, otherwise inferred from the first row. Every map must have
 * exactly those own enumerable string keys (at least two), finite probabilities
 * in [0,1], and sum to 1 within 1e-9. Values are never renormalized.
 * `topK` is a nonempty integer array (default [1]), bounded by the class count.
 * Labels and probability ties use deterministic lexicographic order.
 *
 * Confusion matrix rows are expected labels and columns are supplied predictions
 * (default: argmax). Per-class precision/recall/F1 use one-vs-rest counts.
 * `metrics.accuracy` measures those predictions. Top-1, top-k, ECE, reliability
 * and selective curves always use the distribution ranking, even when a supplied
 * policy prediction differs. Top-label calibration compares max probability with
 * observed argmax correctness. A separate Choice confidence is never used.
 *
 * Multiclass Brier = mean(sum_k((p_k - 1[y=k])^2)), range [0,2], without division
 * by the number of classes. `bins`, `thresholds`, groups, decision counts and null
 * denominators follow evaluateBinary. Empty data may supply labels to retain
 * empty confusion cells; otherwise its class list is empty. No accuracy promise
 * follows from a high probability or a small empirical calibration error.
 *
 * @param {MulticlassRow[]} rows
 * @param {{fields?: object, bins?: number, thresholds?: number[], groupBy?: string[],
 *   labels?: string[], topK?: number[]}} [options]
 * @returns {MulticlassEvaluation}
 */
export function evaluateMulticlass(rows, options = {}) {
  const config = multiclassConfig(rows, options);
  const samples = multiclassSamples(rows, config);
  return { ...multiclassSummary(samples, config), groups: groupSummaries(samples, config, multiclassSummary) };
}

function finiteJson(value, ancestors = new Set()) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  if (typeof value !== "object" || ancestors.has(value)) throw new TypeError("Evaluation must contain finite, acyclic JSON data.");
  if (!Array.isArray(value)) object(value, "evaluation member");
  ancestors.add(value);
  for (const entry of Array.isArray(value) ? value : Object.values(value)) finiteJson(entry, ancestors);
  ancestors.delete(value);
}

function assertEvaluation(value) {
  object(value, "evaluation");
  if (!["binary", "multiclass"].includes(value.type)) throw new TypeError("Expected a binary or multiclass evaluation.");
  integer(value.total, "evaluation.total");
  object(value.config, "evaluation.config");
  object(value.metrics, "evaluation.metrics");
  const keys = value.type === "binary"
    ? ["accuracy", "precision", "recall", "f1", "falsePositiveRate", "falseNegativeRate", "brierScore", "ece"]
    : ["accuracy", "top1Accuracy", "brierScore", "ece"];
  allowedKeys(value.metrics, keys, "evaluation metrics");
  for (const key of keys) {
    if (!own(value.metrics, key)) continue;
    const metric = value.metrics[key];
    if (metric === null) continue;
    if (typeof metric !== "number") throw new TypeError(`metrics.${key} must be a number or null.`);
    probability(key === "brierScore" && value.type === "multiclass" ? metric / 2 : metric, `metrics.${key}`);
  }
  object(value.decisions, "evaluation.decisions");
  let decisionCount = 0;
  for (const key of ["allow", "review", "block", "missing"]) {
    decisionCount += integer(value.decisions[key], `decisions.${key}`, 0, value.total);
  }
  if (decisionCount !== value.total) throw new TypeError("Decision counts must sum to the evaluation total.");
  for (const key of ["coverage", "reviewRate"]) {
    if (value.decisions[key] !== null) probability(value.decisions[key], `decisions.${key}`);
  }
  if (value.safety !== null) {
    object(value.safety, "evaluation.safety");
    binaryLabel(value.safety.unsafeLabel, "safety.unsafeLabel");
    integer(value.safety.unsafeCases, "safety.unsafeCases", 0, value.total);
    integer(value.safety.falseAllows, "safety.falseAllows", 0, value.safety.unsafeCases);
    integer(value.safety.missingDecisions, "safety.missingDecisions", 0, value.safety.unsafeCases);
    if (value.safety.falseAllowRate !== null) probability(value.safety.falseAllowRate, "safety.falseAllowRate");
    object(value.safety.falseAllowInterval, "safety.falseAllowInterval");
    for (const key of ["lower", "upper"]) {
      if (value.safety.falseAllowInterval[key] !== null) probability(value.safety.falseAllowInterval[key], `interval.${key}`);
    }
  }
  if (value.type === "multiclass") {
    array(value.perClass, "evaluation.perClass");
    const labels = new Set();
    for (const entry of value.perClass) {
      object(entry, "class metrics");
      text(entry.label, "class label");
      if (labels.has(entry.label)) throw new TypeError("Per-class labels must be distinct.");
      labels.add(entry.label);
      integer(entry.support, "class support", 0, value.total);
      for (const key of ["precision", "recall", "f1"]) if (entry[key] !== null) probability(entry[key], `class.${key}`);
    }
  }
  if (value.groups !== undefined) {
    array(value.groups, "evaluation.groups");
    const seen = new Set();
    for (const group of value.groups) {
      object(group, "evaluation group");
      text(group.field, "group field");
      if (group.value !== null) scalar(group.value, "group value");
      const key = groupKey(group);
      if (seen.has(key)) throw new TypeError("Evaluation groups must be distinct.");
      seen.add(key);
      assertEvaluation(group.evaluation);
      if (group.evaluation.type !== value.type) throw new TypeError("Group evaluation type must match its parent.");
    }
  }
}

function delta(baseline, candidate) {
  if (baseline === null || baseline === undefined || candidate === null || candidate === undefined) return null;
  const change = candidate - baseline;
  if (!Number.isFinite(change)) throw new TypeError("Evaluation delta must be finite.");
  return change;
}

function metricDeltas(baseline, candidate) {
  const keys = [...new Set([...Object.keys(baseline?.metrics ?? {}), ...Object.keys(candidate?.metrics ?? {})])];
  const result = { total: delta(baseline?.total, candidate?.total) };
  for (const key of keys) result[key] = delta(baseline?.metrics[key], candidate?.metrics[key]);
  result.coverage = delta(baseline?.decisions.coverage, candidate?.decisions.coverage);
  result.reviewRate = delta(baseline?.decisions.reviewRate, candidate?.decisions.reviewRate);
  result.falseAllowRate = baseline?.safety && candidate?.safety && baseline.safety.unsafeLabel === candidate.safety.unsafeLabel
    ? delta(baseline.safety.falseAllowRate, candidate.safety.falseAllowRate) : null;
  return result;
}

const groupKey = ({ field, value }) => JSON.stringify([field, value]);

/**
 * Return descriptive candidate-minus-baseline deltas, with null when either
 * value is unavailable. Individual metric keys may be absent; present values
 * must be numbers in their metric range or null. Types must match.
 * `configChanges` lists changed config
 * keys, including thresholds, bins, labels and unsafe-label meaning. False-allow
 * deltas are null when dangerous classes differ. Added/removed groups and classes
 * retain both sample sizes and null deltas. No pairing, statistical significance,
 * improvement label, or release verdict is inferred from these differences.
 *
 * @param {BinaryEvaluation|MulticlassEvaluation} baseline
 * @param {BinaryEvaluation|MulticlassEvaluation} candidate
 * @returns {{type: string, baselineTotal: number, candidateTotal: number,
 *   configChanges: string[], deltas: Object<string, ?number>, perClass: object[],
 *   groups: {field: string, value: ?GroupValue, baselineTotal: ?number,
 *   candidateTotal: ?number, deltas: Object<string, ?number>}[]}}
 */
export function compareEvaluations(baseline, candidate) {
  finiteJson(baseline);
  finiteJson(candidate);
  assertEvaluation(baseline);
  assertEvaluation(candidate);
  if (baseline.type !== candidate.type) throw new TypeError("Evaluation types must match.");
  const beforeGroups = new Map((baseline.groups ?? []).map((group) => [groupKey(group), group]));
  const afterGroups = new Map((candidate.groups ?? []).map((group) => [groupKey(group), group]));
  const groupKeys = [...new Set([...beforeGroups.keys(), ...afterGroups.keys()])].sort(order);
  const beforeClasses = new Map((baseline.perClass ?? []).map((entry) => [entry.label, entry]));
  const afterClasses = new Map((candidate.perClass ?? []).map((entry) => [entry.label, entry]));
  const labels = [...new Set([...beforeClasses.keys(), ...afterClasses.keys()])].sort(order);
  return { type: baseline.type, baselineTotal: baseline.total, candidateTotal: candidate.total,
    configChanges: [...new Set([...Object.keys(baseline.config), ...Object.keys(candidate.config)])]
      .filter((key) => JSON.stringify(baseline.config[key]) !== JSON.stringify(candidate.config[key])).sort(order),
    deltas: metricDeltas(baseline, candidate),
    perClass: labels.map((label) => {
      const before = beforeClasses.get(label);
      const after = afterClasses.get(label);
      return { label, baselineSupport: before?.support ?? null, candidateSupport: after?.support ?? null,
        deltas: Object.fromEntries(["precision", "recall", "f1"].map((key) => [key, delta(before?.[key], after?.[key])])) };
    }),
    groups: groupKeys.map((key) => {
      const before = beforeGroups.get(key);
      const after = afterGroups.get(key);
      const { field, value } = after ?? before;
      return { field, value, baselineTotal: before?.evaluation.total ?? null, candidateTotal: after?.evaluation.total ?? null,
        deltas: metricDeltas(before?.evaluation, after?.evaluation) };
    }) };
}

function limits(options, defaults = LIMIT_DEFAULTS) {
  return Object.fromEntries(LIMIT_KEYS.map((key) => {
    const value = options[key] === undefined ? defaults[key] : options[key];
    return [key, LIMIT_COUNTS.has(key) ? integer(value, key, 1) : probability(value, key)];
  }));
}

function releaseConfig(options) {
  allowedKeys(options, [...BINARY_OPTIONS, ...LIMIT_KEYS, "split", "tuningCaseIds", "groupRules"], "release options");
  const split = options.split === undefined ? "holdout" : options.split;
  if (!["holdout", "test"].includes(split)) throw new TypeError("Release split must be holdout or test; tuning data cannot qualify a release.");
  const overallLimits = limits(options);
  const binaryOptions = Object.fromEntries(BINARY_OPTIONS.filter((key) => own(options, key)).map((key) => [key, options[key]]));
  const config = binaryConfig(binaryOptions);
  const tuningIds = options.tuningCaseIds === undefined ? [] : options.tuningCaseIds;
  array(tuningIds, "tuningCaseIds");
  const tuningCaseIds = Array.from(tuningIds, (id) => text(id, "tuningCaseId").trim());
  if (new Set(tuningCaseIds).size !== tuningCaseIds.length) throw new TypeError("tuningCaseIds must be distinct.");
  const rules = options.groupRules === undefined ? [] : options.groupRules;
  array(rules, "groupRules");
  const seen = new Set();
  const groupRules = Array.from(rules, (rule) => {
    allowedKeys(rule, ["field", "value", ...LIMIT_KEYS], "group rule");
    const field = text(rule.field, "group rule field");
    const selector = own(rule, "value") ? { field, value: scalar(rule.value, "group rule value") } : { field };
    const key = JSON.stringify(selector);
    if (seen.has(key)) throw new TypeError("Group rule selectors must be distinct.");
    seen.add(key);
    return { ...selector, ...limits(rule, overallLimits) };
  });
  config.groupBy = [...new Set([...config.groupBy, ...groupRules.map((rule) => rule.field)])];
  return { split, config, overallLimits, tuningCaseIds, groupRules };
}

function check(code, status, scope, observed, limit, message) {
  return { code, status, scope, observed, limit, message };
}

function verdict(checks) {
  if (checks.some((entry) => entry.status === "blocked")) return "blocked";
  if (!checks.length || checks.some((entry) => entry.status === "review")) return "review";
  return "pass";
}

function limitChecks(evaluation, policy, scope) {
  const atLeast = (code, value, limit) => check(code, value >= limit ? "pass" : "review", scope, value, limit,
    value >= limit ? "Sample minimum met." : "More labeled cases are required.");
  const atMost = (code, value, limit, exceeded = "blocked") => check(code,
    value === null ? "review" : value > limit ? exceeded : "pass", scope, value, limit,
    value === null ? "The sample cannot estimate this rate." : value > limit ? "The configured limit is exceeded." : "The configured limit is met.");
  // A useless release is not a safe one. Blocking or reviewing every safe case
  // keeps false allows at zero, so usefulness is checked on its own evidence.
  const atLeastRate = (code, value, limit) => check(code,
    value === null ? "review" : value >= limit ? "pass" : "review", scope, value, limit,
    value === null ? "The sample cannot estimate this rate."
      : value >= limit ? "The configured minimum is met." : "The release does not act usefully often enough to qualify.");
  return [atLeast("min_cases", evaluation.total, policy.minCases),
    atLeast("min_unsafe_cases", evaluation.safety?.unsafeCases ?? 0, policy.minUnsafeCases),
    atLeast("min_safe_cases", evaluation.safety?.safeCases ?? 0, policy.minSafeCases),
    atMost("false_allow_rate", evaluation.safety?.falseAllowRate ?? null, policy.maxFalseAllowRate),
    atMost("false_allow_upper_bound", evaluation.safety?.falseAllowInterval.upper ?? null, policy.maxFalseAllowRate, "review"),
    atMost("false_block_rate", evaluation.safety?.falseBlockRate ?? null, policy.maxFalseBlockRate, "review"),
    atLeastRate("safe_allow_rate", evaluation.safety?.safeAllowRate ?? null, policy.minSafeAllowRate),
    atMost("ece", evaluation.metrics.ece, policy.maxEce), atMost("review_rate", evaluation.decisions.reviewRate, policy.maxReviewRate)];
}

/**
 * Qualify an already fixed binary policy on explicitly labeled held-out cases.
 * Every supplied case needs an own string `caseId` (remappable) and `split`.
 * IDs must be distinct across ALL supplied splits after trimming whitespace.
 * Only `split: "holdout"` (default) or `split: "test"` may be selected. Other
 * split rows are excluded from metrics but their IDs/provenance are checked.
 * Selected rows require expected, probability and explicit allow/review/block.
 * `usedForTuning: true` or overlap with `tuningCaseIds` blocks qualification.
 * Supply the tuning ID ledger even when those cases are not in this array.
 *
 * Options include evaluateBinary options plus required-for-pass `unsafeLabel`,
 * `split`, `tuningCaseIds` (default []), and these defaults:
 * minCases=100, minUnsafeCases=30, minSafeCases=30, maxFalseAllowRate=.05,
 * maxFalseBlockRate=.25, minSafeAllowRate=.5, maxEce=.1, maxReviewRate=.25.
 * Case minima must be positive integers; every rate must be finite [0,1].
 * Safety and usefulness are separate requirements: a policy that blocks or
 * reviews every safe case has no false allows and still cannot qualify,
 * because falseBlockRate and safeAllowRate are checked on the safe cases.
 * Unknown/malformed options throw. Invalid case data returns a blocked report
 * with evaluation=null; samples are never silently cleaned to earn a pass.
 *
 * Status precedence: blocked > review > pass. Observed cap breaches and invalid
 * data block; missing samples, missing configured groups, or a Wilson upper
 * endpoint above maxFalseAllowRate require review. Both the observed rate AND
 * the upper endpoint must meet the cap to pass. No cases or no unsafe cases can
 * never pass. Even zero errors leave uncertainty about the false-allow rate.
 *
 * `groupRules` is an array of {field, value?, ...limitOverrides}. Omit value to
 * gate every observed value of that field. Supply a
 * value to require that exact group. Each rule inherits overall limits and all
 * matching rules apply. Rule
 * fields are always included even when groupBy=[]; missing metadata for any
 * configured field requires review. Overall success cannot hide
 * an enforced group breach. Unconfigured groups have status=null and no checks.
 * Absent required groups get empty summaries and review status.
 *
 * The caller supplies trustworthy labels, split declarations and tuning IDs.
 * Hidden tuning, relabeled duplicates, and related examples cannot be detected
 * from IDs alone. Freeze thresholds and policy before observing this split.
 * Wilson assumes independent representative unsafe cases; bounds are pointwise,
 * with no multiple-group adjustment. Passing these checks is sample evidence,
 * not proof of safety, calibrated future probabilities, or zero error.
 *
 * @param {(BinaryRow & {caseId: string, split: string, usedForTuning?: boolean})[]} cases
 * @param {{split?: "holdout"|"test", fields?: object, bins?: number, threshold?: number,
 *   thresholds?: number[], unsafeLabel?: BinaryLabel, groupBy?: string[],
 *   tuningCaseIds?: string[], minCases?: number, minUnsafeCases?: number,
 *   minSafeCases?: number, maxFalseAllowRate?: number, maxFalseBlockRate?: number,
 *   minSafeAllowRate?: number, maxEce?: number, maxReviewRate?: number,
 *   groupRules?: {field: string, value?: GroupValue, minCases?: number,
 *   minUnsafeCases?: number, minSafeCases?: number, maxFalseAllowRate?: number,
 *   maxFalseBlockRate?: number, minSafeAllowRate?: number, maxEce?: number,
 *   maxReviewRate?: number}[]}} [options]
 * @returns {{status: "blocked"|"review"|"pass", split: string,
 *   counts: {supplied: number, selected: number, excluded: number}, policy: object,
 *   evaluation: ?BinaryEvaluation, checks: {code: string, status: string,
 *   scope: string|object, observed: *, limit: *, message: string}[],
 *   groups: object[], notes: string[]}}
 * @example
 * qualifyRelease(cases, { unsafeLabel: true, tuningCaseIds: ["tune-1"],
 *   groupRules: [{ field: "dialect" }, { field: "model", value: "jev-v1" }] });
 */
export function qualifyRelease(cases, options = {}) {
  array(cases, "cases");
  const { split, config, overallLimits, tuningCaseIds, groupRules } = releaseConfig(options);
  const checks = [];
  const selected = [];
  const seen = new Set();
  const tuning = new Set(tuningCaseIds);
  let validData = true;
  const invalid = (code, message, index = null) => {
    validData = false;
    checks.push({ ...check(code, "blocked", "overall", null, null, message), caseIndex: index });
  };
  if (config.unsafeLabel === null) checks.push(check("unsafe_label_required", "blocked", "overall", null, null, "Declare the dangerous expected label explicitly."));
  for (const [index, row] of cases.entries()) {
    try {
      object(row, `case[${index}]`);
      const isSelected = own(row, "split") && row.split === split;
      if (isSelected) selected.push(row);
      const id = text(required(row, config.fields.caseId, `case[${index}]`), "caseId").trim();
      const rowSplit = own(row, "split") ? row.split : null;
      if (typeof rowSplit !== "string" || !rowSplit.trim() || rowSplit !== rowSplit.trim()) {
        invalid("invalid_split", "Case split must be a nonempty string without surrounding whitespace.", index);
        continue;
      }
      if (seen.has(id)) invalid("duplicate_case_id", "Case IDs must be distinct across all supplied splits.", index);
      seen.add(id);
      if (own(row, "usedForTuning") && typeof row.usedForTuning !== "boolean") throw new TypeError("usedForTuning must be boolean.");
      if (isSelected && ((own(row, "usedForTuning") && row.usedForTuning === true) || tuning.has(id))) invalid("tuning_overlap", "Selected case was declared as used for tuning.", index);
      if (isSelected && (!own(row, config.fields.decision) || row[config.fields.decision] === undefined)) {
        invalid("missing_decisions", "Every selected case needs an explicit decision.", index);
      }
    } catch (error) {
      invalid("invalid_case", error.message, index);
    }
  }
  let evaluation = null;
  if (validData) {
    try {
      const samples = binarySamples(selected, config);
      evaluation = { ...binarySummary(samples, config), groups: groupSummaries(samples, config, binarySummary, groupRules.map((rule) => rule.field)) };
    } catch (error) {
      invalid("invalid_case", error.message);
    }
  }
  const groups = (evaluation?.groups ?? []).map((group) => ({ ...group, status: null, checks: [] }));
  if (evaluation) {
    checks.push(...limitChecks(evaluation, overallLimits, "overall"));
    const configuredFields = new Set(groupRules.map((rule) => rule.field));
    for (const group of groups) {
      if (group.value !== null || !group.evaluation.total || !configuredFields.has(group.field)) continue;
      const missing = check("missing_group_metadata", "review", { field: group.field, value: null },
        group.evaluation.total, null, "Selected cases lack configured group metadata.");
      group.checks.push(missing);
      group.status = "review";
      checks.push(missing);
    }
    for (const rule of groupRules) {
      let matches = groups.filter((group) => group.field === rule.field && (!own(rule, "value") || JSON.stringify(group.value) === JSON.stringify(rule.value)));
      if (!matches.length) {
        const missing = { field: rule.field, value: own(rule, "value") ? rule.value : null,
          evaluation: binarySummary([], config), status: null, checks: [] };
        groups.push(missing);
        matches = [missing];
      }
      for (const group of matches) {
        const scope = { field: group.field, value: group.value };
        const added = limitChecks(group.evaluation, rule, scope);
        if (group.evaluation.total === 0) added.unshift(check("missing_group", "review", scope, 0, rule.minCases, "Required group has no labeled selected cases."));
        group.checks.push(...added);
        group.status = verdict(group.checks);
        checks.push(...added);
      }
    }
  }
  return { status: verdict(checks), split,
    counts: { supplied: cases.length, selected: selected.length, excluded: cases.length - selected.length },
    policy: { ...config, ...overallLimits, split, tuningCaseIds, groupRules }, evaluation, checks, groups,
    notes: ["Qualification uses supplied labels, split declarations and tuning IDs; undisclosed reuse cannot be detected.",
      "Wilson intervals assume independent representative cases; bounds are pointwise and not adjusted for multiple groups.",
      "A pass meets the configured checks on supplied cases and does not guarantee future accuracy or zero risk."] };
}
