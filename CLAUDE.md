# MSSQL adapter — working notes

This branch adds a native Microsoft SQL Server (T-SQL) dialect and connection
adapter to Malloy. State as of the last session: **db-all suite at 577/737
passing** under `MALLOY_DATABASE=mssql`. Basic `.malloy` files (table sources,
filters, group-bys, aggregates, joins, ORDER BY, LIMIT, multi-stage pipelines,
single-level nests) compile and execute end-to-end.

If you're picking this up, read this whole file before touching code. Many of
the changes here look "wrong" in isolation — they're load-bearing fixes for
T-SQL's idiosyncrasies (no native bool, no NULLS LAST, no LIMIT, predicate vs.
value distinction). Don't revert without understanding why.

## Layout

| Path | What's there |
|------|--------------|
| `packages/malloy/src/dialect/mssql/` | The T-SQL dialect: SQL emission, function overrides, dialect functions, type mapping |
| `packages/malloy-db-mssql/` | Native `mssql` (tedious) connection adapter |
| `packages/malloy-db-mssql/src/mssql_connection.spec.ts` | Connection-level tests (3 cases, all pass) |
| `test/mssql/mssql_start.sh` / `mssql_stop.sh` | Docker fixture for SQL Server 2022 with malloytest data |
| `test/src/runtimes.ts` | Test-runtime case `mssql` (native) — and `mssql_via_duckdb` (kept for reference) |
| `jest.config.ts` | `db-mssql` project entry |
| `package.json` | `test-mssql` and `ci-mssql` scripts |

## Running tests

Prereqs:
- Docker (for the SQL Server container)
- DuckDB CLI (used by the start script to load test data from parquet)
- `OpenJDK` for the ANTLR codegen step (`brew install openjdk`)

```bash
# Start MSSQL on host port 11433 (avoids conflict with funcard-db-1 on 1433)
test/mssql/mssql_start.sh

# Build everything (codegen needs Java on PATH)
PATH="/opt/homebrew/opt/openjdk/bin:$PATH" npm run build

# Native db-mssql connection tests
PATH="/opt/homebrew/opt/openjdk/bin:$PATH" npx jest --selectProjects db-mssql

# Full shared db-all suite against native MSSQL adapter
PATH="/opt/homebrew/opt/openjdk/bin:$PATH" MALLOY_DATABASE=mssql npx jest --selectProjects db-all

# Or via the npm script
PATH="/opt/homebrew/opt/openjdk/bin:$PATH" npm run test-mssql
```

## Container & connection

- Image: `mcr.microsoft.com/mssql/server:2022-latest` (forced, with
  `--platform=linux/amd64` on ARM64 Macs). The dialect targets T-SQL 2022
  features (`JSON_OBJECT`, `JSON_ARRAY`, `DATEDIFF_BIG`); Azure SQL Edge is
  ARM-native but lacks those.
- Container name: `mssql-malloy`. Port: `11433` (not 1433 — there's an
  existing `funcard-db-1` on the standard port).
- SA password: `Malloy_Test_123`. Database: `malloytest`.
- The native `mssql` driver requires `encrypt: false, trustServerCertificate: true`
  to connect to the container without TLS material.

The DuckDB MSSQL extension is used in `mssql_start.sh` to load parquet
fixtures into the container. It uses `Server=host,port` syntax (not
`Port=...`) which the script reflects.

## Commits and what they did

```
260ddc5 feat(mssql): add native Microsoft SQL Server dialect and adapter
40c1136 feat(mssql): wrap boolean values for T-SQL SELECT-list contexts
0f085fc feat(mssql): add T-SQL function shims and fix boolean literal comparisons
b7bea6d feat(mssql): map array/record types to NVARCHAR(MAX) and parse JSON on read
bd07aa0 feat(mssql): infer JSON-array/record column shapes via OPENJSON probes
f10f18b feat(mssql): emulate NULLS LAST with a leading null-flag sort term
```

Test count progression (db-all):
258 → 326 (SQL Server 2022) → 514 (initial dialect work) → 543 → 555 (function shims)
→ 560 (record/array NVARCHAR mapping) → 576 (JSON shape inference) → 577 (NULLS LAST).

## Cross-cutting design decisions

### T-SQL has no boolean type — we emit predicates and wrap on demand

