// Minimal RFC 4180 CSV loader, so you can point JevSQL at a file without a database.
import { readFileSync } from 'node:fs';

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
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.length > 1 || r[0] !== '');
}

/** Load a CSV into a SQLite table (all columns TEXT). Returns the row count. */
export function loadCsv(db, file, table) {
  const rows = parseCsv(readFileSync(file, 'utf8'));
  if (rows.length === 0) throw new Error(`${file} is empty`);
  const header = rows[0].map((h, i) => (h.trim() || `col${i}`).replace(/\W+/g, '_'));
  const quoted = header.map((h) => `"${h}"`).join(', ');
  db.exec(`DROP TABLE IF EXISTS "${table}"`);
  db.exec(`CREATE TABLE "${table}" (${header.map((h) => `"${h}" TEXT`).join(', ')})`);
  const insert = db.prepare(`INSERT INTO "${table}" (${quoted}) VALUES (${header.map(() => '?').join(', ')})`);
  for (const row of rows.slice(1)) {
    insert.run(...header.map((_, i) => row[i] ?? null));
  }
  return rows.length - 1;
}
