// Offline evidence processing. No database, clock, filesystem, network or model calls.

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const compareText = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const finite = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const text = (value) => typeof value === 'string' && value.trim() ? value : null;
const product = (a, b) => a === null || b === null || !Number.isFinite(a * b) ? null : a * b;

// EXPLAIN can contain numeric strings, especially MySQL cost_info. Missing and
// malformed measurements remain unknown; booleans and empty strings are not zero.
function measurement(value) {
  if (typeof value === 'string' && /^[+]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value.trim())) {
    value = Number(value);
  }
  return finite(value) ? value : null;
}

function requireNumber(value, name, { integer = false, positive = false } = {}) {
  if (!finite(value) || (integer && !Number.isSafeInteger(value)) || (positive && value === 0)) {
    throw new TypeError(`${name} must be a finite ${positive ? 'positive' : 'non-negative'} ${integer ? 'safe integer' : 'number'}.`);
  }
  return value;
}

function totalKnown(values) {
  if (!values.length || values.some((value) => value === null)) return null;
  const total = values.reduce((sum, value) => sum + value, 0);
  return Number.isFinite(total) ? total : null;
}

function dialectName(dialect) {
  if (!['postgresql', 'mysql', 'sqlite'].includes(dialect)) {
    throw new TypeError('dialect must be postgresql, mysql or sqlite.');
  }
  return dialect;
}

function checkTree(value) {
  const active = new WeakSet();
  const stack = [{ value, depth: 0, leave: false }];
  let count = 0;
  while (stack.length) {
    const item = stack.pop();
    if (!item.value || typeof item.value !== 'object') continue;
    if (item.leave) { active.delete(item.value); continue; }
    if (active.has(item.value)) throw new TypeError('Plan must not contain cycles.');
    if (item.depth > 256 || ++count > 100_000) throw new TypeError('Plan exceeds the depth or object limit.');
    active.add(item.value);
    stack.push({ ...item, leave: true });
    for (const child of Object.values(item.value)) stack.push({ value: child, depth: item.depth + 1, leave: false });
  }
}

const IO_FIELDS = {
  sharedHitBlocks: 'Shared Hit Blocks', sharedReadBlocks: 'Shared Read Blocks',
  sharedDirtiedBlocks: 'Shared Dirtied Blocks', sharedWrittenBlocks: 'Shared Written Blocks',
  localHitBlocks: 'Local Hit Blocks', localReadBlocks: 'Local Read Blocks',
  localDirtiedBlocks: 'Local Dirtied Blocks', localWrittenBlocks: 'Local Written Blocks',
  tempReadBlocks: 'Temp Read Blocks', tempWrittenBlocks: 'Temp Written Blocks',
  readTimeMs: 'I/O Read Time', writeTimeMs: 'I/O Write Time',
  sharedReadTimeMs: 'Shared I/O Read Time', sharedWriteTimeMs: 'Shared I/O Write Time',
  localReadTimeMs: 'Local I/O Read Time', localWriteTimeMs: 'Local I/O Write Time',
  tempReadTimeMs: 'Temp I/O Read Time', tempWriteTimeMs: 'Temp I/O Write Time',
};
const emptyIo = () => Object.fromEntries(Object.keys(IO_FIELDS).map((key) => [key, null]));

function cardinality(estimated, actual, loops) {
  let status = 'unknown';
  let ratio = null;
  let errorFactor = null;
  let unboundedError = false;
  if (loops === 0) status = 'not-executed';
  else if (estimated !== null && actual !== null && loops !== null) {
    status = actual === estimated ? 'match' : actual > estimated ? 'underestimated' : 'overestimated';
    ratio = estimated === 0 ? (actual === 0 ? 1 : null) : actual / estimated;
    errorFactor = actual === estimated ? 1 : Math.max(actual, estimated) / Math.min(actual, estimated);
    unboundedError = !Number.isFinite(errorFactor);
    if (!Number.isFinite(ratio)) ratio = null;
    if (unboundedError) errorFactor = null;
  }
  return {
    estimatedRowsPerLoop: estimated, actualRowsPerLoop: actual, loops,
    estimatedTotalRows: product(estimated, loops), actualTotalRows: product(actual, loops),
    actualToEstimatedRatio: ratio, errorFactor, unboundedError, status,
  };
}

function nodeFor(nodes, parentId, operation) {
  const node = {
    id: `n${nodes.length}`, parentId, operation, relation: null, index: null, accessType: null,
    isScan: false, usesIndex: false, isFullScan: false,
    cardinality: cardinality(null, null, null),
    estimatedRowsExaminedPerScan: null, estimatedRowsProducedPerJoin: null,
    rowsRemovedPerLoop: null, observedRowsTotal: null, filteredOutRatio: null,
    actualTimePerLoopMs: null, actualTotalTimeMs: null,
    estimatedStartupCost: null, estimatedTotalCost: null,
    sort: null, hash: null, temporaryStructure: false, io: emptyIo(),
  };
  nodes.push(node);
  return node;
}

