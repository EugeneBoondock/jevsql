# Morphed database audit and remediation

Date: 19 September 2026.

## Scope

The audit used the supplied Supabase PostgreSQL pooler and TypeSafe key. Initial checks ran in read-only transactions with statement and lock timeouts. Approved fixes were then applied through the Supabase migration service.

No row values were printed or sent to TypeSafe. The TypeSafe check used database-derived counts only.

## Baseline checks

- PostgreSQL 17.6 accepted an SSL connection through the session pooler.
- `transaction_read_only` was `on` during the audit phase.
- A 100 ms statement timeout cancelled `pg_sleep(1)` with PostgreSQL code `57014`.
- `PostgreSQLAdapter.snapshot()` captured all available `public` catalogs: 408 tables, 11 views, and 96 triggers.
- JevSQL compiled a bounded read from `public.health_check`, verified the live schema hash, returned a query plan, and read one row without exposing its value.
- TypeSafe `/v1/models` and `/v1/systemone` both responded. A pinned `jev-1.13.0` Choice over database-derived counts returned a schema-valid answer after 472 input tokens.

## Applied fixes

### Public access controls

Migration `20260919184736_harden_public_access_and_rls_policies`:

- Enabled RLS on the nine public tables that previously allowed broad browser-role access.
- Removed all table privileges from `anon` and `authenticated` on those tables.
- Removed `PUBLIC`, `anon`, and `authenticated` execution from eight `SECURITY DEFINER` CRM functions that trusted caller-supplied portal IDs.
- Kept function execution for `service_role`.
- Set fixed function search paths for all 36 routines reported by the security advisor.
- Rewrote 21 RLS policies so session and Auth values are read once per statement.

Migration `20260919184828_finish_rls_initplan_optimization` changed the two remaining JWT expressions to the exact form expected by the advisor.

### Constraints

Migration `20260919185018_validate_existing_public_constraints` validated all 55 previously unvalidated constraints:

- 49 check constraints across 10 tables.
- 6 foreign keys across 6 tables.

All existing rows passed.

### Indexes

Migration `20260919185042_repair_safe_index_findings`:

- Added supporting indexes for every missing foreign key on tables up to 16 MB.
- Removed six duplicate indexes while retaining the used or constraint-backed copy.

Migration `20260919185119_index_work_objects_assignment_fk` added the final foreign-key index on `public.work_objects`. Its heap was about 2.8 MB across roughly 3,470 estimated rows, so the transactional build completed quickly despite the relation total being about 120 MB.

## Verification

Direct catalog checks after the migrations returned:

- Target tables without RLS: `0`.
- Target tables readable by `anon` or `authenticated`: `0`.
- Target owner-rights functions callable by `anon` or `authenticated`: `0`.
- Unvalidated public constraints: `0`.
- Target views with `security_invoker=on`: `9` of `9`.

The final Supabase advisor result contains:

- Security errors: `0`.
- Security warnings: `0`.
- Missing foreign-key indexes: `0`.
- RLS repeated-evaluation warnings: `0`.
- Duplicate-index warnings: `0`.

The local test suite also passes with 378 tests passed, 0 failed, and 2 opt-in destructive database fixtures skipped.

## Remaining informational items

### Secret rotation

The database password, Supabase keys, TypeSafe key, and session secret were supplied in a chat message. Rotate them. The retired legacy anon key returned HTTP 401 with “Invalid API key”. The ignored local environment now uses the project’s active publishable key, and both REST and Auth health probes return HTTP 200.

### Tables without primary keys

The advisor reports 54 tables without primary keys. Their candidate `id` columns are nullable and have no safe, existing unique index. Adding keys would require decisions about row identity, duplicate handling, null backfills, and defaults. No keys were invented during this repair.

The largest affected tables are:

- `notifications`, about 910 MB and roughly 1.06 million estimated rows.
- `proactive_snapshots`, about 58 MB.
- `partner_content_usage`, about 3.2 MB.
- `partner_content_vectors`, about 3.2 MB.
- `proactive_insights`, about 2.8 MB.

### Unused indexes

The advisor reports newly created indexes as unused until workload statistics record scans. Removing indexes based only on a fresh zero-scan counter would be unsafe. Recheck after a representative workload period.

### Table bloat

`public.crm_custom_objects` remains flagged for bloat. A table rewrite can block traffic and should be scheduled during a maintenance window after measuring reclaimed space.

### Auth pool setting

Supabase Auth is configured with an absolute maximum of 10 database connections. Change this to percentage allocation in the Supabase project settings before scaling the database instance.

## Supabase references

- [Connect to Postgres](https://supabase.com/docs/guides/database/connecting-to-postgres)
- [Row Level Security](https://supabase.com/docs/guides/database/postgres/row-level-security)
- [Database security](https://supabase.com/docs/guides/database/secure-data)
- [Database linter](https://supabase.com/docs/guides/database/database-linter)
