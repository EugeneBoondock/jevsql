import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzePlan, summarizeWorkload, routeReplica } from '../src/telemetry.mjs';

function freeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

// Hand-authored fixtures in documented EXPLAIN formats. No server is used.
const PG = freeze([{
  Plan: {
    'Node Type': 'Sort', 'Plan Rows': 20, 'Actual Rows': 2000, 'Actual Loops': 1,
    'Actual Total Time': 50, 'Sort Method': 'external merge', 'Sort Space Type': 'Disk', 'Sort Space Used': 4096,
    'Shared Hit Blocks': 120, 'Shared Read Blocks': 30, 'Temp Read Blocks': 8, 'Temp Written Blocks': 10,
    'I/O Read Time': 3.5,
    Plans: [{
      'Node Type': 'Nested Loop', 'Plan Rows': 20, 'Actual Rows': 2000, 'Actual Loops': 1,
      'Shared Hit Blocks': 120, 'Shared Read Blocks': 30,
      Plans: [{
        'Node Type': 'Index Scan', 'Relation Name': 'customers', 'Index Name': 'customers_pkey',
        'Index Cond': '(id < 21)', 'Plan Rows': 20, 'Actual Rows': 20, 'Actual Loops': 1,
        'Shared Hit Blocks': 20, 'Shared Read Blocks': 10,
      }, {
        'Node Type': 'Seq Scan', 'Relation Name': 'orders', 'Plan Rows': 1, 'Actual Rows': 100,
        'Actual Loops': 20, 'Actual Total Time': 1, 'Rows Removed by Filter': 900,
        'Shared Hit Blocks': 100, 'Shared Read Blocks': 20,
      }],
    }],
  },
  Planning: { 'Shared Hit Blocks': 9999 }, 'Execution Time': 52,
}]);

const MYSQL = freeze({ query_block: {
  select_id: 1, cost_info: { query_cost: '543.00' },
  grouping_operation: {
    using_filesort: true, using_temporary_table: true,
    nested_loop: [
      { table: {
        table_name: 'customers', access_type: 'ALL', possible_keys: ['country_idx'],
        rows_examined_per_scan: 10000, rows_produced_per_join: 100, filtered: '1.00',
        cost_info: { read_cost: '100.00', eval_cost: '10.00', prefix_cost: '110.00' },
      } },
      { table: {
        table_name: 'orders', access_type: 'ref', key: 'customer_idx',
        rows_examined_per_scan: 8, rows_produced_per_join: 400, filtered: '50.00',
        attached_subqueries: [{ dependent: true, cacheable: false, query_block: {
          select_id: 3, table: { table_name: 'audit', access_type: 'ALL', rows_examined_per_scan: 2, filtered: '100.00' },
        } }],
      } },
      { table: {
        table_name: '<derived2>', access_type: 'ALL', rows_examined_per_scan: 2, filtered: '100.00',
        materialized_from_subquery: {
          using_temporary_table: true, dependent: false, cacheable: true,
          query_block: { select_id: 2, table: { table_name: 'items', access_type: 'index', key: 'item_idx', rows_examined_per_scan: 2, filtered: '100.00' } },
        },
      } },
    ],
  },
} });

const SQLITE = freeze([
  { id: 1, parent: 0, notused: 0, detail: 'MULTI-INDEX OR' },
  { id: 2, parent: 1, notused: 0, detail: 'SEARCH orders USING COVERING INDEX customer_idx (customer_id=?)' },
  { id: 3, parent: 1, notused: 0, detail: 'SEARCH orders USING INDEX date_idx (created_at>?)' },
  { id: 8, parent: 0, notused: 0, detail: 'SCAN customers' },
  { id: 9, parent: 0, notused: 0, detail: 'SCAN names USING COVERING INDEX name_idx' },
  { id: 10, parent: 0, notused: 0, detail: 'SEARCH events USING INTEGER PRIMARY KEY (rowid=?)' },
  { id: 11, parent: 0, notused: 0, detail: 'USE TEMP B-TREE FOR ORDER BY' },
  { id: 12, parent: 0, notused: 0, detail: 'SCAN documents VIRTUAL TABLE INDEX 0:M1' },
]);

test('PG fixture exposes a stable tree, scan/index counts and root outputs', () => {
  const result = analyzePlan(PG);
  assert.equal(result.dialect, 'postgresql');
  assert.deepEqual(result.nodes.map((node) => [node.id, node.parentId]), [['n0', null], ['n1', 'n0'], ['n2', 'n1'], ['n3', 'n1']]);
  assert.equal(result.summary.nodeCount, 4);
  assert.equal(result.summary.scanNodes, 2);
  assert.equal(result.summary.indexNodes, 1);
  assert.equal(result.summary.indexAccessRatio, 0.5);
  assert.equal(result.summary.unindexedFullScanNodes, 1);
  assert.equal(result.summary.estimatedOutputRows, 20);
  assert.equal(result.summary.actualOutputRows, 2000);
  assert.equal(result.summary.executionTimeMs, 52);
  assert.equal(result.nodes[2].index, 'customers_pkey');
});

test('PG compares per-loop rows and reports measured loop totals', () => {
  const result = analyzePlan(PG);
  const inner = result.nodes.find((node) => node.relation === 'orders');
  assert.deepEqual(inner.cardinality, {
    estimatedRowsPerLoop: 1, actualRowsPerLoop: 100, loops: 20,
    estimatedTotalRows: 20, actualTotalRows: 2000, actualToEstimatedRatio: 100,
    errorFactor: 100, unboundedError: false, status: 'underestimated',
  });
  assert.equal(inner.observedRowsTotal, 20000);
  assert.equal(inner.actualTimePerLoopMs, 1);
  assert.equal(inner.actualTotalTimeMs, 20);
  assert.equal(inner.filteredOutRatio, 0.9);
  assert.equal(result.summary.cardinalityComparisons, 4);
  assert.equal(result.summary.cardinalityMismatchNodes, 3);
  assert.equal(result.summary.maxFiniteCardinalityError, 100);
  assert.ok(result.symptoms.some((symptom) => symptom.name === 'large-filtered-scan' && symptom.evidence.basis === 'observed-total'));
  assert.ok(result.symptoms.some((symptom) => symptom.name === 'repeated-full-scan'));
});

