// The adjudicated evaluation corpus.
//
// Document B asks for a specific record per decision — case, engine, engine
// version, schema version, model id, prompt-template version, state hash,
// question id and type, probabilities, the code decision, the human gold label,
// the final operational outcome, latency and input tokens — and says to build
// the harness before tuning any prompt. This is that store.
//
// Two rules are enforced rather than documented. A case's split is derived from
// its identifier, so it cannot be chosen after the answers are known; and a gold
// label is append-only with a revision, so relabelling leaves a trail.

import './quiet.mjs';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { integer, stableJson } from './validation.mjs';
import { digest, jsonData, redactText } from './privacy.mjs';

const SPLITS = ['train', 'tune', 'test', 'holdout'];
const DECISIONS = ['allow', 'review', 'block'];
const QUESTION_TYPES = ['noul', 'choice', 'score'];

// Document B's proposed sizing. A target, not an API requirement.
export const PROPOSED_TARGETS = Object.freeze({ query: 400, migration: 250, incident: 350 });

const text = (value, label) => {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${label} must be a non-empty string.`);
  return value.trim();
};

/** Deterministic split from the case identifier alone. The same case always
 * lands in the same split, whoever runs this and whenever they run it. */
export function splitFor(caseId, ratios = { train: 40, tune: 20, test: 20, holdout: 20 }) {
  for (const split of SPLITS) integer(ratios[split] ?? 0, `ratios.${split}`, 0, 100);
  const total = SPLITS.reduce((sum, split) => sum + (ratios[split] ?? 0), 0);
  if (total !== 100) throw new TypeError('Split ratios must sum to 100.');
  const bucket = parseInt(createHash('sha256').update(`jevsql-split:${text(caseId, 'caseId')}`).digest('hex').slice(0, 8), 16) % 100;
  let cursor = 0;
  for (const split of SPLITS) {
    cursor += ratios[split] ?? 0;
    if (bucket < cursor) return split;
  }
  return 'holdout';
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS _jevsql_cases (
    id INTEGER PRIMARY KEY, case_id TEXT NOT NULL, question_id TEXT NOT NULL,
    workflow TEXT NOT NULL, split TEXT NOT NULL, split_source TEXT NOT NULL,
    adversarial INTEGER NOT NULL DEFAULT 0, used_for_tuning INTEGER NOT NULL DEFAULT 0,
    db_engine TEXT, db_version TEXT, schema_version TEXT,
    model TEXT, policy_id TEXT, policy_version TEXT, policy_hash TEXT,
    prompt_template_version TEXT, state_hash TEXT,
    question_type TEXT NOT NULL, answer_json TEXT NOT NULL,
    decision TEXT, receipt_id TEXT, latency_ms REAL, input_tokens INTEGER,
    recorded_at TEXT NOT NULL, UNIQUE(case_id, question_id)
  );
  CREATE TABLE IF NOT EXISTS _jevsql_labels (
    id INTEGER PRIMARY KEY, case_id TEXT NOT NULL, question_id TEXT NOT NULL,
    revision INTEGER NOT NULL, gold_label TEXT NOT NULL, outcome TEXT,
    adjudicator TEXT NOT NULL, note TEXT NOT NULL, created_at TEXT NOT NULL,
    UNIQUE(case_id, question_id, revision)
  );
  CREATE INDEX IF NOT EXISTS _jevsql_cases_lookup ON _jevsql_cases(workflow, question_id, split);
`;

/**
 * An append-only corpus of decisions and their adjudicated outcomes.
 *
 * `record` stores one row per question. `recordReceipt` derives those rows from
 * a control-plane receipt, which is the intended path: review something, file
 * the receipt, adjudicate later. Nothing here calls a model.
 */
export class EvaluationCorpus {
  constructor(file = ':memory:', { ratios, now = Date.now } = {}) {
    this.db = new DatabaseSync(file);
    this.db.exec(SCHEMA);
    this.ratios = ratios ?? { train: 40, tune: 20, test: 20, holdout: 20 };
    this.now = now;
    splitFor('probe', this.ratios);
  }

  /** @param {object} entry one decision about one question */
  record(entry) {
    const caseId = text(entry?.caseId, 'caseId');
    const questionId = text(entry?.questionId, 'questionId');
    const workflow = text(entry?.workflow, 'workflow');
    if (!QUESTION_TYPES.includes(entry.questionType)) throw new TypeError('questionType must be noul, choice or score.');
    if (entry.decision != null && !DECISIONS.includes(entry.decision)) throw new TypeError('decision must be allow, review or block.');
    const explicit = entry.split != null;
    if (explicit && !SPLITS.includes(entry.split)) throw new TypeError(`split must be one of ${SPLITS.join(', ')}.`);
    const split = explicit ? entry.split : splitFor(caseId, this.ratios);
    const answer = jsonData(entry.answer ?? {});
    const existing = this.db.prepare('SELECT split, answer_json FROM _jevsql_cases WHERE case_id=? AND question_id=?').get(caseId, questionId);
    if (existing) {
      if (existing.answer_json !== stableJson(answer)) throw new Error('This case and question already hold a different answer. Use a new case id for a rerun.');
      return this.get(caseId, questionId);
    }
    this.db.prepare(`INSERT INTO _jevsql_cases (case_id,question_id,workflow,split,split_source,adversarial,used_for_tuning,
      db_engine,db_version,schema_version,model,policy_id,policy_version,policy_hash,prompt_template_version,state_hash,
      question_type,answer_json,decision,receipt_id,latency_ms,input_tokens,recorded_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      caseId, questionId, workflow, split, explicit ? 'explicit' : 'derived',
      entry.adversarial ? 1 : 0, split === 'tune' || entry.usedForTuning ? 1 : 0,
      entry.dbEngine ?? null, entry.dbVersion ?? null, entry.schemaVersion ?? null,
      entry.model ?? null, entry.policyId ?? null, entry.policyVersion ?? null, entry.policyHash ?? null,
      entry.promptTemplateVersion ?? null, entry.stateHash ?? null,
      entry.questionType, stableJson(answer), entry.decision ?? null, entry.receiptId ?? null,
      entry.latencyMs ?? null, entry.inputTokens ?? null, new Date(this.now()).toISOString());
    return this.get(caseId, questionId);
  }

  /**
   * File every question of a control-plane receipt as corpus cases.
   * `decisionFor` maps the receipt's decision onto the allow/review/block
   * vocabulary the metrics use; eligible means the code would have acted.
   */
  recordReceipt(receipt, { caseId, workflow = receipt?.kind, adversarial = false, split,
    dbEngine = receipt?.context?.dialect ?? null, dbVersion = null, promptTemplateVersion = null } = {}) {
    if (!receipt || typeof receipt !== 'object') throw new TypeError('A receipt is required.');
    const id = text(caseId ?? receipt.id, 'caseId');
    const decision = receipt.decision === 'eligible' ? 'allow' : receipt.decision === 'block' ? 'block' : 'review';
    const answers = receipt.answers ?? {};
    const questions = Object.keys(answers);
    if (!questions.length) return [];
    // Latency and tokens are per receipt; attribute them evenly so a sum over
    // rows still reconstructs the request cost rather than multiplying it.
    const share = (value) => (typeof value === 'number' && Number.isFinite(value) ? value / questions.length : null);
    return questions.map((questionId) => this.record({
      caseId: id, questionId, workflow, adversarial, split, dbEngine, dbVersion,
      schemaVersion: receipt.context?.schemaVersion ?? null,
      model: receipt.resolvedModel ?? receipt.requestedModel ?? null,
      policyId: receipt.kind ?? null, policyVersion: receipt.policyVersion ?? null,
      policyHash: receipt.policyHash ?? null, promptTemplateVersion, stateHash: receipt.stateHash ?? null,
      questionType: answers[questionId]?.type ?? 'noul', answer: answers[questionId] ?? {},
      decision, receiptId: receipt.id ?? null,
      latencyMs: share(receipt.stats?.wallMs), inputTokens: share(receipt.stats?.inputTokens),
    }));
  }

  /** Append an adjudicated label. Relabelling requires the current revision. */
  label(caseId, questionId, { goldLabel, outcome = null, adjudicator, note = '', expectedRevision = 0 }) {
    const row = this.db.prepare('SELECT 1 FROM _jevsql_cases WHERE case_id=? AND question_id=?').get(caseId, questionId);
    if (!row) throw new Error('Unknown case and question.');
    text(adjudicator, 'adjudicator');
    if (goldLabel === undefined || goldLabel === null) throw new TypeError('A gold label is required.');
    integer(expectedRevision, 'expectedRevision', 0);
    const revision = this.db.prepare('SELECT COALESCE(MAX(revision),0) AS n FROM _jevsql_labels WHERE case_id=? AND question_id=?').get(caseId, questionId).n;
    if (revision !== expectedRevision) throw new Error('This label changed. Read its latest revision before replacing it.');
    this.db.prepare('INSERT INTO _jevsql_labels (case_id,question_id,revision,gold_label,outcome,adjudicator,note,created_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(caseId, questionId, revision + 1, stableJson(jsonData(goldLabel)), outcome == null ? null : String(outcome),
        redactText(adjudicator), redactText(String(note)), new Date(this.now()).toISOString());
    return { caseId, questionId, revision: revision + 1 };
  }

  #shape(row) {
    const label = this.db.prepare('SELECT * FROM _jevsql_labels WHERE case_id=? AND question_id=? ORDER BY revision DESC LIMIT 1')
      .get(row.case_id, row.question_id);
    return { caseId: row.case_id, questionId: row.question_id, workflow: row.workflow, split: row.split,
      splitSource: row.split_source, adversarial: Boolean(row.adversarial), usedForTuning: Boolean(row.used_for_tuning),
      dbEngine: row.db_engine, dbVersion: row.db_version, schemaVersion: row.schema_version, model: row.model,
      policyId: row.policy_id, policyVersion: row.policy_version, policyHash: row.policy_hash,
      promptTemplateVersion: row.prompt_template_version, stateHash: row.state_hash,
      questionType: row.question_type, answer: JSON.parse(row.answer_json), decision: row.decision,
      receiptId: row.receipt_id, latencyMs: row.latency_ms, inputTokens: row.input_tokens, recordedAt: row.recorded_at,
      goldLabel: label ? JSON.parse(label.gold_label) : null, outcome: label?.outcome ?? null,
      labelRevision: label?.revision ?? 0, adjudicator: label?.adjudicator ?? null };
  }

  get(caseId, questionId) {
    const row = this.db.prepare('SELECT * FROM _jevsql_cases WHERE case_id=? AND question_id=?').get(caseId, questionId);
    return row ? this.#shape(row) : null;
  }

  cases({ workflow, questionId, split, adversarial, labelled, limit = 10000 } = {}) {
    integer(limit, 'limit', 1, 1000000);
    const where = [], params = [];
    if (workflow != null) { where.push('workflow=?'); params.push(workflow); }
    if (questionId != null) { where.push('question_id=?'); params.push(questionId); }
    if (split != null) { where.push('split=?'); params.push(split); }
    if (adversarial != null) { where.push('adversarial=?'); params.push(adversarial ? 1 : 0); }
    const rows = this.db.prepare(`SELECT * FROM _jevsql_cases ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id LIMIT ?`)
      .all(...params, limit).map((row) => this.#shape(row));
    return labelled == null ? rows : rows.filter((row) => (row.labelRevision > 0) === Boolean(labelled));
  }

  /** Cases still waiting for a human, oldest first. */
  queue({ workflow, limit = 100 } = {}) {
    return this.cases({ workflow, labelled: false, limit });
  }

  /**
   * Project the corpus onto the row shape `evaluateBinary` and `qualifyRelease`
   * consume. `positive` names the gold label that counts as 1; for a Noul the
   * probability is the answer's own probability, and for a Choice it is the
   * probability mass on `positiveChoice`.
   */
  toBinaryRows({ workflow, questionId, positive = true, positiveChoice = null, split } = {}) {
    const rows = this.cases({ workflow, questionId, split }).filter((row) => row.labelRevision > 0);
    return rows.map((row) => {
      const answer = row.answer;
      let probability;
      if (row.questionType === 'noul') probability = answer.noul;
      else if (row.questionType === 'choice') probability = answer.probabilities?.[positiveChoice ?? answer.choice] ?? 0;
      else probability = answer.probabilities?.[String(positiveChoice ?? 0)] ?? 0;
      return { caseId: `${row.caseId}::${row.questionId}`, split: row.split,
        expected: stableJson(row.goldLabel) === stableJson(positive), probability,
        decision: row.decision ?? undefined, usedForTuning: row.usedForTuning,
        dialect: row.dbEngine ?? undefined, schemaVersion: row.schemaVersion ?? undefined,
        templateVersion: row.promptTemplateVersion ?? undefined, model: row.model ?? undefined };
    });
  }

  /** The ids declared as tuning data, for `qualifyRelease`'s overlap ledger. */
  tuningCaseIds({ workflow, questionId } = {}) {
    return this.cases({ workflow, questionId }).filter((row) => row.usedForTuning)
      .map((row) => `${row.caseId}::${row.questionId}`);
  }

  /** Progress against document B's proposed sizing, by distinct case. */
  coverage(targets = PROPOSED_TARGETS) {
    const rows = this.db.prepare(`SELECT workflow, split, adversarial, COUNT(DISTINCT case_id) AS cases FROM _jevsql_cases
      GROUP BY workflow, split, adversarial`).all();
    const byWorkflow = new Map();
    for (const row of rows) {
      const key = row.workflow;
      if (!byWorkflow.has(key)) byWorkflow.set(key, { workflow: key, cases: 0, adversarial: 0, splits: {} });
      const entry = byWorkflow.get(key);
      entry.cases += row.cases;
      if (row.adversarial) entry.adversarial += row.cases;
      entry.splits[row.split] = (entry.splits[row.split] ?? 0) + row.cases;
    }
    const labelled = new Set(this.db.prepare('SELECT DISTINCT case_id FROM _jevsql_labels').all().map((row) => row.case_id));
    const workflows = [...byWorkflow.values()].map((entry) => {
      const target = Object.entries(targets).find(([name]) => entry.workflow.includes(name))?.[1] ?? null;
      const adjudicated = this.db.prepare('SELECT COUNT(DISTINCT case_id) AS n FROM _jevsql_cases WHERE workflow=?').get(entry.workflow).n;
      const withLabels = this.cases({ workflow: entry.workflow }).filter((row) => row.labelRevision > 0);
      return { ...entry, target, adjudicatedCases: new Set(withLabels.map((row) => row.caseId)).size,
        totalCases: adjudicated, meetsTarget: target === null ? null : entry.cases >= target };
    }).sort((a, b) => a.workflow.localeCompare(b.workflow));
    return { workflows, totalCases: this.db.prepare('SELECT COUNT(DISTINCT case_id) AS n FROM _jevsql_cases').get().n,
      labelledCases: labelled.size, targets,
      ready: workflows.length > 0 && workflows.every((entry) => entry.meetsTarget !== false) };
  }

  export({ workflow } = {}) { return this.cases({ workflow }); }
  close() { this.db.close(); }
}

/** Import adjudicated cases from a plain array, for corpora built elsewhere. */
export function importCases(corpus, entries, { adjudicator = 'import' } = {}) {
  if (!Array.isArray(entries)) throw new TypeError('entries must be an array.');
  let recorded = 0, labelled = 0;
  for (const entry of entries) {
    corpus.record(entry);
    recorded++;
    if (entry.goldLabel !== undefined && entry.goldLabel !== null) {
      corpus.label(entry.caseId, entry.questionId, { goldLabel: entry.goldLabel, outcome: entry.outcome ?? null,
        adjudicator: entry.adjudicator ?? adjudicator, note: entry.note ?? '' });
      labelled++;
    }
  }
  return { recorded, labelled, digest: digest(entries.map((entry) => entry.caseId)) };
}
