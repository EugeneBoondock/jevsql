# JevSQL implementation audit

> **Superseded.** This records the state before remediation. Every defect below
> (F1-F8) and the coverage gaps that follow them are fixed; see
> [implementation-audit-2026-09-19.md](implementation-audit-2026-09-19.md) for the
> fixes, their regression tests, and what remains genuinely open.

Date: 18 September 2026. Scope: the current local project, including its existing local changes, compared with the three supplied research PDFs.

## Finding

**Partially implemented. The project contains working software for much of the proposed design, but the documents’ full scope and overlooked failure cases are not covered.** Eight defects were reproduced. Other proposals have review functions without the surrounding operational workflow. The proposed three-month accuracy, latency, privacy, and business-outcome targets remain unproven.

The distinction matters: implemented evaluation functions do not mean the model has passed an evaluation; a migration review packet does not prove a migration or rollback works; a driver adapter tested with fake connections does not establish behavior on a real server.

## Verification performed

The full suite was rerun after the interruption: **266 tests passed, 0 failed, 0 skipped**, on Node 22.20.0. Both offline demos completed. The workflow demo reused all judgments on an unchanged refresh and made one new judgment after changing an input. The control demo excluded the other tenant with its correctly configured schema and rejected a stale permit.

Separate probes exercised the cases below using in-memory SQLite, a loopback mock server, or synthetic provider/driver objects. No production records or actual credentials were used. This resumed audit made no live TypeSafe inference requests and ran no PostgreSQL/MySQL server tests. Existing live-smoke observations in `docs/validation.md` are historical evidence, not a new benchmark.

Only this audit document was added. Application code and existing tests were not changed. The reported defects remain open.

## Source documents

Page numbers below are PDF page numbers.

- **A:** [jev by TypeSafe AI: A Typed-Decision Layer for AI-Era Databases](<C:/Users/USER/Downloads/jev by TypeSafe AI_ A Typed-Decision Layer for AI-Era Databases.pdf>). Main proposal map: pages 4-10.
- **B:** [Jev for SQL Databases: Deep Research, Architecture Map and Three-Month PoC](<C:/Users/USER/Downloads/Jev for SQL Databases_ Deep Research, Architecture Map and Three-Month PoC.pdf>). Capability map: pages 5-15; control design: pages 16-28; PoC targets: pages 28-31.
- **C:** [JEV Model Database Solutions](<C:/Users/USER/Downloads/JEV Model Database Solutions.pdf>). Main proposals: pages 5-12.

## Coverage map

“Implemented” below means an executable local capability with tests or a reproduced example. It does not mean production qualification. “Partial” identifies the remaining boundary.

