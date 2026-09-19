import test from 'node:test';
import assert from 'node:assert/strict';
import { JevSQL } from '../src/engine.mjs';
import { JevClient } from '../src/client.mjs';
import { startMockServer } from './mock-server.mjs';

const TICKETS = [
  [1, 'open', 'Our API is down and we are losing orders. Need this fixed ASAP.'],
  [2, 'open', 'Just checking in on the docs update, no rush at all.'],
  [3, 'open', 'I have been charged twice and I am furious, I want a refund now.'],
  [4, 'closed', 'Thanks for the quick help, all good.'],
  [5, 'open', 'The billing page is broken when I click export.'],
];

async function withEngine(run, options = {}) {
  const mock = await startMockServer();
  const engine = new JevSQL({
    cacheFile: null,
    client: new JevClient({ apiKey: 'test-key', baseUrl: mock.baseUrl }),
    ...options,
  });
  engine.exec('CREATE TABLE tickets (id INTEGER, status TEXT, body TEXT)');
  const insert = engine.prepare('INSERT INTO tickets VALUES (?, ?, ?)');
  for (const row of TICKETS) insert.run(...row);
  try {
    await run(engine, mock);
  } finally {
    engine.close();
    await mock.close();
  }
}

test('jev_noul returns a probability per row', async () => {
  await withEngine(async (engine) => {
    const { rows } = await engine.query(
      "SELECT id, jev_noul(body, 'Is the customer frustrated?') AS p FROM tickets ORDER BY id",
    );
    assert.equal(rows.length, 5);
    assert.ok(rows.find((r) => r.id === 3).p > 0.9, 'furious ticket scores high');
    assert.ok(rows.find((r) => r.id === 2).p < 0.2, 'calm ticket scores low');
  });
});

test('all rows and questions collapse into one batched request', async () => {
  await withEngine(async (engine, mock) => {
    await engine.query(`
      SELECT id,
             jev_noul(body, 'Is the customer frustrated?') AS frustrated,
             jev_noul(body, 'Is this urgent?') AS urgent,
             jev_choice(body, 'Which team?', 'billing,technical,sales') AS team
      FROM tickets`);
    assert.equal(mock.requestCount, 1, 'one request for 5 rows x 3 questions');
    assert.equal(Object.keys(mock.calls[0].questions).length, 15);
    assert.equal(Object.keys(mock.calls[0].state.rows).length, 5, 'each row text sent once');
  });
});

test('isolated row mode keeps questions together but never mixes row state', async () => {
  await withEngine(async (engine, mock) => {
    const { stats } = await engine.query(`
      SELECT jev_noul(body, 'Is this urgent?'),
             jev_choice(body, 'Which team?', 'billing,technical,sales')
      FROM tickets WHERE id <= 3`);
    assert.equal(stats.rowMode, 'isolated');
    assert.equal(mock.requestCount, 3);
    assert.ok(mock.calls.every((call) => Object.keys(call.state.rows).length === 1));
    assert.ok(mock.calls.every((call) => Object.keys(call.questions).length === 2));
  }, { rowMode: 'isolated' });
  assert.throws(() => new JevSQL({ rowMode: 'unknown' }), /rowMode/);
});

test('a jev predicate in WHERE is relaxed while collecting, then applied exactly', async () => {
  await withEngine(async (engine, mock) => {
    const { rows, stats } = await engine.query(
      "SELECT id FROM tickets WHERE status = 'open' AND jev_bool(body, 'Is the customer frustrated?') = 1 ORDER BY id",
    );
    assert.deepEqual(rows.map((r) => r.id), [1, 3, 5]);
    assert.ok(stats.relaxed.includes('WHERE'));
    // Only the four open tickets are judged; the closed one is filtered by SQL, not paid for.
    assert.equal(Object.keys(mock.calls[0].state.rows).length, 4);
  });
});

test('functions sharing one judgment cost a single question', async () => {
  await withEngine(async (engine, mock) => {
    const { rows } = await engine.query(`
      SELECT id,
             jev_choice(body, 'Which team?', 'billing,technical,sales') AS team,
             jev_choice_conf(body, 'Which team?', 'billing,technical,sales') AS conf,
             jev_prob(body, 'Which team?', 'billing,technical,sales', 'billing') AS p_billing,
             jev_choice_top_prob(body, 'Which team?', 'billing,technical,sales') AS p_top,
             jev_choice_prob_gate(body, 'Which team?', 'billing,technical,sales', 0.75) AS gated
      FROM tickets WHERE id = 5`);
    assert.equal(Object.keys(mock.calls[0].questions).length, 1, 'three functions, one question');
    assert.equal(rows[0].team, 'billing');
    assert.ok(rows[0].conf > 0.5 && rows[0].p_billing > 0.5);
    assert.equal(rows[0].p_top, rows[0].p_billing);
    assert.equal(rows[0].gated, 'billing');
  });
});

test('second run is served from cache with no requests', async () => {
  await withEngine(async (engine, mock) => {
    const sql = "SELECT id, jev_noul(body, 'Is this urgent?') AS p FROM tickets";
    await engine.query(sql);
    const before = mock.requestCount;
    const { rows, stats } = await engine.query(sql);
    assert.equal(mock.requestCount, before, 'no further API calls');
    assert.equal(stats.judgments, 0);
    assert.ok(stats.cacheHits > 0);
    assert.equal(rows.length, 5);
  });
});

test('jev_choice returns NULL below the confidence threshold', async () => {
  await withEngine(async (engine) => {
    engine.exec("INSERT INTO tickets VALUES (6, 'open', 'ambiguous message')");
    const { rows } = await engine.query(
      "SELECT jev_choice(body, 'Which team?', 'billing,technical,sales', 0.9) AS team FROM tickets WHERE id = 6",
    );
    assert.equal(rows[0].team, null, 'low confidence is reported as unknown, not guessed');
  });
});

test('ORDER BY a judgment ranks rows and LIMIT is applied after resolving', async () => {
  await withEngine(async (engine) => {
    const { rows } = await engine.query(`
      SELECT id FROM tickets
      ORDER BY jev_score(body, 'How urgent is this?', 'not urgent,soon,urgent,emergency') DESC, id
      LIMIT 2`);
    assert.equal(rows.length, 2);
    assert.ok(rows.some((r) => r.id === 1), 'the outage is in the top two');
  });
});

test('the cost guard stops an unbounded scan', async () => {
  await withEngine(async (engine) => {
    await assert.rejects(
      () => engine.query("SELECT jev_noul(body, 'Is this urgent?') FROM tickets"),
      /over the limit of 2/,
    );
  }, { maxJudgments: 2 });
});

test('explain estimates cost without calling the API', async () => {
  await withEngine(async (engine, mock) => {
    const stats = await engine.explain("SELECT jev_noul(body, 'Is this urgent?') FROM tickets");
    assert.equal(mock.requestCount, 0, 'dry run makes no requests');
    assert.equal(stats.judgments, 5);
    assert.equal(stats.requests, 1);
    assert.ok(stats.inputTokens > 0 && stats.costUsd > 0);
    assert.ok(stats.estimated);
  });
});

test('queries without jev_ functions run untouched', async () => {
  await withEngine(async (engine, mock) => {
    const { rows, stats } = await engine.query("SELECT COUNT(*) AS n FROM tickets WHERE status = 'open'");
    assert.equal(rows[0].n, 4);
    assert.equal(mock.requestCount, 0);
    assert.equal(stats.judgments, 0);
  });
});
