import { readFileSync } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { JevSQL } from './engine.mjs';
import { loadCsv } from './csv.mjs';
import { loadEnvFiles } from './env.mjs';
import { integer, nonNegative } from './validation.mjs';

const HELP = `jevsql: decision tables powered by TypeSafe’s Jev

USAGE
  jevsql query "<sql>" [options]     run a query
  jevsql explain "<sql>" [options]   show what it would cost, without calling the API
  jevsql repl [options]              interactive shell
  jevsql demo                        build a sample table and run example queries
  jevsql materialize <name> <sql>    save a decision table and its change history
  jevsql refresh <name>             refresh a saved decision table
  jevsql tables                     list saved decision tables
  jevsql changes <name>             read recorded changes
  jevsql check <checks.json>        run data checks; exit 2 on violations
  jevsql evaluate <sql>             measure accuracy and review load on labeled rows
  jevsql control <command>          governed reads, schema review, triage and calibration

OPTIONS
  --db <file>            SQLite database (default: in-memory)
  --csv <file[:table]>   load a CSV into a table (repeatable); table defaults to the filename
  --cache <file>         judgment cache (default: .jevsql-cache.json, --no-cache to disable)
  --max-judgments <n>    cost guard; refuse queries needing more (default: 1000)
  --file <sql-file>      read one query from a file
  --params <json>        positional array or named parameter object
  --model <id>           choose a version, for example jev-1.13.0
  --cache-namespace <s>  isolate a dataset or force a new set of judgments
  --max-estimated-cost <usd>  stop before batches exceed this estimated query cost
  --concurrency <n>      requests in flight (default: 4)
  --isolate-rows         send each distinct row in its own request
  --key <column>        stable key for a saved decision table (default: id)
  --revision <n>        filter change history to one refresh
  --limit <n>           change history size (default: 100)
  --dry-run             preview costs without model calls or saved changes
  --audit               emit rows, stats, and decision receipts as JSON
  --json                 print rows as JSON instead of a table
  --quiet                only print rows

SQL FUNCTIONS
  jev_noul(text, question [, criteria])          -> probability 0..1 that the answer is yes
  jev_bool(text, question [, threshold, criteria]) -> 1 or 0
  jev_choice(text, question, options [, minconf]) -> chosen label, NULL below minconf
  jev_choice_conf(text, question, options)      -> confidence 0..1
  jev_prob(text, question, options, label)      -> probability of one label
  jev_score(text, question, levels)             -> position on the ordered levels
  jev_score_conf(text, question, levels)        -> confidence 0..1
  jev_decide(text, question [, low, high])       -> 0, 1, or NULL for review
  jev_match(left, right [, question])           -> probability that records match
  jev_choice_probs(text, question, options)     -> full distribution as JSON
  jev_choice_top_prob(text, question, options)  -> winning option probability
  jev_choice_prob_gate(text, question, options [, minprob]) -> label or NULL
  jev_score_norm(text, question, levels)        -> score normalized to 0..1
  jev_score_probs(text, question, levels)       -> full distribution as JSON
  jev_candidates(text, kind)                   -> exact spans, no model call
  jev_pick(text, question, candidates [, minconf]) -> source span or NULL
  jev_pick_conf(text, question, candidates)     -> confidence in the selection
  (Choice accepts JSON maps with descriptions; Score accepts structured levels.)

EXAMPLE
  jevsql query "SELECT id, jev_score(body,'how urgent is this?','not urgent,soon,urgent,emergency') AS urgency
                FROM tickets WHERE status='open' AND jev_bool(body,'is the customer frustrated?')=1
                ORDER BY urgency DESC LIMIT 5" --csv examples/tickets.csv
`;

