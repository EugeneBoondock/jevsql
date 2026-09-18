# JevSQL

**Turn database rows into decisions you can query, inspect, refresh, and test.**

JevSQL adds TypeSafe Jev judgments to SQLite. It can compare records by meaning, select exact evidence from text, rank retrieved passages, route uncertain results to review, and detect when a changed source invalidates an earlier decision. It runs as a Node library or CLI with zero runtime dependencies.

| Problem | Working solution |
|---|---|
| An AI answer cites evidence that no longer supports its claim | Save an evidence audit, refresh it, and inspect the before/after decision history. |
| The same business appears under different names in two systems | Use SQL to narrow candidate pairs, then `jev_match` to estimate whether they refer to the same entity. |
| A generated contact address or amount contains invented characters | Find candidates in code, then use `jev_pick` to select an exact source span or return `NULL`. |
| A retrieved passage is related but does not answer the question | Rank permission-filtered passages with descriptive score levels. |
| Automation confidently guesses when evidence is missing | Use explicit unknown labels, abstention bands, and review queues. |
| Nobody knows which confidence threshold is useful | Evaluate labeled rows once and compare accuracy, coverage, and review workload across thresholds. |
| A database passes structural checks but contains unsupported decisions | Run semantic data checks in CI with explicit failure exit codes. |

## Try it immediately

