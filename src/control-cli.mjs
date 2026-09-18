import { existsSync, readFileSync, statSync } from 'node:fs';
import { JevSQL } from './engine.mjs';
import { loadEnvFiles } from './env.mjs';
import { JudgmentCache } from './cache.mjs';
import { DatabaseControl, DecisionService, ReceiptStore, GovernedQueries, SQLiteAdapter, compareReads, POLICY_KINDS } from './control-plane.mjs';
import { diffSchemas, affectedAssets } from './schema.mjs';
import { analyzePlan, summarizeWorkload, routeReplica } from './telemetry.mjs';
import { evaluateBinary, evaluateMulticlass, compareEvaluations, qualifyRelease } from './metrics.mjs';
import { integer, nonNegative } from './validation.mjs';

const HELP = `jevsql control: governed reads, database reviews and measured release checks

USAGE
  jevsql control demo                         synthetic offline tour; --live uses Jev
  jevsql control schema --db data.db          inspect schema without reading records
  jevsql control drift change.json            deterministic contract diff and impact
  jevsql control migration change.json        migration review packet and test packs
  jevsql control query-review query.json      review proposed SQL; --db for SQLite compilation
  jevsql control review event.json            typed domain review or supplied custom policy
  jevsql control select-schema request.json   select relevant tables and retain FK bridges
  jevsql control plan plan.json               measure a PostgreSQL/MySQL/SQLite plan
  jevsql control triage incident.json         review plan symptoms or approved runbooks
  jevsql control workload events.json         deterministic query and N+1 measurements
  jevsql control replica cluster.json         choose a node from fresh health and lag evidence
  jevsql control route request.json --db db    preview a registered typed query
  jevsql control run request.json --db db      review and execute an eligible registered read
  jevsql control compare queries.json --db db compare bounded results in one read snapshot
  jevsql control metrics labels.json          binary or multiclass calibration and errors
  jevsql control qualify labels.json          enforce held-out release requirements
  jevsql control compare-metrics pair.json    compare evaluation reports
  jevsql control receipts --store audit.db    list saved review receipts
  jevsql control queue --store audit.db       list reviews awaiting a human label
  jevsql control feedback label.json --store audit.db  append a reviewed label
  jevsql control verify --store audit.db      check the local receipt hash chain

OPTIONS
  --db <file>                 existing SQLite database
  --store <file>              persist receipts and human labels
  --cache <file>              persisted review cache; default is process memory
  --model <version>           pinned model, default jev-1.13.0
  --max-estimated-cost <usd>  per-review estimate limit, default 0.10
  --max-judgments <n>         review question limit, default 1000
  --limit <n>                 receipt count, default 100
  --dry-run                   estimate without model requests or saved reviews
  --live                      use Jev for the synthetic demo
  --json                      JSON output is already the default

Review kinds: ${POLICY_KINDS.join(', ')}
Exit status: 0 completed or eligible; 2 review/block/failed qualification; 1 invalid input or execution error.
Run accepts the registered query grammar, with roles and tenant supplied by the trusted host.
`;

function parse(argv) {
  const opts = {}, positional = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => {
      const result = argv[++i];
      if (result == null || result.startsWith('--')) throw new Error(`Missing value for ${arg}.`);
      return result;
    };
    switch (arg) {
      case '--db': opts.db = value(); break;
      case '--store': opts.store = value(); break;
      case '--cache': opts.cache = value(); break;
      case '--model': opts.model = value(); break;
      case '--limit': opts.limit = integer(Number(value()), 'limit', 1, 10000); break;
      case '--max-judgments': opts.maxJudgments = integer(Number(value()), 'maxJudgments', 0); break;
      case '--max-estimated-cost': opts.maxEstimatedCostUsd = nonNegative(Number(value()), 'maxEstimatedCostUsd'); break;
      case '--dry-run': opts.dryRun = true; break;
      case '--live': opts.live = true; break;
      case '--json': break;
      case '--help': case '-h': opts.help = true; break;
      default:
        if (arg.startsWith('--')) throw new Error(`Unknown option ${arg}.`);
        positional.push(arg);
    }
  }
  return { opts, positional };
}

function jsonFile(file) {
  if (!file) throw new Error('A JSON input file is required.');
  if (statSync(file).size > 8 * 1024 * 1024) throw new RangeError('Input file exceeds 8 MiB. Split the batch.');
  return JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
}

