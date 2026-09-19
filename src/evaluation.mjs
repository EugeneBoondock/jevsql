import { probability } from './validation.mjs';

/** Measure selective accuracy on supplied ground truth without more model calls. */
export function evaluatePredictions(rows, { expected = 'expected', predicted = 'prediction', confidence = 'confidence',
  thresholds = [0, 0.5, 0.7, 0.8, 0.9, 0.95, 1] } = {}) {
  if (!Array.isArray(rows) || !rows.length) throw new TypeError('Evaluation needs at least one labeled row.');
  if (!Array.isArray(thresholds) || !thresholds.length) throw new TypeError('Evaluation needs at least one threshold.');
  for (const threshold of thresholds) probability(threshold, 'threshold');
  const scalar = (value) => ['string', 'number', 'boolean'].includes(typeof value) && (typeof value !== 'number' || Number.isFinite(value));
  for (const row of rows) {
    if (!scalar(row[expected])) throw new TypeError(`Every evaluation row needs ground truth in ${expected}.`);
    if (!(predicted in row)) throw new TypeError(`Missing prediction column ${predicted}.`);
    if (row[predicted] != null) {
      if (!scalar(row[predicted])) throw new TypeError('Predictions must be scalar labels or null.');
      probability(row[confidence], confidence);
    }
  }
  const sweep = [...new Set(thresholds)].sort((a, b) => a - b).map((threshold) => {
    const accepted = rows.filter((row) => row[predicted] != null && row[confidence] >= threshold);
    const correct = accepted.filter((row) => row[predicted] === row[expected]).length;
    return { threshold, accepted: accepted.length, review: rows.length - accepted.length,
      correct, errors: accepted.length - correct, coverage: accepted.length / rows.length,
      accuracy: accepted.length ? correct / accepted.length : null };
  });
  const confusion = new Map();
  for (const row of rows) {
    const key = JSON.stringify([row[expected], row[predicted]]);
    const cell = confusion.get(key) ?? { expected: row[expected], prediction: row[predicted], count: 0 };
    cell.count++; confusion.set(key, cell);
  }
  return { total: rows.length, thresholds: sweep, confusion: [...confusion.values()] };
}

/** Compare the same query result under packed and isolated row requests. */
export function compareRowModes(packedResult, isolatedResult, { key = 'id', fields } = {}) {
  const packed = packedResult?.rows;
  const isolated = isolatedResult?.rows;
  if (!Array.isArray(packed) || !Array.isArray(isolated)) {
    throw new TypeError('Row-mode comparison needs packed and isolated query results.');
  }
  const index = (rows, name) => {
    const result = new Map();
    for (const row of rows) {
      if (!(key in row) || row[key] == null) throw new TypeError(`Every ${name} row needs a non-null ${key}.`);
      const id = JSON.stringify(row[key]);
      if (result.has(id)) throw new TypeError(`${name} row keys must be unique.`);
      result.set(id, row);
    }
    return result;
  };
  const left = index(packed, 'packed');
  const right = index(isolated, 'isolated');
  if (left.size !== right.size || [...left.keys()].some((id) => !right.has(id))) {
    throw new TypeError('Packed and isolated results must contain the same row keys.');
  }
  const selected = fields ?? [...new Set(packed.flatMap((row) => Object.keys(row)))]
    .filter((name) => name !== key && isolated.every((row) => name in row));
  if (!Array.isArray(selected) || !selected.length || selected.some((name) => typeof name !== 'string' || name === key)) {
    throw new TypeError('Comparison fields must be a non-empty array of column names other than the key.');
  }

  const differences = [];
  const numericDeltas = [];
  for (const [id, packedRow] of left) {
    const isolatedRow = right.get(id);
    for (const field of selected) {
      if (!(field in packedRow) || !(field in isolatedRow)) throw new TypeError(`Missing comparison field ${field}.`);
      const packedValue = packedRow[field];
      const isolatedValue = isolatedRow[field];
      const equal = Object.is(packedValue, isolatedValue);
      const numeric = typeof packedValue === 'number' && Number.isFinite(packedValue)
        && typeof isolatedValue === 'number' && Number.isFinite(isolatedValue);
      const absoluteDelta = numeric ? Math.abs(packedValue - isolatedValue) : null;
      if (numeric) numericDeltas.push(absoluteDelta);
      if (!equal) differences.push({ key: packedRow[key], field, packed: packedValue, isolated: isolatedValue, absoluteDelta });
    }
  }
  const compared = left.size * selected.length;
  const differingRows = new Set(differences.map((item) => JSON.stringify(item.key))).size;
  const stats = (result) => ({ requests: result?.stats?.requests ?? null, inputTokens: result?.stats?.inputTokens ?? null,
    costUsd: result?.stats?.costUsd ?? null, wallMs: result?.stats?.wallMs ?? null });
  return {
    rows: left.size,
    fields: selected,
    compared,
    agreements: compared - differences.length,
    agreementRate: compared ? (compared - differences.length) / compared : null,
    differingRows,
    fieldDisagreements: differences.length,
    maxNumericDelta: numericDeltas.length ? Math.max(...numericDeltas) : null,
    meanNumericDelta: numericDeltas.length ? numericDeltas.reduce((sum, value) => sum + value, 0) / numericDeltas.length : null,
    differences,
    stats: { packed: stats(packedResult), isolated: stats(isolatedResult) },
  };
}
