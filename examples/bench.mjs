// Scale check: how many requests, how long, how much for N rows x M questions.
// Usage: node examples/bench.mjs [rows=100]
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { JevSQL } from '../src/engine.mjs';
import { parseCsv } from '../src/csv.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const envFile = path.join(HERE, '..', '.env');
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
  }
}

const wanted = Number(process.argv[2] ?? 100);
const source = parseCsv(readFileSync(path.join(HERE, 'tickets.csv'), 'utf8')).slice(1);

const engine = new JevSQL({ cacheFile: null, maxJudgments: 5000 });
engine.exec('CREATE TABLE tickets (id INTEGER, body TEXT)');
const insert = engine.prepare('INSERT INTO tickets VALUES (?, ?)');
for (let i = 0; i < wanted; i++) {
  const [, , , body] = source[i % source.length];
  insert.run(i + 1, `Ticket #${i + 1}. ${body}`);
}

const sql = `SELECT id,
    jev_noul(body, 'Is the customer angry or frustrated?') AS frustrated,
    jev_score(body, 'How urgent is this?', 'no rush,this week,today,production is down') AS urgency
  FROM tickets`;

console.log(`${wanted} rows x 2 questions = ${wanted * 2} judgments`);
const cold = await engine.query(sql);
console.log(`cold : ${cold.stats.wallMs} ms · ${cold.stats.requests} requests · ${cold.stats.inputTokens} tokens · $${cold.stats.costUsd.toFixed(5)}`
  + ` · ${Math.round(cold.stats.wallMs / (wanted * 2))} ms per judgment`);

const warm = await engine.query(sql);
console.log(`warm : ${warm.stats.wallMs} ms · ${warm.stats.requests} requests · ${warm.stats.cacheHits} served from cache · $${warm.stats.costUsd.toFixed(5)}`);

// EXPLAIN on a fresh engine (nothing resolved yet) shows the full bill up front.
const dry = new JevSQL({ cacheFile: null });
dry.exec('CREATE TABLE tickets (id INTEGER, body TEXT)');
const dryInsert = dry.prepare('INSERT INTO tickets VALUES (?, ?)');
for (let i = 0; i < wanted; i++) dryInsert.run(i + 1, `Ticket #${i + 1}. ${source[i % source.length][3]}`);
const explained = await dry.explain(sql);
console.log(`explain (dry run, no API calls): ${explained.judgments} judgments, ${explained.requests} requests,`
  + ` ~${explained.inputTokens} tokens, ~$${explained.costUsd.toFixed(5)}`);
dry.close();
engine.close();