export async function controlMain(argv) {
  const { opts, positional } = parse(argv), [command, file, extra] = positional;
  if (opts.help || !command) { console.log(HELP); return; }
  if (extra) throw new Error('Provide one JSON input file.');
  loadEnvFiles();
  if (command === 'demo') {
    if (opts.dryRun && opts.live) throw new Error('Use the offline demo or run a specific review with --dry-run.');
    const { runControlDemo } = await import('../examples/control-plane.mjs');
    console.log(JSON.stringify(await runControlDemo({ live: Boolean(opts.live) }), null, 2)); return;
  }
  const output = (value) => {
    console.log(JSON.stringify(value, null, 2));
    if (!opts.dryRun && (['block', 'review'].includes(value?.decision) || ['blocked', 'review'].includes(value?.status) || value?.ok === false)) process.exitCode = 2;
  };
  if (['receipts', 'queue', 'feedback', 'verify'].includes(command)) {
    if (!opts.store || !existsSync(opts.store)) throw new Error('An existing --store receipt database is required.');
    if (opts.dryRun && command === 'feedback') throw new Error('Feedback is a write; omit --dry-run to record a label.');
    const store = new ReceiptStore(opts.store);
    try {
      if (command === 'receipts') output(store.list({ limit: opts.limit ?? 100 }));
      else if (command === 'queue') output(store.queue({ limit: opts.limit ?? 100 }));
      else if (command === 'verify') output(store.verify());
      else { const input = jsonFile(file); output(store.feedback(input.receiptId, input)); }
    } finally { store.close(); }
    return;
  }
  const standalone = ['drift', 'plan', 'workload', 'replica', 'metrics', 'qualify', 'compare-metrics'];
  if (standalone.includes(command)) {
    const input = jsonFile(file);
    if (command === 'drift') {
      const changes = diffSchemas(input.before, input.after);
      output({ decision: changes.some((change) => change.severity === 'block') ? 'block' : changes.some((change) => change.severity === 'review') ? 'review' : 'eligible',
        changes, affectedAssets: affectedAssets(changes, input.assets ?? []) });
    } else if (command === 'plan') output(analyzePlan(input.plan ?? input, { dialect: input.dialect ?? 'postgresql' }));
    else if (command === 'workload') output(summarizeWorkload(input.events ?? input));
    else if (command === 'replica') {
      const result = routeReplica(input.nodes, input.requirements);
      output({ ...result, decision: result.nodeId == null ? 'review' : 'eligible' });
    } else if (command === 'metrics') {
      output(input.type === 'multiclass' ? evaluateMulticlass(input.rows, input.options) : evaluateBinary(input.rows ?? input, input.options));
    } else if (command === 'qualify') output(qualifyRelease(input.cases ?? input.rows, input.options));
    else output(compareEvaluations(input.baseline, input.candidate));
    return;
  }
  const supported = ['schema', 'migration', 'query-review', 'review', 'select-schema', 'triage', 'route', 'run', 'compare'];
  if (!supported.includes(command)) throw new Error(`Unknown control command ${command}. Use --help.`);
  if (['schema', 'route', 'run', 'compare'].includes(command) && !opts.db) throw new Error('This command needs --db <existing file>.');
  if (opts.db && !existsSync(opts.db)) throw new Error('The database file does not exist.');
  const engine = opts.db ? new JevSQL({ db: opts.db }) : null;
  let store, service;
  try {
    if (command === 'schema') { output(new DatabaseControl({ engine }).schema()); return; }
    const input = jsonFile(file);
    if (command === 'compare') { output(await compareReads(engine, input)); return; }
    store = opts.store && !opts.dryRun ? new ReceiptStore(opts.store) : null;
    service = new DecisionService({ ...(opts.model ? { model: opts.model } : {}),
      ...(opts.maxJudgments !== undefined ? { maxJudgments: opts.maxJudgments } : {}),
      ...(opts.maxEstimatedCostUsd !== undefined ? { maxEstimatedCostUsd: opts.maxEstimatedCostUsd } : {}),
      cache: new JudgmentCache(opts.cache ?? null), store });
    const control = new DatabaseControl({ engine, service }), options = { dryRun: Boolean(opts.dryRun) };
    if (command === 'migration') output(await control.reviewMigration(input, options));
    else if (command === 'query-review') output(await control.reviewQuery(input, options));
    else if (command === 'select-schema') output(await control.selectSchema(input, options));
    else if (command === 'triage') output(input.runbooks ? await control.triageIncident(input, options) : await control.triagePlan(input, options));
    else if (command === 'review') output(input.policy ? await control.custom(input.policy, input.state, options) : await control.review(input.kind, input.state, options));
    else {
      const gate = new GovernedQueries({ service, adapter: new SQLiteAdapter(engine), templates: input.templates,
        tenantColumns: input.tenantColumns ?? {}, allowExecution: command === 'run' && !opts.dryRun });
      const request = { ...options, request: input.request, actor: input.actor, params: input.params ?? {} };
      const result = input.templateId ? await gate.prepare(input.templateId, request) : await gate.route(input.request, request);
      if (command === 'run' && result.permit) output({ ...await gate.execute(result.permit, request), review: result.receipt });
      else output(result);
    }
  } finally {
    if (service) await service.close();
    if (store) store.close();
    if (engine) engine.close();
  }
}