test('PG inclusive IO is taken from roots without adding children or planning', () => {
  const result = analyzePlan(PG);
  assert.equal(result.summary.io.sharedHitBlocks, 120);
  assert.equal(result.summary.io.sharedReadBlocks, 30);
  assert.equal(result.summary.io.sharedHitRatio, 0.8);
  assert.equal(result.summary.io.readTimeMs, 3.5);
  assert.equal(result.summary.io.tempWrittenBlocks, 10);
  assert.equal(result.summary.ioScope, 'root-nodes');
  assert.ok(result.symptoms.some((symptom) => symptom.name === 'buffer-reads'));
  assert.ok(result.symptoms.some((symptom) => symptom.name === 'temporary-io'));
});

test('PG actual disk sort evidence reports a spill and JSON-safe output', () => {
  const result = analyzePlan(PG);
  assert.equal(result.summary.sortSpillNodes, 1);
  assert.equal(result.nodes[0].sort.spilled, true);
  assert.equal(result.nodes[0].sort.evidence[0].spaceUsedKb, 4096);
  assert.ok(result.symptoms.some((symptom) => symptom.name === 'sort-spill'));
  assert.deepEqual(JSON.parse(JSON.stringify(result)), result);
  assert.deepEqual(analyzePlan(JSON.stringify(PG)), result);
});

for (const [estimated, actual, loops, status, ratio, unbounded, mismatches] of [
  [0, 0, 1, 'match', 1, false, 0],
  [0, 10, 2, 'underestimated', null, true, 1],
  [10, 0, 3, 'overestimated', 0, true, 1],
  [10, 0, 0, 'not-executed', null, false, 0],
  [100, 1, undefined, 'unknown', null, false, 0],
  [100, 1, 1, 'overestimated', 0.01, false, 1],
  [1, 0.1, 10, 'overestimated', 0.1, false, 1],
  [9, 1, 1, 'overestimated', 1 / 9, false, 0],
]) {
  test(`PG cardinality handles estimated=${estimated}, actual=${actual}, loops=${loops}`, () => {
    const result = analyzePlan({ 'Node Type': 'Result', 'Plan Rows': estimated, 'Actual Rows': actual, 'Actual Loops': loops });
    const c = result.nodes[0].cardinality;
    assert.equal(c.status, status);
    assert.equal(c.actualToEstimatedRatio, ratio);
    assert.equal(c.unboundedError, unbounded);
    assert.equal(result.summary.cardinalityMismatchNodes, mismatches);
    assert.deepEqual(JSON.parse(JSON.stringify(result)), result);
    if (loops === 0) assert.equal(c.actualTotalRows, 0);
    if (loops === undefined) assert.equal(c.actualTotalRows, null);
  });
}

test('PG correct estimates do not become mismatches when a node repeats', () => {
  const result = analyzePlan({ 'Node Type': 'Index Scan', 'Plan Rows': 2, 'Actual Rows': 2, 'Actual Loops': 1000 });
  assert.equal(result.nodes[0].cardinality.actualTotalRows, 2000);
  assert.equal(result.nodes[0].cardinality.errorFactor, 1);
  assert.equal(result.summary.cardinalityMismatchNodes, 0);
  assert.deepEqual(result.symptoms, []);
});

test('PG scans alone and startup costs never imply a defect or lock wait', () => {
  const result = analyzePlan({
    'Node Type': 'Seq Scan', 'Plan Rows': 200000, 'Actual Rows': 200000, 'Actual Loops': 1,
    'Startup Cost': 999999, 'Total Cost': 1000000, 'Actual Startup Time': 50000,
  });
  assert.deepEqual(result.symptoms, []);
  assert.equal(result.nodes[0].estimatedStartupCost, 999999);
  assert.equal(result.summary.io.readTimeMs, null);
  assert.equal(result.summary.executionTimeMs, null);
});

test('PG bitmap/index-only paths count as indexed access and non-table scans remain distinct', () => {
  const result = analyzePlan({ 'Node Type': 'Append', Plans: [
    { 'Node Type': 'Bitmap Heap Scan', Plans: [{ 'Node Type': 'Bitmap Index Scan', 'Index Name': 'bitmap_idx' }] },
    { 'Node Type': 'Index Only Scan' }, { 'Node Type': 'CTE Scan' }, { 'Node Type': 'Function Scan' },
  ] });
  assert.equal(result.summary.indexNodes, 3);
  assert.equal(result.summary.scanNodes, 5);
  assert.equal(result.summary.fullScanNodes, 0);
  assert.equal(result.summary.indexAccessRatio, 3 / 5);
});

test('PG missing root IO is unknown, explicit zero stays zero, and worker IO is not added', () => {
  const result = analyzePlan({ 'Node Type': 'Gather', 'Shared Hit Blocks': 0, 'Shared Read Blocks': 0,
    Workers: [{ 'Shared Hit Blocks': 900 }], Plans: [{ 'Node Type': 'Seq Scan', 'Temp Read Blocks': 100 }] });
  assert.equal(result.summary.io.sharedHitBlocks, 0);
  assert.equal(result.summary.io.sharedHitRatio, null);
  assert.equal(result.summary.io.tempReadBlocks, null);
  assert.equal(result.nodes.length, 2);
});

test('PG worker and incremental sort statistics can establish a spill', () => {
  const worker = analyzePlan({ 'Node Type': 'Sort', 'Sort Method': 'quicksort', 'Sort Space Type': 'Memory',
    Workers: [{ 'Worker Number': 0, 'Sort Method': 'external merge', 'Sort Space Type': 'Disk', 'Sort Space Used': 200 }] });
  assert.equal(worker.nodes.length, 1);
  assert.equal(worker.summary.sortSpillNodes, 1);
  assert.equal(worker.nodes[0].sort.evidence[1].source, 'worker:0');
  const incremental = analyzePlan({ 'Node Type': 'Incremental Sort', 'Pre-sorted Groups': {
    'Group Count': 5, 'Sort Methods Used': ['quicksort', 'external merge'],
    'Sort Space Disk': { 'Average Sort Space Used': 100, 'Peak Sort Space Used': 250 },
  } });
  assert.equal(incremental.summary.sortSpillNodes, 1);
  assert.equal(incremental.nodes[0].sort.evidence[0].peakDiskKb, 250);
});

