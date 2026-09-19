# Native database rows

Use `jevsql/rows` after SQL authorization, deterministic filters, and pagination.
No SQLite staging or row string truncation is needed.

```js
import { evaluateRows, partitionRows } from 'jevsql/rows';
import { createPgJudgmentCache } from 'jevsql/pg-cache';

const result = await evaluateRows({
  rows: authorizedRows,
  project: row => ({ description: row.description }),
  namespace: JSON.stringify([tenantId, 'workflow-review']),
  questions: {
    relevant: { type: 'noul', instructions: 'Does this describe a failed workflow?' }
  },
  cache: createPgJudgmentCache({ pool }),
  signal: AbortSignal.timeout(6000)
});
const { accepted, rejected, review } = partitionRows(result.records, 'relevant');
```

Questions support Noul, Choice, and Score. Choice requires a label-to-description
criteria object. Score requires ordered descriptive levels. Each record retains
its source object and index, named answers, and model/cache provenance.

Use a server-owned tenant and purpose namespace. Only projected fields are sent.
The default pinned model is `jev-1.13.0`; model aliases are refused. Requests
isolate rows by default. Identical projected states share a judgment, without
dropping duplicate source rows.

Limits default to 400 rows, 800 uncached judgments, four concurrent requests,
and an estimated input cost ceiling of USD 0.05. Cost estimates are not a billing
guarantee. Pass `dryRun: true` to estimate without provider calls or cache warming.
Use a deadline signal to bound the entire operation, including cache reads.

The PostgreSQL cache expects the existing `jev_judgment_cache` table with
`key`, `answer`, `purpose`, and `last_used_at` columns. It performs no DDL.
Writes are serialized, update changed answers, and can be awaited with `drain()`.
Cache failures become misses, never valid judgments.

Validate all requested answers before consuming them. Invalid or partial provider
results throw and are not cached. Callers must expose fallback status explicitly.
Noul boundary values and the middle band stay in review. These judgments apply
only to the supplied rows, not to database totals or permission to mutate data.
