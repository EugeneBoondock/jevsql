export default {
  mutate: [
    'src/validation.mjs:2-27',
    'src/validation.mjs:47-85',
    'src/query-compiler.mjs:252-310',
    'src/sql-inspector.mjs:181-230',
  ],
  testRunner: 'command',
  mutator: { excludedMutations: ['StringLiteral'] },
  commandRunner: {
    command: 'node --test test/unit.test.mjs test/decisions.test.mjs test/hardening.test.mjs test/governed.test.mjs test/hazards.test.mjs test/schema.test.mjs test/metrics.test.mjs test/capabilities.test.mjs test/classification.test.mjs',
  },
  coverageAnalysis: 'off',
  concurrency: 4,
  timeoutMS: 60000,
  reporters: ['clear-text', 'progress'],
  // The current behavioral baseline is 76.06. Raise this floor as surviving
  // safety mutants gain targeted assertions.
  thresholds: { high: 85, low: 80, break: 75 },
};