test('PG in-memory sorts and temporary IO at a non-sort node do not invent sort spills', () => {
  const result = analyzePlan({ 'Node Type': 'Materialize', 'Temp Written Blocks': 4,
    Plans: [{ 'Node Type': 'Sort', 'Sort Method': 'quicksort', 'Sort Space Type': 'Memory', 'Sort Space Used': 10 }] });
  assert.equal(result.summary.sortSpillNodes, 0);
  assert.equal(result.nodes[1].sort.spilled, false);
  assert.ok(result.symptoms.some((symptom) => symptom.name === 'temporary-io'));
  assert.equal(analyzePlan({ 'Node Type': 'Sort' }).nodes[0].sort.spilled, null);
});

test('unrecognized PG sort telemetry stays unknown rather than claiming memory sorting', () => {
  for (const extra of [
    { 'Sort Method': 'unknown' }, { 'Sort Space Type': 'unknown' },
    { 'Full-sort Groups': { 'Sort Methods Used': ['unknown'] } },
    { 'Sort Method': 'quicksort', Workers: [{ 'Sort Method': 'unknown' }] },
  ]) {
    const result = analyzePlan({ 'Node Type': 'Sort', ...extra });
    assert.equal(result.nodes[0].sort.spilled, null);
    assert.equal(result.summary.sortSpillNodes, 0);
  }
});

test('PG unavailable or malformed numeric evidence never becomes a measured zero', () => {
  for (const invalid of [undefined, null, '', ' ', true, false, NaN, Infinity, -1, 'NaN', '0x10', []]) {
    const node = analyzePlan({ 'Node Type': 'Seq Scan', 'Actual Rows': invalid, 'Actual Loops': 1, 'Shared Hit Blocks': invalid }).nodes[0];
    assert.equal(node.cardinality.actualRowsPerLoop, null, String(invalid));
    assert.equal(node.io.sharedHitBlocks, null, String(invalid));
  }
  const node = analyzePlan({ 'Node Type': 'Seq Scan', 'Plan Rows': '1e2', 'Actual Rows': '100', 'Actual Loops': '2' }).nodes[0];
  assert.equal(node.cardinality.actualTotalRows, 200);
  assert.equal(node.cardinality.errorFactor, 1);
});

test('PG overflows and underflows have explicit JSON-safe cardinality evidence', () => {
  const result = analyzePlan({ 'Node Type': 'Result', 'Plan Rows': Number.MIN_VALUE, 'Actual Rows': Number.MAX_VALUE, 'Actual Loops': 2 });
  assert.equal(result.nodes[0].cardinality.actualTotalRows, null);
  assert.equal(result.nodes[0].cardinality.actualToEstimatedRatio, null);
  assert.equal(result.nodes[0].cardinality.unboundedError, true);
  assert.deepEqual(JSON.parse(JSON.stringify(result)), result);
});

test('PG forests aggregate only complete root measurements', () => {
  const result = analyzePlan([
    { Plan: { 'Node Type': 'Result', 'Plan Rows': 3, 'Actual Rows': 3, 'Actual Loops': 1, 'Shared Read Blocks': 2 }, 'Execution Time': 2 },
    { Plan: { 'Node Type': 'Result', 'Plan Rows': 2, 'Actual Rows': 2, 'Actual Loops': 1, 'Shared Read Blocks': 4 }, 'Execution Time': 3 },
  ]);
  assert.equal(result.summary.rootCount, 2);
  assert.equal(result.summary.actualOutputRows, 5);
  assert.equal(result.summary.io.sharedReadBlocks, 6);
  assert.equal(result.summary.io.sharedHitBlocks, null);
  assert.equal(result.summary.executionTimeMs, 5);
});

test('MySQL fixture traverses joins, attached queries and materialized query blocks', () => {
  const result = analyzePlan(MYSQL, { dialect: 'mysql' });
  assert.equal(result.nodes.length, 10);
  assert.deepEqual(result.nodes.filter((node) => node.relation).map((node) => node.relation).sort(), ['<derived2>', 'audit', 'customers', 'items', 'orders']);
  assert.equal(result.summary.rootCount, 1);
  assert.equal(result.summary.indexNodes, 2);
  assert.equal(result.summary.indexAccessRatio, 2 / 5);
  assert.equal(result.nodes[0].estimatedTotalCost, 543);
  const audit = result.nodes.find((node) => node.relation === 'audit');
  assert.equal(result.nodes.find((node) => node.id === audit.parentId).operation, 'Query Block');
});

test('MySQL examined rows, join output and cost remain estimates', () => {
  const result = analyzePlan(MYSQL, { dialect: 'mysql' });
  const orders = result.nodes.find((node) => node.relation === 'orders');
  assert.equal(orders.estimatedRowsExaminedPerScan, 8);
  assert.equal(orders.cardinality.estimatedRowsPerLoop, 4);
  assert.equal(orders.estimatedRowsProducedPerJoin, 400);
  assert.equal(orders.cardinality.actualRowsPerLoop, null);
  assert.equal(orders.cardinality.actualTotalRows, null);
  assert.equal(orders.cardinality.loops, null);
  assert.equal(result.summary.cardinalityComparisons, 0);
  assert.equal(result.summary.executionTimeMs, null);
  assert.equal(result.summary.io.readTimeMs, null);
  const scan = result.symptoms.find((symptom) => symptom.name === 'large-filtered-scan');
  assert.equal(scan.evidence.basis, 'estimated-per-scan');
  assert.equal(scan.evidence.rows, 10000);
  assert.equal(scan.evidence.filteredOutRatio, 0.99);
});

test('MySQL filesort and temporary tables do not prove disk spills', () => {
  const result = analyzePlan(MYSQL, { dialect: 'mysql' });
  assert.equal(result.summary.sortNodes, 1);
  assert.equal(result.summary.sortSpillNodes, 0);
  assert.ok(result.symptoms.some((symptom) => symptom.name === 'filesort'));
  assert.ok(result.symptoms.some((symptom) => symptom.name === 'temporary-structure'));
  assert.ok(!result.symptoms.some((symptom) => ['sort-spill', 'buffer-reads', 'temporary-io'].includes(symptom.name)));
  assert.deepEqual(analyzePlan(JSON.stringify(MYSQL), { dialect: 'mysql' }), result);
});