function pgSort(raw) {
  const evidence = [];
  let measured = false;
  let spilled = false;
  const memoryMethod = (method) => /^(?:quicksort|top-n heapsort)$/i.test(method ?? '');
  const scopes = [{ raw, source: 'leader' }];
  if (Array.isArray(raw.Workers)) {
    raw.Workers.forEach((worker, i) => { if (isRecord(worker)) scopes.push({ raw: worker, source: `worker:${i}` }); });
  }
  for (const scope of scopes) {
    const method = text(scope.raw['Sort Method']);
    const spaceType = text(scope.raw['Sort Space Type']);
    const spaceUsedKb = measurement(scope.raw['Sort Space Used']);
    if (method || spaceType) {
      const disk = spaceType?.toLowerCase() === 'disk' || /^external\b/i.test(method ?? '');
      const memory = spaceType?.toLowerCase() === 'memory' || memoryMethod(method);
      measured ||= disk || memory;
      spilled ||= disk;
      evidence.push({ source: scope.source, method, spaceType, spaceUsedKb, spilled: disk ? true : memory ? false : null });
    }
    for (const name of ['Full-sort Groups', 'Pre-sorted Groups']) {
      const group = scope.raw[name];
      if (!isRecord(group)) continue;
      const methods = Array.isArray(group['Sort Methods Used']) ? group['Sort Methods Used'].filter((item) => typeof item === 'string') : [];
      const diskKb = measurement(group['Sort Space Disk']?.['Peak Sort Space Used']);
      const memoryKb = measurement(group['Sort Space Memory']?.['Peak Sort Space Used']);
      if (methods.length || diskKb !== null || memoryKb !== null) {
        const disk = diskKb > 0 || methods.some((methodName) => /^external\b/i.test(methodName));
        const memory = memoryKb !== null || diskKb === 0 || (methods.length > 0 && methods.every(memoryMethod));
        measured ||= disk || memory;
        spilled ||= disk;
        evidence.push({ source: `${scope.source}:${name}`, methods, peakDiskKb: diskKb, peakMemoryKb: memoryKb, spilled: disk ? true : memory ? false : null });
      }
    }
  }
  return { method: text(raw['Sort Method']), spilled: spilled ? true : measured && evidence.every((item) => item.spilled === false) ? false : null, evidence };
}

// A hashed aggregate or hash join that exceeds work_mem reports its batches and
// disk usage rather than a sort method, so it is separate evidence from pgSort.
// More batches than planned, or any disk usage, is a measured spill.
function pgHash(raw) {
  const evidence = [];
  let spilled = false;
  const scopes = [{ raw, source: 'leader' }];
  if (Array.isArray(raw.Workers)) {
    raw.Workers.forEach((worker, i) => { if (isRecord(worker)) scopes.push({ raw: worker, source: `worker:${i}` }); });
  }
  for (const scope of scopes) {
    const diskKb = measurement(scope.raw['Disk Usage']);
    const peakMemoryKb = measurement(scope.raw['Peak Memory Usage']);
    const aggBatches = measurement(scope.raw['HashAgg Batches']);
    const batches = measurement(scope.raw['Hash Batches']);
    const originalBatches = measurement(scope.raw['Original Hash Batches']);
    const plannedPartitions = measurement(scope.raw['Planned Partitions']);
    const fields = [diskKb, peakMemoryKb, aggBatches, batches, originalBatches, plannedPartitions];
    if (fields.every((value) => value === null)) continue;
    const disk = diskKb > 0 || aggBatches > 1 || batches > 1;
    spilled ||= disk;
    evidence.push({ source: scope.source, diskKb, peakMemoryKb, aggBatches, batches, originalBatches, plannedPartitions, spilled: disk });
  }
  return evidence.length ? { spilled, evidence } : null;
}

function postgresNodes(plan, nodes) {
  const entries = Array.isArray(plan) ? plan : [plan];
  const stack = [];
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (!isRecord(entry)) throw new TypeError('PostgreSQL plan entries must be objects.');
    stack.push({ raw: Object.hasOwn(entry, 'Plan') ? entry.Plan : entry, parentId: null });
  }
  while (stack.length) {
    const { raw, parentId } = stack.pop();
    if (!isRecord(raw) || !text(raw['Node Type'])) throw new TypeError('PostgreSQL nodes need a Node Type.');
    if (raw.Plans !== undefined && !Array.isArray(raw.Plans)) throw new TypeError('PostgreSQL Plans must be an array.');
    const node = nodeFor(nodes, parentId, raw['Node Type']);
    node.accessType = node.operation;
    node.relation = text(raw['Relation Name']);
    node.index = text(raw['Index Name']);
    node.isScan = /\bScan\b/i.test(node.operation);
    node.usesIndex = /\bIndex(?: Only)? Scan\b|\bBitmap Heap Scan\b/i.test(node.operation);
    node.isFullScan = /^(?:Parallel )?Seq Scan$/i.test(node.operation);
    node.cardinality = cardinality(measurement(raw['Plan Rows']), measurement(raw['Actual Rows']), measurement(raw['Actual Loops']));
    node.rowsRemovedPerLoop = measurement(raw['Rows Removed by Filter']);
    const actual = node.cardinality.actualRowsPerLoop;
    const observed = actual === null || node.rowsRemovedPerLoop === null ? null : totalKnown([actual, node.rowsRemovedPerLoop]);
    node.observedRowsTotal = product(observed, node.cardinality.loops);
    node.filteredOutRatio = observed > 0 ? node.rowsRemovedPerLoop / observed : observed === 0 ? 0 : null;
    node.actualTimePerLoopMs = measurement(raw['Actual Total Time']);
    node.actualTotalTimeMs = product(node.actualTimePerLoopMs, node.cardinality.loops);
    node.estimatedStartupCost = measurement(raw['Startup Cost']);
    node.estimatedTotalCost = measurement(raw['Total Cost']);
    if (/\bSort\b/i.test(node.operation)) node.sort = pgSort(raw);
    if (/Hash/i.test(node.operation)) node.hash = pgHash(raw);
    for (const [key, field] of Object.entries(IO_FIELDS)) node.io[key] = measurement(raw[field]);
    for (let i = (raw.Plans?.length ?? 0) - 1; i >= 0; i--) stack.push({ raw: raw.Plans[i], parentId: node.id });
  }
  return totalKnown(entries.map((entry) => measurement(entry['Execution Time'])));
}

const MYSQL_OPERATIONS = {
  query_block: 'Query Block', ordering_operation: 'Ordering', grouping_operation: 'Grouping',
  duplicates_removal: 'Duplicate Removal', union_result: 'Union', windowing: 'Window',
  materialized_from_subquery: 'Materialize',
};
const MYSQL_INDEX_ACCESS = new Set(['index', 'range', 'ref', 'eq_ref', 'ref_or_null', 'index_merge', 'index_subquery', 'unique_subquery', 'fulltext']);