Malloy compiles `true`/`false`/`x = y` etc. into raw SQL. Most dialects accept
the result anywhere. T-SQL only accepts predicates inside WHERE/HAVING/CASE-WHEN/
JOIN-ON; SELECT-list values, JSON values, and COALESCE second args need a
*value* (BIT or 1/0).

Approach taken (commits 40c1136, 0f085fc):
- `MSSQLDialect.sqlBoolean(true)` → `(1=1)` — predicate form, the default.
- `MSSQLDialect.sqlBoolValueOf(predicate)` → `IIF(<pred>, CAST(1 AS BIT), CAST(0 AS BIT))`
  — wraps a predicate into a BIT value.
- `Dialect.boolPredicatesNotValues` flag — MSSQL: true.

Wrap sites are called explicitly at value boundaries:
- `FieldInstanceField.generateValueExpression()` — new method that wraps when
  the field type is boolean. Used by SELECT-list emission and dialect-field
  building in `query_query.ts`.
- `generateCaseSQL` — wraps THEN/ELSE positions when they're bare `true`/`false`
  literals.
- `expression_compiler.ts` `case '='` / `case '!='` — when one side is a
  `true`/`false` AST node and the other side is a BIT column, swap the literal
  for `CAST(1/0 AS BIT)` so the comparison is value=value, not value=predicate.
- `MSSQLDialect.sqlLiteralArray` / `sqlLiteralRecord` — wrap boolean child
  expressions so `JSON_OBJECT('active': true)` produces a BIT value rather than
  the invalid `(1=1)` in JSON value position.
- Test fixture builders (`test/src/test-select.ts`, `packages/malloy/src/test/test-models.ts`)
  — wrap when generating typed-value SELECT lists, *except* for typed-NULL casts
  (where `needsCast: true`) since the value is already typed.
- `filter_compilers.ts` — boolean filter null cases use
  `dialect.sqlBoolValueOf(dialect.sqlBoolean(false))` so the COALESCE second arg
  matches the BIT result of the surrounding CASE.

**What does NOT work:** wrapping every boolean operation as BIT and unwrapping
at predicate sites. We tried; the net was a regression because filter compilers
emit predicates while expression compiler would emit BIT, and a blanket WHERE
unwrap broke the predicate-only paths. Don't go down that road again without a
plan to unify the two compilers.

### T-SQL's GROUP BY rejects positional ordinals — use expressions

`GROUP BY 1, 2` in T-SQL means "group by the constants 1 and 2," not by
positions. Added `Dialect.groupByExpression` flag (MSSQL: true) plus a
`groupByClause()` helper in `query_query.ts` that re-emits the original SELECT
expressions (with constants filtered out, since T-SQL rejects those too).

The constant-filter heuristic is in `hasColumnReference()`: an expression is a
column reference if it contains `[...]` or the bareword `group_set`. Pure
literals and arithmetic on literals are dropped. The bareword exception is
because the dialect's `sqlGroupSetTable` adds an unbracketed `group_set`
column from a `CROSS JOIN (VALUES ...) AS __gs(group_set)`.

The CROSS JOIN's table alias is `__gs`, *not* `group_set` — when SELECT *
propagates the column up through CTEs, T-SQL otherwise gets confused about
`group_set.group_set` and reports binding errors in outer aggregates.

The 5 GROUP BY emit sites in `query_query.ts` are now wired through
`groupByClause()` (expression path) or the original ordinal join (default).
The index segment (`GROUP BY 1,2,3,4,5`) special-cases by emitting the
captured CASE expressions from its own SELECT-list construction.

### T-SQL has no LIMIT and forbids ORDER BY in subqueries without OFFSET/FETCH

Added `Dialect.sqlLimit(n, hasOrderBy)`. Default returns `LIMIT N`. MSSQL
returns `FETCH NEXT N ROWS ONLY` (when ORDER BY already added the OFFSET) or
the full `ORDER BY (SELECT NULL) OFFSET 0 ROWS FETCH NEXT N ROWS ONLY` form.

`MSSQLDialect.sqlOrderBy` for query-context appends `OFFSET 0 ROWS` so an
ORDER BY is legal inside a CTE/derived table even without a LIMIT. For
turtle/analytical contexts (inside aggregate `WITHIN GROUP`), no OFFSET — that
would be a syntax error inside the aggregate.