test('MySQL possible keys are not used keys; full index scans still use indexes', () => {
  const result = analyzePlan(MYSQL, { dialect: 'mysql' });
  const table = result.nodes.find((node) => node.relation === 'customers');
  const index = result.nodes.find((node) => node.relation === 'items');
  assert.equal(table.usesIndex, false);
  assert.equal(table.index, null);
  assert.equal(index.isFullScan, true);
  assert.equal(index.usesIndex, true);
  const unknown = analyzePlan({ query_block: { table: { table_name: 't', access_type: 'ALL', rows_examined_per_scan: 100, filtered: 101 } } }, { dialect: 'mysql' });
  assert.equal(unknown.nodes[1].cardinality.estimatedRowsPerLoop, null);
  assert.equal(unknown.nodes[1].filteredOutRatio, null);
});

test('MySQL union query specifications and table-free query blocks are accepted', () => {
  const result = analyzePlan({ query_block: { union_result: { query_specifications: [
    { query_block: { select_id: 1, table: { table_name: 'a', access_type: 'range', key: 'idx', rows_examined_per_scan: 0, filtered: 0 } } },
    { query_block: { select_id: 2, message: 'No tables used' } },
  ] } } }, { dialect: 'mysql' });
  assert.equal(result.nodes.filter((node) => node.operation === 'Query Block').length, 3);
  assert.equal(result.nodes.find((node) => node.relation === 'a').cardinality.estimatedRowsPerLoop, 0);
  assert.equal(result.summary.indexNodes, 1);
});

test('MySQL metadata keys cannot resolve inherited operation names', () => {
  const result = analyzePlan(JSON.parse('{"query_block":{"constructor":{"using_filesort":true}}}'), { dialect: 'mysql' });
  assert.deepEqual(result.nodes.map((node) => node.operation), ['Query Block', 'Operation']);
  assert.deepEqual(JSON.parse(JSON.stringify(result)), result);
});

test('SQLite fixture distinguishes searches, full index scans and virtual table scans', () => {
  const result = analyzePlan(SQLITE, { dialect: 'sqlite' });
  assert.equal(result.summary.nodeCount, 8);
  assert.equal(result.summary.scanNodes, 3);
  assert.equal(result.summary.fullScanNodes, 3);
  assert.equal(result.summary.indexNodes, 4);
  assert.equal(result.summary.indexAccessRatio, 4 / 6);
  assert.equal(result.nodes[1].parentId, result.nodes[0].id);
  assert.equal(result.nodes[1].index, 'customer_idx');
  assert.equal(result.nodes[5].usesIndex, true);
  assert.equal(result.nodes[7].usesIndex, false);
  assert.equal(result.summary.cardinalityComparisons, 0);
  assert.equal(result.summary.io.sharedReadBlocks, null);
});

test('SQLite temporary B-trees do not imply measured disk IO or spills', () => {
  const result = analyzePlan(SQLITE, { dialect: 'sqlite' });
  assert.equal(result.summary.sortNodes, 1);
  assert.equal(result.summary.sortSpillNodes, 0);
  assert.deepEqual(result.symptoms.map((symptom) => symptom.name), ['temporary-structure']);
  assert.ok(result.nodes.every((node) => node.cardinality.actualTotalRows === null));
});

test('SQLite accepts array rows, result wrappers and forward parent references', () => {
  const result = analyzePlan({ rows: [
    [3, 1, 0, 'SEARCH t USING AUTOMATIC PARTIAL COVERING INDEX (x=?)'],
    [1, 0, 0, 'CORRELATED SCALAR SUBQUERY 1'],
    [5, 0, 0, 'SCAN TABLE "odd table" USING INDEX "odd index"'],
  ] }, { dialect: 'sqlite' });
  assert.equal(result.nodes[0].parentId, 'n1');
  assert.equal(result.nodes[0].usesIndex, true);
  assert.equal(result.nodes[0].index, null);
  assert.equal(result.nodes[2].relation, '"odd table"');
  assert.equal(result.nodes[2].index, '"odd index"');
  assert.equal(analyzePlan([[0, 0, 0, 'SCAN t']], { dialect: 'sqlite' }).nodes[0].parentId, null);
});

test('SQLite validates duplicate ids, malformed rows and parent cycles', () => {
  for (const rows of [
    [[1, 0, 0, 'SCAN a'], [1, 0, 0, 'SCAN b']],
    [[1, 2, 0, 'SCAN a'], [2, 1, 0, 'SCAN b']],
    [[1, 1, 0, 'SCAN a']], [[-1, 0, 0, 'SCAN a']], [[1, 0, 0, null]], [null],
  ]) assert.throws(() => analyzePlan(rows, { dialect: 'sqlite' }), TypeError);
});

for (const dialect of ['postgresql', 'mysql', 'sqlite']) {
  test(`${dialect} empty plans return zero counts and unknown evidence`, () => {
    const result = analyzePlan([], { dialect });
    assert.deepEqual(result.nodes, []);
    assert.deepEqual(result.symptoms, []);
    assert.equal(result.summary.nodeCount, 0);
    assert.equal(result.summary.indexAccessRatio, null);
    assert.equal(result.summary.actualOutputRows, null);
    assert.equal(result.summary.io.sharedHitBlocks, null);
  });
}

