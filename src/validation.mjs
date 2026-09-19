// Shared validation for SQL arguments, API payloads, and workflow settings.
export function probability(value, name = 'probability') {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new TypeError(`${name} must be a number from 0 to 1.`);
  }
  return value;
}

export function integer(value, name, min = 1, max = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new TypeError(`${name} must be an integer from ${min} to ${max}.`);
  }
  return value;
}

export function nonNegative(value, name) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new TypeError(`${name} must be a finite, non-negative number.`);
  }
  return value;
}

export function quoteIdentifier(name) {
  if (typeof name !== 'string' || !name.trim() || name.includes('\0')) {
    throw new TypeError('A non-empty SQL identifier is required.');
  }
  return `"${name.replaceAll('"', '""')}"`;
}

export function stableJson(value) {
  return JSON.stringify(value, (_, entry) => {
    if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
      return Object.fromEntries(Object.keys(entry).sort().map((key) => [key, entry[key]]));
    }
    return entry;
  });
}

/** Decode SQLite JSON values; ordinary text stays text. */
export function structured(value) {
  if (typeof value === 'string' && /^\s*[\[{]/.test(value)) {
    try { return JSON.parse(value); } catch { /* ordinary text */ }
  }
  return value;
}

export function validateAnswer(answer, question) {
  if (!answer || answer.type !== question.kind) throw new Error(`Invalid ${question.kind} answer type.`);
  if (question.kind === 'noul') {
    probability(answer.noul, 'answer.noul');
    return answer;
  }
  probability(answer.confidence, 'answer.confidence');
  const labels = question.kind === 'score'
    ? question.criteria.map((_, i) => String(i))
    : Array.isArray(question.criteria) ? question.criteria : Object.keys(question.criteria);
  const probabilities = answer.probabilities;
  if (!probabilities || typeof probabilities !== 'object' || Array.isArray(probabilities)
      || Object.keys(probabilities).length !== labels.length) {
    throw new Error('Answer must contain the full probability distribution.');
  }
  let sum = 0;
  for (const label of labels) sum += probability(probabilities[label], `probabilities[${label}]`);
  if (Math.abs(sum - 1) > 0.02) throw new Error('Answer probabilities must sum to 1.');
  if (question.kind === 'choice') {
    if (!labels.includes(answer.choice)) throw new Error('Answer choice is outside the supplied options.');
    // TypeSafe defines Choice as the highest-probability option. A response whose
    // selected option is not an argmax is internally contradictory, so it must not
    // be able to satisfy a confidence gate. Ties are allowed within tolerance.
    const best = labels.reduce((max, label) => Math.max(max, probabilities[label]), -Infinity);
    if (probabilities[answer.choice] < best - 0.02) {
      throw new Error('Answer choice is not the highest-probability option.');
    }
  }
  if (question.kind === 'score') {
    if (typeof answer.score !== 'number' || !Number.isFinite(answer.score)
        || answer.score < 0 || answer.score > labels.length - 1) {
      throw new Error('Answer score is outside the supplied levels.');
    }
    const expected = labels.reduce((total, label, index) => total + index * probabilities[label], 0);
    if (Math.abs(answer.score - expected) > 0.02) {
      throw new Error('Answer score is not the probability-weighted value of its levels.');
    }
  }
  return answer;
}
