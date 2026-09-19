// Reading SQL somebody else wrote.
//
// The compiler proves things because it built the query. This reads a string,
// so every check has to hold from the shape alone. The tests that matter most
// are the ones asserting it stays QUIET: a text analyser that cries wolf is
// one nobody leaves switched on.
import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeQueryText, analyzeQueryTexts } from '../src/hazards.mjs';

const codes = (sql, options) => analyzeQueryText(sql, options).findings.map((finding) => finding.code);

test('a LIMIT with no ORDER BY is an arbitrary window', () => {
  assert.deepEqual(codes('SELECT id FROM t LIMIT 10'), ['unstable_window']);
  assert.deepEqual(codes('SELECT id FROM t ORDER BY id LIMIT 10'), []);
});

test('each query level is judged against its own ORDER BY', () => {
  // The inner SELECT orders itself; the outer one has no LIMIT to answer for.
  assert.deepEqual(codes('SELECT * FROM (SELECT id FROM t ORDER BY id LIMIT 5) s ORDER BY id'), []);
  // A window function's ORDER BY belongs to the window, not to the statement.
  assert.deepEqual(codes('SELECT id, row_number() OVER (ORDER BY x) FROM t LIMIT 5'), ['unstable_window']);
  // And an ordered outer query is not rescued by an unordered inner one.
  assert.deepEqual(codes('SELECT * FROM (SELECT id FROM t) s ORDER BY id LIMIT 5'), []);
});

test('NOT IN over a subquery is called out, NOT EXISTS is not', () => {
  assert.deepEqual(codes('SELECT * FROM a WHERE id NOT IN (SELECT parent_id FROM b)'), ['not_in_subquery']);
  assert.deepEqual(codes('SELECT * FROM a WHERE NOT EXISTS (SELECT 1 FROM b WHERE b.parent_id = a.id)'), []);
  // A value list has no NULL-from-a-subquery problem.
  assert.deepEqual(codes("SELECT * FROM a WHERE status NOT IN ('open', 'closed')"), []);
});

test('COUNT(*) beside an outer join counts unmatched rows as one', () => {
  assert.deepEqual(codes('SELECT o.id, COUNT(*) FROM o LEFT JOIN l ON l.o = o.id GROUP BY o.id'),
    ['count_star_over_outer_join']);
  // Counting the joined side is the other answer, and a deliberate one.
  assert.deepEqual(codes('SELECT o.id, COUNT(l.id) FROM o LEFT JOIN l ON l.o = o.id GROUP BY o.id'), []);
  // With no outer join there is no unmatched row to disagree about.
  assert.deepEqual(codes('SELECT o.id, COUNT(*) FROM o JOIN l ON l.o = o.id GROUP BY o.id'), []);
});

test('UNION is noted, UNION ALL is not', () => {
  assert.deepEqual(codes('SELECT a FROM x UNION SELECT a FROM y'), ['union_deduplicates']);
  assert.deepEqual(codes('SELECT a FROM x UNION ALL SELECT a FROM y'), []);
});

test('keywords inside strings and comments are text, not SQL', () => {
  // The whole reason this runs on masked SQL. A literal that reads like a
  // clause must not produce a finding, and must not hide one either.
  assert.deepEqual(codes("SELECT 'limit 10 with no order by' AS note FROM t ORDER BY id LIMIT 1"), []);
  assert.deepEqual(codes('SELECT id FROM t /* ORDER BY id */ LIMIT 10'), ['unstable_window']);
  assert.deepEqual(codes("SELECT 'not in (select x from y)' FROM t ORDER BY id"), []);
});

test('unreadable SQL says so rather than reporting clean', () => {
  // An empty finding list means "none of these shapes are present". It must
  // never also mean "I could not look".
  const findings = analyzeQueryText("SELECT * FROM t WHERE a = 'x").findings;
  assert.deepEqual(findings.map((finding) => finding.code), ['unreadable_sql']);
  assert.match(findings[0].detail, /none of these checks ran/);
});

test('findings point at the line they came from', () => {
  const sql = 'SELECT id\n  FROM t\n  WHERE x = 1\n  LIMIT 10';
  assert.equal(analyzeQueryText(sql).findings[0].line, 4);
});

test('a batch keeps the id of whatever it was given', () => {
  const found = analyzeQueryTexts([
    { id: 'reports/top-owners', sql: 'SELECT id FROM t LIMIT 10' },
    { id: 'reports/fine', sql: 'SELECT id FROM t ORDER BY id LIMIT 10' },
  ], { dialect: 'postgresql' });
  assert.equal(found.length, 1);
  assert.equal(found[0].id, 'reports/top-owners');
  assert.equal(found[0].code, 'unstable_window');
});

test('it refuses input it cannot analyse rather than returning nothing', () => {
  assert.throws(() => analyzeQueryText(''), TypeError);
  assert.throws(() => analyzeQueryText('SELECT 1', { dialect: 'oracle' }), TypeError);
  assert.throws(() => analyzeQueryTexts('not an array'), TypeError);
  assert.throws(() => analyzeQueryTexts([{ id: 'x' }]), TypeError);
});

test('the size of the window decides how loudly to say it', () => {
  // Run over a real application the first version raised 158 findings and 150
  // were LIMIT 1 — existence and lookup queries where an arbitrary row is the
  // whole point. A list nobody reads is worth the same as no list.
  const level = (sql) => analyzeQueryText(sql, { dialect: 'postgresql' }).findings[0];

  assert.equal(level('SELECT id FROM t LIMIT 1').level, 'note');
  assert.equal(level('SELECT id FROM t LIMIT 1').code, 'arbitrary_row');

  assert.equal(level('SELECT id FROM t LIMIT 20').level, 'review');
  assert.equal(level('SELECT id FROM t LIMIT 20').code, 'unstable_window');

  // Paging an unordered result is the one that is always wrong.
  assert.equal(level('SELECT id FROM t LIMIT 20 OFFSET 40').code, 'unstable_pagination');
  assert.equal(level('SELECT id FROM t LIMIT 1 OFFSET 7').code, 'unstable_pagination');
});