test('plan readers validate format, cycles and depth without altering inputs', () => {
  for (const plan of [null, undefined, 5, {}, [null], '{', 'SELECT 1', { Plan: null }, { 'Node Type': 'Result', Plans: {} }]) {
    assert.throws(() => analyzePlan(plan), TypeError);
  }
  assert.throws(() => analyzePlan(PG, { dialect: 'unknown' }), TypeError);
  assert.throws(() => analyzePlan({}, { dialect: 'mysql' }), TypeError);
  assert.throws(() => analyzePlan({}, { dialect: 'sqlite' }), TypeError);
  const cycle = { 'Node Type': 'Result' }; cycle.Plans = [cycle];
  assert.throws(() => analyzePlan(cycle), /cycles/);
  let deep = { 'Node Type': 'Result' };
  for (let i = 0; i < 140; i++) deep = { 'Node Type': 'Result', Plans: [deep] };
  assert.throws(() => analyzePlan(deep), /limit/);
  const shared = freeze({ 'Node Type': 'Result' });
  assert.equal(analyzePlan({ 'Node Type': 'Append', Plans: [shared, shared] }).nodes.length, 3);
  for (const [plan, dialect] of [[PG, 'postgresql'], [MYSQL, 'mysql'], [SQLITE, 'sqlite']]) {
    const before = JSON.stringify(plan);
    analyzePlan(plan, { dialect });
    assert.equal(JSON.stringify(plan), before);
  }
});

const WORKLOAD = freeze([
  { requestId: 'a', sql: 'SELECT id FROM users', durationMs: 5 },
  { requestId: 'a', sql: 'SELECT * FROM orders WHERE user_id = 1', durationMs: 10 },
  { requestId: 'a', sql: ' select * from orders /* trace */ where user_id=2; ', durationMs: 20 },
  { requestId: 'a', sql: 'SELECT * FROM orders WHERE user_id=$1', durationMs: 30, success: false },
  { requestId: 'b', sql: 'SELECT * FROM orders WHERE user_id=8', durationMs: 100 },
  { sql: 'SELECT * FROM orders WHERE user_id=9', durationMs: 50 },
  { sql: 'SELECT * FROM orders WHERE user_id=10', durationMs: 40 },
]);

test('workload canonical shapes count repeats within each request for N+1 candidates', () => {
  const result = summarizeWorkload(WORKLOAD);
  assert.equal(result.totalEvents, 7);
  assert.equal(result.requestCount, 2);
  assert.equal(result.unattributedEvents, 2);
  assert.equal(result.patterns.length, 2);
  assert.equal(result.patterns[0].count, 6);
  assert.equal(result.patterns[0].requestCount, 2);
  assert.deepEqual(result.nPlusOneCandidates, [{ requestId: 'a', shape: 'select * from orders where user_id = ?', dialect: 'postgresql', database: null, count: 3, repeatedCount: 2 }]);
  assert.equal(result.requests.find((request) => request.requestId === 'a').count, 4);
  assert.equal(result.requests.find((request) => request.requestId === 'a').patterns[0].count, 3);
});

test('workload measures percentiles, failures and ranked duration costs', () => {
  const result = summarizeWorkload(WORKLOAD);
  assert.equal(result.durations.totalMs, 255);
  assert.equal(result.durations.p50Ms, 30);
  assert.equal(result.durations.p95Ms, 100);
  assert.equal(result.durations.p99Ms, 100);
  assert.equal(result.failureCount, 1);
  assert.equal(result.failureRate, 1 / 7);
  assert.equal(result.costlyPatterns[0].durations.totalMs, 250);
  assert.equal(result.costlyPatterns[0].durationShare, 250 / 255);
  assert.equal(result.costlyPatterns[1].durations.totalMs, 5);
  assert.deepEqual(JSON.parse(JSON.stringify(result)), result);
});

test('unrelated, missing and typed request ids never merge into an N+1 request', () => {
  const events = [
    ...Array.from({ length: 20 }, (_, requestId) => ({ requestId, sql: 'SELECT * FROM t WHERE id=?' })),
    { requestId: '1', sql: 'SELECT * FROM t WHERE id=?' },
    { sql: 'SELECT * FROM t WHERE id=?' }, { requestId: null, sql: 'SELECT * FROM t WHERE id=?' },
  ];
  const result = summarizeWorkload(events);
  assert.equal(result.requestCount, 21);
  assert.equal(result.unattributedEvents, 2);
  assert.equal(result.patterns[0].count, 23);
  assert.deepEqual(result.nPlusOneCandidates, []);
});

test('workload empty input has explicit empty collections and null percentiles', () => {
  const result = summarizeWorkload([]);
  assert.equal(result.totalEvents, 0);
  assert.equal(result.requestCount, 0);
  assert.equal(result.failureRate, 0);
  for (const field of ['patterns', 'requests', 'nPlusOneCandidates', 'costlyPatterns']) assert.deepEqual(result[field], []);
  assert.deepEqual(result.durations, { samples: 0, missing: 0, totalMs: 0, meanMs: null, minMs: null, maxMs: null, p50Ms: null, p95Ms: null, p99Ms: null });
});

test('workload uses nearest rank and distinguishes missing durations from zero', () => {
  const result = summarizeWorkload(Array.from({ length: 100 }, (_, i) => ({ sql: 'SELECT 1', durationMs: 100 - i })));
  assert.equal(result.durations.p50Ms, 50);
  assert.equal(result.durations.p95Ms, 95);
  assert.equal(result.durations.p99Ms, 99);
  const partial = summarizeWorkload([{ sql: 'SELECT 1' }, { sql: 'SELECT 2', durationMs: null }, { sql: 'SELECT 3', durationMs: 0 }]);
  assert.equal(partial.durations.samples, 1);
  assert.equal(partial.durations.missing, 2);
  assert.equal(partial.durations.p99Ms, 0);
  assert.deepEqual(partial.costlyPatterns, []);
});

test('all supported explicit failure evidence is counted once per event', () => {
  const result = summarizeWorkload([
    { sql: 'SELECT 1', failed: true, success: false, error: 'failed' },
    { sql: 'SELECT 1', success: false }, { sql: 'SELECT 1', error: { code: 'TIMEOUT' } },
    { sql: 'SELECT 1', success: true, failed: false, error: null }, { sql: 'SELECT 1', error: false },
  ]);
  assert.equal(result.failureCount, 3);
  assert.equal(result.patterns[0].failureCount, 3);
});

function shapes(sqls, extra = {}) {
  return summarizeWorkload(sqls.map((sql) => ({ requestId: 'r', sql, ...extra })));
}