Three `LIMIT N` emit sites in `query_query.ts` were updated to call
`dialect.sqlLimit(...)`. The fixture generators in `test/src/test-select.ts`
and `packages/malloy/src/test/test-models.ts` also route ORDER BY/LIMIT
through the dialect (using `dialect.sqlOrderBy` and `dialect.sqlLimit`) so
the fixtures emit T-SQL-valid pagination.

### NULLS LAST emulation (commit f10f18b)

T-SQL has no NULLS LAST keyword. Earlier attempts to wrap each ORDER BY term
as `CASE WHEN <alias> IS NULL THEN 1 ELSE 0 END, <alias> DIR` failed because
T-SQL refuses to bind SELECT-list aliases inside CASE in ORDER BY — even
simple-rename aliases. Empirically tested:

```sql
-- Works: column from FROM source
ORDER BY CASE WHEN col IS NULL THEN 1 ELSE 0 END, col ASC

-- Fails (Invalid column name): alias of column rename
SELECT col AS [c] FROM t
ORDER BY CASE WHEN [c] IS NULL THEN 1 ELSE 0 END, [c] ASC

-- Fails: alias of an aggregate
SELECT MAX(col) AS [m] FROM t GROUP BY ...
ORDER BY CASE WHEN [m] IS NULL THEN 1 ELSE 0 END, [m] ASC
```

Solution (in `genereateSQLOrderBy`): for `nullsLastWantsFlag` dialects, prepend
an `ASC` null-flag term *using the field's underlying SQL expression*
(`fi.getSQL()`), gated to a simple `[col]` / `<alias>.[col]` form via the
`simpleColRef` regex. Aggregates and complex expressions skip the flag and
inherit T-SQL's default null sort. The flag column itself is always `ASC` so
nulls land last whether the sort is ASC or DESC.

```sql
-- Result for `order_by: l asc` on a simple column
ORDER BY CASE WHEN base.[l] IS NULL THEN 1 ELSE 0 END ASC, 1 asc OFFSET 0 ROWS
```

### Time zones — IANA → Windows mapping

T-SQL's `AT TIME ZONE` only accepts Windows zone names. There's a small
`ianaToWindowsTz` map in `mssql.ts` covering the zones used by Malloy tests
(US, GMT, mainland Europe, Asia, Sydney, Mexico City, Dublin). Unknown zones
pass through unchanged so failures surface as T-SQL errors rather than
silent corruption. Add to the map as you encounter new zones.

### JSON-typed columns from `mssql.sql(...)` — OPENJSON shape probing

T-SQL has no native compound types, so `sp_describe_first_result_set`
reports any `JSON_ARRAY`/`JSON_OBJECT` result as plain `NVARCHAR(MAX)`. That
breaks Malloy schemas for nested test fixtures.

`MSSQLConnection.fetchSelectSchema` does a two-pass probe (commit bd07aa0):

1. After `sp_describe`, identify columns reported as
   `NVARCHAR/CHAR/NCHAR/TEXT/NTEXT`.
2. One probe query: `SELECT TOP 1 ISJSON(c1), LEFT(LTRIM(c1),1), ...
   FROM (<user-sql>) AS __probe` — detects JSON-shaped columns and
   discriminates array (`[`) from object (`{`).
3. For each JSON column, a recursive `OPENJSON((SELECT TOP 1 <expr> FROM
   (<user-sql>) AS __probe))` probe — OPENJSON returns key/type pairs where
   `type` is `1=string, 2=number, 3=bool, 4=array, 5=object`. Descends into
   nested arrays via `JSON_QUERY(<col>, '$[0]')` and into nested records via
   `JSON_QUERY(<col>, '$.<key>')` until every leaf is a scalar.
4. Fields are then built via `mkFieldDef` so they carry the right
   `BasicArrayDef` / `RepeatedRecordDef` / `RecordDef` shape (with `join`,
   `elementTypeDef`, etc.).

Cost is one shape-probe per `mssql.sql(...)` plus 1+N OPENJSON probes per
JSON column. Acceptable for fixture-style usage; very wide JSON shapes pay
multiplicatively. Tables (`mssql.table(...)`) and primitive columns are
unaffected.

We considered a SELECT-list parser, naming-convention sentinels, and explicit
type annotations as alternatives. The probe is the lowest-friction option and
catches every test fixture without modification. Doc the alternatives in case
the perf cost becomes an issue in production.

