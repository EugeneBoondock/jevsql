import test from 'node:test';
import assert from 'node:assert/strict';
import { PostgreSQLAdapter, MySQLAdapter } from '../src/adapters.mjs';
import { compileTemplate } from '../src/query-compiler.mjs';

function harness(dialect, overrides = {}) {
  const calls = []; let releases = 0, acquisitions = 0;
  const rowsFor = (sql) => {
    if (sql.includes('information_schema.columns')) return [
      { table_schema: 'app', table_name: 'orders', column_name: 'id', data_type: 'integer', is_nullable: 'NO', ordinal_position: 1 },
      { table_schema: 'app', table_name: 'orders', column_name: 'tenant_id', data_type: 'text', is_nullable: 'NO', ordinal_position: 2 },
    ];
    if (sql.includes('information_schema.table_constraints')) return [
      { table_schema: 'app', table_name: 'orders', constraint_name: 'orders_pk', constraint_type: 'PRIMARY KEY', column_name: 'id', ordinal_position: 1 },
    ];
    if (sql.includes('pg_catalog.pg_constraint') || sql.includes('information_schema.referential_constraints')) return [];
    if (sql.startsWith('EXPLAIN')) return [{ [dialect === 'postgresql' ? 'QUERY PLAN' : 'EXPLAIN']: JSON.stringify([{ Plan: { 'Node Type': 'Index Scan' } }]) }];
    if (/SELECT (?:\/\*.*\*\/ )?["`]/.test(sql)) {
      if (overrides.failRead) throw new Error('driver read failed');
      overrides.onRead?.(); return [{ id: 1 }];
    }
    return [];
  };
  const connection = { async query(sql, params) {
    calls.push({ sql, params, connection: 1 }); return { rows: rowsFor(sql) };
  }, async execute(sql, params) {
    calls.push({ sql, params, connection: 1 }); return [rowsFor(sql), []];
  }, release() { releases++; } };
  const Type = dialect === 'postgresql' ? PostgreSQLAdapter : MySQLAdapter;
  const adapter = new Type({ schemaName: 'app', acquire: async () => { acquisitions++; return connection; } });
  return { adapter, calls, get releases() { return releases; }, get acquisitions() { return acquisitions; } };
}
const template = { id: 'orders', version: '1', description: 'List own orders', roles: ['analyst'], params: {},
  query: { from: 'app.orders', select: [{ column: 'id', as: 'id' }], limit: 5 } };
const actor = { id: 'a', roles: ['analyst'], tenantId: 'private-tenant' };

for (const dialect of ['postgresql', 'mysql']) {
  test(`${dialect} adapter introspects, explains and reads with bound values on exclusive read-only leases`, async () => {
    const h = harness(dialect);
    const snapshot = await h.adapter.snapshot();
    assert.equal(snapshot.dialect, dialect); assert.equal(snapshot.tables[0].primaryKey[0], 'id');
    const query = compileTemplate(template, snapshot, { actor });
    assert.ok(await h.adapter.explain(query));
    assert.deepEqual((await h.adapter.read(query)).rows, [{ id: 1 }]);
    assert.equal(h.acquisitions, 3); assert.equal(h.releases, 3);
    assert.equal(h.calls.filter((c) => /BEGIN.*READ ONLY|START TRANSACTION READ ONLY/.test(c.sql)).length, 3);
    assert.equal(h.calls.filter((c) => c.sql === 'COMMIT').length, 3);
    assert.ok(h.calls.filter((c) => /^SELECT (?:\/\*.*\*\/ )?["`]/.test(c.sql)).every((c) => c.params[0] === 'private-tenant'));
    assert.ok(h.calls.every((c) => !c.sql.includes('private-tenant')));
    assert.ok(h.calls.every((c) => !/EXPLAIN\s+ANALYZE/i.test(c.sql)));
    if (dialect === 'mysql') assert.ok(h.calls.some((c) => c.sql.includes('MAX_EXECUTION_TIME(2000)')));
    else assert.ok(h.calls.some((c) => c.sql.includes("set_config('statement_timeout'")));
  });

  test(`${dialect} rolls back failed and cancelled reads before releasing`, async () => {
    for (const failRead of [true, false]) {
      const controller = new AbortController();
      const h = harness(dialect, { failRead, onRead: () => controller.abort() });
      const query = compileTemplate(template, await h.adapter.snapshot(), { actor });
      await assert.rejects(() => h.adapter.read(query, { signal: controller.signal }));
      assert.equal(h.calls.at(-1).sql, 'ROLLBACK'); assert.equal(h.releases, 2);
    }
  });

  test(`${dialect} expiry callback runs after leasing and schema verification, before actual read`, async () => {
    const h = harness(dialect);
    const query = compileTemplate(template, await h.adapter.snapshot(), { actor });
    await assert.rejects(() => h.adapter.read(query, { beforeExecute: () => { throw new Error('expired'); } }), /expired/);
    assert.equal(h.calls.at(-1).sql, 'ROLLBACK');
    assert.equal(h.calls.filter((c) => /^SELECT (?:\/\*.*\*\/ )?["`]/.test(c.sql)).length, 0);
    await assert.rejects(() => h.adapter.read({ ...query }), /unchanged query/);
  });
}
