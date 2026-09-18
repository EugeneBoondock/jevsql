# JevSQL

**SQL with natural-language predicates.** Filter, rank, classify and score rows by what they *mean*, using [TypeSafe](https://docs.typesafe.ai)'s Jev — a System One model that returns calibrated probabilities instead of text.

```sql
SELECT id, customer,
       jev_choice(body, 'Which team should handle this?', 'billing,technical,sales') AS team
FROM tickets
WHERE status = 'open'
  AND jev_bool(body, 'Is the customer angry or frustrated?', 0.6) = 1
ORDER BY jev_score(body, 'How urgent is this?', 'no rush,this week,today,production is down') DESC
LIMIT 10;
```

No embeddings, no JSON parsing, no prompt scaffolding. Judgments are batched into a handful of API requests, cached by content hash, and guarded by a cost limit.

```
100 rows x 2 questions = 200 judgments
cold : 1535 ms · 4 requests · 14567 tokens · $0.00061 · 8 ms per judgment
warm : 3 ms · 0 requests · 200 served from cache · $0.00000
explain (dry run, no API calls): 200 judgments, 4 requests, ~7777 tokens, ~$0.00033
```

*(`node examples/bench.mjs 100`, measured against the live API. Cost uses TypeSafe's published $0.042 / 1M input tokens; output tokens are free.)*

## Install

```bash
git clone https://github.com/EugeneBoondock/jevsql.git
cd jevsql
cp .env.example .env     # add your TYPESAFE_API_KEY
node examples/demo.mjs   # guided tour over a sample ticket table
```

Node 22.5+ only. **Zero runtime dependencies** — it uses Node's built-in `node:sqlite`, so there is nothing to compile.

## Use it from the CLI

```bash
# query a CSV directly
node bin/jevsql.mjs query "SELECT id, jev_noul(body,'is this a bug report?') AS p FROM tickets ORDER BY p DESC LIMIT 5" \
  --csv examples/tickets.csv

# what would this cost? (no API calls)
node bin/jevsql.mjs explain "SELECT jev_choice(body,'which team?','billing,technical') FROM tickets" --csv examples/tickets.csv

# interactive
node bin/jevsql.mjs repl --db mydata.db
```

## Use it as a library

```js
import { JevSQL } from 'jevsql';

const engine = new JevSQL({ db: 'tickets.db', cacheFile: '.jevsql-cache.json', maxJudgments: 500 });
const { rows, stats } = await engine.query(`
  SELECT id, jev_score(body, 'How severe is this bug?', 'cosmetic,workaround exists,blocking') AS severity
  FROM tickets WHERE status = 'open' ORDER BY severity DESC LIMIT 20
`);
console.log(rows, stats); // stats: judgments, requests, cacheHits, inputTokens, costUsd, wallMs
engine.close();
```

## The functions

| Function | Returns | Notes |
|---|---|---|
| `jev_noul(text, question)` | probability 0–1 | the calibrated yes-probability itself |
| `jev_bool(text, question [, threshold])` | 1 / 0 | threshold defaults to 0.5 |
| `jev_choice(text, question, options [, min_confidence])` | chosen label, or `NULL` | `NULL` below `min_confidence` — "I don't know" instead of a guess |
| `jev_choice_conf(text, question, options)` | confidence 0–1 | how peaked the distribution is |
| `jev_prob(text, question, options, label)` | probability 0–1 | probability of one specific label |
| `jev_score(text, question, levels)` | position across levels | probability-weighted, can fall between levels |
| `jev_score_conf(text, question, levels)` | confidence 0–1 | |

`options` / `levels` accept a JSON array (`'["a","b"]'`), or a comma- or pipe-separated list (`'a,b,c'`). A Choice takes up to 255 options and a Score up to 10 levels — TypeSafe's limits, not ours.

Functions that describe the *same* judgment share one API question. `jev_choice`, `jev_choice_conf` and `jev_prob` over the same `(text, question, options)` cost one question between them, not three.

## How it works

SQLite's user-defined functions are synchronous; Jev is an HTTP call. A scan cannot stop and await per row, and firing one request per row would be slow and expensive. So the query runs more than once:

1. **Collect.** `jev_*` functions record what they were asked and return a placeholder. Any filter mentioning a judgment is neutralised — `WHERE status='open' AND jev_bool(...)=1` becomes `WHERE status='open' AND (jev_bool(...)=1 OR 1=1)` — so the predicate is still *evaluated* (that is how we learn what to judge) but filters nothing out. Ordinary filters are left alone, so you never pay for rows the query wasn't going to touch.
2. **Resolve.** Every distinct judgment is packed into as few requests as possible. TypeSafe evaluates all questions in a request in parallel against one shared state, so the batch is a matrix: many rows in the state, one question per (row, question) pair. Each row's text is sent once no matter how many questions it answers. Defaults: 25 rows, 120 questions, ~60k characters per request.
3. **Run.** The original query executes against resolved answers. Anything still missing triggers another resolve-and-rerun (bounded), so an imperfect rewrite costs a round trip, never a wrong answer.

Everything else is ordinary SQL: `GROUP BY` a `jev_choice`, `ORDER BY` a `jev_score`, join on judgments, aggregate them.

### Caching

Judgments are keyed by `sha256(model, kind, question, criteria, state)` and stored in a JSON file. Jev is self-consistent for a fixed input, so a rerun is free and instant (3 ms for 200 judgments above). Delete the cache file to re-judge; `--no-cache` to disable.

**The cache holds your row text.** It is gitignored by default — keep it that way if your data is sensitive.

### Cost guards

- `maxJudgments` (default 1000, `--max-judgments`) refuses a query that would need more, so a stray `SELECT jev_noul(...) FROM big_table` fails fast instead of billing you.
- `explain` / `jevsql explain` reports judgments, requests, estimated tokens and cost **without calling the API**.
- Every query returns its own `stats`, so cost is visible per query, not per month.

## Limits and honest caveats

- **This is a middleware layer, not a storage-engine extension.** It runs inside Node against SQLite. A real `pg_jev` living in the Postgres planner is the logical next step (see below).
- **Judgments are not free and not certain.** Jev returns calibrated probabilities, which is not the same as being right. Use `jev_choice_conf` / `min_confidence` to route uncertain rows to a human, and validate thresholds against your own labelled data.
- **The collect rewrite is a string transform,** deliberately conservative: anything it cannot split safely it relaxes as a whole, which costs extra judgments, never correctness. Very unusual SQL (CTEs with judgments in several scopes, window functions over judgments) is not well tested — issues welcome.
- **Judgment predicates are not indexes.** SQL filters run first and cut the candidate set; the judgment then runs over what survives. Put cheap filters in the query.
- **`node:sqlite` is marked experimental** in Node 22/24. That is upstream's label, not a JevSQL caveat, but it may change under us.
- Row text is sent to TypeSafe's API. Don't point it at data you can't send to a third party.

## Roadmap

- `pg_jev`: the same planner idea as a real PostgreSQL extension (pgrx), so batching happens inside the executor.
- DuckDB plugin for columnar/analytical scans.
- A `jev_batch_hint` pragma for tuning batch shape per query.
- Streaming results as batches resolve, instead of resolving everything first.

Contributions welcome — the test suite runs against a mock TypeSafe server, so you need no API key to work on it:

```bash
npm test   # 28 tests, no network, no key
```

## Prior art

[MindsDB](https://mindsdb.com) puts models behind SQL but leans on text-generating LLMs (slow, parse-prone). `pgvector` does similarity, not structured judgment with calibrated confidence. Python UDFs in DuckDB/Spark work but batch at the application layer. JevSQL is narrower than all of them on purpose: typed judgments, batched and cached, with the cost visible before you spend it.

## License

MIT © Eugene Boondock. Not affiliated with TypeSafe AI.
