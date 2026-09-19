import test from 'node:test';
import assert from 'node:assert/strict';
import { PostgreSQLAdapter, MySQLAdapter } from '../src/adapters.mjs';
import { compileTemplate } from '../src/query-compiler.mjs';

const enabled = process.env.JEVSQL_REAL_DATABASES === '1';
const actor = { id: 'ci', roles: ['analyst'], tenantId: 'tenant-a' };
const template = { id: 'real-orders', version: '1', description: 'Read tenant orders', roles: ['analyst'], params: {},
  query: { from: 'app.orders', select: [{ column: 'id', as: 'id' }], orderBy: [{ column: 'id' }], limit: 10 } };

test('PostgreSQL adapter uses a restricted account against a real server', { skip: !enabled }, async () => {
  const { Pool } = await import('pg');
  const admin = new Pool({ connectionString: process.env.JEVSQL_POSTGRES_ADMIN_URL });
  let reader;
  try {
    await admin.query(`
      DROP SCHEMA IF EXISTS app CASCADE;
      DROP ROLE IF EXISTS jevsql_reader;
      CREATE ROLE jevsql_reader LOGIN PASSWORD 'reader-password';
      CREATE SCHEMA app;
      CREATE TABLE app.customers(id integer PRIMARY KEY, name text NOT NULL);
      CREATE TABLE app.orders(id integer PRIMARY KEY, tenant_id text NOT NULL,
        customer_id integer REFERENCES app.customers(id), amount numeric(10,2) CHECK (amount >= 0));
      CREATE INDEX orders_tenant_idx ON app.orders(tenant_id);
      INSERT INTO app.customers VALUES (1, 'Acme');
      INSERT INTO app.orders VALUES (1, 'tenant-a', 1, 10), (2, 'tenant-b', 1, 20);
      GRANT USAGE ON SCHEMA app TO jevsql_reader;
      GRANT SELECT ON ALL TABLES IN SCHEMA app TO jevsql_reader;
    `);
    reader = new Pool({ connectionString: process.env.JEVSQL_POSTGRES_READER_URL });
    const adapter = new PostgreSQLAdapter({ schemaName: 'app', statementTimeoutMs: 500,
      acquire: () => reader.connect() });
    const snapshot = await adapter.snapshot();
    assert.equal(snapshot.dialect, 'postgresql');
    assert.ok(snapshot.tables.some((table) => table.name === 'app.orders'));
    const query = compileTemplate(template, snapshot, { actor });
    assert.ok(await adapter.explain(query));
    assert.deepEqual((await adapter.read(query)).rows.map((row) => row.id), [1]);
    await assert.rejects(() => reader.query("INSERT INTO app.orders VALUES (3, 'tenant-a', 1, 30)"), /permission denied/);

    const blocker = await admin.connect();
    try {
      await blocker.query('BEGIN');
      await blocker.query('LOCK TABLE app.orders IN ACCESS EXCLUSIVE MODE');
      const timed = new PostgreSQLAdapter({ schemaName: 'app', statementTimeoutMs: 100, acquire: () => reader.connect() });
      await assert.rejects(() => timed.read(query), /lock timeout|canceling statement/i);
    } finally {
      await blocker.query('ROLLBACK');
      blocker.release();
    }
    const controller = new AbortController();
    await assert.rejects(() => adapter.read(query, { signal: controller.signal,
      beforeExecute: () => controller.abort(new Error('cancelled by test')) }), /cancelled by test/);
  } finally {
    await reader?.end();
    await admin.end();
  }
});

test('MySQL adapter uses a restricted account against a real server', { skip: !enabled }, async () => {
  const mysql = await import('mysql2/promise');
  const admin = await mysql.createConnection(process.env.JEVSQL_MYSQL_ADMIN_URL);
  let reader;
  try {
    await admin.query('DROP DATABASE IF EXISTS app');
    await admin.query('CREATE DATABASE app');
    await admin.query("DROP USER IF EXISTS 'jevsql_reader'@'%'");
    await admin.query("CREATE USER 'jevsql_reader'@'%' IDENTIFIED BY 'reader-password'");
    await admin.query('CREATE TABLE app.customers(id integer PRIMARY KEY, name varchar(100) NOT NULL)');
    await admin.query('CREATE TABLE app.orders(id integer PRIMARY KEY, tenant_id varchar(100) NOT NULL, customer_id integer, amount decimal(10,2), CONSTRAINT orders_customer_fk FOREIGN KEY(customer_id) REFERENCES app.customers(id), CONSTRAINT amount_positive CHECK(amount >= 0))');
    await admin.query('CREATE INDEX orders_tenant_idx ON app.orders(tenant_id)');
    await admin.query("INSERT INTO app.customers VALUES (1, 'Acme')");
    await admin.query("INSERT INTO app.orders VALUES (1, 'tenant-a', 1, 10), (2, 'tenant-b', 1, 20)");
    await admin.query("GRANT SELECT, SHOW VIEW ON app.* TO 'jevsql_reader'@'%'");
    reader = mysql.createPool(process.env.JEVSQL_MYSQL_READER_URL);
    const adapter = new MySQLAdapter({ schemaName: 'app', statementTimeoutMs: 500,
      acquire: () => reader.getConnection() });
    const snapshot = await adapter.snapshot();
    assert.equal(snapshot.dialect, 'mysql');
    assert.ok(snapshot.tables.some((table) => table.name === 'app.orders'));
    const query = compileTemplate(template, snapshot, { actor });
    assert.ok(await adapter.explain(query));
    assert.deepEqual((await adapter.read(query)).rows.map((row) => row.id), [1]);
    await assert.rejects(() => reader.query("INSERT INTO app.orders VALUES (3, 'tenant-a', 1, 30)"), /denied|command/);

    await admin.query('LOCK TABLES app.orders WRITE');
    try {
      const timed = new MySQLAdapter({ schemaName: 'app', statementTimeoutMs: 100, acquire: () => reader.getConnection() });
      await assert.rejects(() => timed.read(query), /lock wait timeout|timeout exceeded/i);
    } finally {
      await admin.query('UNLOCK TABLES');
    }
    const controller = new AbortController();
    await assert.rejects(() => adapter.read(query, { signal: controller.signal,
      beforeExecute: () => controller.abort(new Error('cancelled by test')) }), /cancelled by test/);
  } finally {
    await reader?.end();
    await admin.end();
  }
});