function mysqlNodes(plan, nodes) {
  const entries = Array.isArray(plan) ? plan : [plan];
  for (const entry of entries) {
    if (!isRecord(entry) || !isRecord(entry.query_block)) throw new TypeError('MySQL JSON plans need a query_block object.');
  }
  const stack = entries.slice().reverse().map((raw) => ({ raw, key: '', parentId: null }));
  while (stack.length) {
    const { raw, key, parentId } = stack.pop();
    if (Array.isArray(raw)) {
      for (let i = raw.length - 1; i >= 0; i--) stack.push({ raw: raw[i], key: '', parentId });
      continue;
    }
    if (!isRecord(raw)) continue;
    const table = Object.hasOwn(raw, 'table_name') || Object.hasOwn(raw, 'access_type');
    let nextParent = parentId;
    if (table || Object.hasOwn(MYSQL_OPERATIONS, key) || raw.using_filesort === true || raw.using_temporary_table === true) {
      const access = typeof raw.access_type === 'string' ? raw.access_type.toLowerCase() : null;
      const operation = Object.hasOwn(MYSQL_OPERATIONS, key) ? MYSQL_OPERATIONS[key] : 'Operation';
      const node = nodeFor(nodes, parentId, table ? `Table ${text(raw.access_type) ?? 'Access'}` : operation);
      nextParent = node.id;
      node.relation = text(raw.table_name);
      node.index = text(raw.key);
      node.accessType = access;
      node.isScan = table && ['all', 'index', 'range'].includes(access);
      node.isFullScan = table && ['all', 'index'].includes(access);
      node.usesIndex = table && (MYSQL_INDEX_ACCESS.has(access) || (['const', 'system'].includes(access) && node.index !== null));
      node.estimatedRowsExaminedPerScan = measurement(raw.rows_examined_per_scan ?? raw.rows);
      node.estimatedRowsProducedPerJoin = measurement(raw.rows_produced_per_join);
      const filtered = measurement(raw.filtered);
      const keptRatio = filtered !== null && filtered <= 100 ? filtered / 100 : null;
      node.filteredOutRatio = keptRatio === null ? null : 1 - keptRatio;
      // These are optimizer estimates. FORMAT JSON query blocks do not supply
      // actual executions or per-loop timings, even when read_cost is present.
      node.cardinality = cardinality(product(node.estimatedRowsExaminedPerScan, keptRatio), null, null);
      node.estimatedTotalCost = measurement(raw.cost_info?.query_cost ?? raw.cost_info?.prefix_cost);
      if (raw.using_filesort === true) node.sort = { method: 'filesort', spilled: null, evidence: [] };
      node.temporaryStructure = raw.using_temporary_table === true;
    }
    const keys = Object.keys(raw).sort();
    for (let i = keys.length - 1; i >= 0; i--) {
      const childKey = keys[i];
      if (raw[childKey] && typeof raw[childKey] === 'object') stack.push({ raw: raw[childKey], key: childKey, parentId: nextParent });
    }
  }
  return null;
}

function sqliteNodes(plan, nodes) {
  const rows = isRecord(plan) && Array.isArray(plan.rows) ? plan.rows : plan;
  if (!Array.isArray(rows)) throw new TypeError('SQLite plans must be an array of EXPLAIN QUERY PLAN rows.');
  const bySourceId = new Map();
  for (const row of rows) {
    if (!Array.isArray(row) && !isRecord(row)) throw new TypeError('SQLite plan rows must be objects or four-column arrays.');
    const [id, parent, detail] = Array.isArray(row) ? [row[0], row[1], row[3]] : [row.id, row.parent, row.detail];
    if (!Number.isSafeInteger(id) || id < 0 || !Number.isSafeInteger(parent) || parent < 0 || !text(detail)) {
      throw new TypeError('SQLite plan rows need non-negative integer id and parent, and a detail string.');
    }
    if (bySourceId.has(id)) throw new TypeError('SQLite plan ids must be unique.');
    const node = nodeFor(nodes, null, detail.trim());
    node.sourceId = id;
    node.sourceParentId = parent;
    node.isScan = /^SCAN\b/i.test(node.operation);
    node.isFullScan = node.isScan;
    node.usesIndex = /\bUSING (?:(?:AUTOMATIC|PARTIAL|COVERING) )*(?:INDEX\b|(?:INTEGER )?PRIMARY KEY\b)/i.test(node.operation);
    node.accessType = /^(SCAN|SEARCH)\b/i.exec(node.operation)?.[1].toLowerCase() ?? null;
    const identifier = '(?:"(?:[^"\\n]|"")*"|`(?:[^`\\n]|``)*`|\\[[^\\]\\n]+\\]|[^\\s(]+)';
    node.relation = new RegExp(`^(?:SCAN|SEARCH) (?:TABLE )?(${identifier})`, 'i').exec(node.operation)?.[1] ?? null;
    node.index = new RegExp(`\\bUSING (?:(?:AUTOMATIC|PARTIAL|COVERING) )*INDEX (${identifier})`, 'i').exec(node.operation)?.[1] ?? null;
    node.temporaryStructure = /\b(?:USE|USING) TEMP B-TREE\b/i.test(node.operation);
    if (/\bUSE TEMP B-TREE FOR\b/i.test(node.operation)) node.sort = { method: 'temporary-b-tree', spilled: null, evidence: [] };
    bySourceId.set(id, node);
  }
  for (const node of nodes) {
    // A missing parent (usually 0) is the virtual root of an EQP result.
    const parent = bySourceId.get(node.sourceParentId);
    node.parentId = parent && !(node.sourceId === 0 && parent === node) ? parent.id : null;
  }
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const done = new Set();
  for (const node of nodes) {
    const path = new Set();
    let cursor = node;
    while (cursor && !done.has(cursor.id)) {
      if (path.has(cursor.id)) throw new TypeError('SQLite parent ids must not contain cycles.');
      path.add(cursor.id);
      cursor = byId.get(cursor.parentId);
    }
    for (const id of path) done.add(id);
  }
  return null;
}

