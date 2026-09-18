import { JevSQL } from '../src/engine.mjs';
import { JevClient } from '../src/client.mjs';
import { startMockServer } from './mock-server.mjs';

export async function fixture(t, options = {}, mockOptions = {}) {
  const mock = await startMockServer(mockOptions);
  const engine = new JevSQL({ client: new JevClient({ apiKey: 'test-key', baseUrl: mock.baseUrl, model: 'jev-test' }), ...options });
  t.after(async () => { engine.close(); await mock.close(); });
  engine.exec('CREATE TABLE records(id INTEGER PRIMARY KEY, body TEXT, expected TEXT)');
  const insert = engine.prepare('INSERT INTO records VALUES (?, ?, ?)');
  insert.run(1, 'billing refund needed urgently', 'billing');
  insert.run(2, 'technical docs question, no rush', 'technical');
  insert.run(3, 'ambiguous request', 'sales');
  return { engine, mock };
}

export const routeSql = `SELECT id,
  jev_choice(body, 'Which team?', 'billing,technical,sales') AS team,
  jev_choice_conf(body, 'Which team?', 'billing,technical,sales') AS confidence
  FROM records ORDER BY id`;
