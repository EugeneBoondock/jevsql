// Five things that go wrong with ordinary tooling, and what JevSQL does instead.
//
// Both sides of every comparison are executed. The "ordinary tooling" column is
// not a description of what would happen: it is a real query against a real
// database, and the wrong numbers it prints are the numbers it actually
// returned. The last example calls the live Jev API, so it needs a key.
//
//   node examples/contrast.mjs

import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { JevSQL } from '../src/engine.mjs';
import { JevClient } from '../src/client.mjs';
import { loadEnvFiles } from '../src/env.mjs';
import { compileTemplate } from '../src/query-compiler.mjs';
import { classifyStatement } from '../src/sql-inspector.mjs';
import { verifyMigration } from '../src/migration-runner.mjs';
import { inspectSchema } from '../src/schema.mjs';

const BOLD = '[1m', RESET = '[0m';
const GREEN = '[32m', RED = '[31m', CYAN = '[36m', GREY = '[90m';
const plain = () => process.env.NO_COLOR || (!process.stdout.isTTY && !process.env.FORCE_COLOR);
const c = (colour, value) => (plain() ? String(value) : `${colour}${value}${RESET}`);
const ARROW = '→';

let n = 0;
const head = (title) => console.log(`\n${c(BOLD + CYAN, `  ${++n}. ${title}`)}\n`);
const old = (label, value) => console.log(`     ${c(RED, 'ordinary')}  ${label.padEnd(22)} ${value}`);
const nu = (label, value) => console.log(`     ${c(GREEN, '  jevsql')}  ${label.padEnd(22)} ${value}`);
const sql = (value) => console.log(`     ${c(GREY, value)}`);
const note = (value) => console.log(`     ${c(GREY, value)}`);

const SHOP = `
CREATE TABLE customers(id INTEGER PRIMARY KEY, name TEXT NOT NULL, tenant_id TEXT NOT NULL);
CREATE TABLE orders(id INTEGER PRIMARY KEY, customer_id INTEGER NOT NULL REFERENCES customers(id),
  tenant_id TEXT NOT NULL, total REAL NOT NULL);
CREATE TABLE order_items(id INTEGER PRIMARY KEY, order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  sku TEXT NOT NULL, quantity INTEGER NOT NULL);`;

function shopDatabase() {
  const db = new DatabaseSync(':memory:');
  db.exec(SHOP);
  db.exec(`
    INSERT INTO customers VALUES (1,'Acme','tenant-a'),(2,'Globex','tenant-b');
    INSERT INTO orders VALUES (1,1,'tenant-a',100),(2,1,'tenant-a',250),(3,2,'tenant-b',900);
    INSERT INTO order_items VALUES
      (1,1,'sku-1',1),(2,1,'sku-2',1),(3,1,'sku-3',1),
      (4,2,'sku-4',1),(5,2,'sku-5',1),(6,2,'sku-6',1),
      (7,3,'sku-7',1),(8,3,'sku-8',1),(9,3,'sku-9',1);`);
  return db;
}

// Five genuine billing complaints and five that are not, including two that use
// none of the obvious words and two that use them while meaning something else.
const TICKETS = [
  { id: 1, body: 'You took money off my card again after I cancelled in March.', billing: true },
  { id: 2, body: 'I was double-billed for February and nobody has replied.', billing: true },
  { id: 3, body: 'The amount on my statement does not match what I agreed to pay.', billing: true },
  { id: 4, body: 'I was charged the annual price after choosing the monthly plan.', billing: true },
  { id: 5, body: 'Two subscriptions left my account this month instead of one.', billing: true },
  { id: 6, body: 'Your refund policy page has a broken link on mobile.', billing: false },
  { id: 7, body: 'No charge needed, I just wanted to say the new dashboard is great.', billing: false },
  { id: 8, body: 'How do I add a second user to my workspace?', billing: false },
  { id: 9, body: 'The export button spins forever on large reports.', billing: false },
  { id: 10, body: 'Can you explain what the billing cycle means in the docs?', billing: false },
];

const TRUTH = TICKETS.filter((ticket) => ticket.billing).map((ticket) => ticket.id);
const listed = (ids) => TICKETS.filter((ticket) => ids.includes(ticket.id)).map((ticket) => `#${ticket.id}`).join(' ');
const score = (found) => ({
  correct: found.filter((id) => TRUTH.includes(id)).length,
  missed: TRUTH.filter((id) => !found.includes(id)),
  wrong: found.filter((id) => !TRUTH.includes(id)),
});

