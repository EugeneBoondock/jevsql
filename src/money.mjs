import { integer } from './validation.mjs';

// Decimal text is retained exactly; never sum monetary values with binary floats.
function decimal(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number' && (!Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER)) throw new Error('Invalid decimal');
  if (!['string', 'number'].includes(typeof value)) throw new Error('Invalid decimal');
  const text = String(value).trim();
  if (!/^[+-]?\d+(?:\.\d+)?$/.test(text) || text.length > 120) throw new Error('Invalid decimal');
  const [whole, fraction = ''] = text.replace(/^[+-]/, '').split('.');
  if (fraction.length > 30) throw new Error('Invalid decimal');
  return { units: BigInt(whole + fraction) * (text.startsWith('-') ? -1n : 1n), scale: fraction.length };
}
function format(units, scale) {
  const sign = units < 0n ? '-' : '';
  const digits = (units < 0n ? -units : units).toString().padStart(scale + 1, '0');
  return scale ? sign + digits.slice(0, -scale) + '.' + digits.slice(-scale) : sign + digits;
}

/** A streaming exact sum, partitioned by currency. No model calls or row retention.
 * readPage must explicitly report done and advance its cursor. Partial scans throw.
 */
export async function aggregateMoney({ readPage, amount, currency, include = () => true,
  decode = rows => rows, pageSize = 250, maxPages = 4000, maxRows = 1000000,
  maxCurrencies = 256, signal } = {}) {
  for (const fn of [readPage, amount, currency, include, decode]) if (typeof fn !== 'function') throw new TypeError('Callbacks are required.');
  integer(pageSize, 'pageSize', 1, 1000); integer(maxPages, 'maxPages');
  integer(maxRows, 'maxRows'); integer(maxCurrencies, 'maxCurrencies');
  const groups = new Map();
  let cursor = null, scanned = 0, matched = 0, missing = 0, invalid = 0, pages = 0;
  for (; pages < maxPages;) {
    signal?.throwIfAborted();
    const page = await readPage({ cursor, limit: pageSize, signal });
    signal?.throwIfAborted();
    if (!Array.isArray(page?.rows) || page.rows.length > pageSize || typeof page.done !== 'boolean') throw new Error('Invalid bounded page');
    if (!page.done && (!page.rows.length || page.nextCursor == null || JSON.stringify(page.nextCursor) === JSON.stringify(cursor))) throw new Error('Cursor did not advance');
    if (scanned + page.rows.length > maxRows) throw new Error('Row budget exceeded; no total is available');
    const rows = await decode(page.rows);
    if (!Array.isArray(rows) || rows.length !== page.rows.length) throw new Error('Decode must preserve every row');
    scanned += rows.length; pages++;
    for (const row of rows) {
      signal?.throwIfAborted();
      if (!include(row)) continue;
      matched++;
      const rawCurrency = currency(row);
      const key = typeof rawCurrency === 'string' && /^[A-Z]{3}$/.test(rawCurrency.trim().toUpperCase())
        ? rawCurrency.trim().toUpperCase() : null;
      if (!groups.has(key)) {
        if (groups.size >= maxCurrencies) throw new Error('Currency budget exceeded');
        groups.set(key, { currency: key, units: 0n, scale: 0, records: 0, amounts: 0, missing: 0, invalid: 0 });
      }
      const group = groups.get(key); group.records++;
      let parsed;
      try { parsed = decimal(amount(row)); } catch { group.invalid++; invalid++; continue; }
      if (parsed === null) { group.missing++; missing++; continue; }
      const scale = Math.max(group.scale, parsed.scale);
      group.units = group.units * 10n ** BigInt(scale - group.scale) + parsed.units * 10n ** BigInt(scale - parsed.scale);
      group.scale = scale; group.amounts++;
    }
    if (page.done) {
      const totals = [...groups.values()].map(({ units, scale, ...group }) => ({
        ...group, knownAmountTotal: format(units, scale),
        total: group.missing || group.invalid ? null : format(units, scale),
      }));
      return { complete: true, scanned, matched, pages, missingAmounts: missing,
        invalidAmounts: invalid, totals, moneyComplete: missing === 0 && invalid === 0 && !groups.has(null) };
    }
    cursor = page.nextCursor;
  }
  throw new Error('Page budget exceeded; no total is available');
}

/** Trusted SQL only. Caller must include tenant authorization in sql/values.
 * A read-only repeatable-read cursor avoids large responses and shifting pages.
 */
export async function aggregatePgMoney({ pool, sql, values = [], statementTimeoutMs = 8000, ...options }) {
  if (!pool?.connect || typeof sql !== 'string' || !sql.trim()) throw new TypeError('Pool and trusted SQL required');
  integer(statementTimeoutMs, 'statementTimeoutMs', 1, 60000);
  const client = await pool.connect();
  let broken = false;
  try {
    options.signal?.throwIfAborted();
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await client.query("SELECT set_config('statement_timeout', $1, true)", [String(statementTimeoutMs)]);
    await client.query('DECLARE jevsql_money_cursor NO SCROLL CURSOR FOR ' + sql, values);
    let batch = 0;
    const result = await aggregateMoney({ ...options, readPage: async ({ limit }) => {
      const { rows } = await client.query('FETCH FORWARD ' + limit + ' FROM jevsql_money_cursor');
      return { rows, done: rows.length === 0, nextCursor: ++batch };
    } });
    return { ...result, consistency: 'repeatable_read' };
  } finally {
    try { await client.query('ROLLBACK'); } catch { broken = true; }
    client.release(broken);
  }
}
