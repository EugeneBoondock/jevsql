# JevSQL implementation audit and remediation

Date: 19 September 2026. Supersedes [implementation-audit-2026-09-18.md](implementation-audit-2026-09-18.md), which recorded the state before this work.

Scope: the three supplied research documents, re-read in full, compared against the code by reading every module rather than by trusting the previous audit.

## Finding

**The eight defects the previous audit reported are fixed, each with a regression test that asserts on what leaves the process rather than only on returned rows. Four coverage gaps are closed, and the highest-priority capability named in document A — the typed guardrail in front of an agent-issued statement — is now implemented.** The evaluation and operational evidence the documents ask for is still not produced, and is listed explicitly below rather than implied.

Suite: **284 tests passed, 0 failed** on Node 22.20.0. Both offline demos run. No live TypeSafe requests and no PostgreSQL/MySQL server tests were made.

## Source documents

- **A:** *jev by TypeSafe AI: A Typed-Decision Layer for AI-Era Databases* — proposal map, pages 4-10.
- **B:** *Jev for SQL Databases: Deep Research, Architecture Map and Three-Month PoC* — capability map pages 5-15, control design 16-28, PoC targets 28-31.
- **C:** *JEV Model Database Solutions* — proposals, pages 5-12.

## Defects fixed

Each was independently reproduced against the code before being changed.

| ID | Defect | Fix | Regression test |
| --- | --- | --- | --- |
| F1 | A grouped predicate such as `WHERE (tenant_id = 1 AND jev_bool(...))` has no top-level `AND`, so the whole clause was relaxed for the collect pass and every tenant's text was sent for judgment. Returned rows stayed correct, which hid it. | [rewrite.mjs](../src/rewrite.mjs) now descends into parenthesised conjunctions. A clause that genuinely cannot be split is reported in `stats.widened`, and `strictCollect: true` refuses the query. | "a grouped authorization predicate still narrows which rows are judged" — asserts on the mock server's received payloads |
| F2 | A tenant column named `account_id`, or `TENANT_ID` in a case-insensitive catalog, was not recognised, so the compiled SQL carried no tenant predicate while the review evidence still claimed an enforced scope. | [query-compiler.mjs](../src/query-compiler.mjs) requires an explicit classification for every table a tenant-scoped actor touches: a column name, or `null` for shared. Recognition is identifier-case aware. Evidence now reports the scope actually enforced. | "an unclassified table refuses to compile for a tenant-scoped actor", "a tenant column is recognised however the catalog cases it" |
| F3 | Runbook descriptions and other question criteria travelled to the provider, and into `includeEvidence` receipts, without passing through redaction. | [privacy.mjs](../src/privacy.mjs) adds `redactQuestions`; [decision-service.mjs](../src/decision-service.mjs) minimises questions on the same path as state, before hashing or sending. Option labels are preserved because they are part of the answer contract. | "runbook descriptions are redacted before they reach the provider or a receipt" |
| F4 | The proof that a join cannot multiply rows used column names and index uniqueness while ignoring collation, so a `NOCASE` key joined to a `BINARY UNIQUE` column produced a summed 20 where 10 was correct. | The uniqueness proof now requires the comparison collation to match the collation that enforces uniqueness; otherwise the join is treated as multiplicative and the aggregate is refused. | "a collation mismatch makes a join multiplicative instead of aggregable", plus the matching-collation case |
| F5 | Denied-column checks read `Column` opcodes against `table_info` order. An `INTEGER PRIMARY KEY` is read with `Rowid` and produced no column at all; a `WITHOUT ROWID` table is stored key-first, so a denied column was reported as a different public column. | [sql-inspector.mjs](../src/sql-inspector.mjs) derives the real physical layout for `WITHOUT ROWID` tables, uses `index_xinfo` for index cursors, resolves `Rowid`/`IdxRowid`, and blocks when a read cannot be named while a column policy applies. | "denied columns are detected through rowid aliases and WITHOUT ROWID layouts" |
| F6 | A Choice answer naming an option with probability 0 passed validation and could satisfy a confidence gate. | [validation.mjs](../src/validation.mjs) requires the chosen option to be an argmax within tolerance, matching TypeSafe's definition of Choice. | "a choice that is not its own highest-probability option is rejected" |
| F7 | `verify()` covered receipts only, so editing a saved human label left it reporting `ok: true` with an unchanged head hash. | [receipts.mjs](../src/receipts.mjs) adds a single `_jevsql_chain` integrity log covering receipts and labels, backfilled from existing receipts so an archived head hash stays valid. `verify()` also detects rows written straight to either table. | "the integrity log covers human labels as well as receipts", "a label appended straight to the table, bypassing the log, is detected" |
| F8 | Remote catalog snapshots selected `ordinal_position` and then discarded it, so a reordered PostgreSQL or MySQL catalog hashed identically and produced no diff. | [adapters.mjs](../src/adapters.mjs) preserves position, converting the 1-based catalog value to the 0-based snapshot field and rejecting an invalid one. | "remote-style snapshots keep column positions, so reordering is a change" |