`malloyTypeToSQLType` for `array`/`record` → `NVARCHAR(MAX)` (commit b7bea6d).
This is what makes `null::number[]` and `null::{a: number}` casts work.

The connection no longer auto-JSON-parses strings — that's done in
`packages/malloy/src/api/util.ts:mapValue` only when the field's declared type
is `array_type` or `record_type`. The earlier connection-level parse fired on
any string starting with `[` or `{` and silently corrupted real NVARCHAR
columns containing JSON-looking text.

### T-SQL function shims (commit 0f085fc)

In `packages/malloy/src/dialect/mssql/function_overrides.ts`:

- `length` → `LEN`
- `substr` (two-arg) → `SUBSTRING(value, position, LEN(value))` (T-SQL `SUBSTRING` requires 3 args)
- `substr` (three-arg) → `SUBSTRING`
- `strpos` → `CHARINDEX(search, test)`
- `starts_with` / `ends_with` → CASE with LIKE
- `div` → `FLOOR(a/b)` (T-SQL `/` is integer-on-integer)
- `byte_length` → `DATALENGTH`
- `chr` → `CHAR`
- `ln` → `LOG`
- `log` → `LOG(value, base)`
- `pow` → `POWER`
- `round` (1-arg) → `ROUND(x, 0)` (T-SQL ROUND requires 2 args)
- `trunc` → `ROUND(x, n, 1)` (third arg = 1 truncates)
- `ceil` → `CEILING`
- `atan2` → `ATN2`
- `string_repeat` → `REPLICATE`
- `ifnull` → `ISNULL`
- `stddev` → `STDEV` (sample std-dev, matches BigQuery semantics)
- `is_nan` / `is_inf` → constant `(0=1)` (T-SQL FLOAT can't represent NaN/Inf)
- `replace.regular_expression` → falls back to literal `REPLACE` (T-SQL has no
  native regex until SQL Server 2025)
- `trim` / `ltrim` / `rtrim` with characters → `TRIM(<chars> FROM <value>)`
  (T-SQL's syntax differs from the standard 2-arg form)

### Identifier quoting and table paths

`sqlMaybeQuoteIdentifier` uses `[name]` (T-SQL bracket-quoting) with `]` →
`]]` escape. `quoteTablePath` splits on `.` and quotes each segment, so
`malloytest.airports` becomes `[malloytest].[airports]`.

### Sampling

`sqlSampleTable` uses `TOP N ... ORDER BY NEWID()` for row sampling and
`TABLESAMPLE (P PERCENT)` for percent sampling. Default sample is 50000 rows.

### Hash-based symmetric aggregate keys

T-SQL doesn't have a native bigint hash; we use
`CONVERT(BIGINT, SUBSTRING(HASHBYTES('MD5', <key> + ''), 1, 7))`. The 7-byte
slice keeps the result within signed BIGINT range — 8 bytes can produce the
most-negative value which then overflows on `SUM` aggregation. Still
occasionally overflows on extreme tests; if we need a real fix, mask with
`& 0x7FFFFFFFFFFFFFFF` or split SUM into two halves.

## Known limitations and remaining work (112 failures)

Roughly:

| Count | Class | Notes |
|------:|-------|-------|
| ~50 | Data diffs | Mostly time-edge cases (DST boundaries, week truncation), some join-result ordering, a few rounding diffs. Need per-test investigation. |
| 12 | Boolean predicate as value, deeper paths | T-SQL rejects predicates as values inside non-boundary contexts (e.g. `concat('x', true)` → `CONCAT('x', (1=1))`). Fixing this requires unifying the filter-compiler / expression-compiler emission story (see commit 40c1136 message). |
| 6 | Multi-part identifier `base.X` | Inner-stage column references leaking into outer SELECT scope, surfaces in `row_number works inside nest` and similar nested-window-function tests. Pre-existed the NULLS LAST work. |
| 6 | HASHBYTES bigint overflow | Symmetric aggregate hash key, see above. |
| ~10 | Misc T-SQL quirks | `NULLIF(NULL, ...)`, `COALESCE(NULL, NULL, ...)`, `Multiple ordered aggregate functions ... incompatible orderings`, `No column name was specified for column 1`, etc. — single instances per test. |
| 4 | DATEDIFF overflow | Second/millisecond units on big timestamp ranges. Switch to `DATEDIFF_BIG` in more places (already used in `sqlMeasureTimeExpr`; `sqlTruncate`/related still use `DATEDIFF`). |
| 2 | Multi-stage STRING_AGG with incompatible orderings | Two `WITHIN GROUP (ORDER BY ...)` clauses in the same scope have different keys; T-SQL rejects. |

For deeper recovery, the **single biggest leverage point** is making the
boolean predicate-vs-value story consistent across the filter compiler and
expression compiler. Today the SELECT-list `generateValueExpression()` wrap
covers most cases but leaks for things like `concat(x, true)`,
`JSON_OBJECT('k': complex_bool_expr)`, etc.

## How to extend the dialect safely

- Don't add `Dialect.<flag>` defaults that change existing dialects' behavior
  — make them opt-in. Existing flags I added: `groupByExpression`,
  `boolPredicatesNotValues`, `nullsLastWantsFlag`. All default to false.
- Don't auto-parse JSON in `MSSQLConnection.runRawSQL` — that was tried and
  silently broke NVARCHAR columns containing JSON-looking text. Schema-aware
  parsing in `api/util.ts:mapValue` is the right layer.
- Don't try to make boolean operators always emit BIT — see the cross-cutting
  notes above.
- When you change `sqlOrderBy`, double-check the `query` vs `turtle` /
  `analytical` distinction. OFFSET only goes on top-level/CTE ORDER BYs;
  `WITHIN GROUP` ORDER BYs must NOT have OFFSET.
- The T-SQL container takes `Server=host,port` not `Port=...` for the DuckDB
  MSSQL extension; for the native `mssql` driver it's `server` + `port`. They
  are not interchangeable.

## Files to look at when something breaks

- `packages/malloy/src/dialect/mssql/mssql.ts` — main dialect, most T-SQL idioms
- `packages/malloy/src/dialect/mssql/function_overrides.ts` — function shims
- `packages/malloy/src/dialect/mssql/dialect_functions.ts` — dialect-specific functions
- `packages/malloy-db-mssql/src/mssql_connection.ts` — connection, schema fetch (incl. JSON probe)
- `packages/malloy/src/model/query_query.ts` — emits the actual SQL; touched for
  GROUP BY (expression vs ordinal), ORDER BY (NULLS LAST flag), LIMIT, ON conditions
- `packages/malloy/src/model/expression_compiler.ts` — boolean literal emission,
  comparison/CASE BIT-wrapping
- `packages/malloy/src/dialect/dialect.ts` — base Dialect class with the new flags
- `packages/malloy/src/api/util.ts` — schema-aware JSON parsing on read
- `test/mssql/mssql_start.sh` — container fixture and data load

## Smoke test script

`/tmp/smoke.ts` (last used to verify basic .malloy compilation) — feel free to
delete or move into the repo if you want a checked-in example. The contents
were:

```ts
import {SingleConnectionRuntime} from '@malloydata/malloy';
import {MSSQLConnection} from '@malloydata/db-mssql';

const conn = new MSSQLConnection('mssql', {
  server: 'localhost',
  port: 11433,
  user: 'sa',
  password: 'Malloy_Test_123',
  database: 'malloytest',
  encrypt: false,
  trustServerCertificate: true,
});
const rt = new SingleConnectionRuntime({connection: conn});
const result = await rt.loadQuery(`
  source: airports is mssql.table('malloytest.airports') extend {
    measure: airport_count is count()
    measure: avg_elev is elevation.avg()
  }
  run: airports -> {
    where: state ? 'CA' | 'NY' | 'TX'
    group_by: state
    aggregate: airport_count, avg_elev
    order_by: airport_count desc
    limit: 5
  }
`).run();
```

## Memory aid: where I keep getting confused

- Don't conflate `mssql_via_duckdb` with `mssql`. The former runs malloytest
  through the DuckDB → MSSQL extension and is largely abandoned; the native
  `mssql` adapter is what we're building. Both still exist in `runtimes.ts`.
- `MALLOY_DATABASE=mssql` and the `db-mssql` jest project are the things to
  run. `db-all` is the shared cross-dialect suite that gets exercised by
  whatever `MALLOY_DATABASE` is set.
- T-SQL ORDER BY *inside aggregate WITHIN GROUP* is different from query-level
  ORDER BY — the former forbids OFFSET. `sqlOrderBy(_, orderFor)` distinguishes.
- "Aliases inside CASE in ORDER BY" don't bind in T-SQL even for simple
  renames. Don't try this again.
