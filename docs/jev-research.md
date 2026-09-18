# Jev research and implementation decisions

Reviewed September 18, 2026. Sources are TypeSafe’s own documentation. The implementation is a local SQLite library; no hosted service is required.

## What Jev changes about a database tool

The [introduction](https://docs.typesafe.ai/introduction) and [build guide](https://docs.typesafe.ai/concepts/how-to-build-with-system-one) describe a model that answers narrow, typed questions. Software supplies the alternatives and decides what to do with the result. This suggests a database tool centered on inspectable decisions: compare, select evidence, rank, abstain, and record what changed.

An automatic text-to-SQL wrapper would leave the original project’s useful distinction mostly unused. This implementation instead makes model decisions available to normal SQL and persists them for other tools to consume.

## Protocol and model behavior

The [HTTP reference](https://docs.typesafe.ai/api) defines one state with a map of typed questions, plus returned answers, usage, and model information. The client retains that wire format. It now supports cancellation, bounded retries, and response validation before caching.

The [models page](https://docs.typesafe.ai/models) lists Jev 1.13.0, a 64k total request budget, and a separate 32k budget for state plus the longest question. JevSQL enforces smaller configurable serialized-byte limits because it does not have the provider’s tokenizer. A byte budget is not an exact token limit. The actual returned model is retained in receipts; users can pin a version and separate cache namespaces.

## Primitives become reusable SQL values

The [Choice](https://docs.typesafe.ai/primitives/choice), [Score](https://docs.typesafe.ai/primitives/score), and [Noul](https://docs.typesafe.ai/primitives/noul) references define different decisions. Choice compares a closed set. Score locates an input among ordered descriptions. Noul estimates a yes-probability. A normalized score remains a position on a rubric; it is not an extracted physical quantity.

The [advanced structure guide](https://docs.typesafe.ai/primitives/advanced) supports descriptive objects and nested JSON in questions and rubrics. JevSQL now preserves those structures instead of flattening every label or level to a string. Invalid option counts, duplicate labels, and thresholds fail before requests are sent.

The [confidence guide](https://docs.typesafe.ai/confidence) distinguishes the full distribution from the convenient confidence statistic. SQL can now read both. The [Noul consistency cookbook](https://docs.typesafe.ai/cookbooks/consistency_noul_cookbook) motivates a review band; `jev_decide` exposes it without losing access to the original probability. Labeled evaluation measures selective accuracy and coverage rather than presenting confidence as proof of correctness.

## Beyond ticket classification

The [entity alignment cookbook](https://docs.typesafe.ai/cookbooks/entity_alignment) treats matching as a decision over candidate pairs. `jev_match` accepts two structured records and a matching question. Ordinary SQL narrows the pair set first. Returning a probability deliberately stops short of merging a customer or business record.

The [pre-parsed extraction cookbook](https://docs.typesafe.ai/cookbooks/pre_parsed_value_extraction_cookbook) separates candidate discovery from candidate selection. `jev_candidates` finds spans without inference. `jev_pick` supplies candidate IDs plus a none option, validates that all candidates exist in the source, and copies the selected span in code. Empty candidates cost no request.

The [citation-checking cookbook](https://docs.typesafe.ai/cookbooks/citation_check) motivated the evidence audit recipe. JevSQL adds a persistent workflow: record the decision, refresh when the evidence changes, and inspect the before/after result. The review queue gives each flagged row a next action: repair a stale claim, gather evidence, or review uncertainty.

The [RAG passage cookbook](https://docs.typesafe.ai/cookbooks/classifying_rag_passages) motivated passage ranking before a writing model consumes the context. Permission filtering stays in SQL. A suspicious-content judgment is advisory and is never treated as authorization.

## Make the behavior operational

[Fan-out](https://docs.typesafe.ai/patterns/fan-out) uses one shared state for multiple questions. JevSQL groups repeated states and shares one question across related SQL functions. The batcher now splits even a single state with many questions and includes serialized rubrics in its budget checks.

[Composite scoring](https://docs.typesafe.ai/patterns/composite-scoring) keeps combinations in code. Full score distributions and normalized scores make those combinations available to SQL without asking the model to perform arithmetic. [Confidence routing](https://docs.typesafe.ai/patterns/confidence-routing) becomes an explicit review table or data check, with thresholds measured against labeled records.

Decision tables, row change history, query receipts, rollback, and CI exit codes are JevSQL features built around these patterns. They are not claimed TypeSafe API features. Refresh still scans the source query; it saves model work through content caching and applies only changed output rows.

## Boundaries that shaped the implementation

The [Jev 1.13 limitations page](https://docs.typesafe.ai/model-jaggedness/jev-1.13), reviewed by TypeSafe on September 17, describes failures with numeric precision, dates, indirect instructions, distracting context, and adversarial text. Those findings led to exact-span extraction, narrow state, descriptive rubrics, SQL-side calculations, and explicit review paths.

JevSQL does not generate arbitrary answers, autonomously modify business records, guarantee security decisions, or claim a measured thousand-fold speedup. Its live validation uses a small synthetic dataset; task accuracy needs a separate evaluation on representative data.