test('shape normalization handles escaped strings, dollar quotes, comments and numeric forms', () => {
  const stringResult = shapes([
    "SELECT * FROM t WHERE value='a''b -- still text'",
    'select * from t where value=$tag$/* text */$tag$',
    "SELECT * FROM t WHERE value=E'back\\\\slash' -- trace\n",
    "select /* outer /* nested */ done */ * from t where value='x'",
  ]);
  assert.equal(stringResult.patterns.length, 1);
  assert.equal(stringResult.patterns[0].count, 4);
  const numbers = shapes(['SELECT * FROM t WHERE id=-12', 'SELECT * FROM t WHERE id=+1.2e3', 'SELECT * FROM t WHERE id=$12', 'SELECT * FROM t WHERE id=?']);
  assert.equal(numbers.patterns.length, 1);
  assert.equal(shapes(['SELECT 0xFF', 'SELECT 0b10', 'SELECT .5']).patterns.length, 1);
});

test('shape normalization preserves identifiers, operators, casts and list arity', () => {
  assert.equal(shapes(['SELECT "Name" FROM t', 'SELECT "name" FROM t']).patterns.length, 2);
  assert.equal(shapes(['SELECT col1 FROM t', 'SELECT col2 FROM t']).patterns.length, 2);
  assert.equal(shapes(['SELECT id-1 FROM t', 'SELECT id+2 FROM t']).patterns.length, 2);
  assert.equal(shapes(['SELECT * FROM t WHERE id IN (1)', 'SELECT * FROM t WHERE id IN (1,2)']).patterns.length, 2);
  const cast = shapes(["SELECT 'x'::text", 'select $1::text']);
  assert.equal(cast.patterns.length, 1);
  assert.equal(cast.patterns[0].shape, 'select ? :: text');
  assert.equal(shapes(["SELECT data->>'x' FROM t", "SELECT data->'x' FROM t"]).patterns.length, 2);
});

test('shape normalization preserves hints and executable comments', () => {
  const result = shapes(['SELECT /*+ INDEX(t idx) */ * FROM t', 'SELECT /*+ FULL(t) */ * FROM t', 'SELECT * FROM t']);
  assert.equal(result.patterns.length, 3);
  assert.equal(shapes(['SELECT /*! STRAIGHT_JOIN */ * FROM t', 'SELECT * FROM t'], { dialect: 'mysql' }).patterns.length, 2);
});

test('MySQL shapes preserve identifier case and handle dialect comments', () => {
  assert.equal(shapes(['SELECT id FROM Users', 'select id from users'], { dialect: 'mysql' }).patterns.length, 2);
  assert.equal(shapes(['SELECT * FROM `Users` WHERE id=1 # trace', 'select * from `Users` where id=2 -- trace'], { dialect: 'mysql' }).patterns.length, 1);
  assert.equal(shapes(['SELECT 4--2', 'SELECT 4'], { dialect: 'mysql' }).patterns.length, 2);
});

test('SQLite shapes handle named parameters and bracket-quoted identifiers', () => {
  const result = shapes([
    'SELECT * FROM [odd table] WHERE id=@id', 'select * from [odd table] where id=$id',
    'SELECT * FROM [odd table] WHERE id=:id', 'select * from [odd table] where id=?123',
  ], { dialect: 'sqlite' });
  assert.equal(result.patterns.length, 1);
  assert.equal(result.patterns[0].count, 4);
});

test('database and dialect namespaces prevent unrelated shape groups', () => {
  const events = [
    { requestId: 'r', database: 'a', dialect: 'postgresql', sql: 'SELECT 1' },
    { requestId: 'r', database: 'b', dialect: 'postgresql', sql: 'SELECT 1' },
    { requestId: 'r', database: 'a', dialect: 'mysql', sql: 'SELECT 1' },
  ];
  const result = summarizeWorkload(events);
  assert.equal(result.patterns.length, 3);
  assert.equal(result.requests[0].patterns.length, 3);
  assert.deepEqual(result.nPlusOneCandidates, []);
});

test('N+1 candidates cover repeated reads, not repeated writes or multi-statements', () => {
  assert.equal(shapes(['SELECT * FROM t WHERE id=1', 'SELECT * FROM t WHERE id=2']).nPlusOneCandidates[0].repeatedCount, 1);
  for (const sql of ['UPDATE t SET x=1 WHERE id=2', 'DELETE FROM t WHERE id=1', 'SELECT 1; DELETE FROM t', 'EXPLAIN SELECT 1']) {
    assert.deepEqual(shapes([sql, sql]).nPlusOneCandidates, []);
  }
  const read = 'WITH a AS (SELECT id FROM t) SELECT * FROM a WHERE id=1';
  assert.equal(shapes([read, read]).nPlusOneCandidates.length, 1);
  const write = 'WITH a AS (UPDATE t SET x=1 RETURNING id) SELECT * FROM a';
  assert.deepEqual(shapes([write, write]).nPlusOneCandidates, []);
  const scalar = "SELECT replace(name, 'a', 'b') FROM t WHERE id=1";
  assert.equal(shapes([scalar, scalar]).nPlusOneCandidates.length, 1);
  const executable = 'SELECT 1 /*! INTO OUTFILE \'output\' */';
  assert.deepEqual(shapes([executable, executable], { dialect: 'mysql' }).nPlusOneCandidates, []);
});

test('workload uses safe map keys, accepts query aliases, and leaves input untouched', () => {
  const events = freeze([{ requestId: '__proto__', query: 'SELECT 1', durationMs: 5 }, { requestId: '__proto__', query: 'SELECT 2', durationMs: 5 }]);
  const before = JSON.stringify(events);
  assert.equal(summarizeWorkload(events).nPlusOneCandidates[0].count, 2);
  assert.equal(JSON.stringify(events), before);
  assert.deepEqual(summarizeWorkload(events), summarizeWorkload([...events].reverse()));
  assert.deepEqual(summarizeWorkload(WORKLOAD), summarizeWorkload(WORKLOAD));
});

