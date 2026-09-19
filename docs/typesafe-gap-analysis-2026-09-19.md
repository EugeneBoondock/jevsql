# TypeSafe documentation gap analysis

Date: 19 September 2026.

## Verified baseline

- `npm test`: 378 passed, 0 failed, 2 real-server checks skipped locally.
- Node test coverage: 95.98% lines, 87.46% branches, 95.28% functions.
- Mutation test: 76.06% across 376 behavioral changes; the 75% CI floor passed. Validation reached 85.81% and query compilation reached 76.81%.
- `npm run workflows`: passed against the offline fixture.
- `npm run control`: passed against the offline fixture.
- `npm run workflows -- --live`: passed against TypeSafe `jev-1.13.0` using only the bundled synthetic records.
- Morphed database probe: passed against PostgreSQL 17.6 through the Supabase pooler. JevSQL captured the 408-table `public` schema, returned a plan, enforced a statement timeout, verified the schema hash, and completed one bounded read from `public.health_check`.
- Morphed TypeSafe probe: `/v1/models` and a pinned `jev-1.13.0` Choice both responded using a database-derived count summary without row contents.

The live run covered Choice, Noul, Score, exact-span selection, entity matching, cached refresh, review queues and saved data checks.

## Defect repaired during this review

TypeSafe defines a Score as the probability-weighted position across its ordered levels. JevSQL checked the score range, but did not check that the returned score agreed with the returned probability distribution. A malformed response could therefore be cached and exposed as a valid score.

`validateAnswer` now recomputes the expected score and rejects a disagreement outside the existing probability tolerance. The mock server was corrected because it had been emitting inconsistent Score values. A regression test proves both rejection and acceptance paths.

## Added in this review

| Priority | Addition | Result |
| --- | --- | --- |
| P1 | Isolated-row request mode plus an A/B evaluator | `rowMode: 'isolated'`, `--isolate-rows`, query stats, and `compareRowModes()` are implemented and tested. |
| P1 | Noul `true` and `false` criteria | `jev_noul`, `jev_bool`, `jev_decide`, and `jev_match` accept structured criteria. Criteria reach TypeSafe intact and are part of cache identity. |
| P1 | Choice winner-probability access and gating | `jev_choice_top_prob` and `jev_choice_prob_gate` reuse the same Choice answer as existing projections. |
| P2 | Hierarchical Choice search | `hierarchicalChoice()` performs beam search, length-normalized ranking, and probability and margin review gates. |
| P2 | Retrieval gate before passage ranking | The workflow recipe uses an answer-exists Noul before Score ranking. The offline test excludes an allowed but nonanswering passage. |
| P2 | Date-part extraction and deterministic resolution | `extractDate()` selects bounded parts. `resolveDateParts()` validates calendar dates and applies relative date arithmetic in code. |
| P3 | Generic approved-function router | `routeApprovedFunction()` uses a registered function set, closed argument values, code defaults, and mandatory confirmation before side effects. |
| P3 | HTTP client parity tests and model discovery | Tests cover `429`, `529`, both `Retry-After` forms, exhausted timeouts, malformed JSON, missing answer ids, and authenticated `listModels()`. |

## Test and evidence gaps

1. The row-mode comparison tool exists, but no representative labeled dataset has been run through both modes. This measurement needs adjudicated project data.
2. No adjudicated corpus ships with the project, so confidence cutoffs, selective accuracy, calibration and review workload remain unmeasured on representative data.
3. Real PostgreSQL and MySQL CI jobs now verify schema reads, plans, tenant-bound reads, restricted roles, rollback, cancellation, statement timeouts and lock timeouts. A separate read-only run against the Morphed Supabase PostgreSQL database passed snapshot, plan, timeout, schema-hash and bounded-read checks. Repeated CI history and a live MySQL deployment still need review before making a reliability claim.
4. CI now enforces 95% lines, 86% branches, and 95% functions.
5. Module-level branch weak spots remain in command dispatch, remote-adapter fallbacks, the control plane and the semantic layer even though the project-wide floor passes. Candidate rescoring now has direct tests for deduplication, unlabelled and null-state skips, verdict mapping, receipt identity, validation and cancellation.
6. Mutation testing now covers selected paths in `validation.mjs`, `query-compiler.mjs`, and `sql-inspector.mjs`. The measured behavioral score is 76.06% and CI enforces a 75% floor. The remaining 90 changes include defensive or equivalent branches plus assertions that can still become more exact.
7. The live smoke run is small and synthetic. It confirms wire compatibility, not production accuracy, throughput or rate-limit behavior.

## Keep outside the automatic path

- Database writes, permission changes, failover, index creation and destructive maintenance should continue to require deterministic checks and human approval.
- Dates, arithmetic, ordering and exact value normalization should stay in code.
- A schema-valid model answer should never be treated as proof that the answer is correct.

## TypeSafe sources reviewed

- [Introduction](https://docs.typesafe.ai/introduction)
- [State](https://docs.typesafe.ai/concepts/state)
- [How to build with TypeSafe](https://docs.typesafe.ai/concepts/how-to-build-with-system-one)
- [Choice](https://docs.typesafe.ai/primitives/choice)
- [Score](https://docs.typesafe.ai/primitives/score)
- [Noul](https://docs.typesafe.ai/primitives/noul)
- [Advanced structure](https://docs.typesafe.ai/primitives/advanced)
- [Confidence](https://docs.typesafe.ai/confidence)
- [Speculative fan-out](https://docs.typesafe.ai/patterns/fan-out)
- [Intent routing](https://docs.typesafe.ai/patterns/intent-routing)
- [Jev 1.13 jaggedness](https://docs.typesafe.ai/model-jaggedness/jev-1.13)
- [Self-consistency for choices](https://docs.typesafe.ai/cookbooks/consistency_choice_cookbook)
- [Parallel questions](https://docs.typesafe.ai/cookbooks/parallel_questions)
- [Re-ranking](https://docs.typesafe.ai/cookbooks/rerank_typesafe)
- [Line-by-line search](https://docs.typesafe.ai/cookbooks/semantic_find)
- [Function calling](https://docs.typesafe.ai/cookbooks/function_calling)
- [Guardrails for LLMs](https://docs.typesafe.ai/cookbooks/llm_guardrails)
- [Date extraction](https://docs.typesafe.ai/cookbooks/date_extraction_cookbook)
- [Hierarchical classification](https://docs.typesafe.ai/cookbooks/hierarchical_classification)