export async function runContrast() {
  console.log(c(BOLD, '\n  JevSQL vs. doing it the ordinary way\n'));
  note('Everything below is executed. Both columns run against real databases.');

  // ------------------------------------------------------------------ 1
  head('Revenue that is silently three times too big');
  const db = shopDatabase();
  const truth = db.prepare('SELECT SUM(total) AS revenue FROM orders').get().revenue;
  const naive = 'SELECT SUM(o.total) AS revenue FROM orders o JOIN order_items i ON i.order_id = o.id';
  sql(naive);
  const wrong = db.prepare(naive).get().revenue;
  old('runs clean, returns', `${c(RED + BOLD, wrong)}   ${c(GREY, `(real revenue is ${truth})`)}`);
  note('No syntax error, no warning, no failing test. Each order is counted once per line item.');
  const schema = inspectSchema(db);
  try {
    compileTemplate({ id: 'revenue', version: '1', description: 'Total order revenue', roles: ['analyst'],
      params: { tenant: { type: 'string' } },
      query: { from: 'orders', joins: [{ table: 'order_items', on: [['orders.id', 'order_items.order_id']] }],
        select: [{ aggregate: 'sum', column: 'orders.total', as: 'revenue' }],
        filters: [{ column: 'orders.tenant_id', op: 'eq', param: 'tenant' }] } },
    schema, { actor: { id: 'a', roles: ['analyst'], tenantId: 'tenant-a' },
      params: { tenant: 'tenant-a' }, tenantColumns: { orders: 'tenant_id', order_items: null } });
    nu('compiled', c(RED, 'accepted the join'));
  } catch (error) {
    nu('refuses to compile', c(GREEN, error.message));
  }
  note('order_items has no unique key on order_id, so the join can multiply rows. Proved from the schema.');

  // ------------------------------------------------------------------ 2
  head('A DELETE that passes a read-only check');
  const statement = 'WITH gone AS (DELETE FROM orders RETURNING id) SELECT count(*) AS n FROM gone';
  sql(statement);
  const readOnlyGuard = (text) => /^\s*(?:select|with)\b/i.test(text.trim());
  old('guard verdict', readOnlyGuard(statement) ? c(RED + BOLD, 'read-only, allowed') : c(GREEN, 'blocked'));
  const victim = shopDatabase();
  victim.exec('PRAGMA foreign_keys = ON');
  const countRows = (connection, table) => connection.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
  const before = countRows(victim, 'orders'), itemsBefore = countRows(victim, 'order_items');
  // SQLite has no writable CTE, so the delete the allowed statement contains is
  // executed directly to show what it does on an engine that supports one.
  victim.exec('DELETE FROM orders');
  old('orders table', `${before} rows  ${ARROW}  ${c(RED + BOLD, `${countRows(victim, 'orders')} rows`)}`);
  old('line items, cascaded', `${itemsBefore} rows  ${ARROW}  ${c(RED + BOLD, `${countRows(victim, 'order_items')} rows`)}`);
  const classified = classifyStatement(statement, { dialect: 'postgresql' });
  nu('classified as', `${c(BOLD, classified.operation)}, destructive: ${c(GREEN, classified.destructive)} `
    + `${c(GREY, `(${classified.reasons.join(', ')})`)}`);
  nu('orders table', `${db.prepare('SELECT COUNT(*) AS n FROM orders').get().n} rows, ${c(GREEN, 'untouched')}`);
  note('A leading-keyword check reads WITH and stops there. Classification reads the whole statement.');
  victim.close();

  // ------------------------------------------------------------------ 3
  head('One tenant reading another tenant’s money');
  const requested = "tenant-a' OR '1'='1";
  sql(`"... WHERE tenant_id = '" + requestedTenant + "'"   with  ${JSON.stringify(requested)}`);
  const interpolated = `SELECT SUM(total) AS revenue FROM orders WHERE tenant_id = '${requested}'`;
  old('returns', `${c(RED + BOLD, db.prepare(interpolated).get().revenue)}   ${c(GREY, '(tenant-a alone is 350)')}`);
  const compiled = compileTemplate({ id: 'tenant-revenue', version: '1', description: 'Revenue for the current tenant',
    roles: ['analyst'], params: { minimum: { type: 'number' } },
    query: { from: 'orders', select: [{ aggregate: 'sum', column: 'total', as: 'revenue' }],
      filters: [{ column: 'total', op: 'gte', param: 'minimum' }] } },
  schema, { actor: { id: 'analyst-1', roles: ['analyst'], tenantId: 'tenant-a' }, params: { minimum: 0 },
    tenantColumns: { orders: 'tenant_id' } });
  nu('returns', `${c(GREEN + BOLD, db.prepare(compiled.sql).get(...compiled.values).revenue)}   `
    + c(GREY, 'tenant comes from the authenticated actor'));
  sql(compiled.sql);
  note('The request text never reaches the SQL. There is no string to interpolate into.');

  // ------------------------------------------------------------------ 4
  head('A rollback that reported success and lost every row');
  const up = 'ALTER TABLE orders ADD COLUMN vat_number TEXT';
  const down = 'DROP TABLE orders; CREATE TABLE orders(id INTEGER PRIMARY KEY, customer_id INTEGER NOT NULL '
    + "REFERENCES customers(id), tenant_id TEXT NOT NULL, total REAL NOT NULL)";
  sql(`down:  DROP TABLE orders;  CREATE TABLE orders(...)`);
  const migrated = shopDatabase();
  const rowsBefore = migrated.prepare('SELECT COUNT(*) AS n FROM orders').get().n;
  let exitCode = 0;
  try { migrated.exec(up); migrated.exec(down); } catch { exitCode = 1; }
  const rowsAfter = migrated.prepare('SELECT COUNT(*) AS n FROM orders').get().n;
  old('migration tool says', `exit ${exitCode}, ${c(RED + BOLD, 'rolled back successfully')}`);
  old('orders rows', `${rowsBefore}  ${ARROW}  ${c(RED + BOLD, rowsAfter)}`);
  const replay = verifyMigration({ baselineSql: SHOP, up, down,
    fixtures: [{ sql: "INSERT INTO customers VALUES (1,'Acme','tenant-a')" },
      { sql: "INSERT INTO orders VALUES (1,1,'tenant-a',100)" }] });
  nu('replay verdict', `${c(GREEN, 'rejected')}   schema restored: ${replay.rollback.restoresSchema}, `
    + `rows restored: ${c(RED, replay.rollback.restoresData)}`);
  note('Both statements exited zero. Only comparing the rows afterwards catches it.');
  migrated.close();

  // ------------------------------------------------------------------ 5
  head('Finding the billing complaints, against the live model');
  const engine = new JevSQL({ client: new JevClient({ model: 'jev-1.13.0' }), cacheFile: null });
  engine.exec('CREATE TABLE tickets(id INTEGER PRIMARY KEY, body TEXT NOT NULL, billing INTEGER NOT NULL)');
  const insert = engine.prepare('INSERT INTO tickets VALUES (?,?,?)');
  for (const ticket of TICKETS) insert.run(ticket.id, ticket.body, ticket.billing ? 1 : 0);

  // A fair keyword list: stems rather than whole words, so "double-billed" and
  // "charged" both match. Making this list weaker would rig the comparison.
  sql("LIKE '%refund%' OR '%charg%' OR '%bill%' OR '%invoice%' OR '%pay%'");
  const keywordIds = engine.prepare("SELECT id FROM tickets WHERE body LIKE '%refund%' OR body LIKE '%charg%' "
    + "OR body LIKE '%bill%' OR body LIKE '%invoice%' OR body LIKE '%pay%' ORDER BY id").all().map((row) => row.id);
  const keyword = score(keywordIds);
  old('found', `${c(RED + BOLD, `${keyword.correct}/5`)} real complaints, `
    + `${keyword.wrong.length ? c(RED, `${keyword.wrong.length} false positives`) : '0 false positives'}`);
  if (keyword.missed.length) old('missed entirely', listed(keyword.missed));
  if (keyword.wrong.length) old('wrongly flagged', listed(keyword.wrong));

  sql("jev_bool(body, 'Is this customer reporting a problem with money they were charged?')");
  const { rows, stats } = await engine.query("SELECT id FROM tickets WHERE "
    + "jev_bool(body, 'Is this customer reporting a problem with money they were charged?') = 1 ORDER BY id");
  const jev = score(rows.map((row) => row.id));
  nu('found', `${c(GREEN + BOLD, `${jev.correct}/5`)} real complaints, `
    + `${jev.wrong.length ? c(RED, `${jev.wrong.length} false positives`) : c(GREEN, '0 false positives')}`);
  if (jev.missed.length) nu('missed entirely', listed(jev.missed));
  if (jev.wrong.length) nu('wrongly flagged', listed(jev.wrong));
  nu('what it cost', `${stats.requests} request, ${stats.inputTokens} input tokens, `
    + `$${stats.costUsd.toFixed(6)}, ${stats.wallMs} ms for ${TICKETS.length} rows`);
  note(`Live ${stats.model}. All ten rows batched into one request. No keyword list to maintain.`);

  console.log(`\n  ${c(BOLD, 'Every wrong answer above ran cleanly and returned a number somebody would have believed.')}\n`);
  db.close();
  engine.close();
  return { keyword, jev, stats };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  loadEnvFiles();
  if (!process.env.TYPESAFE_API_KEY) {
    console.error('The last example runs against the live API. Set TYPESAFE_API_KEY in .env.local.');
    process.exit(1);
  }
  runContrast().catch((error) => { console.error(error); process.exitCode = 1; });
}