test('workload rejects invalid records, measurements and incomplete SQL tokens', () => {
  for (const event of [null, {}, { sql: '' }, { sql: '-- comment only' }, { sql: 'SELECT 1', query: 'SELECT 2' },
    { sql: 'SELECT 1', requestId: {} }, { sql: 'SELECT 1', requestId: '' }, { sql: 'SELECT 1', database: 1 },
    { sql: 'SELECT 1', failed: 'true' }, { sql: 'SELECT 1', success: 1 }, { sql: 'SELECT 1', dialect: 'oracle' }]) {
    assert.throws(() => summarizeWorkload([event]), TypeError);
  }
  for (const durationMs of [-1, Infinity, NaN, '10', true]) assert.throws(() => summarizeWorkload([{ sql: 'SELECT 1', durationMs }]), TypeError);
  for (const sql of ["SELECT 'unfinished", 'SELECT "unfinished', 'SELECT /* missing', 'SELECT $tag$missing']) assert.throws(() => summarizeWorkload([{ sql }]), /unterminated/);
  assert.throws(() => summarizeWorkload(null), TypeError);
  assert.throws(() => summarizeWorkload([{ sql: 'SELECT 1', durationMs: Number.MAX_VALUE }, { sql: 'SELECT 2', durationMs: Number.MAX_VALUE }]), RangeError);
});

const NOW = 10000;
const policy = (overrides = {}) => ({ consistency: 'bounded', nowMs: NOW, maxTelemetryAgeMs: 100, maxLagMs: 25, ...overrides });
const replica = (id, overrides = {}) => ({ id, role: 'replica', healthy: true, telemetryAtMs: NOW - 10,
  capacity: 10, inFlight: 0, lagMs: 5, lagObservedAtMs: NOW - 10, routeCost: 1, estimatedLatencyMs: 10, ...overrides });

test('strong consistency chooses an eligible primary regardless of replica attractiveness', () => {
  const result = routeReplica([replica('r'), replica('p', { role: 'primary', inFlight: 8, lagMs: undefined })], policy({ consistency: 'strong' }));
  assert.deepEqual(result, { nodeId: 'p', reason: 'strong-primary', eligible: ['p'] });
});

test('read-after-write forces primary for bounded and eventual reads', () => {
  for (const consistency of ['bounded', 'eventual']) {
    const result = routeReplica([replica('r'), replica('p', { role: 'primary', lagMs: undefined })], policy({ consistency, readAfterWrite: true }));
    assert.deepEqual(result, { nodeId: 'p', reason: 'read-after-write-primary', eligible: ['p'] });
  }
  assert.deepEqual(routeReplica([replica('r')], policy({ readAfterWrite: true })), { nodeId: null, reason: 'review:no-eligible-primary', eligible: [] });
});

test('primary fallback preserves policy and does not need replica lag', () => {
  const nodes = [replica('r', { lagMs: 26 }), replica('p', { role: 'primary', lagMs: undefined, lagObservedAtMs: undefined })];
  assert.deepEqual(routeReplica(nodes, policy()), { nodeId: 'p', reason: 'primary-fallback', eligible: ['p'] });
  assert.equal(routeReplica(nodes, policy({ maxRouteCost: 0 })).nodeId, null);
});

test('routing limits include exact age, lag, cost, latency and capacity boundaries', () => {
  const node = replica('r', { telemetryAtMs: NOW - 100, lagObservedAtMs: NOW - 100, lagMs: 25, inFlight: 9 });
  assert.equal(routeReplica([node], policy({ maxRouteCost: 1, maxLatencyMs: 10 })).nodeId, 'r');
  assert.equal(routeReplica([replica('r', { lagMs: 0 })], policy({ maxLagMs: 0 })).nodeId, 'r');
  assert.equal(routeReplica([replica('r', { routeCost: 0, estimatedLatencyMs: 0 })], policy({ maxRouteCost: 0, maxLatencyMs: 0 })).nodeId, 'r');
  assert.equal(routeReplica([replica('r', { telemetryAtMs: NOW, lagObservedAtMs: NOW })], policy({ maxTelemetryAgeMs: 0 })).nodeId, 'r');
});

for (const [label, changes] of [
  ['missing lag', { lagMs: undefined }], ['null lag', { lagMs: null }], ['negative lag', { lagMs: -1 }],
  ['string lag', { lagMs: '0' }], ['infinite lag', { lagMs: Infinity }], ['NaN lag', { lagMs: NaN }],
  ['excessive lag', { lagMs: 26 }], ['missing lag timestamp', { lagObservedAtMs: undefined }],
  ['stale lag timestamp', { lagObservedAtMs: NOW - 101 }], ['future lag timestamp', { lagObservedAtMs: NOW + 1 }],
  ['string lag timestamp', { lagObservedAtMs: String(NOW) }],
]) {
  test(`bounded routing refuses ${label}; eventual still permits fresh healthy capacity`, () => {
    const nodes = [replica('r', changes)];
    assert.equal(routeReplica(nodes, policy()).nodeId, null);
    assert.equal(routeReplica(nodes, policy({ consistency: 'eventual' })).nodeId, 'r');
  });
}

for (const [label, changes] of [
  ['unhealthy', { healthy: false }], ['unknown health', { healthy: undefined }], ['string health', { healthy: 'true' }],
  ['numeric health', { healthy: 1 }], ['stale health', { telemetryAtMs: NOW - 101 }],
  ['future health', { telemetryAtMs: NOW + 1 }], ['missing health timestamp', { telemetryAtMs: undefined }],
  ['negative health timestamp', { telemetryAtMs: -1 }], ['string health timestamp', { telemetryAtMs: String(NOW) }],
  ['fractional health timestamp', { telemetryAtMs: NOW - 0.5 }], ['zero capacity', { capacity: 0 }],
  ['missing capacity', { capacity: undefined }], ['negative capacity', { capacity: -1 }],
  ['fractional capacity', { capacity: 2.5 }], ['string capacity', { capacity: '10' }],
  ['unsafe capacity', { capacity: Number.MAX_SAFE_INTEGER + 1 }], ['full capacity', { inFlight: 10 }],
  ['over capacity', { inFlight: 11 }], ['missing occupancy', { inFlight: undefined }],
  ['negative occupancy', { inFlight: -1 }], ['fractional occupancy', { inFlight: 0.5 }],
  ['unknown role', { role: 'leader' }],
]) {
  test(`all consistency modes refuse ${label}`, () => {
    for (const consistency of ['strong', 'bounded', 'eventual']) {
      const node = replica('n', { role: consistency === 'strong' ? 'primary' : 'replica', ...changes });
      assert.equal(routeReplica([node], policy({ consistency })).nodeId, null);
    }
  });
}