Use **Node 22.16+**. The project uses the built-in `node:sqlite` module, including [statement column metadata](https://nodejs.org/api/sqlite.html#statementcolumns).

```bash
npm test
npm run workflows
```

The workflow tour runs offline with clearly labeled, scripted answers. It exercises nine steps, including a stale-claim repair queue and a refresh that pays for only one changed input. Fixture results demonstrate software behavior, not model accuracy.

To run the same synthetic examples against Jev, add your key to `.env.local`:

```dotenv
TYPESAFE_API_KEY=your_key_here
TYPESAFE_DEFAULT_MODEL=jev-1.13.0
```

```bash
npm run workflows -- --live
```

The CLI and workflow tour load `.env.local` before `.env`; existing environment variables win. The live tour sends only its bundled synthetic records. Library users supply `apiKey`, set the process environment, or use Node’s `--env-file` option.

The original ticket demo remains available with `node bin/jevsql.mjs demo`.

## Save decisions as ordinary database tables

```bash
node bin/jevsql.mjs materialize routes --file examples/recipes/ticket-routing.sql --csv examples/tickets.csv --db decisions.db --model jev-1.13.0
node bin/jevsql.mjs refresh routes --db decisions.db --model jev-1.13.0
node bin/jevsql.mjs changes routes --db decisions.db --revision 1
node bin/jevsql.mjs query "SELECT * FROM routes WHERE team IS NULL ORDER BY confidence" --db decisions.db
```

A saved decision table is a normal SQLite table with a primary key. Other applications can query it without this library or an API key. Refreshing uses the saved SQL, parameters, model name, and cache namespace. Unchanged judgment inputs reuse cached answers; changed, added, and deleted output rows are recorded separately.

Refreshes use a SQLite savepoint. Duplicate or missing keys, invalid responses, and failed queries leave the previous table and history intact. Existing user tables are never overwritten. A table must retain its key and column shape; create a new name for a new shape.

The source query still scans its candidate rows during refresh. This is incremental model work and changed-row storage, not database change-data capture. Nothing runs on a timer automatically.

```js
import { JevSQL } from 'jevsql';

const engine = new JevSQL({
  db: 'data.db',
  cacheFile: '.jevsql-cache.json',
  model: 'jev-1.13.0',
  cacheNamespace: 'routing-policy-v1',
  maxJudgments: 500,
  maxEstimatedCostUsd: 0.02,
});

try {
  const result = await engine.materialize('routes', `
    SELECT id,
      jev_choice(body, 'Which team should handle this?',
        'billing,technical,sales', 0.8) AS team
    FROM tickets WHERE status = :status
  `, { key: 'id', params: { status: 'open' } });

  console.log(result.changes, result.stats);
  console.log(await engine.refresh('routes'));
  console.log(engine.changes('routes', { limit: 20 }));
  console.log(engine.tables());
} finally {
  engine.close();
}
```

Use `materialize(name, sql, { dryRun: true })` to estimate a save without creating a decision table. Use `query(sql, { audit: true })` for decision receipts without saving a table.

## SQL functions

| Function | Result |
|---|---|
| `jev_noul(text, question)` | Yes-probability in `[0, 1]`. |
| `jev_bool(text, question [, threshold])` | `1` when probability is at least the threshold, otherwise `0`. Default `0.5`. |
| `jev_decide(text, question [, low, high])` | `0` below `low`, `1` above `high`, otherwise `NULL`. Defaults `0.1` and `0.9`; both boundaries remain in review. |
| `jev_choice(text, question, options [, min_confidence])` | Selected label, or `NULL` below the confidence threshold. Default `0`. |
| `jev_choice_conf(text, question, options)` | Provider-reported confidence. |
| `jev_choice_probs(text, question, options)` | Complete probability distribution as JSON. |
| `jev_prob(text, question, options, label)` | Probability of a supplied label. Unknown labels are rejected. |
| `jev_score(text, question, levels)` | Position across descriptive levels, possibly fractional. |
| `jev_score_norm(text, question, levels)` | Score divided by the number of intervals, in `[0, 1]`. |
| `jev_score_conf(text, question, levels)` | Provider-reported confidence. |
| `jev_score_probs(text, question, levels)` | Distribution across level indexes as JSON. |
| `jev_match(left, right [, question])` | Probability that two records match under the supplied question. |
| `jev_candidates(text [, kind])` | JSON array of exact spans. No model call. Kinds: `email`, `phone`, `money`, `url`, `line`; default `email`. |
| `jev_pick(text, question, candidates [, min_confidence])` | Exact supplied span or `NULL`. Default confidence threshold `0.8`. |
| `jev_pick_conf(text, question, candidates)` | Confidence from the same selection answer. |

All model functions propagate a missing source as SQL `NULL`. Empty candidate lists produce `NULL` without a request. An ordinary classification with insufficient evidence still needs an explicit unknown option or confidence threshold.

Functions reading the same judgment share one API question. Selecting a label, its confidence, its distribution, and one label probability costs one judgment between them. Noul, Bool, and Decide likewise share an answer. Different question types remain distinct.

Options accept JSON arrays, comma-separated or pipe-separated labels, or a JSON object mapping labels to descriptions. Choice supports 2–255 distinct labels. Score supports 2–10 ordered levels, including structured descriptions. Questions can also be JSON objects. See the [TypeSafe primitives](https://docs.typesafe.ai/primitives) and [structured rubrics](https://docs.typesafe.ai/primitives/advanced).

```sql
SELECT id,
  jev_choice(body, 'Which queue owns this request?',
    '{"billing":"Invoices, charges, and refunds","technical":"Errors, outages, and configuration","unknown":"No clear match"}',
    0.8) AS queue
FROM tickets;
```

### Extraction that stays attached to its source

```sql
SELECT id,
  jev_pick(notes, 'Which email should receive future invoices?',
    jev_candidates(notes, 'email'), 0.8) AS invoice_email
FROM contact_notes;
```

The candidate finder is a heuristic parser. It does not identify every possible international address, currency notation, or telephone format. You can supply your own JSON array of up to 254 candidates. Every candidate must occur verbatim in the source. The model chooses a candidate ID or none; code copies the value. This prevents invented characters, but the model can still select the wrong source span.

### Match records without a shared identifier

```sql
SELECT a.id AS incoming_id, b.id AS existing_id,
  jev_match(
    json_object('name', a.name, 'city', a.city),
    json_object('name', b.name, 'city', b.city)
  ) AS match_probability
FROM incoming_companies a
JOIN companies b ON a.country = b.country AND a.city = b.city;
```

The SQL join bounds the candidate pairs. The score informs a review or matching policy; this function does not merge records. A Cartesian join can be expensive and remains subject to the judgment limit.

## Checks and measured review queues

A data check is a query that returns violating rows. The default allowed count is zero; use `maxRows` to set another allowance.

```json
{
  "checks": [
    {
      "name": "Every open ticket has a confident route",
      "sql": "SELECT id FROM routes WHERE team IS NULL"
    }
  ]
}
```

```bash
node bin/jevsql.mjs check checks.json --db decisions.db
```

Exit codes: `0` for passing checks, `2` for violations, `1` for operational or usage errors. `--dry-run` reports cost estimates and leaves the pass result undecided. Each check has its own query budget.

For evaluation, return columns named `expected`, `prediction`, and `confidence` from a labeled query:

```bash
node bin/jevsql.mjs evaluate --file labeled-query.sql --db data.db
```

The report shows accepted rows, errors, accuracy, coverage, and review count across seven thresholds, plus a confusion table. No extra model calls are needed for the threshold sweep. Missing predictions count as abstentions. Accuracy is `null` when no rows are accepted. Use separate validation data before choosing a production threshold.

The library also exports `evaluatePredictions(rows, options)` for existing predictions and supports custom column names and thresholds. Model confidence and the probability of one label are different quantities; neither substitutes for measured task accuracy. See [TypeSafe’s confidence documentation](https://docs.typesafe.ai/confidence).

## Query API and CLI

```js
const { rows, stats, decisions } = await engine.query(sql, {
  params: { status: 'open' }, // or an array for anonymous ? parameters
  audit: true,
  signal: abortController.signal,
});
const preview = await engine.explain(sql, { params: { status: 'open' } });
```

`query()` and `explain()` accept one read statement: `SELECT`, `WITH`, or `VALUES`. SQLite read-only execution prevents a write hidden behind a CTE. Use `exec()` and `prepare()` for ordinary database setup and writes; evaluate model functions through `query()`.

Await each operation before starting another on the same engine. Overlapping queries and closing an active engine are rejected. Independent engines may run concurrently. Do not modify the exposed database connection during an active operation.

Useful flags include `--file`, `--params`, `--json`, `--audit`, `--quiet`, `--model`, `--cache-namespace`, `--max-judgments`, `--max-estimated-cost`, `--concurrency`, and `--dry-run`. See `node bin/jevsql.mjs --help` for all commands.

`--csv file[:table]` explicitly imports or replaces a table before the command runs. That import also happens for `explain` and `--dry-run`; use the default in-memory database when an import should not persist. Invalid headers and broken imports roll back instead of leaving a partial table.

## Cost, batching, and cache policy

The collect pass discovers judgments, batches distinct states and questions, resolves responses, and reruns the original query. Ordinary SQL predicates can narrow candidates before inference. The planner counts serialized UTF-8 bytes, including prompts and rubrics, with default limits of 25 states, 120 questions, and 60,000 bytes per request. Questions for a single state split across batches when necessary; an oversized state/question pair is rejected.

`maxJudgments` is a firm cap on new judgments within a query, default 1,000. `maxEstimatedCostUsd` is an estimate-based stop before dispatching another round. Token estimates use serialized bytes divided by four; actual usage and billing can differ. Nested or conditional queries can discover more work in later rounds, so `explain()` is a planning estimate, not a spending guarantee. A late failure can occur after earlier requests were billed.

Successful query stats include new judgments, cache hits, requests, input tokens, calculated cost, wall time, rounds, and relaxed clauses. Pricing currently uses the [published Jev rate](https://docs.typesafe.ai/models) of $0.042 per million input tokens, with free output tokens, checked on September 18, 2026.

Cache identity includes the requested model, question type, instructions, criteria, source, and namespace. The new key format intentionally leaves earlier cache entries unused. Pin a version such as `jev-1.13.0` for a stable policy, and change the namespace when deliberately rejudging inputs. A moving model alias can mix older cached results with newer responses. Caching reuses a recorded answer; it does not prove that fresh model calls would return the same answer.

The default cache is in memory. `cacheFile` persists answers between processes; the CLI defaults to `.jevsql-cache.json`. `--no-cache` disables disk persistence, while judgments still deduplicate and stay in memory during that process. The file cache is intended for one writer. Custom caches can provide synchronous `get`/`set`, `flush`, and optional asynchronous `warm(keys)`.

Decision receipts include hashes, question details, criteria, the requested and returned model, timestamps, and cache/API provenance. They are query-level receipts, not per-cell explanations or a model reasoning transcript. Saved runs retain these receipts beside the before/after row history.

## Data and operating boundaries

Only pass data that may be sent to TypeSafe. Cache labels, selection criteria, saved query parameters, decision tables, and change history may contain sensitive values. Source text is not separately retained in query receipts, but selected spans and rubric labels can reveal it. Protect database and cache files accordingly.

This is a SQLite middleware library, not a PostgreSQL or DuckDB extension. It materializes query results in memory. Refreshes hold a transaction across model work and can block other writers; use bounded source queries and a separate analysis database for larger workloads.

The collect rewrite is a conservative SQL text transform, not a full SQL optimizer. Alias ordering, quoted function names, parameters, ordinary joins, comments, and common predicates have regression coverage. Complex nested queries, windows, volatile SQL expressions, and many dependent model calls need workload-specific testing; unresolved work fails after a bounded number of rounds.

Keep arithmetic, date comparisons, access control, and actual writes in code. Jev’s own [known limitations](https://docs.typesafe.ai/model-jaggedness/jev-1.13) include numeric precision, indirect questions, distracting state, and adversarial text. The passage example includes an advisory suspicious-content signal; it is not a security boundary.

## Recipes, research, and validation

[The workflow tour](examples/workflows.mjs) runs the [SQL recipes](examples/recipes): evidence audit, review queue, source extraction, entity matching, passage ranking, and data checks. [Research notes](docs/jev-research.md) record the documentation findings and design choices. [Validation notes](docs/validation.md) distinguish fixture checks from the live synthetic run.

```bash
npm test
npm run workflows
```

The test suite uses local mock servers and needs no API key. No deployment, external database migration, or hosted service is required.

## License

MIT. Not affiliated with TypeSafe AI.