| Proposed capability | Status and evidence | Remaining work |
| --- | --- | --- |
| Typed Noul, Choice, Score, distributions, abstention; A 2, B 3-5 | Implemented in [functions.mjs](C:/Users/USER/Projects/jevsql/src/functions.mjs:44) and [decisions.mjs](C:/Users/USER/Projects/jevsql/src/decisions.mjs:42). | Response consistency weakness F6. |
| Exact-source extraction, entity matching, passage ranking, quality checks; A 6-7, B 10, 15 | Implemented SQL functions and offline recipes, including empty-source abstention. [Workflow demo](C:/Users/USER/Projects/jevsql/examples/workflows.mjs:11). | No general ingestion/normalization pipeline, entity merge workflow, or embedding refresh service. Candidate discovery is heuristic. |
| Saved decisions, refresh, receipts, changed-row history | Implemented in [workflows.mjs](C:/Users/USER/Projects/jevsql/src/workflows.mjs:61). | Refresh rescans candidates and retains a transaction during model work. No automatic change feed or scheduling. |
| Query intent, grain, tenant, and privacy review; A 4-6, B 16-19, C 7-8 | Partial: deterministic SQLite inspection plus semantic checks. [reviewQuery](C:/Users/USER/Projects/jevsql/src/control-plane.mjs:24). | Not a deployed SQL proxy. Arbitrary external SQL remains advisory. Findings F1, F2, F5, and F6 prevent treating this as complete isolation. |
| Approved query routing and typed SQL construction; A 8-9, C 8-9 | Implemented finite templates, roles, parameters, joins, aggregates, and single-use permits. [GovernedQueries](C:/Users/USER/Projects/jevsql/src/governed-queries.mjs:14), [compiler](C:/Users/USER/Projects/jevsql/src/query-compiler.mjs:59). | F2 and F4. No full reusable business-measure language, generated endpoint service, or metric-aware analyst application. |
| PostgreSQL/MySQL read execution; B 28-30, C 7-10 | Driver wrappers exist, with read-only transactions, bound parameters, schema checks, and rollback. [Adapters](C:/Users/USER/Projects/jevsql/src/adapters.mjs:119). | Tests use fake drivers. Host authentication and restricted database roles are caller responsibilities; F8 affects snapshot completeness. |
| Schema extraction, drift, consumer impact; A 5, B 9, 14 | Implemented table snapshots, deterministic diffs, explicit dependency traversal. [Schema functions](C:/Users/USER/Projects/jevsql/src/schema.mjs:263). | No application/ORM type extraction and deterministic app-to-database comparison. Views/triggers are excluded; remote metadata is narrower. |
| Migration review packets and test selection; A 9, B 21-22 | Implemented findings, hashes, affected assets, and required test-pack names. [reviewMigration](C:/Users/USER/Projects/jevsql/src/control-plane.mjs:48). | No test-pack runner, migration replay, proof that SQL produces the supplied after-schema, or rollback restoration check. |
| Schema relevance pruning; A 8, C 5-6 | Implemented semantic selection and bounded foreign-key path retention. [selectSchema](C:/Users/USER/Projects/jevsql/src/control-plane.mjs:91). | No measured downstream accuracy or context-saving target. |
| Plan triage, slow-query grouping, N+1 evidence; A 6, B 5-7, 15, C 9-10 | Implemented offline plan readers and numerical symptom calculations. [analyzePlan](C:/Users/USER/Projects/jevsql/src/telemetry.mjs:341), [summarizeWorkload](C:/Users/USER/Projects/jevsql/src/telemetry.mjs:534). | No live collector or baseline plan-regression pipeline; hash-spill fields are missed. |
| Incident/runbook routing; A 9, B 9-11 | Implemented selection from supplied runbooks. [triageIncident](C:/Users/USER/Projects/jevsql/src/control-plane.mjs:82). | No lock-graph builder, operational runbook executor, restore drill, or backup/replication monitoring pipeline; F3. |
| Replica selection; C 10 | Implemented deterministic checks for consistency, fresh evidence, lag, capacity, and stable selection. [routeReplica](C:/Users/USER/Projects/jevsql/src/telemetry.mjs:648). | Actual dispatch and atomic capacity reservation remain external. No selection defect was confirmed. |
| Calibration and release evaluation; B 27-30 | Implemented binary/multiclass metrics, top-K, Brier/ECE, reliability/threshold curves, group checks, Wilson bounds, and declared tuning-overlap rejection. [metrics.mjs](C:/Users/USER/Projects/jevsql/src/metrics.mjs:326). | No adjudicated production-representative corpus or demonstrated target results. Release usefulness checks are incomplete. |
| Privacy, retries, budgets, model/cache versions; B 25-27 | Implemented in [DecisionService](C:/Users/USER/Projects/jevsql/src/decision-service.mjs:68). | F1/F3 expose separate outbound paths. Budgets are estimates. Lower-level JevSQL still defaults to a moving model alias unless configured. |
| Human review, feedback, audit; B 25-27 | Local queue, revision-checked labels, and receipt hash chain exist. [ReceiptStore](C:/Users/USER/Projects/jevsql/src/receipts.mjs:8). | No authenticated approval application; feedback is not an execution approval and is outside the receipt chain, F7. |
| Catalog, lineage, mappings, architecture, access, synthetic realism; A 7-9, B 11-15 | Semantic review presets and caller-supplied evidence paths exist. [policies.mjs](C:/Users/USER/Projects/jevsql/src/policies.mjs:9). | No automatic catalog/lineage discovery, catalog update service, ETL orchestrator, FK-aware data factory, dialect translator, or partition/shard implementation. |
| Candidate rewrite/index review; B 6, 20-21 | Semantic candidate rubric and bounded SQLite result comparison exist. [compareReads](C:/Users/USER/Projects/jevsql/src/control-plane.mjs:120). | No candidate generator, cross-engine property-test runner, index benchmarking pipeline, or promotion workflow. |

## Reproduced defects

### F1. P1: collection widens a grouped tenant predicate before model dispatch

**Source:** [rewrite.mjs](C:/Users/USER/Projects/jevsql/src/rewrite.mjs:48).

The probe selected a model-derived queue with a predicate combining `tenant_id = 1` and `jev_bool(...)`. Without outer parentheses, only tenant 1 text reached the mock provider. Adding parentheses around the same predicate caused tenant 2 text to reach the provider as well. Both final query results still contained only tenant 1.

This is exposure during model input collection, which checking final returned rows will miss. Isolate authorized source rows before collection and preserve authorization predicates through transformations; reject unsupported shapes. Regression checks must inspect outbound states.