test('route budgets require valid cost and latency evidence', () => {
  for (const routeCost of [undefined, null, -1, Infinity, NaN, '1', 2]) {
    assert.equal(routeReplica([replica('r', { routeCost })], policy({ maxRouteCost: 1 })).nodeId, null);
  }
  for (const estimatedLatencyMs of [undefined, null, -1, Infinity, NaN, '10', 11]) {
    assert.equal(routeReplica([replica('r', { estimatedLatencyMs })], policy({ maxLatencyMs: 10 })).nodeId, null);
  }
  assert.equal(routeReplica([replica('r', { routeCost: undefined, estimatedLatencyMs: undefined })], policy()).nodeId, 'r');
});

test('routing reserves enough projected slots and respects utilization headroom', () => {
  const node = replica('r', { inFlight: 4 });
  assert.equal(routeReplica([node], policy({ maxUtilization: 0.5 })).nodeId, 'r');
  assert.equal(routeReplica([node], policy({ maxUtilization: 0.5, capacityUnits: 2 })).nodeId, null);
  assert.equal(routeReplica([replica('r', { inFlight: 9 })], policy({ capacityUnits: 2 })).nodeId, null);
  assert.equal(routeReplica([replica('r', { capacity: Number.MAX_SAFE_INTEGER, inFlight: Number.MAX_SAFE_INTEGER - 1 })], policy({ capacityUnits: 2 })).nodeId, null);
});

test('routing selection is stable across input orders and uses code-point id ties', () => {
  const nodes = freeze([replica('é'), replica('a'), replica('Z'), replica('primary', { role: 'primary' })]);
  const expected = { nodeId: 'Z', reason: 'bounded-replica', eligible: ['Z', 'a', 'é', 'primary'] };
  assert.deepEqual(routeReplica(nodes, policy()), expected);
  assert.deepEqual(routeReplica([...nodes].reverse(), policy()), expected);
  assert.deepEqual(routeReplica([nodes[2], nodes[0], nodes[3], nodes[1]], policy()), expected);
});

test('routing ranks projected load, cost, latency and bounded lag before id', () => {
  assert.equal(routeReplica([replica('a', { inFlight: 5 }), replica('z', { inFlight: 1 })], policy()).nodeId, 'z');
  assert.equal(routeReplica([replica('a', { routeCost: 2 }), replica('z', { routeCost: 1 })], policy()).nodeId, 'z');
  assert.equal(routeReplica([replica('a', { estimatedLatencyMs: 20 }), replica('z', { estimatedLatencyMs: 10 })], policy()).nodeId, 'z');
  assert.equal(routeReplica([replica('a', { lagMs: 20 }), replica('z', { lagMs: 5 })], policy()).nodeId, 'z');
  assert.equal(routeReplica([replica('a', { routeCost: undefined }), replica('z')], policy()).nodeId, 'z');
  assert.equal(routeReplica([replica('a', { lagMs: 20 }), replica('z', { lagMs: 5 })], policy({ consistency: 'eventual' })).nodeId, 'a');
});

test('routing never weakens a constraint when no candidate is eligible', () => {
  assert.deepEqual(routeReplica([], policy()), { nodeId: null, reason: 'review:no-eligible-node', eligible: [] });
  assert.deepEqual(routeReplica([replica('r')], policy({ consistency: 'strong' })), { nodeId: null, reason: 'review:no-eligible-primary', eligible: [] });
  assert.equal(routeReplica([replica('p', { role: 'primary', healthy: false }), replica('r')], policy({ readAfterWrite: true })).nodeId, null);
  assert.equal(routeReplica([replica('r', { healthy: false, healthScore: 1, recommendation: 'healthy' })], policy()).nodeId, null);
});

test('routing validates requirement types and refuses misspelled policy fields', () => {
  for (const changes of [
    { consistency: undefined }, { consistency: 'session' }, { nowMs: undefined }, { nowMs: -1 }, { nowMs: NaN },
    { nowMs: Infinity }, { nowMs: '10000' }, { nowMs: 1.5 }, { maxTelemetryAgeMs: undefined },
    { maxTelemetryAgeMs: -1 }, { maxTelemetryAgeMs: Infinity }, { maxLagMs: undefined }, { maxLagMs: -1 },
    { maxLagMs: NaN }, { maxLagMs: '25' }, { readAfterWrite: 'true' }, { readAfterWrite: null },
    { capacityUnits: 0 }, { capacityUnits: -1 }, { capacityUnits: 1.5 }, { capacityUnits: '1' },
    { maxUtilization: 0 }, { maxUtilization: 1.1 }, { maxUtilization: NaN }, { maxRouteCost: -1 },
    { maxRouteCost: Infinity }, { maxLatencyMs: '10' }, { readAfterwrite: true },
  ]) assert.throws(() => routeReplica([], policy(changes)), TypeError);
  for (const value of [null, undefined, [], 'bounded']) assert.throws(() => routeReplica([], value), TypeError);
  assert.throws(() => routeReplica(null, policy()), TypeError);
});

test('routing validates node identities even when telemetry would be ineligible', () => {
  for (const node of [null, {}, replica(''), replica(' '), replica(4)]) assert.throws(() => routeReplica([node], policy()), TypeError);
  assert.throws(() => routeReplica([replica('r'), replica('r', { healthy: false })], policy()), /unique/);
});

test('routing remains pure and accepts an explicitly supplied zero epoch clock', () => {
  const nodes = freeze([replica('r')]);
  const requirements = freeze(policy());
  const before = JSON.stringify({ nodes, requirements });
  const result = routeReplica(nodes, requirements);
  assert.deepEqual(routeReplica(nodes, requirements), result);
  assert.equal(JSON.stringify({ nodes, requirements }), before);
  assert.equal(nodes[0].inFlight, 0);
  assert.equal(routeReplica([replica('r', { telemetryAtMs: 0, lagObservedAtMs: 0 })], policy({ nowMs: 0, maxTelemetryAgeMs: 0 })).nodeId, 'r');
});