function planSymptoms(nodes) {
  const symptoms = [];
  const add = (node, name, severity, evidence) => symptoms.push({ name, severity, nodeId: node.id, evidence });
  for (const node of nodes) {
    const c = node.cardinality;
    if (c.unboundedError || c.errorFactor >= 10) add(node, 'cardinality-mismatch', 'warning', { ...c });
    if (node.sort?.spilled === true) add(node, 'sort-spill', 'warning', { ...node.sort, evidence: node.sort.evidence.map((item) => ({ ...item })) });
    if (node.hash?.spilled === true) add(node, 'hash-spill', 'warning', { ...node.hash, evidence: node.hash.evidence.map((item) => ({ ...item })) });
    if (node.sort?.method === 'filesort') add(node, 'filesort', 'info', { diskSpillKnown: false });
    if (node.temporaryStructure) add(node, 'temporary-structure', 'info', { diskSpillKnown: false });
    const reads = Object.fromEntries(['sharedReadBlocks', 'localReadBlocks'].filter((key) => node.io[key] > 0).map((key) => [key, node.io[key]]));
    if (Object.keys(reads).length) add(node, 'buffer-reads', 'info', reads);
    if (node.io.tempReadBlocks > 0 || node.io.tempWrittenBlocks > 0) {
      add(node, 'temporary-io', 'warning', { tempReadBlocks: node.io.tempReadBlocks, tempWrittenBlocks: node.io.tempWrittenBlocks });
    }
    const examined = node.observedRowsTotal ?? node.estimatedRowsExaminedPerScan;
    if (node.isFullScan && !node.usesIndex && examined >= 1000 && node.filteredOutRatio >= 0.9) {
      add(node, 'large-filtered-scan', 'warning', {
        rows: examined, filteredOutRatio: node.filteredOutRatio,
        basis: node.observedRowsTotal === null ? 'estimated-per-scan' : 'observed-total',
      });
    }
    if (node.isFullScan && c.loops >= 10 && (node.observedRowsTotal ?? c.actualTotalRows) >= 10_000) {
      add(node, 'repeated-full-scan', 'warning', { loops: c.loops, observedRows: node.observedRowsTotal ?? c.actualTotalRows });
    }
  }
  return symptoms;
}

/**
 * Analyze supplied EXPLAIN data without executing SQL. Accepted inputs are a
 * decoded object/array or its JSON string: PostgreSQL [{Plan, ...}] or a bare
 * Plan tree; MySQL {query_block: ...} (including nested/materialized queries);
 * SQLite [{id,parent,notused,detail}], four-column arrays, or {rows: [...]}.
 * Empty arrays are valid. Bad structures/cycles throw TypeError. Tree inputs
 * are limited to depth 256 and 100,000 objects. Inputs are never changed.
 *
 * nodes have stable id/parentId, operation/relation/index/accessType, isScan,
 * usesIndex, isFullScan, cardinality, estimates, filter ratios, sort and io.
 * Cardinality rows and time are per loop; total fields multiply by measured
 * loops. Zero loops means not-executed. Both row counts zero gives ratio 1;
 * one zero gives unboundedError, with null for undefined/infinite ratios.
 * Unknown or malformed measurements and arithmetic overflow return null.
 * MySQL rows_examined_per_scan and rows_produced_per_join stay estimates.
 *
 * summary counts plan nodes, not tables: scanNodes and indexNodes can overlap.
 * indexAccessRatio uses nodes with isScan or usesIndex as its denominator.
 * Root IO alone supplies summary.io, avoiding inclusive parent/child sums.
 * Missing root counters remain null even when a child reports a counter.
 * Rows are output counts, not distinct rows read. IO blocks are buffer events,
 * not necessarily physical device reads. Costs never imply locks or IO time.
 *
 * Symptoms carry {name,severity,nodeId,evidence}. Cardinality error >=10x
 * (including one-sided zero) is a warning. A large-filtered-scan requires an
 * unindexed full scan, >=1,000 observed/estimated rows and >=90% rejection.
 * A repeated-full-scan requires >=10 loops and >=10,000 observed row visits.
 * Ordinary scans are not warnings. Filesort/temporary structures alone do not
 * prove a spill. Actual PG sort methods/space evidence can prove a spill.
 * PostgreSQL hashed aggregates and hash joins report batches, planned
 * partitions and disk usage instead of a sort method: those land in node.hash,
 * and disk usage above zero or more batches than one is a hash-spill warning.
 *
 * @param {object|Array|string} plan
 * @param {{dialect?: 'postgresql'|'mysql'|'sqlite'}} [options]
 * @returns {{dialect:string,nodes:Array,summary:object,symptoms:Array}}
 * @see https://www.postgresql.org/docs/current/using-explain.html
 * @see https://dev.mysql.com/doc/refman/8.4/en/explain-output.html
 * @see https://sqlite.org/eqp.html
 */