function parseArgs(argv) {
  const opts = { csv: [], cache: '.jevsql-cache.json' };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      const value = argv[++i];
      if (value == null || value.startsWith('--')) throw new Error(`Missing value for ${arg}.`);
      return value;
    };
    switch (arg) {
      case '--db': opts.db = next(); break;
      case '--csv': opts.csv.push(next()); break;
      case '--cache': opts.cache = next(); break;
      case '--no-cache': opts.cache = null; break;
      case '--max-judgments': opts.maxJudgments = integer(Number(next()), 'max judgments', 0); break;
      case '--file': opts.file = next(); break;
      case '--params': opts.params = JSON.parse(next()); break;
      case '--model': opts.model = next(); break;
      case '--cache-namespace': opts.cacheNamespace = next(); break;
      case '--max-estimated-cost': opts.maxEstimatedCostUsd = nonNegative(Number(next()), 'estimated cost'); break;
      case '--concurrency': opts.concurrency = integer(Number(next()), 'concurrency', 1, 32); break;
      case '--isolate-rows': opts.rowMode = 'isolated'; break;
      case '--key': opts.key = next(); break;
      case '--revision': opts.revision = integer(Number(next()), 'revision'); break;
      case '--limit': opts.limit = integer(Number(next()), 'limit'); break;
      case '--dry-run': opts.dryRun = true; break;
      case '--audit': opts.audit = true; break;
      case '--json': opts.json = true; break;
      case '--quiet': opts.quiet = true; break;
      case '-h': case '--help': opts.help = true; break;
      default:
        if (arg.startsWith('--')) throw new Error(`Unknown option ${arg}. Try --help.`);
        rest.push(arg);
    }
  }
  return { opts, rest };
}

function printTable(rows) {
  if (rows.length === 0) { console.log('(no rows)'); return; }
  const columns = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const cell = (v) => (v == null ? '' : typeof v === 'number' ? (Number.isInteger(v) ? String(v) : v.toFixed(3)) : String(v).replace(/\s+/g, ' '));
  const widths = columns.map((c) => Math.min(48, Math.max(c.length, ...rows.map((r) => cell(r[c]).length))));
  const line = (cells) => cells.map((v, i) => v.slice(0, widths[i]).padEnd(widths[i])).join('  ');
  console.log(line(columns));
  console.log(widths.map((w) => '-'.repeat(w)).join('  '));
  for (const row of rows) console.log(line(columns.map((c) => cell(row[c]))));
}

function summarize(stats) {
  const bits = [`${stats.wallMs} ms`];
  if (stats.judgments) bits.push(`${stats.judgments} judgments`);
  if (stats.requests) bits.push(`${stats.requests} request${stats.requests === 1 ? '' : 's'}`);
  if (stats.cacheHits) bits.push(`${stats.cacheHits} cached`);
  if (stats.inputTokens) bits.push(`${stats.inputTokens} tokens`);
  if (stats.costUsd) bits.push(`$${stats.costUsd.toFixed(6)}${stats.estimated ? ' (est)' : ''}`);
  if (stats.rounds > 1) bits.push(`${stats.rounds} rounds`);
  if (stats.relaxed?.length) bits.push(`relaxed ${stats.relaxed.join('+')} while collecting`);
  return bits.join(' · ');
}

function openEngine(opts) {
  const engine = new JevSQL({
    db: opts.db ?? ':memory:',
    cacheFile: opts.cache,
    ...(opts.maxJudgments != null ? { maxJudgments: opts.maxJudgments } : {}),
    ...(opts.model ? { model: opts.model } : {}),
    ...(opts.concurrency ? { concurrency: opts.concurrency } : {}),
    ...(opts.rowMode ? { rowMode: opts.rowMode } : {}),
    ...(opts.cacheNamespace ? { cacheNamespace: opts.cacheNamespace } : {}),
    ...(opts.maxEstimatedCostUsd != null ? { maxEstimatedCostUsd: opts.maxEstimatedCostUsd } : {}),
  });
  try {
    for (const spec of opts.csv) {
      const [file, named] = spec.split(/:(?![\\/])/);
      const table = named ?? path.basename(file).replace(/\.[^.]+$/, '').replace(/\W/g, '_');
      const count = loadCsv(engine.db, file, table);
      if (!opts.quiet) console.error(`loaded ${count} rows into ${table}`);
    }
  } catch (error) { engine.close(); throw error; }
  return engine;
}

