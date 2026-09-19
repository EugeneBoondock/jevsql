// Scripted answers for the offline tour. These are not model predictions.
export class WorkflowFixtureClient {
  model = 'jevsql-scripted-fixture';
  stats = { requests: 0, inputTokens: 0, outputTokens: 0, latencyMs: 0 };

  async evaluate(state, questions, { signal } = {}) {
    signal?.throwIfAborted();
    const answers = {};
    for (const [id, q] of Object.entries(questions)) {
      const rowId = q.instructions.subject.replaceAll('`', '').split('.').pop();
      const row = state.rows[rowId];
      if (q.type === 'choice') {
        const options = Object.keys(q.criteria);
        let choice, confidence = 0.96;
        if (options.includes('supported')) {
          choice = row.evidence.includes('14 days') ? 'contradicted'
            : row.evidence.includes('not mentioned') ? 'unknown' : 'supported';
          if (choice === 'unknown') confidence = 0.55;
        } else {
          choice = options.find((key) => q.criteria[key] === 'billing@acme.example') ?? 'none';
        }
        answers[id] = { type: 'choice', choice, confidence,
          probabilities: Object.fromEntries(options.map((key) => [key, key === choice ? 0.96 : 0.04 / (options.length - 1)])) };
      } else if (q.type === 'score') {
        const score = row.passage.includes('within 30 days') ? 2.85 : 0.2;
        const last = q.criteria.length - 1;
        const distribution = q.criteria.map((_, i) => i === 0 ? 1 - score / last : i === last ? score / last : 0);
        answers[id] = { type: 'score', score, confidence: 0.94,
          probabilities: Object.fromEntries(distribution.map((p, i) => [String(i), p])),
          legend: Object.fromEntries(q.criteria.map((label, i) => [String(i), label])) };
      } else {
        const matched = row?.left && row?.right && row.left.name.startsWith('Acme') && row.right.name.startsWith('Acme');
        const suspicious = typeof row === 'string' && row.includes('ignore');
        const answerExists = row?.passage && String(q.instructions.question).includes('contain information')
          && row.passage.includes('within 30 days');
        answers[id] = { type: 'noul', noul: matched || suspicious || answerExists ? 0.97 : 0.03 };
      }
    }
    this.stats.requests++;
    return { model: this.model, answers, usage: { input_tokens: 0, output_tokens: 0 } };
  }
}

export function seedWorkflowData(engine) {
  engine.exec(`
    CREATE TABLE claims(id INTEGER PRIMARY KEY, claim TEXT, evidence TEXT, expected TEXT);
    INSERT INTO claims VALUES
      (1, 'Returns are accepted within 30 days.', 'Returns are accepted within 30 days of purchase.', 'supported'),
      (2, 'Support is available on weekends.', 'Weekend support is not mentioned in the policy.', 'unknown'),
      (3, 'Shipping is free.', 'Shipping is free on all orders.', 'supported');
    CREATE TABLE contact_notes(id INTEGER PRIMARY KEY, notes TEXT);
    INSERT INTO contact_notes VALUES
      (1, 'Use billing@acme.example for future invoices. old@acme.example is no longer monitored.'),
      (2, 'Call the office. No email address was provided.');
    CREATE TABLE incoming_companies(id INTEGER PRIMARY KEY, name TEXT, city TEXT, country TEXT);
    INSERT INTO incoming_companies VALUES (1, 'Acme Ltd', 'Johannesburg', 'ZA');
    CREATE TABLE companies(id INTEGER PRIMARY KEY, name TEXT, city TEXT, country TEXT);
    INSERT INTO companies VALUES
      (10, 'Acme Limited', 'Johannesburg', 'ZA'),
      (11, 'Northwind Tools', 'Johannesburg', 'ZA'),
      (12, 'Acme Limited', 'London', 'GB');
    CREATE TABLE passages(id INTEGER PRIMARY KEY, question TEXT, passage TEXT, allowed INTEGER);
    INSERT INTO passages VALUES
      (1, 'How long do I have to return an order?', 'You can return orders within 30 days of purchase.', 1),
      (2, 'How long do I have to return an order?', 'Our summer collection comes in five colors.', 1),
      (3, 'How long do I have to return an order?', 'Private staff-only policy.', 0);
  `);
}
