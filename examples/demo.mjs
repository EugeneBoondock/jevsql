// A guided tour: load a CSV of support tickets, then ask SQL questions that
// ordinary SQL cannot answer. Needs TYPESAFE_API_KEY (see .env.example).
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { JevSQL } from '../src/engine.mjs';
import { loadCsv } from '../src/csv.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const QUERIES = [
  {
    title: 'Triage: route every open ticket and show how sure Jev is',
    sql: `SELECT id, customer,
                 jev_choice(body, 'Which team should handle this ticket?', 'billing,technical,sales,cancellation') AS team,
                 round(jev_choice_conf(body, 'Which team should handle this ticket?', 'billing,technical,sales,cancellation'), 2) AS confidence
          FROM tickets WHERE status = 'open' ORDER BY confidence ASC LIMIT 6`,
  },
  {
    title: 'Filter on meaning: open tickets where the customer sounds angry',
    sql: `SELECT id, customer, substr(body, 1, 60) || '...' AS excerpt
          FROM tickets
          WHERE status = 'open' AND jev_bool(body, 'Is the customer angry or frustrated?', 0.6) = 1
          ORDER BY id`,
  },
  {
    title: 'Rank by judgment: the most urgent open tickets',
    sql: `SELECT id, customer,
                 round(jev_score(body, 'How urgent is this for the customer?', 'no rush,this week,today,production is down'), 2) AS urgency
          FROM tickets WHERE status = 'open' ORDER BY urgency DESC LIMIT 5`,
  },
  {
    title: 'Aggregate over judgments: churn risk by team',
    sql: `SELECT jev_choice(body, 'Which team should handle this ticket?', 'billing,technical,sales,cancellation') AS team,
                 COUNT(*) AS tickets,
                 round(AVG(jev_noul(body, 'Is this customer at risk of leaving?')), 3) AS avg_churn_risk
          FROM tickets WHERE status = 'open'
          GROUP BY team ORDER BY avg_churn_risk DESC`,
  },
];

export async function runDemo() {
  const engine = new JevSQL({ cacheFile: path.join(HERE, '.demo-cache.json'), maxJudgments: 200 });
  const rows = loadCsv(engine.db, path.join(HERE, 'tickets.csv'), 'tickets');
  console.log(`Loaded ${rows} tickets.\n`);

  try {
    for (const { title, sql } of QUERIES) {
      console.log(`\x1b[1m${title}\x1b[0m`);
      console.log(`\x1b[90m${sql.trim().replace(/\s+/g, ' ')}\x1b[0m`);
      const started = performance.now();
      const { rows: result, stats } = await engine.query(sql);
      console.table(result);
      console.log(`  ${Math.round(performance.now() - started)} ms · ${stats.judgments} judgments · ${stats.requests} request(s)`
        + ` · ${stats.cacheHits} from cache · $${stats.costUsd.toFixed(6)}\n`);
    }
    console.log('Run it again: every judgment is cached, so the same queries cost nothing.');
  } finally {
    engine.close();
  }
}

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  const { existsSync, readFileSync } = await import('node:fs');
  const envFile = path.join(HERE, '..', '.env');
  if (existsSync(envFile)) {
    for (const line of readFileSync(envFile, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
    }
  }
  runDemo().catch((err) => { console.error(err.message); process.exit(1); });
}