export function analyzePlan(plan, { dialect = 'postgresql' } = {}) {
  dialectName(dialect);
  if (typeof plan === 'string') {
    try { plan = JSON.parse(plan); } catch { throw new TypeError('Plan must be valid EXPLAIN JSON.'); }
  }
  checkTree(plan);
  const nodes = [];
  const executionTimeMs = dialect === 'postgresql' ? postgresNodes(plan, nodes)
    : dialect === 'mysql' ? mysqlNodes(plan, nodes) : sqliteNodes(plan, nodes);
  const roots = nodes.filter((node) => node.parentId === null);
  const symptoms = planSymptoms(nodes);
  const io = Object.fromEntries(Object.keys(IO_FIELDS).map((key) => [key, totalKnown(roots.map((node) => node.io[key]))]));
  const sharedAccess = totalKnown([io.sharedHitBlocks, io.sharedReadBlocks]);
  io.sharedHitRatio = sharedAccess > 0 ? io.sharedHitBlocks / sharedAccess : null;
  const accesses = nodes.filter((node) => node.isScan || node.usesIndex).length;
  const indexNodes = nodes.filter((node) => node.usesIndex).length;
  const errors = nodes.map((node) => node.cardinality.errorFactor).filter((value) => value !== null);
  return {
    dialect, nodes,
    summary: {
      nodeCount: nodes.length, rootCount: roots.length,
      scanNodes: nodes.filter((node) => node.isScan).length,
      fullScanNodes: nodes.filter((node) => node.isFullScan).length,
      unindexedFullScanNodes: nodes.filter((node) => node.isFullScan && !node.usesIndex).length,
      indexNodes, accessNodes: accesses, indexAccessRatio: accesses ? indexNodes / accesses : null,
      sortNodes: nodes.filter((node) => node.sort !== null).length,
      sortSpillNodes: nodes.filter((node) => node.sort?.spilled === true).length,
      hashNodes: nodes.filter((node) => node.hash !== null).length,
      hashSpillNodes: nodes.filter((node) => node.hash?.spilled === true).length,
      cardinalityComparisons: nodes.filter((node) => ['match', 'underestimated', 'overestimated'].includes(node.cardinality.status)).length,
      cardinalityMismatchNodes: symptoms.filter((symptom) => symptom.name === 'cardinality-mismatch').length,
      unboundedCardinalityErrors: nodes.filter((node) => node.cardinality.unboundedError).length,
      maxFiniteCardinalityError: errors.length ? errors.reduce((max, value) => Math.max(max, value), 0) : null,
      estimatedOutputRows: totalKnown(roots.map((node) => node.cardinality.estimatedRowsPerLoop)),
      actualOutputRows: totalKnown(roots.map((node) => node.cardinality.actualTotalRows)),
      executionTimeMs, io, ioScope: 'root-nodes',
    },
    symptoms,
  };
}

const SQL_KEYWORDS = new Set(('select from where join inner left right full outer cross on using as with recursive materialized not and or in is null true false unknown exists between like ilike escape case when then else end distinct all union intersect except order group by having limit offset fetch first next rows only asc desc nulls last insert into values update set delete returning conflict do nothing create table drop alter begin commit rollback explain analyze over partition filter window lateral for share lock of skip locked replace merge matched natural straight_join force use ignore index').split(' '));

