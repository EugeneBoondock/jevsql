import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { JevSQL } from './engine.mjs';
import { loadCsv } from './csv.mjs';

const HELP = `jevsql — SQL with natural-language predicates, judged by TypeSafe's Jev

USAGE
  jevsql query "<sql>" [options]     run a query
  jevsql explain "<sql>" [options]   show what it would cost, without calling the API
  jevsql repl [options]              interactive shell
  jevsql demo                        build a sample table and run example queries

OPTIONS
  --db <file>            SQLite database (default: in-memory)
  --csv <file[:table]>   load a CSV into a table (repeatable); table defaults to the filename
  --cache <file>         judgment cache (default: .jevsql-cache.json, --no-cache to disable)
  --max-judgments <n>    cost guard; refuse queries needing more (default: 1000)
  --json                 print rows as JSON instead of a table
  --quiet                only print rows

SQL FUNCTIONS
  jev_noul(text, question)                      -> probability 0..1 that the answer is yes
  jev_bool(text, question [, threshold=0.5])    -> 1 or 0
  jev_choice(text, question, options [, minconf]) -> chosen label, NULL below minconf
  jev_choice_conf(text, question, options)      -> confidence 0..1
  jev_prob(text, question, options, label)      -> probability of one label
  jev_score(text, question, levels)             -> position on the ordered levels
  jev_score_conf(text, question, levels)        -> confidence 0..1
  (options/levels: JSON array, or a comma- or pipe-separated list)

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
    const next = () => argv[++i];
    switch (arg) {
      case '--db': opts.db = next(); break;
      case '--csv': opts.csv.push(next()); break;
      case '--cache': opts.cache = next(); break;
      case '--no-cache': opts.cache = null; break;
      case '--max-judgments': opts.maxJudgments = Number(next()); break;
      case '--json': opts.json = true; break;
      case '--quiet': opts.quiet = true; break;
      case '-h': case '--help': opts.help = true; break;
      default: rest.push(arg);
    }
  }
  return { opts, rest };
}

function loadDotEnv(file = '.env') {
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
  }
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
    ...(opts.maxJudgments ? { maxJudgments: opts.maxJudgments } : {}),
  });
  for (const spec of opts.csv) {
    const [file, named] = spec.split(/:(?![\\/])/);
    const table = named ?? path.basename(file).replace(/\.[^.]+$/, '').replace(/\W/g, '_');
    const count = loadCsv(engine.db, file, table);
    if (!opts.quiet) console.error(`loaded ${count} rows into ${table}`);
  }
  return engine;
}

async function runQuery(engine, sql, opts) {
  const { rows, stats } = await engine.query(sql);
  if (opts.json) console.log(JSON.stringify(rows, null, 2));
  else printTable(rows);
  if (!opts.quiet) console.error(summarize(stats));
}

async function repl(engine, opts) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: 'jevsql> ' });
  console.log('JevSQL shell. End statements with ";". .explain <sql>, .tables, .exit');
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
  const { opts, rest } = parseArgs(argv);
  const command = rest[0];
  if (opts.help || !command) { console.log(HELP); return; }
  loadDotEnv();

  if (command === 'demo') {
    const { runDemo } = await import('../examples/demo.mjs');
    await runDemo();
    return;
  }

  const engine = openEngine(opts);
  try {
    if (command === 'query') {
      const sql = rest.slice(1).join(' ');
      if (!sql) throw new Error('no SQL given');
      await runQuery(engine, sql, opts);
    } else if (command === 'explain') {
      const sql = rest.slice(1).join(' ');
      if (!sql) throw new Error('no SQL given');
      console.log(summarize(await engine.explain(sql)));
    } else if (command === 'repl') {
      await repl(engine, opts);
    } else {
      throw new Error(`unknown command "${command}". Try --help.`);
    }
  } finally {
    engine.close();
  }
}
