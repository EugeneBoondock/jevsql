import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { JevSQL, evaluatePredictions } from '../src/engine.mjs';
import { loadEnvFiles } from '../src/env.mjs';
import { WorkflowFixtureClient, seedWorkflowData } from './workflow-fixtures.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const readRecipe = (name) => readFileSync(path.join(HERE, 'recipes', name), 'utf8');

export async function runWorkflows({ live = false, db = ':memory:', log = console.log } = {}) {
  if (live) loadEnvFiles();
  const engine = new JevSQL({ db, maxJudgments: 100, maxEstimatedCostUsd: 0.02,
    ...(live ? { model: process.env.TYPESAFE_DEFAULT_MODEL ?? 'jev-1.13.0' } : { client: new WorkflowFixtureClient() }) });
  const show = (title, value) => log(`${title}\n${JSON.stringify(value, null, 2)}\n`);
  log(live ? 'Live tour: synthetic example records are sent to TypeSafe.'
    : 'Offline tour: scripted fixture answers, no network calls, no API key, no model-accuracy claim.');
  try {
    seedWorkflowData(engine);
    const first = await engine.materialize('evidence_decisions', readRecipe('evidence-audit.sql'));
    show('1. Claims become searchable evidence decisions', first.rows);
    const review = await engine.query(readRecipe('review-queue.sql'));
    show('2. A review queue with a concrete next action', review.rows);
    const extraction = await engine.query(readRecipe('source-extraction.sql'));
    show('3. Invoice contacts selected from exact source spans', extraction.rows);
    const matches = await engine.query(readRecipe('entity-match.sql'));
    show('4. Candidate business matches after SQL blocking', matches.rows);
    const ranking = await engine.query(readRecipe('passage-ranking.sql'));
    show('5. Permission-filtered passages ranked for an answer', ranking.rows);
    const evaluation = evaluatePredictions(first.rows);
    show('6. Accuracy versus review workload on supplied labels', evaluation.thresholds);
    const warm = await engine.refresh('evidence_decisions');
    show('7. Unchanged refresh', { requests: warm.stats.requests, unchanged: warm.changes.unchanged });
    engine.exec("UPDATE claims SET evidence='Returns are accepted only within 14 days of purchase.', expected='contradicted' WHERE id=1");
    const changed = await engine.refresh('evidence_decisions');
    show('8. A changed policy produces a recorded decision change', { newJudgments: changed.stats.judgments, changes: changed.changes });
    const checks = await engine.check(JSON.parse(readRecipe('evidence-checks.json')).checks);
    show('9. Data checks identify claims that need attention', checks);
    return { first, review, extraction, matches, ranking, evaluation, warm, changed, checks };
  } finally { engine.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== '--live')) throw new Error('Usage: node examples/workflows.mjs [--live]');
  runWorkflows({ live: args.includes('--live') }).catch((error) => { console.error(error.message); process.exitCode = 1; });
}
