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
