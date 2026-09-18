// Minimal RFC 4180 CSV loader, so you can point JevSQL at a file without a database.
import { readFileSync } from 'node:fs';
import { quoteIdentifier as qi } from './validation.mjs';

export function parseCsv(text) {
  const rows = [];
  let row = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 1; }
        else quoted = false;
      } else field += ch;
      continue;
    }
    if (ch === '"') { quoted = true; continue; }
    if (ch === ',') { row.push(field); field = ''; continue; }
    if (ch === '\r') continue;
    if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue; }
    field += ch;
  }
  if (quoted) throw new Error('CSV contains an unclosed quoted field.');
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.length > 1 || r[0] !== '');
}

/** Load a CSV into a SQLite table (all columns TEXT). Returns the row count. */
export function loadCsv(db, file, table) {
  qi(table);
  const rows = parseCsv(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  if (rows.length === 0) throw new Error(`${file} is empty`);
  const header = rows[0].map((h, i) => (h.trim() || `col${i}`).replace(/\W+/g, '_'));
  if (new Set(header.map((name) => name.toLowerCase())).size !== header.length) throw new Error('CSV column names must be distinct after normalization.');
  if (rows.slice(1).some((row) => row.length > header.length)) throw new Error('CSV row has more values than the header.');
  db.exec('SAVEPOINT _jevsql_csv');
  try {
    db.exec(`DROP TABLE IF EXISTS ${qi(table)}`);
    db.exec(`CREATE TABLE ${qi(table)} (${header.map((h) => `${qi(h)} TEXT`).join(', ')})`);
    const insert = db.prepare(`INSERT INTO ${qi(table)} (${header.map(qi).join(', ')}) VALUES (${header.map(() => '?').join(', ')})`);
    for (const row of rows.slice(1)) insert.run(...header.map((_, i) => row[i] ?? null));
    db.exec('RELEASE _jevsql_csv');
  } catch (error) {
    db.exec('ROLLBACK TO _jevsql_csv'); db.exec('RELEASE _jevsql_csv'); throw error;
  }
  return rows.length - 1;
}
