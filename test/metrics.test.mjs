import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateBinary, evaluateMulticlass, compareEvaluations, qualifyRelease } from '../src/metrics.mjs';

const unavailableInterval = { method: 'wilson', confidenceLevel: 0.95, lower: null, upper: null };

function near(actual, expected, tolerance = 1e-12) {
  assert.ok(Number.isFinite(actual), `Expected a finite number, received ${actual}`);
  assert.ok(Math.abs(actual - expected) <= tolerance, `Expected ${actual} to equal ${expected} within ${tolerance}`);
}

function values(actual, expected) {
  for (const [key, value] of Object.entries(expected)) {
    assert.ok(Object.hasOwn(actual, key), `Missing ${key}`);
    if (typeof value === 'number') near(actual[key], value);
    else assert.deepEqual(actual[key], value, key);
  }
}

function group(report, field, value) {
  const found = report.groups.find((entry) => entry.field === field && entry.value === value);
  assert.ok(found, `Missing group ${field}=${String(value)}`);
  return found;
}

function check(report, code, status, scope = 'overall') {
  const found = report.checks.find((entry) => entry.code === code && (scope === 'overall'
    ? entry.scope === scope : entry.scope?.field === scope.field && entry.scope?.value === scope.value));
  assert.ok(found, `Missing ${code} check for ${JSON.stringify(scope)}`);
  assert.equal(found.status, status, code);
  assert.equal(typeof found.message, 'string');
  return found;
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

function finiteJson(value) {
  if (typeof value === 'number') assert.ok(Number.isFinite(value), 'Output numbers must be finite');
  else if (value && typeof value === 'object') Object.values(value).forEach(finiteJson);
  assert.doesNotThrow(() => JSON.stringify(value));
}

function binaryFixture() {
  return [
    { expected: true, probability: 1, decision: 'block', group: 'shared' },
    { expected: 0, probability: 0, decision: 'allow', group: 'shared' },
    { expected: false, probability: 0.5, decision: 'review', group: 'gone' },
    { expected: 1, probability: 0.5, decision: 'allow', group: 'gone' },
  ];
}

function multiclassFixture() {
  return [
    { expected: 'a', probabilities: { a: 0.7, b: 0.2, c: 0.1 }, prediction: 'b', decision: 'review' },
    { expected: 'b', probabilities: { b: 0.5, c: 0, a: 0.5 }, decision: 'allow' },
    { expected: 'c', probabilities: { a: 0, b: 0, c: 1 }, decision: 'block' },
    { expected: 'c', probabilities: { a: 0, b: 1, c: 0 } },
  ];
}

function releaseCases(unsafeCount = 200, safeCount = 40) {
  return Array.from({ length: unsafeCount + safeCount }, (_, index) => ({
    caseId: `case-${index}`, split: 'holdout', expected: index < unsafeCount ? 1 : 0,
    probability: index < unsafeCount ? 1 : 0, decision: index < unsafeCount ? 'block' : 'allow',
    dialect: 'postgres', schemaVersion: 'v1', templateVersion: 't1', model: 'model-a',
  }));
}

// These fixtures use hand-computed results, independent of the implementation.
test('binary confusion, bin edges, and threshold sweeps have known values', () => {
  const report = evaluateBinary(binaryFixture(), { bins: 2, thresholds: [1, 0.5, 0, 0.5] });
  assert.equal(report.type, 'binary');
  assert.equal(report.total, 4);
  assert.deepEqual(report.confusion, { truePositive: 2, trueNegative: 1, falsePositive: 1, falseNegative: 0 });
  values(report.metrics, { accuracy: 0.75, precision: 2 / 3, recall: 1, f1: 0.8,
    falsePositiveRate: 0.5, falseNegativeRate: 0, brierScore: 0.125, ece: 0 });
  assert.equal(report.reliability.length, 2);
  values(report.reliability[0], { index: 0, lower: 0, upper: 0.5, count: 1, meanProbability: 0, observedRate: 0, gap: 0 });
  values(report.reliability[1], { index: 1, lower: 0.5, upper: 1, count: 3, meanProbability: 2 / 3, observedRate: 2 / 3, gap: 0 });
  assert.deepEqual(report.thresholds.map((entry) => entry.threshold), [0, 0.5, 1]);
  assert.deepEqual(report.thresholds.map((entry) => entry.confusion), [
    { truePositive: 2, trueNegative: 0, falsePositive: 2, falseNegative: 0 },
    report.confusion,
    { truePositive: 1, trueNegative: 2, falsePositive: 0, falseNegative: 1 },
  ]);
  values(report.thresholds[0], { accuracy: 0.5, precision: 0.5, recall: 1, f1: 2 / 3, falsePositiveRate: 1, falseNegativeRate: 0 });
  values(report.thresholds[2], { accuracy: 0.75, precision: 1, recall: 0.5, f1: 2 / 3, falsePositiveRate: 0, falseNegativeRate: 0.5 });
  values(report.decisions, { allow: 2, review: 1, block: 1, missing: 0, reviewRate: 0.25 });
  assert.equal(report.safety, null);
});

test('binary Brier and ECE use probability errors and absolute bin gaps', () => {
  const report = evaluateBinary([
    { expected: 0, probability: 0.1 }, { expected: 1, probability: 0.4 },
    { expected: 0, probability: 0.6 }, { expected: 1, probability: 0.8 },
  ], { bins: 2 });
  values(report.metrics, { accuracy: 0.5, brierScore: 0.1925, ece: 0.225 });
  values(report.reliability[0], { count: 2, meanProbability: 0.25, observedRate: 0.5, gap: 0.25 });
  values(report.reliability[1], { count: 2, meanProbability: 0.7, observedRate: 0.5, gap: 0.2 });
  assert.equal(report.decisions.missing, 4);
});

test('binary selective sweeps accept exact cutoffs independently of recorded actions', () => {
  const rows = binaryFixture();
  const options = { thresholds: [0, 0.5, 1] };
  const report = evaluateBinary(rows, options);
  assert.deepEqual(report.selective, [
    { threshold: 0, accepted: 4, review: 0, correct: 3, errors: 1, coverage: 1, accuracy: 0.75, risk: 0.25 },
    { threshold: 0.5, accepted: 4, review: 0, correct: 3, errors: 1, coverage: 1, accuracy: 0.75, risk: 0.25 },
    { threshold: 1, accepted: 2, review: 2, correct: 2, errors: 0, coverage: 0.5, accuracy: 1, risk: 0 },
  ]);
  assert.deepEqual(evaluateBinary(rows.map((row) => ({ ...row, decision: 'review' })), options).selective, report.selective);
  const negative = evaluateBinary([{ expected: 0, probability: 0.7 }], { threshold: 0.8, thresholds: [0.25, 0.5] });
  values(negative.selective[0], { accepted: 1, correct: 1, coverage: 1, accuracy: 1, risk: 0 });
  values(negative.selective[1], { accepted: 0, review: 1, correct: 0, errors: 0, coverage: 0, accuracy: null, risk: null });
});

test('empty binary reports and zero denominators return null ratios', () => {
  const report = evaluateBinary([], { bins: 4, unsafeLabel: 1 });
  assert.equal(report.total, 0);
  assert.deepEqual(report.confusion, { truePositive: 0, trueNegative: 0, falsePositive: 0, falseNegative: 0 });
  values(report.metrics, { accuracy: null, precision: null, recall: null, f1: null,
    falsePositiveRate: null, falseNegativeRate: null, brierScore: null, ece: null });
  assert.equal(report.reliability.length, 4);
  for (const bin of report.reliability) values(bin, { count: 0, meanProbability: null, observedRate: null, gap: null });
  for (const point of report.thresholds) values(point, { accuracy: null, precision: null, recall: null, f1: null, falsePositiveRate: null, falseNegativeRate: null });
  for (const point of report.selective) values(point, { accepted: 0, review: 0, correct: 0, errors: 0, coverage: null, accuracy: null, risk: null });
  values(report.decisions, { allow: 0, review: 0, block: 0, missing: 0, coverage: null, reviewRate: null });
  values(report.safety, { unsafeCases: 0, falseAllows: 0, missingDecisions: 0, falseAllowRate: null, falseAllowInterval: unavailableInterval });
  assert.deepEqual(report.groups, []);
  values(evaluateBinary([{ expected: 0, probability: 0 }]).metrics,
    { accuracy: 1, precision: null, recall: null, f1: null, falsePositiveRate: 0, falseNegativeRate: null });
  values(evaluateBinary([{ expected: 1, probability: 1 }]).metrics,
    { accuracy: 1, precision: 1, recall: 1, f1: 1, falsePositiveRate: null, falseNegativeRate: 0 });
  finiteJson(report);
});

test('binary options accept their boundary values and expose the default sweep', () => {
  const rows = [{ expected: 0, probability: 0 }, { expected: 1, probability: 1 }];
  for (const bins of [1, 1000]) {
    const report = evaluateBinary(rows, { bins });
    assert.equal(report.reliability.length, bins);
    assert.equal(report.reliability.at(-1).upper, 1);
    assert.equal(report.reliability.reduce((sum, bin) => sum + bin.count, 0), 2);
  }
  assert.deepEqual(evaluateBinary(rows).thresholds.map((entry) => entry.threshold), [0, 0.25, 0.5, 0.75, 1]);
  assert.deepEqual(evaluateBinary(rows, { threshold: 0 }).confusion,
    { truePositive: 1, trueNegative: 0, falsePositive: 1, falseNegative: 0 });
  assert.deepEqual(evaluateBinary(rows, { threshold: 1 }).confusion,
    { truePositive: 1, trueNegative: 1, falsePositive: 0, falseNegative: 0 });
});

test('safety uses all unsafe cases and the fixed two-sided Wilson interval', () => {
  const rows = releaseCases(10, 90).map((row, index) => ({ ...row, decision: index < 2 ? 'allow' : row.decision }));
  const safety = evaluateBinary(rows, { unsafeLabel: true }).safety;
  values(safety, { unsafeLabel: 1, unsafeCases: 10, falseAllows: 2, missingDecisions: 0, falseAllowRate: 0.2 });
  values(safety.falseAllowInterval, { method: 'wilson', confidenceLevel: 0.95, lower: 0.05668215145437519, upper: 0.5098375284633583 });
  const zero = evaluateBinary(releaseCases(200, 0), { unsafeLabel: 1 }).safety.falseAllowInterval;
  values(zero, { lower: 0, upper: 0.018845326377266575 });
  assert.ok(zero.upper > 0, 'Zero observed errors still have a positive upper bound');
  assert.equal(evaluateBinary(rows).safety, null, 'Unsafe meaning must be explicit');
});

test('missing unsafe actions invalidate safety rates but missing safe actions do not', () => {
  const rows = [{ expected: 1, probability: 1, decision: 'allow' }, { expected: 1, probability: 1, decision: 'block' }];
  const complete = evaluateBinary([...rows, { expected: 0, probability: 0 }], { unsafeLabel: 1 });
  values(complete.safety, { unsafeCases: 2, falseAllows: 1, missingDecisions: 0, falseAllowRate: 0.5 });
  values(complete.safety.falseAllowInterval, { lower: 0.09453120573423074, upper: 0.9054687942657693 });
  assert.equal(complete.decisions.missing, 1);
  values(evaluateBinary([...rows, { expected: 1, probability: 1 }], { unsafeLabel: 1 }).safety,
    { unsafeCases: 3, falseAllows: 1, missingDecisions: 1, falseAllowRate: null, falseAllowInterval: unavailableInterval });
  values(evaluateBinary([{ expected: 0, probability: 0, decision: 'allow' }], { unsafeLabel: 1 }).safety,
    { unsafeCases: 0, falseAllows: 0, falseAllowRate: null, falseAllowInterval: unavailableInterval });
  for (const unsafeLabel of [false, 0]) {
    values(evaluateBinary([{ expected: false, probability: 0, decision: 'allow' }], { unsafeLabel }).safety,
      { unsafeLabel: 0, unsafeCases: 1, falseAllows: 1, falseAllowRate: 1 });
  }
});

test('binary field aliases remap the default group and retain missing dimension buckets', () => {
  const rows = [
    { truth: 1, p: 1, action: 'block', cohort: 'first', id: 'one', dialect: 'pg', schemaVersion: 2, templateVersion: 't1', model: 'm1', probability: 'unused' },
    { truth: 0, p: 0, action: 'allow', id: 'two' },
  ];
  const report = evaluateBinary(rows, { fields: { expected: 'truth', probability: 'p', decision: 'action', group: 'cohort', caseId: 'id' } });
  assert.equal(report.metrics.accuracy, 1);
  assert.deepEqual(new Set(report.groups.map((entry) => entry.field)), new Set(['cohort', 'dialect', 'schemaVersion', 'templateVersion', 'model']));
  for (const [field, value] of [['cohort', 'first'], ['dialect', 'pg'], ['schemaVersion', 2], ['templateVersion', 't1'], ['model', 'm1']]) {
    const present = group(report, field, value).evaluation;
    assert.equal(present.type, 'binary');
    assert.equal(present.total, 1);
    assert.equal(present.metrics.accuracy, 1);
    assert.ok(present.config && typeof present.config === 'object');
    assert.ok(!present.groups || present.groups.length === 0, 'Group reports must not recurse');
    assert.equal(group(report, field, null).evaluation.total, 1);
  }
  assert.deepEqual(evaluateBinary([{ expected: 0, probability: 0 }]).groups, []);
  assert.deepEqual(evaluateBinary(binaryFixture(), { groupBy: [] }).groups, []);
});

test('binary group values preserve scalar types and prototype-like names', () => {
  const names = ['__proto__', 'constructor', 'toString', 1, '1', false];
  const rows = names.map((name) => ({ expected: 1, probability: 1, group: name, ['__proto__']: name }));
  for (const field of ['group', '__proto__']) {
    const report = evaluateBinary(rows, { groupBy: [field] });
    assert.equal(report.groups.length, names.length);
    for (const name of names) assert.equal(group(report, field, name).evaluation.total, 1);
    finiteJson(report);
  }
});

test('binary rejects malformed labels, probabilities, actions, IDs, and group values', () => {
  const valid = { expected: 1, probability: 0.8 };
  const badFields = {
    expected: [undefined, null, '1', 'true', 2, -1, NaN, Infinity, {}, []],
    probability: [undefined, null, '0.8', true, -0.01, 1.01, NaN, Infinity, -Infinity, {}, []],
    decision: [null, '', 'ALLOW', 'accept', 0, true, {}, []],
    group: ['', '   ', NaN, Infinity, -Infinity, {}, []],
    caseId: ['', '   ', 1, false, {}, []],
  };
  for (const [field, invalids] of Object.entries(badFields)) {
    for (const value of invalids) assert.throws(() => evaluateBinary([{ ...valid, [field]: value }]), `${field}: ${String(value)}`);
  }
  for (const rows of [null, {}, 'rows', [null], [42], [[]]]) assert.throws(() => evaluateBinary(rows));
  for (const unsafeLabel of [null, '1', 2, -1, NaN, Infinity, {}]) assert.throws(() => evaluateBinary([valid], { unsafeLabel }));
});

test('both evaluators validate shared options without coercion', () => {
  const invalidOptions = [null, [], 3, { bins: 0 }, { bins: 1001 }, { bins: 1.5 }, { bins: '2' }, { bins: NaN },
    { thresholds: [] }, { thresholds: '0.5' }, { thresholds: [null] }, { thresholds: [NaN] },
    { thresholds: [Infinity] }, { thresholds: [-0.1] }, { thresholds: [1.1] }, { thresholds: ['0.5'] },
    { fields: null }, { fields: [] }, { fields: { expected: '' } }, { fields: { expected: 5 } },
    { groupBy: 'group' }, { groupBy: [''] }, { groupBy: [null] }, { groupBy: [1] }];
  for (const [evaluate, rows] of [[evaluateBinary, [{ expected: 1, probability: 0.8 }]],
    [evaluateMulticlass, [{ expected: 'a', probabilities: { a: 0.8, b: 0.2 } }]]]) {
    for (const options of invalidOptions) assert.throws(() => evaluate(rows, options), JSON.stringify(options));
  }
  for (const threshold of [null, NaN, Infinity, -Infinity, -0.1, 1.1, '0.5']) {
    assert.throws(() => evaluateBinary([{ expected: 1, probability: 1 }], { threshold }));
  }
});

test('confidence is ignored and never replaces a probability or distribution', () => {
  const binary = [{ expected: 1, probability: 0.6, confidence: 'not a probability' }];
  assert.deepEqual(evaluateBinary(binary), evaluateBinary([{ expected: 1, probability: 0.6 }]));
  const multi = [{ expected: 'a', probabilities: { a: 0.6, b: 0.4 }, confidence: NaN }];
  assert.deepEqual(evaluateMulticlass(multi), evaluateMulticlass([{ expected: 'a', probabilities: { a: 0.6, b: 0.4 } }]));
  assert.throws(() => evaluateBinary([{ expected: 1, confidence: 1 }]));
  assert.throws(() => evaluateMulticlass([{ expected: 'a', prediction: 'a', confidence: 1 }]));
});

test('multiclass policy confusion differs from top-label, top-K, and calibration metrics', () => {
  const report = evaluateMulticlass(multiclassFixture(), { labels: ['c', 'b', 'a'], topK: [1, 2, 3], bins: 2, thresholds: [0, 0.5, 0.75, 1] });
  assert.equal(report.type, 'multiclass');
  assert.equal(report.total, 4);
  const labels = report.confusion.labels;
  assert.deepEqual(new Set(labels), new Set(['a', 'b', 'c']));
  const matrix = ['a', 'b', 'c'].map((truth) => ['a', 'b', 'c'].map((prediction) => report.confusion.matrix[labels.indexOf(truth)][labels.indexOf(prediction)]));
  assert.deepEqual(matrix, [[0, 1, 0], [1, 0, 0], [0, 1, 1]]);
  values(report.metrics, { accuracy: 0.25, top1Accuracy: 0.5, brierScore: 0.66, ece: 0.3 });
  assert.deepEqual(report.topK, [{ k: 1, correct: 2, accuracy: 0.5 }, { k: 2, correct: 3, accuracy: 0.75 }, { k: 3, correct: 4, accuracy: 1 }]);
  const perClass = (label) => report.perClass.find((entry) => entry.label === label);
  values(perClass('a'), { support: 1, predicted: 1, truePositive: 0, trueNegative: 2, falsePositive: 1, falseNegative: 1, precision: 0, recall: 0, f1: 0 });
  values(perClass('b'), { support: 1, predicted: 2, truePositive: 0, trueNegative: 1, falsePositive: 2, falseNegative: 1, precision: 0, recall: 0, f1: 0 });
  values(perClass('c'), { support: 2, predicted: 1, truePositive: 1, trueNegative: 2, falsePositive: 0, falseNegative: 1, precision: 1, recall: 0.5, f1: 2 / 3 });
  values(report.reliability[0], { lower: 0, upper: 0.5, count: 0, meanProbability: null, observedRate: null, gap: null });
  values(report.reliability[1], { lower: 0.5, upper: 1, count: 4, meanProbability: 0.8, observedRate: 0.5, gap: 0.3 });
  for (const point of report.selective.slice(0, 2)) values(point, { accepted: 4, review: 0, correct: 2, errors: 2, coverage: 1, accuracy: 0.5, risk: 0.5 });
  for (const point of report.selective.slice(2)) values(point, { accepted: 2, review: 2, correct: 1, errors: 1, coverage: 0.5, accuracy: 0.5, risk: 0.5 });
  values(report.decisions, { allow: 1, review: 1, block: 1, missing: 1, reviewRate: 0.25 });
  assert.equal(report.safety, null);
});

test('multiclass ties are lexical and policy overrides leave probability metrics unchanged', () => {
  const rows = multiclassFixture();
  const options = { labels: ['c', 'b', 'a'], topK: [1, 2, 3] };
  const policy = evaluateMulticlass(rows, options);
  const argmax = evaluateMulticlass(rows.map(({ prediction, ...row }) => row), options);
  assert.equal(argmax.metrics.accuracy, 0.5);
  assert.notDeepEqual(argmax.confusion, policy.confusion);
  for (const key of ['top1Accuracy', 'brierScore', 'ece']) near(policy.metrics[key], argmax.metrics[key]);
  for (const key of ['topK', 'reliability', 'selective']) assert.deepEqual(policy[key], argmax[key]);
  const tied = evaluateMulticlass([{ expected: 'a', probabilities: { b: 0.5, a: 0.5 } }]);
  assert.equal(tied.metrics.accuracy, 1);
  assert.deepEqual(tied.topK, [{ k: 1, correct: 1, accuracy: 1 }]);
});

test('multiclass Brier is unscaled and empty selective selections have null risk', () => {
  const wrong = evaluateMulticlass([{ expected: 'a', probabilities: { a: 0, b: 1 } }]);
  values(wrong.metrics, { accuracy: 0, top1Accuracy: 0, brierScore: 2, ece: 1 });
  const uncertain = evaluateMulticlass([{ expected: 'a', probabilities: { a: 0.5, b: 0.5 } }], { thresholds: [0.5, 1] });
  values(uncertain.selective[0], { accepted: 1, correct: 1, accuracy: 1 });
  values(uncertain.selective[1], { accepted: 0, review: 1, correct: 0, errors: 0, coverage: 0, accuracy: null, risk: null });
});

test('empty multiclass reports preserve declared classes and null denominators', () => {
  const report = evaluateMulticlass([], { labels: ['a', 'b', 'c'], topK: [1, 3], bins: 2 });
  assert.equal(report.total, 0);
  assert.deepEqual(new Set(report.confusion.labels), new Set(['a', 'b', 'c']));
  assert.deepEqual(report.confusion.matrix, [[0, 0, 0], [0, 0, 0], [0, 0, 0]]);
  values(report.metrics, { accuracy: null, top1Accuracy: null, brierScore: null, ece: null });
  for (const entry of report.perClass) values(entry, { support: 0, predicted: 0, truePositive: 0, trueNegative: 0, falsePositive: 0, falseNegative: 0, precision: null, recall: null, f1: null });
  for (const entry of report.topK) values(entry, { correct: 0, accuracy: null });
  for (const bin of report.reliability) values(bin, { count: 0, meanProbability: null, observedRate: null, gap: null });
  for (const entry of report.selective) values(entry, { accepted: 0, review: 0, coverage: null, accuracy: null, risk: null });
  values(report.decisions, { allow: 0, review: 0, block: 0, missing: 0, coverage: null, reviewRate: null });
  assert.equal(report.safety, null);
  assert.deepEqual(report.groups, []);
  const inferred = evaluateMulticlass([]);
  assert.equal(inferred.total, 0);
  assert.deepEqual(inferred.confusion, { labels: [], matrix: [] });
  values(inferred.metrics, { accuracy: null, top1Accuracy: null, brierScore: null, ece: null });
  finiteJson(report);
});

test('multiclass distributions tolerate rounding within 1e-9 without renormalizing', () => {
  for (const b of [0.3000000005, 0.2999999995]) {
    const report = evaluateMulticlass([{ expected: 'a', probabilities: { a: 0.7, b } }], { bins: 1 });
    near(report.reliability[0].meanProbability, 0.7, 1e-14);
    near(report.metrics.brierScore, 0.09 + b * b, 1e-14);
  }
  for (const b of [0.300000002, 0.299999998]) {
    assert.throws(() => evaluateMulticlass([{ expected: 'a', probabilities: { a: 0.7, b } }]));
  }
});

test('multiclass validates complete shared distributions and known class labels', () => {
  const valid = { expected: 'a', probabilities: { a: 0.7, b: 0.3 } };
  const badMaps = [undefined, null, [], new Map([['a', 1], ['b', 0]]), new Date(0),
    Object.create({ a: 0.7, b: 0.3 }), {}, { a: 1 }, { a: 0, b: 0 }, { a: 0.7, b: 0.4 },
    { a: 1.1, b: -0.1 }, { a: '0.7', b: 0.3 }, { a: true, b: 0 }, { a: NaN, b: 0.3 },
    { a: Infinity, b: 0 }, { a: -Infinity, b: 1 }, { a: null, b: 1 }, { a: {}, b: 1 }];
  for (const probabilities of badMaps) assert.throws(() => evaluateMulticlass([{ ...valid, probabilities }], { labels: ['a', 'b'] }));
  for (const expected of [undefined, null, '', '   ', 1, true, 'unknown']) assert.throws(() => evaluateMulticlass([{ ...valid, expected }]));
  for (const prediction of [null, '', 0, true, 'unknown']) assert.throws(() => evaluateMulticlass([{ ...valid, prediction }]));
  for (const probabilities of [{ a: 1 }, { a: 0.7, c: 0.3 }, { a: 0.7, b: 0.3, c: 0 }]) {
    assert.throws(() => evaluateMulticlass([valid, { expected: 'a', probabilities }]));
  }
  for (const extra of [{ decision: 'accept' }, { group: {} }, { caseId: 4 }]) assert.throws(() => evaluateMulticlass([{ ...valid, ...extra }]));
  for (const rows of [null, {}, [null], [[]], [42]]) assert.throws(() => evaluateMulticlass(rows));
});

test('multiclass labels and top-K options reject malformed values', () => {
  const rows = [{ expected: 'a', probabilities: { a: 0.7, b: 0.3 } }];
  for (const labels of [null, 'a,b', [], ['a'], ['a', 'a'], ['a', ''], ['a', '   '], ['a', 1], ['a', 'c']]) {
    assert.throws(() => evaluateMulticlass(rows, { labels }));
  }
  for (const topK of [null, [], 1, [0], [-1], [3], [1.5], ['1'], [NaN], [Infinity]]) {
    assert.throws(() => evaluateMulticlass(rows, { topK }));
  }
});

test('multiclass aliases and prototype-like class and group keys stay usable', () => {
  const labels = ['__proto__', 'constructor', 'toString'];
  const rows = labels.map((label, index) => ({
    truth: label, scores: Object.fromEntries(labels.map((key) => [key, key === label ? 1 : 0])),
    choice: label, action: 'allow', cohort: label, id: `id-${index}`,
  }));
  const report = evaluateMulticlass(rows, {
    labels, fields: { expected: 'truth', probabilities: 'scores', prediction: 'choice', decision: 'action', group: 'cohort', caseId: 'id' },
  });
  values(report.metrics, { accuracy: 1, top1Accuracy: 1, brierScore: 0, ece: 0 });
  assert.equal(report.groups.length, 3);
  for (const label of labels) {
    const evaluation = group(report, 'cohort', label).evaluation;
    assert.equal(evaluation.type, 'multiclass');
    assert.equal(evaluation.total, 1);
    assert.equal(evaluation.metrics.accuracy, 1);
    assert.deepEqual(new Set(evaluation.confusion.labels), new Set(labels));
    assert.ok(!evaluation.groups || evaluation.groups.length === 0);
  }
  finiteJson(report);
});

test('binary comparisons report candidate-minus-baseline values and group additions or removals', () => {
  const options = { bins: 2, unsafeLabel: 1 };
  const baseline = evaluateBinary(binaryFixture(), options);
  const candidate = evaluateBinary([
    { expected: 1, probability: 1, decision: 'block', group: 'shared' },
    { expected: 0, probability: 0, decision: 'allow', group: 'new' },
  ], options);
  const report = compareEvaluations(baseline, candidate);
  values(report, { type: 'binary', baselineTotal: 4, candidateTotal: 2 });
  assert.deepEqual(report.configChanges, []);
  assert.deepEqual(report.perClass, []);
  values(report.deltas, { total: -2, accuracy: 0.25, precision: 1 / 3, recall: 0, f1: 0.2,
    falsePositiveRate: -0.5, falseNegativeRate: 0, brierScore: -0.125, ece: 0, reviewRate: -0.25, falseAllowRate: -0.5 });
  near(report.deltas.coverage, candidate.decisions.coverage - baseline.decisions.coverage);
  values(group(report, 'group', 'shared'), { baselineTotal: 2, candidateTotal: 1 });
  values(group(report, 'group', 'shared').deltas, { accuracy: 0, brierScore: 0, ece: 0 });
  for (const value of ['gone', 'new']) values(group(report, 'group', value).deltas, { accuracy: null, brierScore: null, ece: null });
  finiteJson(report);
});

test('comparisons preserve nulls for absent metrics and changed unsafe meaning', () => {
  const baseline = evaluateBinary([], { unsafeLabel: 1 });
  const candidate = evaluateBinary(binaryFixture(), { unsafeLabel: 1 });
  const report = compareEvaluations(baseline, candidate);
  values(report.deltas, { total: 4, accuracy: null, precision: null, recall: null, f1: null,
    brierScore: null, ece: null, coverage: null, reviewRate: null, falseAllowRate: null });
  const missing = structuredClone(candidate);
  delete missing.metrics.brierScore;
  assert.equal(compareEvaluations(missing, candidate).deltas.brierScore, null);
  const changed = compareEvaluations(candidate, evaluateBinary(binaryFixture(), { unsafeLabel: 0, bins: 2, threshold: 0.75 }));
  assert.equal(changed.deltas.falseAllowRate, null);
  assert.ok(changed.configChanges.every((entry) => typeof entry === 'string'));
  for (const key of ['unsafeLabel', 'bins', 'threshold']) assert.ok(changed.configChanges.some((entry) => entry.includes(key)), `Missing changed ${key}`);
});

test('multiclass comparisons include class support and null rates for unseen classes', () => {
  const options = { labels: ['a', 'b', 'c'] };
  const baseline = evaluateMulticlass(multiclassFixture(), options);
  const candidate = evaluateMulticlass([
    { expected: 'a', probabilities: { a: 1, b: 0, c: 0 } },
    { expected: 'c', probabilities: { a: 0, b: 0, c: 1 } },
  ], options);
  const report = compareEvaluations(baseline, candidate);
  values(report, { type: 'multiclass', baselineTotal: 4, candidateTotal: 2 });
  values(report.deltas, { accuracy: 0.75, top1Accuracy: 0.5, brierScore: -0.66, falseAllowRate: null });
  const a = report.perClass.find((entry) => entry.label === 'a');
  values(a, { baselineSupport: 1, candidateSupport: 1 });
  values(a.deltas, { precision: 1, recall: 1, f1: 1 });
  const b = report.perClass.find((entry) => entry.label === 'b');
  values(b, { baselineSupport: 1, candidateSupport: 0 });
  values(b.deltas, { precision: null, recall: null, f1: null });
  values(report.perClass.find((entry) => entry.label === 'c').deltas, { precision: 0, recall: 0.5, f1: 1 / 3 });
});

test('comparisons reject incompatible reports and nonfinite numbers in either input', () => {
  const binary = evaluateBinary(binaryFixture(), { unsafeLabel: 1 });
  const multi = evaluateMulticlass(multiclassFixture());
  assert.throws(() => compareEvaluations(binary, multi));
  for (const malformed of [null, undefined, {}, [], { type: 'other', total: 0 }]) {
    assert.throws(() => compareEvaluations(malformed, binary));
    assert.throws(() => compareEvaluations(binary, malformed));
  }
  for (const [path, value] of [
    [['total'], NaN], [['metrics', 'accuracy'], Infinity], [['metrics', 'brierScore'], NaN],
    [['decisions', 'coverage'], -Infinity], [['confusion', 'truePositive'], Infinity],
    [['safety', 'falseAllowRate'], NaN], [['reliability', 0, 'count'], Infinity],
  ]) {
    const invalid = structuredClone(binary);
    const owner = path.slice(0, -1).reduce((object, key) => object[key], invalid);
    owner[path.at(-1)] = value;
    assert.throws(() => compareEvaluations(invalid, binary), path.join('.'));
    assert.throws(() => compareEvaluations(binary, invalid), path.join('.'));
  }
  const invalid = structuredClone(multi);
  invalid.confusion.matrix[0][0] = Infinity;
  assert.throws(() => compareEvaluations(multi, invalid));
});

test('comparisons reject coerced scores, invalid counts, duplicate classes, and cycles', () => {
  const report = evaluateMulticlass(multiclassFixture());
  for (const score of ['0.2', true, {}, -0.1, 2.1]) {
    const invalid = structuredClone(report);
    invalid.metrics.brierScore = score;
    assert.throws(() => compareEvaluations(report, invalid));
  }
  const badCounts = structuredClone(report);
  badCounts.decisions.allow = 3;
  assert.throws(() => compareEvaluations(report, badCounts));
  const duplicate = structuredClone(report);
  duplicate.perClass.push(duplicate.perClass[0]);
  assert.throws(() => compareEvaluations(report, duplicate));
  const cyclic = structuredClone(report);
  cyclic.config.parent = cyclic;
  assert.throws(() => compareEvaluations(report, cyclic));
});

test('a release passes strict limits with enough independent unsafe evidence', () => {
  const options = { unsafeLabel: 1, minCases: 240, minUnsafeCases: 200, maxFalseAllowRate: 0.02, maxEce: 0, maxReviewRate: 0 };
  const report = qualifyRelease(releaseCases(), options);
  assert.equal(report.status, 'pass');
  assert.equal(report.split, 'holdout');
  assert.deepEqual(report.counts, { supplied: 240, selected: 240, excluded: 0 });
  assert.ok(report.policy && typeof report.policy === 'object');
  assert.equal(report.evaluation.type, 'binary');
  values(report.evaluation.metrics, { accuracy: 1, brierScore: 0, ece: 0 });
  values(check(report, 'min_cases', 'pass'), { observed: 240, limit: 240 });
  values(check(report, 'min_unsafe_cases', 'pass'), { observed: 200, limit: 200 });
  values(check(report, 'false_allow_rate', 'pass'), { observed: 0, limit: 0.02 });
  values(check(report, 'false_allow_upper_bound', 'pass'), { observed: 0.018845326377266575, limit: 0.02 });
  assert.deepEqual(new Set(report.groups.map((entry) => entry.field)), new Set(['dialect', 'schemaVersion', 'templateVersion', 'model']));
  for (const entry of report.groups) {
    assert.equal(entry.status, null);
    assert.deepEqual(entry.checks, []);
  }
  finiteJson(report);
});

test('one zero-error unsafe case needs review because its Wilson bound is large', () => {
  const report = qualifyRelease(releaseCases(1, 0), { unsafeLabel: 1, minCases: 1, minUnsafeCases: 1 });
  assert.equal(report.status, 'review');
  check(report, 'min_cases', 'pass');
  check(report, 'min_unsafe_cases', 'pass');
  check(report, 'false_allow_rate', 'pass');
  values(check(report, 'false_allow_upper_bound', 'review'), { observed: 0.7934506856227626, limit: 0.05 });
});

test('missing unsafe meaning blocks a release instead of guessing the unsafe class', () => {
  const report = qualifyRelease(releaseCases());
  assert.equal(report.status, 'blocked');
  check(report, 'unsafe_label_required', 'blocked');
});

test('empty selections and selections with no unsafe cases require review', () => {
  for (const cases of [[], [{ caseId: 'training', split: 'tuning', usedForTuning: true }]]) {
    const report = qualifyRelease(cases, { unsafeLabel: 1 });
    assert.equal(report.status, 'review');
    assert.equal(report.counts.selected, 0);
    check(report, 'min_cases', 'review');
    check(report, 'min_unsafe_cases', 'review');
    assert.equal(report.evaluation.safety.falseAllowRate, null);
  }
  const safeOnly = qualifyRelease(releaseCases(0, 100), { unsafeLabel: 1 });
  assert.equal(safeOnly.status, 'review');
  check(safeOnly, 'min_cases', 'pass');
  check(safeOnly, 'min_unsafe_cases', 'review');
  assert.deepEqual(safeOnly.evaluation.safety.falseAllowInterval, unavailableInterval);
});

test('release selection supports test splits and ignores excluded prediction data', () => {
  const cases = releaseCases().map((row) => ({ ...row, split: 'test' }));
  cases.push({ caseId: 'training', split: 'tuning', usedForTuning: true, probability: 'unused', expected: 'unused' });
  cases.push({ caseId: 'other-holdout', split: 'holdout' });
  const report = qualifyRelease(cases, { split: 'test', unsafeLabel: 1, tuningCaseIds: ['training'] });
  assert.equal(report.status, 'pass');
  assert.equal(report.split, 'test');
  assert.deepEqual(report.counts, { supplied: 242, selected: 240, excluded: 2 });
});

test('all-review actions and missing actions block otherwise accurate releases', () => {
  const reviewed = qualifyRelease(releaseCases().map((row) => ({ ...row, decision: 'review' })), { unsafeLabel: 1 });
  assert.equal(reviewed.status, 'blocked');
  values(check(reviewed, 'review_rate', 'blocked'), { observed: 1, limit: 0.25 });
  assert.equal(reviewed.evaluation.metrics.accuracy, 1);
  for (const index of [0, 239]) {
    const cases = releaseCases();
    delete cases[index].decision;
    const report = qualifyRelease(cases, { unsafeLabel: 1 });
    assert.equal(report.status, 'blocked');
    check(report, 'missing_decisions', 'blocked');
  }
});

test('release rate caps distinguish observed breaches from uncertain upper bounds', () => {
  for (const [errors, status] of [[5, 'review'], [6, 'blocked']]) {
    const cases = releaseCases(100, 0).map((row, index) => ({ ...row, decision: index < errors ? 'allow' : 'block' }));
    const report = qualifyRelease(cases, { unsafeLabel: 1 });
    assert.equal(report.status, status);
    values(check(report, 'false_allow_rate', errors === 5 ? 'pass' : 'blocked'), { observed: errors / 100, limit: 0.05 });
    if (errors === 5) values(check(report, 'false_allow_upper_bound', 'review'), { observed: 0.11175046923191913, limit: 0.05 });
  }
  // Safe cases are present so that only the calibration cap decides the verdict.
  const cases = releaseCases(200, 40).map((row) => ({ ...row, probability: 0.65 }));
  const badCalibration = qualifyRelease(cases, { unsafeLabel: 1 });
  assert.equal(badCalibration.status, 'blocked');
  values(check(badCalibration, 'ece', 'blocked'), { observed: 5 / 6 - 0.65, limit: 0.1 });
  assert.equal(qualifyRelease(cases, { unsafeLabel: 1, maxEce: 0.25 }).status, 'pass');
});

test('a release that never allows a safe case cannot qualify on its false-allow rate alone', () => {
  // Every case is scored correctly, and every action is block. False allows are
  // zero, so the safety caps alone would pass a gate that does nothing useful.
  const cases = releaseCases(200, 40).map((row) => ({ ...row, decision: 'block' }));
  const report = qualifyRelease(cases, { unsafeLabel: 1 });
  assert.equal(report.status, 'review');
  values(report.evaluation.safety, { falseAllowRate: 0, safeCases: 40, falseBlocks: 40, falseBlockRate: 1, safeAllowRate: 0 });
  values(check(report, 'false_allow_rate', 'pass'), { observed: 0, limit: 0.05 });
  values(check(report, 'false_block_rate', 'review'), { observed: 1, limit: 0.25 });
  values(check(report, 'safe_allow_rate', 'review'), { observed: 0, limit: 0.5 });
  // The same scoring with useful actions qualifies.
  assert.equal(qualifyRelease(releaseCases(200, 40), { unsafeLabel: 1 }).status, 'pass');
});

test('release qualification requires labeled safe cases', () => {
  const report = qualifyRelease(releaseCases(200, 0), { unsafeLabel: 1 });
  assert.equal(report.status, 'review');
  values(check(report, 'min_safe_cases', 'review'), { observed: 0, limit: 30 });
  values(check(report, 'safe_allow_rate', 'review'), { observed: null, limit: 0.5 });
});

test('exact and wildcard group rules block a bad group despite a passing aggregate', () => {
  for (const field of ['dialect', 'schemaVersion', 'templateVersion', 'model']) {
    const cases = releaseCases().map((row, index) => index < 3 ? { ...row, [field]: 'legacy', decision: 'allow' } : row);
    const aggregate = qualifyRelease(cases, { unsafeLabel: 1 });
    assert.equal(aggregate.status, 'pass');
    values(aggregate.evaluation.safety, { falseAllowRate: 0.015 });
    near(aggregate.evaluation.safety.falseAllowInterval.upper, 0.04316572879269026);
    for (const rule of [{ field, value: 'legacy' }, { field }]) {
      const report = qualifyRelease(cases, { unsafeLabel: 1, groupBy: [], groupRules: [rule] });
      assert.equal(report.status, 'blocked');
      const bad = group(report, field, 'legacy');
      assert.equal(bad.status, 'blocked');
      assert.equal(bad.evaluation.total, 3);
      values(check(bad, 'false_allow_rate', 'blocked', { field, value: 'legacy' }), { observed: 1, limit: 0.05 });
      check(bad, 'min_cases', 'review', { field, value: 'legacy' });
      check(bad, 'min_unsafe_cases', 'review', { field, value: 'legacy' });
    }
  }
});

test('small configured groups require review even when all actions are safe', () => {
  const cases = releaseCases().map((row, index) => index === 0 ? { ...row, dialect: 'tiny' } : row);
  const report = qualifyRelease(cases, { unsafeLabel: 1, groupRules: [{ field: 'dialect', value: 'tiny', minCases: 1, minUnsafeCases: 1 }] });
  assert.equal(report.status, 'review');
  const tiny = group(report, 'dialect', 'tiny');
  assert.equal(tiny.status, 'review');
  check(tiny, 'min_cases', 'pass', { field: 'dialect', value: 'tiny' });
  check(tiny, 'min_unsafe_cases', 'pass', { field: 'dialect', value: 'tiny' });
  values(check(tiny, 'false_allow_upper_bound', 'review', { field: 'dialect', value: 'tiny' }), { observed: 0.7934506856227626, limit: 0.05 });
});

test('absent exact groups and wholly absent wildcard metadata require review', () => {
  for (const rule of [{ field: 'dialect', value: 'oracle' }, { field: 'tenant' }]) {
    const report = qualifyRelease(releaseCases(), { unsafeLabel: 1, groupBy: [], groupRules: [rule] });
    assert.equal(report.status, 'review');
    const checks = [...report.checks, ...report.groups.flatMap((entry) => entry.checks)];
    assert.ok(checks.some((entry) => entry.status === 'review' && entry.scope?.field === rule.field));
    const absent = group(report, rule.field, rule.value ?? null);
    assert.equal(absent.evaluation.total, Object.hasOwn(rule, 'value') ? 0 : 240);
  }
});

test('exact and wildcard group rules review missing metadata even with permissive group limits', () => {
  const cases = releaseCases();
  delete cases[0].dialect;
  for (const selector of [{ field: 'dialect' }, { field: 'dialect', value: 'postgres' }]) {
    const report = qualifyRelease(cases, { unsafeLabel: 1, groupBy: [], groupRules: [
      { ...selector, minCases: 1, minUnsafeCases: 1, maxFalseAllowRate: 1, maxEce: 1, maxReviewRate: 1 },
    ] });
    assert.equal(report.status, 'review');
    assert.equal(group(report, 'dialect', null).status, 'review');
    assert.equal(group(report, 'dialect', null).evaluation.total, 1);
    assert.equal(group(report, 'dialect', 'postgres').status, 'pass');
    check(report, 'missing_group_metadata', 'review', { field: 'dialect', value: null });
  }
});

test('group rules can enforce custom fields, typed values, and stricter caps', () => {
  const cases = releaseCases().map((row, index) => ({ ...row, ['__proto__']: index < 20 ? false : 'false', decision: index === 0 ? 'allow' : row.decision }));
  const report = qualifyRelease(cases, { unsafeLabel: 1, groupBy: [], groupRules: [
    { field: '__proto__', value: false, minCases: 20, minUnsafeCases: 20, maxFalseAllowRate: 0.01 },
  ] });
  assert.equal(report.status, 'blocked');
  values(check(group(report, '__proto__', false), 'false_allow_rate', 'blocked', { field: '__proto__', value: false }), { observed: 0.05, limit: 0.01 });
});

test('duplicate IDs cannot evade checks through whitespace or another split', () => {
  for (const extra of [
    { caseId: 'case-0', split: 'holdout', expected: 1, probability: 1, decision: 'block' },
    { caseId: 'case-0', split: 'test' },
    { caseId: ' \tcase-0\n', split: 'tuning', usedForTuning: true },
  ]) {
    const report = qualifyRelease([...releaseCases(), extra], { unsafeLabel: 1 });
    assert.equal(report.status, 'blocked');
    check(report, 'duplicate_case_id', 'blocked');
  }
  const report = qualifyRelease([...releaseCases(), { caseId: 'external', split: 'test' }, { caseId: ' external ', split: 'tuning' }], { unsafeLabel: 1 });
  assert.equal(report.status, 'blocked');
  check(report, 'duplicate_case_id', 'blocked');
});

test('selected tuning provenance and external ledger overlaps block release', () => {
  const flagged = releaseCases();
  flagged[0].usedForTuning = true;
  const report = qualifyRelease(flagged, { unsafeLabel: 1 });
  assert.equal(report.status, 'blocked');
  check(report, 'tuning_overlap', 'blocked');
  for (const [caseId, ledgerId] of [['case-0', 'case-0'], ['case-0', ' case-0 '], [' case-0 ', 'case-0']]) {
    const cases = releaseCases();
    cases[0].caseId = caseId;
    const overlap = qualifyRelease(cases, { unsafeLabel: 1, tuningCaseIds: [ledgerId] });
    assert.equal(overlap.status, 'blocked');
    check(overlap, 'tuning_overlap', 'blocked');
  }
});

test('malformed selected data fails closed instead of dropping a bad case', () => {
  const good = releaseCases()[0];
  const invalids = [null, [], 42, {}, { ...good, caseId: '' }, { ...good, caseId: '   ' },
    { ...good, expected: '1' }, { ...good, expected: 2 }, { ...good, expected: null },
    { ...good, probability: NaN }, { ...good, probability: Infinity }, { ...good, probability: -Infinity },
    { ...good, probability: -0.01 }, { ...good, probability: 1.01 }, { ...good, probability: '1' },
    { ...good, probability: undefined, confidence: 1 }, { ...good, decision: 'accept' },
    { ...good, group: {} }, { ...good, usedForTuning: 'false' }];
  for (const invalid of invalids) {
    const report = qualifyRelease([invalid, ...releaseCases().slice(1)], { unsafeLabel: 1 });
    assert.equal(report.status, 'blocked');
    assert.equal(report.evaluation, null);
    assert.ok(report.checks.some((entry) => entry.code === 'invalid_case' && entry.status === 'blocked'));
  }
});

test('invalid split metadata and excluded provenance also fail closed', () => {
  for (const split of [undefined, null, '', '   ', 1]) {
    const cases = releaseCases();
    cases[0].split = split;
    const report = qualifyRelease(cases, { unsafeLabel: 1 });
    assert.equal(report.status, 'blocked');
    assert.equal(report.evaluation, null);
    check(report, 'invalid_split', 'blocked');
  }
  const report = qualifyRelease([...releaseCases(), { caseId: 'external', split: 'tuning', usedForTuning: 'true' }], { unsafeLabel: 1 });
  assert.equal(report.status, 'blocked');
  assert.equal(report.evaluation, null);
  check(report, 'invalid_case', 'blocked');
});

test('release options and group rules reject unknown keys and invalid limits', () => {
  const invalids = [null, [], 1, { unknown: true }, { split: 'tuning' }, { split: 'train' }, { split: '' },
    { unsafeLabel: null }, { unsafeLabel: '1' }, { unsafeLabel: 2 },
    { tuningCaseIds: 'case-0' }, { tuningCaseIds: [''] }, { tuningCaseIds: ['   '] }, { tuningCaseIds: [1] },
    { bins: 0 }, { threshold: Infinity }, { thresholds: [] }, { fields: { expected: 1 } }, { groupBy: [null] },
    { groupRules: null }, { groupRules: {} }, { groupRules: [null] }, { groupRules: [{}] },
    { groupRules: [{ field: '' }] }, { groupRules: [{ field: 'dialect', value: {} }] },
    { groupRules: [{ field: 'dialect', value: NaN }] }, { groupRules: [{ field: 'dialect', value: Infinity }] },
    { groupRules: [{ field: 'dialect', minCases: 0 }] }, { groupRules: [{ field: 'dialect', maxEce: 2 }] },
    { groupRules: [{ field: 'dialect', misspelledLimit: 1 }] }];
  for (const key of ['minCases', 'minUnsafeCases']) {
    for (const value of [0, -1, 1.5, '1', NaN, Infinity]) invalids.push({ [key]: value });
  }
  for (const key of ['maxFalseAllowRate', 'maxEce', 'maxReviewRate']) {
    for (const value of [-0.1, 1.1, null, '0.1', NaN, Infinity, -Infinity]) invalids.push({ [key]: value });
  }
  for (const options of invalids) assert.throws(() => qualifyRelease(releaseCases(1, 0), options), JSON.stringify(options));
});

test('release field aliases apply to evidence, grouping, and duplicate ID checks', () => {
  const fields = { expected: 'truth', probability: 'p', decision: 'action', group: 'cohort', caseId: 'id' };
  const cases = releaseCases().map(({ expected, probability, decision, caseId, ...row }) => ({
    ...row, truth: expected, p: probability, action: decision, id: caseId, cohort: 'mapped',
  }));
  const report = qualifyRelease(cases, { fields, unsafeLabel: 1, bins: 2, threshold: 0.5, thresholds: [1, 0, 0.5] });
  assert.equal(report.status, 'pass');
  assert.equal(group(report, 'cohort', 'mapped').evaluation.total, 240);
  assert.deepEqual(report.evaluation.thresholds.map((entry) => entry.threshold), [0, 0.5, 1]);
  const duplicate = qualifyRelease([...cases, { id: ' case-0 ', split: 'test' }], { fields, unsafeLabel: 1 });
  assert.equal(duplicate.status, 'blocked');
  check(duplicate, 'duplicate_case_id', 'blocked');
});

test('all four APIs preserve deeply frozen inputs and produce stable finite JSON', () => {
  const binaryRows = deepFreeze(binaryFixture());
  const binaryOptions = deepFreeze({ bins: 2, thresholds: [1, 0.5, 0, 0.5], groupBy: ['group'], fields: { probability: 'probability' }, unsafeLabel: 1 });
  const multiRows = deepFreeze(multiclassFixture());
  const multiOptions = deepFreeze({ labels: ['c', 'b', 'a'], topK: [1, 2, 3], thresholds: [1, 0, 0.5], fields: { probabilities: 'probabilities' } });
  const cases = deepFreeze(releaseCases());
  const releaseOptions = deepFreeze({ unsafeLabel: 1, tuningCaseIds: ['excluded'], groupBy: [],
    groupRules: [{ field: 'dialect', value: 'postgres' }], thresholds: [1, 0.5, 0, 0.5] });
  const inputs = [binaryRows, binaryOptions, multiRows, multiOptions, cases, releaseOptions];
  const before = structuredClone(inputs);
  const binary = evaluateBinary(binaryRows, binaryOptions);
  const multi = evaluateMulticlass(multiRows, multiOptions);
  const release = qualifyRelease(cases, releaseOptions);
  assert.equal(release.status, 'pass');
  for (const [report, repeat] of [[binary, () => evaluateBinary(binaryRows, binaryOptions)],
    [multi, () => evaluateMulticlass(multiRows, multiOptions)], [release, () => qualifyRelease(cases, releaseOptions)]]) {
    assert.deepEqual(report, repeat());
    finiteJson(report);
    const frozen = deepFreeze(report);
    assert.ok(Object.isFrozen(frozen));
  }
  for (const report of [binary, multi]) {
    const snapshot = structuredClone(report);
    const comparison = compareEvaluations(report, report);
    near(comparison.deltas.accuracy, 0);
    near(comparison.deltas.brierScore, 0);
    finiteJson(comparison);
    assert.deepEqual(report, snapshot);
  }
  assert.deepEqual(inputs, before);
});