async function runQuery(engine, sql, opts) {
  const result = await engine.query(sql, { params: opts.params ?? [], audit: opts.audit, dryRun: opts.dryRun });
  const { rows, stats } = result;
  if (opts.audit || opts.dryRun) console.log(JSON.stringify(result, null, 2));
  else if (opts.json) console.log(JSON.stringify(rows, null, 2));
  else printTable(rows);
  if (!opts.quiet) console.error(summarize(stats));
}

async function repl(engine, opts) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: 'jevsql> ' });
  console.log('JevSQL shell. End statements with a semicolon. .explain <sql>, .tables, .exit');
  rl.prompt();
  let buffer = '';
  for await (const line of rl) {
    const text = line.trim();
    if (text === '.exit' || text === '.quit') break;
    if (text === '.tables') {
      const tables = engine.db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all();
      console.log(tables.map((t) => t.name).join('  ') || '(none)');
      rl.prompt(); continue;
    }
    if (text.startsWith('.explain ')) {
      try { console.log(summarize(await engine.explain(text.slice(9)))); } catch (err) { console.error(err.message); }
      rl.prompt(); continue;
    }
    buffer += `${line}\n`;
    if (!buffer.trim().endsWith(';')) continue;
    const sql = buffer.trim().replace(/;$/, '');
    buffer = '';
    try { await runQuery(engine, sql, opts); } catch (err) { console.error(`error: ${err.message}`); }
    rl.prompt();
  }
  rl.close();
}

export async function main(argv) {
  if (argv[0] === 'control') {
    const { controlMain } = await import('./control-cli.mjs');
    return controlMain(argv.slice(1));
  }
  const { opts, rest } = parseArgs(argv);
  const command = rest[0];
  if (opts.help || !command) { console.log(HELP); return; }
  loadEnvFiles();

  if (command === 'demo') {
    const { runDemo } = await import('../examples/demo.mjs');
    await runDemo();
    return;
  }

  if (['materialize', 'refresh', 'tables', 'changes'].includes(command) && (!opts.db || opts.db === ':memory:')) {
    throw new Error('This command needs --db <file> so saved decisions survive the process.');
  }
  const sqlFor = (offset = 1) => {
    if (opts.file && rest.length > offset) throw new Error('Use either inline SQL or --file.');
    const sql = opts.file ? readFileSync(opts.file, 'utf8') : rest.slice(offset).join(' ');
    if (!sql.trim()) throw new Error('No SQL given.');
    return sql;
  };
  const output = (value) => console.log(JSON.stringify(value, null, 2));
  const engine = openEngine(opts);
  try {
    if (command === 'query') {
      await runQuery(engine, sqlFor(), opts);
    } else if (command === 'explain') {
      const stats = await engine.explain(sqlFor(), { params: opts.params ?? [] });
      if (opts.json) output(stats); else console.log(summarize(stats));
    } else if (command === 'materialize' || command === 'refresh') {
      if (!rest[1]) throw new Error('A decision table name is required.');
      const options = { key: opts.key ?? 'id', params: opts.params ?? [], dryRun: opts.dryRun };
      const result = command === 'materialize' ? await engine.materialize(rest[1], sqlFor(2), options) : await engine.refresh(rest[1], options);
      const { rows, decisions, ...summary } = result;
      output(opts.audit ? result : summary);
    } else if (command === 'tables') {
      const tables = engine.tables();
      if (opts.json) output(tables); else printTable(tables);
    } else if (command === 'changes') {
      output(engine.changes(rest[1], { revision: opts.revision, limit: opts.limit ?? 100 }));
    } else if (command === 'check') {
      if (!rest[1]) throw new Error('A checks JSON file is required.');
      const document = JSON.parse(readFileSync(rest[1], 'utf8'));
      const report = await engine.check(Array.isArray(document) ? document : document.checks, { dryRun: opts.dryRun });
      output(report);
      if (report.ok === false) process.exitCode = 2;
    } else if (command === 'evaluate') {
      if (opts.dryRun) output(await engine.explain(sqlFor(), { params: opts.params ?? [] }));
      else output(await engine.evaluate(sqlFor(), { params: opts.params ?? [] }));
    } else if (command === 'repl') {
      await repl(engine, opts);
    } else {
      throw new Error(`Unknown command “${command}”. Try --help.`);
    }
  } finally {
    engine.close();
  }
}