## Coverage gaps closed

- **Release qualification could pass a policy that blocks everything.** Blocking every case gives a perfect false-allow rate. [metrics.mjs](../src/metrics.mjs) now measures the safe side too — `safeCases`, `falseBlocks`, `falseBlockRate`, `falseBlockInterval`, `safeAllowRate` — and `qualifyRelease` enforces `minSafeCases`, `maxFalseBlockRate` and `minSafeAllowRate` alongside the existing safety caps. A block-everything policy returns `review`. This matches document B's safety metric family, which lists false-block rate beside false-allow rate.
- **Measured hash spills were discarded.** The `cause` rubric referred to hash spills that the parser never produced. [telemetry.mjs](../src/telemetry.mjs) reads `HashAgg Batches`, `Hash Batches`, `Original Hash Batches`, `Planned Partitions`, `Disk Usage` and `Peak Memory Usage`, per worker as well as the leader, exposes them as `node.hash`, and raises a `hash-spill` symptom on measured disk usage or extra batches.
- **Column positions in remote snapshots** — see F8.
- **Documentation understated the control modules.** The README now describes both execution paths, their different guarantees, model pinning, the tenant-classification requirement, and the collect-pass widening boundary.

## Capabilities added

Document A ranks the typed guardrail proxy first of ten, and document C describes the same pattern as an inline execution firewall. It was the largest missing piece.

- **`DatabaseControl.reviewStatement`** gates one agent-issued statement against its declared intent. `classifyStatement` in [sql-inspector.mjs](../src/sql-inspector.mjs) decides the operation class, destructiveness and boundedness from masked SQL text, so quoted identifiers cannot fake a keyword and a writable CTE is classified by the write it performs rather than by its leading `WITH`. The `statement` review preset adds intent match, destructiveness, reversibility, shared-data reach, actor expectation, operation class and a blast-radius rubric. Only a read that matches its intent can be `eligible`; every write needs approval, a destructive, unbounded or permission-changing statement needs an out-of-band human, and a multi-statement batch is refused without a model request. Nothing in this path can execute a statement.
- **Three further review presets** named in document B and absent before: `orm` for already-counted N+1 and model/schema mismatch evidence, `cost` for grouping measured spend by business purpose and spotting redundant workloads, and `secrets` for the ambiguous prose that regular expressions cannot settle.
- The guardrail is exposed as `jevsql control statement` and is exercised in the offline control demo.

## What is still not done

These remain open, and none of them is a code-level defect. They are the evidence and operational surface the documents propose.

- **No adjudicated evaluation corpus.** Document B proposes roughly 1,000 cases: 400 request/SQL pairs, 250 migrations, 350 incidents. None exists here. Every accuracy, calibration, precision, recall, reviewer-time and triage-time target in document B is therefore unproven. The harness to measure them is implemented and tested; the measurements have not been taken.
- **No live PostgreSQL or MySQL verification.** The adapters are tested with fake drivers. Restricted roles, transaction behaviour, cancellation, statement timeouts, migration replay and rollback have not been exercised against a real server, and CI does not provision one.
- **No shadow pilot.** Document B's promotion ladder — offline evaluation, shadow scoring, advisory, low-risk routing, high-confidence read-only automation — has only its first rung.
- **Schema extraction stays table-focused.** Views and triggers are outside the snapshot, so replacing a view leaves the hash unchanged. Remote snapshots remain narrower than local ones: they carry columns, primary/unique constraints and foreign keys, but not ordinary indexes, check constraints, generated expressions or collations. Because collation is absent remotely, the F4 proof falls back to treating both sides as the default collation, which is correct for SQLite snapshots and unverified for a MySQL catalog whose columns genuinely differ.
- **No operational runners.** There is no test-pack runner, migration replay, lock-graph builder, live telemetry collector, catalog or lineage discovery, ETL orchestrator, foreign-key-aware data factory, dialect translator, index benchmarking pipeline or partition/shard implementation. Reviews exist for these; the surrounding workflow does not.
- **No application or ORM type extraction**, so the app-versus-database type divergence gate in document A's cluster 2 is only half present: the database side is deterministic, the application side is caller-supplied.

## Claims that should not become guarantees

Document C overstates what constrained output establishes. A schema-valid answer is not a correct one, and F2, F4 and F6 were local counterexamples where a well-typed answer accompanied a wrong result. TypeSafe documents calibration across groups and explicitly separates it from the correctness of any individual answer.

The latency, automation-percentage, cost and zero-error figures in document C are vendor or third-party claims, not JevSQL measurements. Autonomous index creation, failover and unrestricted mutation should not be added to match them. The review-only boundary is deliberate: after this work, the count of database mutations a model answer can trigger on its own is still zero.
