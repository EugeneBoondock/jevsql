# Validation record

Date: September 18, 2026. Runtime used: Node 22.20.0 on Windows.

## Automated coverage

The original 28 tests were retained. Added suites cover:

- Typed rubrics, distributions, abstention boundaries, semantic pair state, exact-span selection, and malformed answers.
- Single-state batch splitting, UTF-8 request budgets, read-only execution, SQL parameters and quoted function names, comments, Unicode, views, and LIMIT behavior.
- Shared cache warming, cancellation, overlapping query rejection, and namespaced cache identity.
- Transactional saved tables, insert/update/delete history, empty results, duplicate keys, rollback, process restarts, data checks, and labeled evaluation.
- CLI SQL files, persisted caches, JSON receipts, saved tables across separate processes, exit codes, and the offline recipe tour.

Run `npm test` for the current authoritative test result. These tests use local mock servers and scripted responses, so they measure software behavior rather than model quality.

## Live synthetic smoke test

The workflow tour also ran against the actual TypeSafe service using the configured local credentials. No credential values were printed. Only bundled synthetic records were sent.

| Observation | Actual result |
|---|---|
| Returned model | `jev-1.13.0` |
| Total successful requests | 5 |
| Input tokens reported by API | 2,948 |
| Calculated cost at the documented rate | $0.000123816 |
| Initial evidence decisions | Two supported claims; one with insufficient evidence. |
| Exact-span contact selection | `billing@acme.example`; missing address returned `NULL`. |
| Matching business name variants | 0.94 for Acme Ltd / Acme Limited. |
| Different business in the same city | 0.08 for Acme Ltd / Northwind Tools. |
| Passage ranking | Direct answer about 0.987; unrelated passage about 0.017. |
| Unchanged refresh | Zero API requests. |
| Edited policy | One new judgment; claim changed from supported to contradicted. |
| Saved data checks | Two unsupported or unsettled claims identified. |

The cost is calculated from actual input usage and the [published rate](https://docs.typesafe.ai/models), not a billing statement. This small run confirms that the enhanced request format and workflows work with the service. It is not a general accuracy benchmark, reliability guarantee, or throughput measurement. A new live run can produce different probabilities.

Reproduce the tour with `npm run workflows -- --live`. Use `npm run workflows` for the offline version.
