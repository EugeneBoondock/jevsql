/** Mask quoted content and comments without changing offsets. */
export function maskSql(sql, { keepJevNames = false } = {}) {
  let out = '', i = 0;
  while (i < sql.length) {
    const start = i;
    if (sql.startsWith('--', i)) {
      while (i < sql.length && sql[i] !== '\n') i++;
    } else if (sql.startsWith('/*', i)) {
      const end = sql.indexOf('*/', i + 2);
      if (end < 0) throw new SyntaxError('Unclosed SQL comment.');
      i = end + 2;
    } else if (['\'', '"', '`', '['].includes(sql[i])) {
      const close = sql[i] === '[' ? ']' : sql[i];
      i++;
      let closed = false;
      while (i < sql.length) {
        if (sql[i++] === close) {
          if (close !== ']' && sql[i] === close) { i++; continue; }
          closed = true; break;
        }
      }
      if (!closed) throw new SyntaxError('Unclosed SQL quoted value.');
      const content = sql.slice(start + 1, i - 1);
      if (keepJevNames && sql[start] !== "'" && /^jev_[a-z_]+$/i.test(content)
          && /^\s*\(/.test(sql.slice(i))) {
        out += ` ${content} `;
        continue;
      }
    } else { out += sql[i++]; continue; }
    out += sql.slice(start, i).replace(/[^\r\n]/g, ' ');
  }
  return out;
}

export function topLevelWords(sql) {
  const masked = maskSql(sql), words = [];
  let depth = 0;
  for (const match of masked.matchAll(/[A-Za-z_][A-Za-z0-9_]*|[()]/g)) {
    if (match[0] === '(') depth++;
    else if (match[0] === ')') depth--;
    else if (depth === 0) words.push({ word: match[0].toUpperCase(), start: match.index, end: match.index + match[0].length });
  }
  return words;
}

/** Replayed SQL must be a single read. SQLite query_only enforces this too. */
export function readQuery(sql) {
  if (typeof sql !== 'string' || !sql.trim()) throw new TypeError('A SQL query is required.');
  const masked = maskSql(sql);
  const semicolons = [...masked.matchAll(/;/g)];
  if (semicolons.length > 1 || (semicolons.length && masked.slice(semicolons[0].index + 1).trim())) {
    throw new Error('Exactly one read-only SQL statement is allowed. Use exec() for writes.');
  }
  const cleaned = semicolons.length ? sql.slice(0, semicolons[0].index) + sql.slice(semicolons[0].index + 1) : sql;
  const first = topLevelWords(cleaned)[0]?.word;
  if (!['SELECT', 'WITH', 'VALUES'].includes(first)) throw new Error('query() and explain() accept SELECT, WITH, or VALUES only. Use exec() for writes.');
  return cleaned;
}

export function bindAll(statement, params = [], { removedLimit = false } = {}) {
  if (Array.isArray(params)) {
    // Collection only removes a trailing LIMIT/OFFSET. Preserve the remaining
    // positional bindings, including question marks inside literals or comments.
    const count = [...maskSql(statement.sourceSQL).matchAll(/\?(?!\d)/g)].length;
    return statement.all(...(removedLimit ? params.slice(0, count) : params));
  }
  if (params && typeof params === 'object') {
    if (removedLimit) statement.setAllowUnknownNamedParameters(true);
    return statement.all(params);
  }
  throw new TypeError('params must be an array or named-parameter object.');
}
