import { DecisionService } from './decision-service.mjs';
import { inspectSchema, normalizeSchema, diffSchemas, affectedAssets, pruneSchema } from './schema.mjs';
import { analyzePlan, summarizeWorkload } from './telemetry.mjs';
import { inspectQuery, sqlMetadata } from './sql-inspector.mjs';
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