function sqlShape(sql, dialect) {
  const tokens = [];
  let i = 0;
  const add = (value, kind = 'symbol') => tokens.push({ value, kind });
  const quotedEnd = (start, close, backslash = false) => {
    for (let j = start + 1; j < sql.length; j++) {
      if (backslash && sql[j] === '\\') { j++; continue; }
      if (sql[j] !== close) continue;
      if (sql[j + 1] === close) { j++; continue; }
      return j + 1;
    }
    throw new TypeError('SQL contains an unterminated quoted value.');
  };
  while (i < sql.length) {
    const rest = sql.slice(i);
    if (/\s/.test(sql[i])) { i++; continue; }
    if ((rest.startsWith('--') && (dialect !== 'mysql' || !rest[2] || /\s/.test(rest[2]))) || (dialect === 'mysql' && sql[i] === '#')) {
      const end = sql.indexOf('\n', i);
      i = end < 0 ? sql.length : end + 1;
      continue;
    }
    if (rest.startsWith('/*')) {
      let depth = 1;
      let end = i + 2;
      while (end < sql.length && depth) {
        if (sql.startsWith('/*', end)) { depth++; end += 2; }
        else if (sql.startsWith('*/', end)) { depth--; end += 2; }
        else end++;
      }
      if (depth) throw new TypeError('SQL contains an unterminated comment.');
      // Optimizer hints and executable MySQL comments can change the plan.
      if (rest[2] === '+' || rest[2] === '!') add(sql.slice(i, end), 'hint');
      i = end;
      continue;
    }
    const dollarQuote = dialect === 'postgresql' ? /^(?:\$[A-Za-z_][A-Za-z_0-9]*\$|\$\$)/.exec(rest)?.[0] : null;
    if (dollarQuote) {
      const end = sql.indexOf(dollarQuote, i + dollarQuote.length);
      if (end < 0) throw new TypeError('SQL contains an unterminated dollar-quoted value.');
      i = end + dollarQuote.length;
      add('?', 'literal');
      continue;
    }
    const prefix = /^(?:[eEnNxXbB]|_[A-Za-z0-9]+)(?=')/.exec(rest)?.[0];
    if (sql[i] === "'" || prefix) {
      const quote = i + (prefix?.length ?? 0);
      i = quotedEnd(quote, "'", dialect === 'mysql' || prefix?.toLowerCase() === 'e');
      add('?', 'literal');
      continue;
    }
    if (sql[i] === '"' || sql[i] === '`' || (dialect === 'sqlite' && sql[i] === '[')) {
      const end = quotedEnd(i, sql[i] === '[' ? ']' : sql[i], dialect === 'mysql');
      add(sql.slice(i, end), 'identifier');
      i = end;
      continue;
    }
    const operator = /^(?:->>|#>>|<=>|::|>=|<=|<>|!=|\|\||&&|->|#>|\?\||\?&|:=|<<|>>)/.exec(rest)?.[0];
    if (operator) { add(operator); i += operator.length; continue; }
    const parameter = /^(?:\$\d+|\?\d*|:[A-Za-z_][A-Za-z_0-9]*)/.exec(rest)?.[0]
      ?? (dialect === 'sqlite' ? /^[@$][A-Za-z_][A-Za-z_0-9]*/.exec(rest)?.[0] : null);
    if (parameter) { add('?', 'literal'); i += parameter.length; continue; }
    const previous = tokens.at(-1);
    const unary = !previous || ['(', ',', '=', '<', '>', '<=', '>=', '<>', '!=', '+', '-', '*', '/', '%', 'select', 'where', 'and', 'or', 'then', 'else', 'when', 'values', 'limit', 'offset', 'by'].includes(previous.value);
    const number = new RegExp(`^${unary ? '[+-]?' : ''}(?:0[xX][0-9a-fA-F]+|0[bB][01]+|(?:\\d+(?:\\.\\d*)?|\\.\\d+)(?:[eE][+-]?\\d+)?)`).exec(rest)?.[0];
    if (number) { add('?', 'literal'); i += number.length; continue; }
    const word = /^[\p{L}_][\p{L}\p{N}_$]*/u.exec(rest)?.[0];
    if (word) {
      const lower = word.toLowerCase();
      if (['true', 'false', 'null'].includes(lower)) add('?', 'literal');
      else add(dialect === 'mysql' && !SQL_KEYWORDS.has(lower) ? word : lower, 'word');
      i += word.length;
      continue;
    }
    add(sql[i++]);
  }
  while (tokens.at(-1)?.value === ';') tokens.pop();
  if (!tokens.length || tokens.every((token) => token.kind === 'hint')) throw new TypeError('Every event needs a non-empty SQL statement.');
  const head = tokens.find((token) => token.kind !== 'hint')?.value;
  let depth = 0;
  let read = ['select', 'with'].includes(head);
  let foundSelect = false;
  for (const [index, token] of tokens.entries()) {
    if (token.value === '(') depth++;
    else if (token.value === ')') depth--;
    else if (token.value === ';') read = false;
    else if (token.kind === 'hint' && token.value.startsWith('/*!')) read = false;
    else if (token.kind === 'word') {
      if (depth === 0 && token.value === 'select') foundSelect = true;
      // A data-changing CTE can sit inside a top-level SELECT. REPLACE(...)
      // is also a scalar string function, distinct from REPLACE INTO.
      const scalarReplace = token.value === 'replace' && tokens[index + 1]?.value === '(';
      if (!scalarReplace && ['insert', 'update', 'delete', 'merge', 'replace'].includes(token.value)) read = false;
    }
  }
  return { shape: tokens.map((token) => token.value).join(' '), read: read && foundSelect };
}

function durationStats(values, count) {
  const sorted = values.slice().sort((a, b) => a - b);
  const totalMs = values.reduce((sum, value) => sum + value, 0);
  if (!Number.isFinite(totalMs)) throw new RangeError('Duration total exceeds the finite number range.');
  const percentile = (p) => sorted.length ? sorted[Math.ceil(sorted.length * p) - 1] : null;
  return {
    samples: sorted.length, missing: count - sorted.length, totalMs,
    meanMs: sorted.length ? totalMs / sorted.length : null,
    minMs: sorted[0] ?? null, maxMs: sorted.at(-1) ?? null,
    p50Ms: percentile(0.5), p95Ms: percentile(0.95), p99Ms: percentile(0.99),
  };
}

function eventGroup() { return { count: 0, failureCount: 0, times: [] }; }
function addEvent(group, event) {
  group.count++;
  if (event.failed) group.failureCount++;
  if (event.duration !== null) group.times.push(event.duration);
}
function groupResult(group) {
  return { count: group.count, failureCount: group.failureCount, failureRate: group.count ? group.failureCount / group.count : 0, durations: durationStats(group.times, group.count) };
}

/**
 * Summarize an array of completed query events. Event shape:
 * {sql:string, requestId?:string|number, durationMs?:number|null,
 *  dialect?:'postgresql'|'mysql'|'sqlite', database?:string,
 *  failed?:boolean, success?:boolean, error?:unknown}.
 * query is accepted as an alias for sql; conflicting aliases throw. A numeric
 * requestId must be a safe integer; string ids must be non-empty. Missing/null
 * request ids never share a request bucket. Use globally unique request ids.
 * Duration is finite, non-negative milliseconds; missing/null is unmeasured.
 * Any failed:true, success:false, or non-null/non-false error counts a failure.
 *
 * Shapes normalize whitespace, ordinary comments, unquoted case (except MySQL
 * identifiers), literals and bind parameters. Quoted identifiers, list arity,
 * operators, hints and executable comments remain distinct. This is a lexical
 * grouping heuristic, not a SQL parser or privacy boundary. Default dialect
 * is postgresql. database and dialect form separate pattern namespaces.
 *
 * Returns totalEvents/requestCount/unattributedEvents, failureCount/failureRate,
 * durations {samples,missing,totalMs,meanMs,minMs,maxMs,p50Ms,p95Ms,p99Ms},
 * global patterns, per-request requests, nPlusOneCandidates, and costlyPatterns.
 * Percentiles use nearest rank, with null for no samples. Patterns contain
 * {shape,dialect,database,count,failureCount,failureRate,durations,requestCount}.
 * N+1 candidates are read shapes occurring >=2 times within the SAME request
 * and namespace, with count and repeatedCount. They are clues, not proof of a
 * parent/child dependency; retries and intentional repeats also qualify.
 * costlyPatterns ranks measured patterns with positive total duration, with
 * durationShare. Durations sum query time, not concurrent request wall time.
 * No event or supplied array is changed. Invalid input throws TypeError;
 * overflowing duration totals throw RangeError. Ordering uses code-point ties.
 * @param {Array<object>} events
 * @returns {object}
 */
export function summarizeWorkload(events) {
  if (!Array.isArray(events)) throw new TypeError('events must be an array.');
  const overall = eventGroup();
  const patterns = new Map();
  const requests = new Map();
  let unattributedEvents = 0;
  for (const event of events) {
    if (!isRecord(event)) throw new TypeError('Every event must be an object.');
    if (event.sql !== undefined && event.query !== undefined && event.sql !== event.query) throw new TypeError('Event sql and query must agree.');
    const sql = event.sql ?? event.query;
    if (!text(sql)) throw new TypeError('Every event needs a non-empty SQL statement.');
    const dialect = dialectName(event.dialect ?? 'postgresql');
    const database = event.database ?? null;
    if (database !== null && !text(database)) throw new TypeError('database must be a non-empty string.');
    const id = event.requestId ?? null;
    if (id !== null && !text(id) && !Number.isSafeInteger(id)) throw new TypeError('requestId must be a non-empty string or safe integer.');
    for (const key of ['failed', 'success']) {
      if (event[key] !== undefined && typeof event[key] !== 'boolean') throw new TypeError(`${key} must be a boolean.`);
    }
    const duration = event.durationMs ?? null;
    if (duration !== null) requireNumber(duration, 'durationMs');
    const normalized = sqlShape(sql, dialect);
    const key = JSON.stringify([database, dialect, normalized.shape]);
    const measured = { duration, failed: event.failed === true || event.success === false || (event.error != null && event.error !== false) };
    addEvent(overall, measured);
    if (!patterns.has(key)) patterns.set(key, { ...eventGroup(), shape: normalized.shape, dialect, database, requestIds: new Set(), read: normalized.read });
    const pattern = patterns.get(key);
    addEvent(pattern, measured);
    // Any non-read statement sharing a lexical shape suppresses N+1 tagging.
    pattern.read &&= normalized.read;
    if (id === null) { unattributedEvents++; continue; }
    const requestKey = JSON.stringify([typeof id, id]);
    pattern.requestIds.add(requestKey);
    if (!requests.has(requestKey)) requests.set(requestKey, { ...eventGroup(), requestId: id, patterns: new Map() });
    const request = requests.get(requestKey);
    addEvent(request, measured);
    if (!request.patterns.has(key)) request.patterns.set(key, eventGroup());
    addEvent(request.patterns.get(key), measured);
  }
  const patternResult = (key, group) => {
    const pattern = patterns.get(key);
    return { shape: pattern.shape, dialect: pattern.dialect, database: pattern.database, ...groupResult(group) };
  };
  const entries = [...patterns.entries()].sort((a, b) => b[1].count - a[1].count || compareText(a[0], b[0]));
  const patternRows = entries.map(([key, group]) => ({ ...patternResult(key, group), requestCount: group.requestIds.size }));
  const nPlusOneCandidates = [];
  const requestRows = [...requests.entries()].sort((a, b) => compareText(a[0], b[0])).map(([, request]) => {
    const local = [...request.patterns.entries()].sort((a, b) => b[1].count - a[1].count || compareText(a[0], b[0]));
    for (const [key, group] of local) {
      const pattern = patterns.get(key);
      if (group.count >= 2 && pattern.read) {
        nPlusOneCandidates.push({ requestId: request.requestId, shape: pattern.shape, dialect: pattern.dialect, database: pattern.database, count: group.count, repeatedCount: group.count - 1 });
      }
    }
    return { requestId: request.requestId, ...groupResult(request), patterns: local.map(([key, group]) => patternResult(key, group)) };
  });
  const durations = durationStats(overall.times, overall.count);
  const costlyPatterns = patternRows.filter((pattern) => pattern.durations.totalMs > 0)
    .sort((a, b) => b.durations.totalMs - a.durations.totalMs || compareText(JSON.stringify([a.database, a.dialect, a.shape]), JSON.stringify([b.database, b.dialect, b.shape])))
    .map((pattern) => ({ ...pattern, durationShare: pattern.durations.totalMs / durations.totalMs }));
  return {
    totalEvents: overall.count, requestCount: requests.size, unattributedEvents,
    failureCount: overall.failureCount, failureRate: overall.count ? overall.failureCount / overall.count : 0,
    durations, patterns: patternRows, requests: requestRows, nPlusOneCandidates, costlyPatterns,
  };
}

const ROUTE_FIELDS = new Set(['consistency', 'maxLagMs', 'nowMs', 'maxTelemetryAgeMs', 'readAfterWrite', 'capacityUnits', 'maxUtilization', 'maxRouteCost', 'maxLatencyMs']);

/**
 * Choose from caller-supplied node telemetry; never probe a node or consult a
 * model. The caller MUST authenticate the request, authorize its consistency
 * policy, and construct requirements from trusted server-side data. This pure
 * function validates that policy but cannot establish identity or prevent a
 * caller from forging telemetry. Pass the same clock value for one decision.
 *
 * Node shape: {id:string, role:'primary'|'replica', healthy:boolean,
 * telemetryAtMs:number, capacity:number, inFlight:number,
 * lagMs?:number, lagObservedAtMs?:number, routeCost?:number,
 * estimatedLatencyMs?:number}. capacity/inFlight are non-negative safe integer
 * slots in the same snapshot; capacity 0 is unavailable. Only healthy:true is
 * healthy. Missing/malformed role, health, time or capacity makes a node
 * ineligible. Duplicate/missing/empty ids throw TypeError. Unknown node fields
 * have no effect. The caller must supply the authoritative primary role.
 *
 * Requirements: {consistency:'strong'|'bounded'|'eventual', nowMs:number,
 * maxTelemetryAgeMs:number, maxLagMs?:number, readAfterWrite?:boolean,
 * capacityUnits?:number, maxUtilization?:number, maxRouteCost?:number,
 * maxLatencyMs?:number}. No unknown keys are accepted. Invalid requirements
 * throw TypeError. nowMs and timestamps are non-negative safe integer epoch
 * milliseconds. Limits are finite non-negative numbers. Bounded requires
 * maxLagMs, including zero. readAfterWrite defaults false, capacityUnits to 1
 * (a positive safe integer), maxUtilization to 1 (must be >0 and <=1).
 *
 * Strong/readAfterWrite admits only primaries. Bounded replicas need finite
 * non-negative lag AND a separately fresh lagObservedAtMs. Primaries do not
 * need replication lag. Eventual still enforces health, age and capacity.
 * Future timestamps, stale evidence and insufficient projected capacity are
 * rejected. Age/lag/budget limits are inclusive. routeCost and maxRouteCost
 * use the same caller-defined units per routed request; a cost/latency limit
 * requires a valid measurement. Optional malformed cost/latency/lag evidence
 * is never used for ranking. There is no fallback that weakens constraints.
 *
 * Eligible nodes rank by replica preference (except primary-only requests),
 * projected utilization, routeCost, estimatedLatencyMs, bounded lag, then id
 * in code-point order. Missing optional rank measurements sort last.
 * Returns {nodeId,reason,eligible:string[]} with eligible ids in rank order.
 * With none, nodeId is null and reason starts with review:. This is a routing
 * decision, not a capacity reservation: the caller must reserve atomically
 * and retry with a fresh snapshot when another request takes the last slot.
 * @param {Array<object>} nodes
 * @param {object} requirements
 * @returns {{nodeId:string|null,reason:string,eligible:string[]}}
 */
export function routeReplica(nodes, requirements) {
  if (!Array.isArray(nodes)) throw new TypeError('nodes must be an array.');
  if (!isRecord(requirements)) throw new TypeError('requirements must be an object.');
  for (const key of Object.keys(requirements)) if (!ROUTE_FIELDS.has(key)) throw new TypeError(`Unknown route requirement: ${key}.`);
  const { consistency, nowMs, maxTelemetryAgeMs, maxLagMs, readAfterWrite = false, capacityUnits = 1,
    maxUtilization = 1, maxRouteCost, maxLatencyMs } = requirements;
  if (!['strong', 'bounded', 'eventual'].includes(consistency)) throw new TypeError('consistency must be strong, bounded or eventual.');
  requireNumber(nowMs, 'nowMs', { integer: true });
  requireNumber(maxTelemetryAgeMs, 'maxTelemetryAgeMs');
  if (typeof readAfterWrite !== 'boolean') throw new TypeError('readAfterWrite must be a boolean.');
  requireNumber(capacityUnits, 'capacityUnits', { integer: true, positive: true });
  requireNumber(maxUtilization, 'maxUtilization', { positive: true });
  if (maxUtilization > 1) throw new TypeError('maxUtilization must be at most 1.');
  if (consistency === 'bounded' || maxLagMs !== undefined) requireNumber(maxLagMs, 'maxLagMs');
  if (maxRouteCost !== undefined) requireNumber(maxRouteCost, 'maxRouteCost');
  if (maxLatencyMs !== undefined) requireNumber(maxLatencyMs, 'maxLatencyMs');
  const primaryOnly = consistency === 'strong' || readAfterWrite;
  const fresh = (at) => Number.isSafeInteger(at) && at >= 0 && at <= nowMs && nowMs - at <= maxTelemetryAgeMs;
  const ids = new Set();
  const eligible = [];
  for (const node of nodes) {
    if (!isRecord(node) || !text(node.id)) throw new TypeError('Every route node needs a non-empty string id.');
    if (ids.has(node.id)) throw new TypeError('Route node ids must be unique.');
    ids.add(node.id);
    if (!['primary', 'replica'].includes(node.role) || node.healthy !== true || !fresh(node.telemetryAtMs)) continue;
    if (primaryOnly && node.role !== 'primary') continue;
    if (!Number.isSafeInteger(node.capacity) || node.capacity <= 0 || !Number.isSafeInteger(node.inFlight) || node.inFlight < 0) continue;
    if (capacityUnits > node.capacity - node.inFlight) continue;
    const utilization = (node.inFlight + capacityUnits) / node.capacity;
    if (utilization > maxUtilization) continue;
    if (!primaryOnly && consistency === 'bounded' && node.role === 'replica'
      && (!finite(node.lagMs) || !fresh(node.lagObservedAtMs) || node.lagMs > maxLagMs)) continue;
    if (maxRouteCost !== undefined && (!finite(node.routeCost) || node.routeCost > maxRouteCost)) continue;
    if (maxLatencyMs !== undefined && (!finite(node.estimatedLatencyMs) || node.estimatedLatencyMs > maxLatencyMs)) continue;
    eligible.push({ node, utilization });
  }
  const optionalRank = (value) => finite(value) ? value : Infinity;
  eligible.sort((a, b) => {
    const role = (node) => !primaryOnly && node.role === 'primary' ? 1 : 0;
    const lag = (node) => consistency === 'bounded' && node.role === 'replica' && fresh(node.lagObservedAtMs) ? optionalRank(node.lagMs) : Infinity;
    return role(a.node) - role(b.node) || a.utilization - b.utilization
      || optionalRank(a.node.routeCost) - optionalRank(b.node.routeCost)
      || optionalRank(a.node.estimatedLatencyMs) - optionalRank(b.node.estimatedLatencyMs)
      || lag(a.node) - lag(b.node) || compareText(a.node.id, b.node.id);
  });
  const selected = eligible[0]?.node;
  const reason = !selected ? (primaryOnly ? 'review:no-eligible-primary' : 'review:no-eligible-node')
    : readAfterWrite ? 'read-after-write-primary' : consistency === 'strong' ? 'strong-primary'
      : selected.role === 'primary' ? 'primary-fallback' : `${consistency}-replica`;
  return { nodeId: selected?.id ?? null, reason, eligible: eligible.map(({ node }) => node.id) };
}