### F2. P1: unclassified tenant columns permit cross-tenant governed reads

**Sources:** [query-compiler.mjs](C:/Users/USER/Projects/jevsql/src/query-compiler.mjs:114), [governed-queries.mjs](C:/Users/USER/Projects/jevsql/src/governed-queries.mjs:88).

Synthetic tables using `TENANT_ID` or `account_id`, without an explicit mapping, omitted tenant predicates. Actual `prepare()` followed by `execute()` returned both tenant a and tenant b to actor a. The evidence sent to the model still described an authenticated current tenant. An explicit `account_id` mapping correctly restricted the result.

Require explicit tenant-owned or shared classification for every participating table, respect identifier case rules, and refuse missing classifications. This finding concerns compiler defaults; it does not show a bypass of independently enforced database row policies.

### F3. P1: runbook criteria bypass state redaction

**Sources:** [policies.mjs](C:/Users/USER/Projects/jevsql/src/policies.mjs:108), [decision-service.mjs](C:/Users/USER/Projects/jevsql/src/decision-service.mjs:165).

A synthetic password assignment and email in a runbook description survived in outgoing question criteria. The same password field in state became `[removed]`. Enabling `includeEvidence` also saved the unredacted criteria in the receipt.

Put variable descriptions in the redacted evidence path and reference safe identifiers from questions. Verify the complete serialized request and stored evidence, including question content, rather than state alone.

### F4. P1: aggregate multiplication checks ignore comparison collation

**Source:** [query-compiler.mjs](C:/Users/USER/Projects/jevsql/src/query-compiler.mjs:140).

A customer code with `BINARY UNIQUE` contained distinct values `A` and `a`. An order code using `NOCASE` referenced `A` and carried amount 10. Foreign-key validation passed. The compiler accepted the join, which returned a summed amount of **20 instead of 10**.

The uniqueness check uses column names and index uniqueness without matching the join’s comparison semantics. Validate collations when proving that a join cannot multiply rows, or reject the aggregate. Retain the concrete 10-versus-20 case as a regression.

### F5. P2: denied-column inspection misses physical read layouts

**Source:** [sql-inspector.mjs](C:/Users/USER/Projects/jevsql/src/sql-inspector.mjs:102).

Reading a denied integer primary key produced a `Rowid` opcode and an empty detected-column list. Reading a denied primary-key field in a `WITHOUT ROWID` table was incorrectly reported as a different public column. Both inspections returned no blocking findings.

Resolve all supported physical layouts and read opcodes, and refuse unresolved access. This bypass concerns the deterministic review result; arbitrary SQL review itself has no execution permission.

### F6. P2: contradictory Choice fields can authorize a template

**Source:** [validation.mjs](C:/Users/USER/Projects/jevsql/src/validation.mjs:47).

A mock returned `choice: routine_read`, confidence 1, but probabilities assigning 0 to `routine_read` and 1 to `ambiguous`. Validation passed, an executable permit was issued, and the registered read ran.

TypeSafe’s API reference defines Choice as the highest-probability option. Validate that relationship, allowing ties and appropriate numerical tolerance, before issuing eligibility. This is an injected malformed-response test; the audit did not observe the real provider emit this response.

### F7. P2: feedback changes are outside audit verification

**Sources:** [receipts.mjs feedback](C:/Users/USER/Projects/jevsql/src/receipts.mjs:66), [verification](C:/Users/USER/Projects/jevsql/src/receipts.mjs:91).

Changing a saved feedback label, reviewer, and reason directly in the local database left `verify()` returning `ok: true` and the identical head hash. That verifier covers receipts, not feedback.

This requires write access to the receipt database. Include feedback revisions in the integrity record and verify against a separately retained head. Authenticate reviewers in the host application.

### F8. P2: remote schema snapshots discard column positions

**Source:** [adapters.mjs](C:/Users/USER/Projects/jevsql/src/adapters.mjs:87).

The catalog query selects `ordinal_position`, but normalization drops it. Reversed positions in PostgreSQL and MySQL catalog fixtures therefore produced identical schema hashes and no detected changes. Ordinal-sensitive consumers are not covered.

Preserve position through normalization and test both snapshot and diff behavior. These were fake-driver observations; no live server behavior was claimed.

## Additional coverage gaps

**Release qualification can pass a block-everything policy.** With 200 correctly scored unsafe cases and 40 correctly scored safe cases, but every action set to `block`, `qualifyRelease()` returned `pass`. Classifier accuracy and non-review coverage were both 1. The implemented checks omit false-block rate and a minimum useful-allow rate. This is a policy-coverage gap, not an arithmetic error. Add action-based precision and availability criteria separately from model scoring. [Limit checks](C:/Users/USER/Projects/jevsql/src/metrics.mjs:632).

