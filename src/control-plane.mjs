import { DecisionService } from './decision-service.mjs';
import { inspectSchema, normalizeSchema, diffSchemas, affectedAssets, pruneSchema } from './schema.mjs';
import { analyzePlan, summarizeWorkload } from './telemetry.mjs';
import { buildLockGraph, summarizeBackups, summarizeReplication } from './operations.mjs';
import { buildLineage, propagateSensitivity, surprisingEdges } from './lineage.mjs';
import { compareAppTypes } from './app-types.mjs';
import { classifyStatement, inspectQuery, sqlMetadata } from './sql-inspector.mjs';
import { policyFor, incidentPolicy } from './policies.mjs';
import { digest } from './privacy.mjs';
import { integer, probability, stableJson } from './validation.mjs';

const requiredText = (value, name) => {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${name} is required.`);
  return value;
};

/** Metadata and decision workflows. Only GovernedQueries owns an execution path. */
export class DatabaseControl {
  constructor({ service = new DecisionService(), engine = null } = {}) { this.service = service; this.engine = engine; }
  schema() {
    if (!this.engine) throw new Error('A local SQLite engine is required for inspection.');
    return inspectSchema(this.engine.db);
  }

  review(kind, state, options = {}) { return this.service.review(policyFor(kind), state, options); }

  async reviewQuery({ request, sql, params = [], schema, policy = {}, dialect = schema?.dialect ?? 'sqlite' }, options = {}) {
    requiredText(request, 'Request');
    const metadata = sqlMetadata(sql, { dialect });
    const snapshot = schema ? normalizeSchema(schema) : this.engine ? this.schema() : null;
    if (!snapshot) throw new Error('Supply a schema snapshot or a local engine.');
    if (snapshot.dialect !== dialect) throw new TypeError('Query dialect and schema snapshot must match.');
    let inspection;
    if (dialect === 'sqlite' && this.engine) {
      inspection = inspectQuery(this.engine.db, sql, { params, allowedTables: policy.allowedTables, deniedColumns: policy.deniedColumns ?? [] });
    } else {
      inspection = { findings: [{ code: 'external_query_requires_native_validation', level: 'review',
        detail: 'External SQL review is advisory. Execution accepts registered compiled templates only.' }], tables: [] };
    }
    const names = inspection.tables.map((name) => name.replace(/^main\./, ''))
      .filter((name) => snapshot.tables.some((table) => table.name === name));
    const focused = names.length ? pruneSchema(snapshot, names) : snapshot;
    const receipt = await this.service.review(policyFor('query'), {
      request, candidate_sql: metadata.sql, schema: focused, policy,
      parsed_sql: { tables: inspection.tables, columns: inspection.columns ?? [], functions: inspection.functions ?? [] },
    }, { ...options, findings: [...inspection.findings, ...(options.findings ?? [])],
      context: { ...options.context, dialect, schemaVersion: snapshot.hash, sqlHash: digest(sql), paramsHash: digest(params) } });
    return { ...receipt, inspection, executionAllowed: false };
  }

  /**
   * Gate one agent-issued statement against its declared intent. Deterministic
   * classification decides the required approval; the typed answers are evidence
   * for whoever gives it. Nothing here can execute a statement, and no answer
   * can raise the approval this returns — a model can only lower eligibility.
   *
   * `environment` marks where the statement would run. Anything that is not a
   * read needs approval, a destructive or unbounded statement needs an
   * out-of-band human, and production keeps that requirement regardless of how
   * confidently the statement matches its intent.
   */
  async reviewStatement({ statement, intent, dialect = 'sqlite', actor = null,
    environment = 'unknown', scope = {}, policy = {} }, options = {}) {
    requiredText(intent, 'Declared intent');
    const classification = classifyStatement(statement, { dialect });
    const findings = [];
    if (classification.statementCount > 1) {
      findings.push({ level: 'block', code: 'multiple_statements', detail: 'Review one statement at a time; a batch hides its own operations.' });
    }
    if (classification.operation === 'unknown') {
      findings.push({ level: 'review', code: 'unclassified_operation', detail: 'The statement text does not determine an operation class.' });
    }
    if (classification.destructive) {
      findings.push({ level: 'review', code: 'destructive_statement', detail: `The statement ${classification.reasons.join(', ')}.` });
    }
    if (classification.unbounded) {
      findings.push({ level: 'review', code: 'unbounded_write', detail: 'The statement changes state without a WHERE clause or row limit.' });
    }
    if (classification.changesPermissions) {
      findings.push({ level: 'review', code: 'permission_change', detail: 'The statement changes roles, grants or policies.' });
    }
    if (classification.operation !== 'read' && environment === 'production') {
      findings.push({ level: 'review', code: 'production_write', detail: 'A statement that changes production state needs a named human approver.' });
    }
    const approval = classification.statementCount > 1 ? 'refused'
      : classification.destructive || classification.unbounded || classification.changesPermissions ? 'out_of_band_human'
        : classification.operation === 'read' ? 'none' : 'human';
    const receipt = await this.service.review(policyFor('statement'), {
      intent, candidate_statement: classification.sql, parsed_statement: classification,
      actor, environment, scope, policy,
    }, { ...options, findings: [...findings, ...(options.findings ?? [])],
      context: { ...options.context, dialect, environment, statementHash: digest(classification.sql) }, cacheTtlMs: 0 });
    return { ...receipt, classification, requiredApproval: approval,
      executionAllowed: false, statementExecuted: false };
  }

  async reviewMigration({ before, after, intent, sql = '', assets = [], contracts = {}, policy = {} }, options = {}) {
    requiredText(intent, 'Migration intent');
    const oldSchema = normalizeSchema(before), newSchema = normalizeSchema(after);
    const changes = diffSchemas(oldSchema, newSchema), impacted = affectedAssets(changes, assets);
    const findings = changes.map((change) => ({ level: change.severity === 'safe' ? 'info' : change.severity,
      code: change.kind, detail: change.reason, table: change.table ?? null, column: change.column ?? null }));
    const tests = new Set(['schema-contract']);
    for (const change of changes) {
      if (change.severity !== 'safe') { tests.add('read-path'); tests.add('write-path'); tests.add('rollback'); }
      if (/column_added|nullable|default|type/.test(change.kind)) tests.add('backfill');
      if (/foreign|primary|unique/.test(change.kind)) tests.add('constraint');
      if (/tenant/i.test(`${change.table ?? ''} ${change.column ?? ''}`)) tests.add('tenant-isolation');
    }
    for (const asset of impacted) for (const name of asset.testPacks ?? []) tests.add(requiredText(name, 'Test pack name'));
    const receipt = await this.service.review(policyFor('migration'), {
      intent, changes, consumers: impacted, contracts, policy,
      migration: sql ? sqlMetadata(sql, { dialect: newSchema.dialect }).sql : null,
    }, { ...options, findings: [...findings, ...(options.findings ?? [])],
      context: { ...options.context, dialect: newSchema.dialect, beforeSchema: oldSchema.hash,
        schemaVersion: newSchema.hash, artifactHash: digest({ before: oldSchema.hash, after: newSchema.hash, sql, intent, contracts, policy }) } });
    return { ...receipt, changes, affectedAssets: impacted, requiredTestPacks: [...tests].sort(),
      migrationExecuted: false, packetType: 'review-evidence' };
  }

  async triagePlan({ plan, dialect = 'postgresql', context = {}, events = [] }, options = {}) {
    const analysis = analyzePlan(plan, { dialect });
    const workload = summarizeWorkload(events);
    // Numeric features are computed before inference. A plan node is evidence,
    // not proof that a particular intervention will improve runtime.
    const receipt = await this.service.review(policyFor('plan'), { dialect, symptoms: analysis.symptoms,
      measured: analysis.summary, workload, context }, { ...options, context: { ...options.context, dialect }, cacheTtlMs: 0 });
    return { ...receipt, analysis, workload, actionExecuted: false };
  }

  async triageIncident({ evidence, runbooks, dialect = 'postgresql' }, options = {}) {
    const receipt = await this.service.review(incidentPolicy(runbooks), { evidence, dialect },
      { ...options, context: { ...options.context, dialect }, cacheTtlMs: 0 });
    const answer = receipt.answers?.runbook;
    const selected = answer && answer.choice !== 'unknown' && answer.confidence >= 0.9 && receipt.answers.enough_evidence?.noul >= 0.95
      ? runbooks.find((book) => book.id === answer.choice)?.id ?? null : null;
    return { ...receipt, suggestedRunbook: selected, actionExecuted: false };
  }

  async selectSchema({ request, schema, requiredTables = [], minRelevance = 0.8, maxTables = 50 }, options = {}) {
    requiredText(request, 'Request'); probability(minRelevance, 'minRelevance'); integer(maxTables, 'maxTables');
    const snapshot = normalizeSchema(schema);
    if (!snapshot.tables.length) return { decision: 'review', reason: 'empty_schema', schema: snapshot };
    const questions = Object.fromEntries(snapshot.tables.map((table, index) => [`table_${index}`, {
      type: 'noul', instructions: `Is table ${index} in tables needed to answer the exact request? Consider both records and required relationships.`,
    }]));
    const receipt = await this.service.review({ id: 'schema-selection', version: '1', questions }, {
      request, tables: snapshot.tables.map((table) => ({ name: table.name, columns: table.columns.map(({ name, type }) => ({ name, type })), foreignKeys: table.foreignKeys })),
    }, { ...options, context: { ...options.context, schemaVersion: snapshot.hash, dialect: snapshot.dialect } });
    if (options.dryRun) return receipt;
    const selected = [...new Set([...requiredTables, ...snapshot.tables.filter((table, index) => (receipt.answers[`table_${index}`]?.noul ?? 0) >= minRelevance).map((table) => table.name)])];
    if (!selected.length) return { ...receipt, selectedTables: [], schema: null, reason: 'no_relevant_schema' };
    const pruned = pruneSchema(snapshot, selected, { maxTables });
    return { ...receipt, selectedTables: selected, schema: pruned,
      reduction: { originalTables: snapshot.tables.length, retainedTables: pruned.tables.length,
        originalBytes: Buffer.byteLength(stableJson(snapshot)), retainedBytes: Buffer.byteLength(stableJson(pruned)) } };
  }

  /** Lock and deadlock triage. The wait graph, the cycles and the root blockers
   * are computed here; the model only names the family. */
  async triageLocks({ waits, statements = [], dialect = 'postgresql', context = {} }, options = {}) {
    const graph = buildLockGraph(waits);
    const receipt = await this.service.review(policyFor('locks'), {
      dialect, contention: graph.summary, cycles: graph.cycles,
      root_blockers: graph.rootBlockers, statements, context,
    }, { ...options, cacheTtlMs: 0,
      findings: [...(graph.deadlocked ? [{ level: 'review', code: 'deadlock_cycle',
        detail: `A wait-for cycle exists between ${graph.cycles[0].join(', ')}.` }] : []), ...(options.findings ?? [])],
      context: { ...options.context, dialect } });
    return { ...receipt, graph, actionExecuted: false };
  }

  /** Backup and point-in-time-recovery posture. Objectives are compared in code. */
  async reviewBackups({ jobs, rpoTargetMs = null, rtoTargetMs = null, nowMs = Date.now(), context = {} }, options = {}) {
    const posture = summarizeBackups(jobs, { nowMs, rpoTargetMs, rtoTargetMs });
    const findings = [];
    if (posture.recoveryPoint.met === false) findings.push({ level: 'review', code: 'recovery_point_missed', detail: 'The newest usable backup is older than the stated objective.' });
    if (posture.recoveryTime.met === false) findings.push({ level: 'review', code: 'recovery_time_missed', detail: 'The slowest restore drill exceeded the stated objective.' });
    if (posture.posture === 'no-verified-backup') findings.push({ level: 'review', code: 'no_verified_backup', detail: 'No verified backup was supplied.' });
    const receipt = await this.service.review(policyFor('backup'), { posture, context },
      { ...options, cacheTtlMs: 0, findings: [...findings, ...(options.findings ?? [])] });
    return { ...receipt, posture, restoreExecuted: false };
  }

  /** Replication health. Lag is measured upstream and bucketed before review. */
  async reviewReplication({ nodes, maxLagMs = null, nowMs = Date.now(), logs = [], context = {} }, options = {}) {
    const health = summarizeReplication(nodes, { nowMs, maxLagMs });
    const findings = health.summary.posture === 'healthy' ? []
      : [{ level: 'review', code: `replication_${health.summary.posture.replace(/-/g, '_')}`, detail: `Replication posture is ${health.summary.posture}.` }];
    const receipt = await this.service.review(policyFor('replication'), { health: health.summary, nodes: health.nodes, logs, context },
      { ...options, cacheTtlMs: 0, findings: [...findings, ...(options.findings ?? [])] });
    return { ...receipt, health, failoverExecuted: false };
  }

  /** Application types against the live schema. The comparison is deterministic;
   * only the divergences that survive it are sent for judgement. */
  async reviewTypes({ appModel, schema, context = {} }, options = {}) {
    const snapshot = schema ? normalizeSchema(schema) : this.engine ? this.schema() : null;
    if (!snapshot) throw new Error('Supply a schema snapshot or a local engine.');
    const report = compareAppTypes(appModel, snapshot);
    const findings = report.divergences.filter((item) => item.level !== 'info')
      .map((item) => ({ level: item.level, code: item.code, detail: item.detail,
        table: item.table ?? null, column: item.column ?? null }));
    const ambiguous = report.divergences.filter((item) => item.level === 'review');
    // Nothing to judge when the deterministic comparison is already conclusive.
    if (!ambiguous.length) {
      return { decision: findings.some((item) => item.level === 'block') ? 'block' : 'eligible',
        reasons: findings.map((item) => item.code), source: 'rules', report, answers: {}, findings,
        divergences: report.divergences, migrationExecuted: false };
    }
    const receipt = await this.service.review(policyFor('types'), {
      language: report.language, divergences: ambiguous, coverage: report.coverage, context,
    }, { ...options, findings: [...findings, ...(options.findings ?? [])],
      context: { ...options.context, schemaVersion: snapshot.hash, appHash: report.appHash } });
    return { ...receipt, report, divergences: report.divergences, migrationExecuted: false };
  }

  /** Repeated-query evidence. Counting happens upstream, as the documents require. */
  async reviewOrm({ events, models = [], context = {} }, options = {}) {
    const workload = summarizeWorkload(events);
    const findings = workload.nPlusOneCandidates.length
      ? [{ level: 'review', code: 'repeated_query_shapes', detail: `${workload.nPlusOneCandidates.length} shape(s) repeat within a single request.` }] : [];
    const receipt = await this.service.review(policyFor('orm'), {
      repeated_shapes: workload.nPlusOneCandidates, costly_shapes: workload.costlyPatterns?.slice(0, 10) ?? [],
      measured: { totalEvents: workload.totalEvents, requests: workload.requestCount, durations: workload.durations },
      models, context,
    }, { ...options, findings: [...findings, ...(options.findings ?? [])], cacheTtlMs: 0 });
    return { ...receipt, workload, changeApplied: false };
  }

  /** Spend grouping. All arithmetic is supplied; the model groups by purpose. */
  async reviewCost({ workloads, context = {} }, options = {}) {
    if (!Array.isArray(workloads) || !workloads.length) throw new TypeError('Supply measured workloads.');
    const receipt = await this.service.review(policyFor('cost'), { workloads, context },
      { ...options, cacheTtlMs: 0 });
    return { ...receipt, changeApplied: false };
  }

  /** Ambiguous credential-like values that rules could not settle. */
  async reviewSecrets({ fragments, context = {} }, options = {}) {
    if (!Array.isArray(fragments) || !fragments.length) throw new TypeError('Supply minimised fragments to review.');
    const receipt = await this.service.review(policyFor('secrets'), { fragments, context },
      { ...options, cacheTtlMs: 0 });
    return { ...receipt, rotationPerformed: false };
  }

  /** Lineage enrichment. Propagation and surprising edges are computed first. */
  async reviewLineage({ jobs, datasets = [], allowedCrossDomain = [], context = {} }, options = {}) {
    const graph = buildLineage(jobs, { datasets });
    const propagation = propagateSensitivity(graph);
    const surprises = surprisingEdges(graph, { allowedCrossDomain });
    const findings = [...propagation.findings.filter((item) => item.level !== 'info')
      .map((item) => ({ level: item.level, code: item.code, detail: item.detail })),
    ...surprises.map((item) => ({ level: 'review', code: item.code, detail: `${item.from} flows to ${item.to} via ${item.job}.` }))];
    const receipt = await this.service.review(policyFor('lineage'), {
      edges: graph.edges.slice(0, 200), datasets: graph.nodes.map(({ name, domain, owner, sensitivity, purpose }) => ({ name, domain, owner, sensitivity, purpose })),
      inherited_sensitivity: propagation.effective, surprising_edges: surprises, context,
    }, { ...options, findings: [...findings, ...(options.findings ?? [])],
      context: { ...options.context, lineageHash: graph.hash } });
    return { ...receipt, graph, propagation, surprisingEdges: surprises, catalogUpdated: false };
  }

  /** A candidate rewrite or index, with its measured evidence attached. */
  async reviewCandidate({ original, candidate, requirements, measurements = null, propertyEvidence = null, context = {} }, options = {}) {
    requiredText(requirements, 'Stated requirements');
    const findings = [];
    if (propertyEvidence && propertyEvidence.equivalent === false) {
      findings.push({ level: 'block', code: 'property_test_failed',
        detail: `The candidate returned different results on ${propertyEvidence.failed} fixture(s).` });
    }
    if (measurements && measurements.sameRowCount === false) {
      findings.push({ level: 'block', code: 'row_count_changed', detail: 'The measured candidate returned a different number of rows.' });
    }
    const receipt = await this.service.review(policyFor('candidate'), {
      requirements, original, candidate,
      measured: measurements ? { verdict: measurements.verdict, planChanged: measurements.planChanged,
        medianImprovement: measurements.medianImprovement } : null,
      property_tests: propertyEvidence ? { equivalent: propertyEvidence.equivalent, fixtures: propertyEvidence.fixtures,
        failed: propertyEvidence.failed, failedNames: propertyEvidence.results?.filter((item) => !item.equal).map((item) => item.name) } : null,
      context,
    }, { ...options, findings: [...findings, ...(options.findings ?? [])] });
    return { ...receipt, promoted: false };
  }

  /** Cross-engine equivalence. Neither statement is executed here. */
  async reviewDialect({ source, target, sourceDialect, targetDialect, requirements = '', context = {} }, options = {}) {
    const receipt = await this.service.review(policyFor('dialect'), {
      source: sqlMetadata(source, { dialect: sourceDialect }).sql,
      target: sqlMetadata(target, { dialect: targetDialect }).sql,
      sourceDialect, targetDialect, requirements, context,
    }, { ...options, context: { ...options.context, sourceDialect, targetDialect } });
    return { ...receipt, translated: false, migrationExecuted: false };
  }

  /** Generated fixture coherence. Constraint satisfaction is already proved by
   * inserting the rows; this judges whether the scenario reads as plausible. */
  async reviewSeedRealism({ tables, rules = '', context = {} }, options = {}) {
    const receipt = await this.service.review(policyFor('realism'), { tables, rules, context }, options);
    return { ...receipt, dataUsed: false };
  }

  /** A saved extension point for domain rubrics, with the same versioning,
   * privacy, receipts, budgets and error paths as the built-in workflows. */
  custom(policy, state, options) { return this.service.review(policy, state, options); }
}

/** Compare bounded SQLite results under one read snapshot. Preserves duplicate
 * rows and value types; ordering is checked only when requested. A successful
 * comparison is fixture evidence, not a proof for every possible database.
 */
export async function compareReads(engine, { original, candidate, params = [], candidateParams = params, ordered = false, maxRows = 1000 }) {
  integer(maxRows, 'maxRows', 1, 100000);
  for (const [sql, values] of [[original, params], [candidate, candidateParams]]) {
    const inspection = inspectQuery(engine.db, sql, { params: values });
    if (inspection.findings.some((finding) => finding.level === 'block')) throw new Error('Candidate comparison requires approved pure read statements.');
  }
  engine.exec('SAVEPOINT _jevsql_compare_reads');
  const db = engine.db, previous = db.prepare('PRAGMA query_only').get().query_only;
  try {
    db.exec('PRAGMA query_only=ON');
    const read = (sql, values) => {
      const statement = db.prepare(sql), rows = [];
      const cursor = Array.isArray(values) ? statement.iterate(...values) : statement.iterate(values);
      for (const row of cursor) {
        if (rows.length >= maxRows) throw new RangeError('Comparison row limit exceeded. Narrow the fixture query.');
        rows.push(row);
      }
      return { columns: statement.columns().map(({ name }) => name), rows };
    };
    const a = read(original, params), b = read(candidate, candidateParams);
    const encode = (row, columns) => stableJson(columns.map((column) => {
      const value = row[column];
      return value instanceof Uint8Array ? ['blob', Buffer.from(value).toString('base64')] : [typeof value, value];
    }));
    const left = a.rows.map((row) => encode(row, a.columns)), right = b.rows.map((row) => encode(row, b.columns));
    if (!ordered) { left.sort(); right.sort(); }
    const columnsMatch = stableJson(a.columns) === stableJson(b.columns);
    const equal = columnsMatch && stableJson(left) === stableJson(right);
    db.exec(`PRAGMA query_only=${previous ? 'ON' : 'OFF'}`); db.exec('RELEASE _jevsql_compare_reads');
    return { equal, ordered, columnsMatch, originalRows: left.length, candidateRows: right.length,
      originalHash: digest(left), candidateHash: digest(right), evidence: 'current-database-snapshot' };
  } catch (error) {
    db.exec(`PRAGMA query_only=${previous ? 'ON' : 'OFF'}`);
    db.exec('ROLLBACK TO _jevsql_compare_reads'); db.exec('RELEASE _jevsql_compare_reads'); throw error;
  }
}

export { DecisionService } from './decision-service.mjs';
export { ReceiptStore } from './receipts.mjs';
export { GovernedQueries } from './governed-queries.mjs';
export { SQLiteAdapter, PostgreSQLAdapter, MySQLAdapter } from './adapters.mjs';
export { POLICY_KINDS, policyFor } from './policies.mjs';
export { classifyStatement, inspectQuery, sqlMetadata } from './sql-inspector.mjs';
export { buildLockGraph, summarizeBackups, summarizeReplication } from './operations.mjs';
export { buildLineage, propagateSensitivity, surprisingEdges, discoverLineage } from './lineage.mjs';
export { compareAppTypes, normalizeAppModel, assetsFromAppTypes } from './app-types.mjs';
export { verifyMigration, standardPacks } from './migration-runner.mjs';
export { generateSeedData, applySeedData } from './seed.mjs';
export { proposeIndexes, measureIndexCandidate, propertyCompare, edgeCaseFixtures, extractAccessPattern } from './candidates.mjs';
export { SemanticLayer, defineMetric, metricTemplate } from './semantic-layer.mjs';
export { EvaluationCorpus, splitFor, importCases, PROPOSED_TARGETS } from './corpus.mjs';
export { ShadowRunner, promotionStatus, assessWorkflow, adversarialOutcome, rescore, STAGES } from './shadow.mjs';
export { scanText, scanState, fence, runAdversarialSuite, ADVERSARIAL_CASES } from './injection.mjs';
export { CascadingRouter, decisionTier, humanTier, cascadeEconomics } from './escalation.mjs';