**Schema coverage is table-focused.** Replacing a view and adding an insert-blocking trigger left the SQLite schema hash and diff unchanged. This is a documented extraction boundary, rather than a failed table-diff test, but it leaves the broader migration proposals incomplete. Remote snapshots also omit several details retained locally, including ordinary/expression indexes, checks, generated expressions, and collations. [Schema inspection](C:/Users/USER/Projects/jevsql/src/schema.mjs:263), [remote catalog input](C:/Users/USER/Projects/jevsql/src/adapters.mjs:43).

**Measured hash spills are missed.** A PostgreSQL hashed aggregate with `HashAgg Batches: 4` and `Disk Usage: 2048` produced no symptoms. The parser discards those fields even though the cause rubric refers to hash spills. Add engine-specific parsing and fixtures. [Plan normalization](C:/Users/USER/Projects/jevsql/src/telemetry.mjs:170).

**Documentation understates the newer control modules.** The README mainly describes the SQLite row-decision library, despite the additional control service, remote adapters, and evaluation modules. Document the two execution paths and their different guarantees, especially tenant configuration and model pinning. [README](C:/Users/USER/Projects/jevsql/README.md), [engine default](C:/Users/USER/Projects/jevsql/src/engine.mjs:41).

## PoC evidence still required

Document B proposes about 1,000 adjudicated cases: 400 request/SQL pairs, 250 migrations, and 350 incidents. These are proposed study sizes, not an API requirement. No such reviewed corpus or completed shadow pilot was found in the inspected project.

| Target in B, pages 29-30 | Audit status |
| --- | --- |
| Unsafe-query recall at least 95%; unsafe/mismatch precision at least 85%; auto-pass semantic errors at most 2% | Not established by current fixtures or demos. |
| High-risk migration recall at least 90%; reviewer time reduced at least 30% | No labeled migration study or timing study found. |
| Incident top-1 at least 75%; top-3 at least 90%; triage time reduced at least 25% | Top-K calculations exist; measured operational results do not. |
| Expected calibration error at most 0.08 | ECE is implemented. The default release cap is 0.10 and can be configured; no representative holdout establishes the proposed 0.08 target. |
| Interactive incremental p95 latency at most 750 ms | No workload-scale latency evidence found. |
| No automatic allow after a successful adversarial test; zero unapproved sensitive records sent | Not established; F1/F3 show outbound controls need repair. |
| Exact model, question/policy version, state and outcome evidence | Much of the control receipt structure exists. Human adjudication, operational outcomes, database-version coverage, and corpus workflow still need completion. |

CI currently runs the mock-based Node suite on Windows/Linux and Node 22/24. It does not provision PostgreSQL/MySQL servers or run migration replay and rollback suites. [CI configuration](C:/Users/USER/Projects/jevsql/.github/workflows/ci.yml:7).

## Claims from the documents that should not become guarantees

Document C overstates what constrained answers establish. A selected label and a prepared template do not prove that the intended metric, tenant scope, or aggregate is correct; F2 and F4 demonstrate local counterexamples. TypeSafe describes calibration across groups and explicitly distinguishes that from correctness of an individual answer. Its confidence documentation describes a distribution-derived statistic, not a universal task-accuracy guarantee.

The latency, automation percentages, cost examples, and zero-error claims in C are not JevSQL measurements. Automatic production index creation, failover, or unrestricted mutation should not be added merely to match those suggestions. The review-only boundary for such actions is appropriate. The missing deliverable is a separately tested and authorized operational workflow where one is actually required.

Official references checked on 18 September 2026: TypeSafe API reference, Choice answer (`https://docs.typesafe.ai/api`); Confidence (`https://docs.typesafe.ai/confidence`); System One (`https://docs.typesafe.ai/concepts/system-one`).

## Recommended completion order

First repair the two tenant paths, outbound criteria redaction, and collation-sensitive aggregate checks. Then repair column inspection, response consistency, feedback evidence, and remote snapshot positions. Add regression cases that inspect both returned data and outbound model inputs.

Next validate restricted roles, transaction behavior, cancellation, schema checks, migrations, and rollback on real PostgreSQL/MySQL test instances. Complete explicit schema/consumer coverage before treating migration packets as approval evidence.

Finally build the adjudicated evaluation corpus, qualify each workflow and database separately, and measure shadow-pilot accuracy, useful allows, false blocks, review workload, latency, and cost against the chosen targets. Preserve the distinction between a successful test harness and a successful PoC.
