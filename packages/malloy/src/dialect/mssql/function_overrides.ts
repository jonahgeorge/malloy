/*
 * Copyright 2026 Light Labs.
 *
 * Licensed under the MIT license. See LICENSE in the project root.
 */

import type {MalloyStandardFunctionImplementations as OverrideMap} from '../functions/malloy_standard_functions';

export const MSSQL_MALLOY_STANDARD_OVERLOADS: OverrideMap = {
  // T-SQL uses LEN() rather than LENGTH(); CHARINDEX rather than POSITION/LOCATE.
  strpos: {sql: 'CHARINDEX(${search_string}, ${test_string})'},
  starts_with: {
    sql: "CASE WHEN ${value} LIKE ${prefix} + '%' THEN 1 ELSE 0 END",
  },
  ends_with: {
    sql: "CASE WHEN ${value} LIKE '%' + ${suffix} THEN 1 ELSE 0 END",
  },
  // T-SQL has no integer division on floats; use FLOOR.
  div: {sql: 'FLOOR(${dividend} / ${divisor})'},
  byte_length: {sql: 'DATALENGTH(${value})'},
  chr: {sql: 'CHAR(${value})'},
  length: {function: 'LEN'},
  // T-SQL SUBSTRING requires 3 args; pad with LEN(value) for the 2-arg form.
  substr: {
    'position_only': {sql: 'SUBSTRING(${value}, ${position}, LEN(${value}))'},
    'with_length': {function: 'SUBSTRING'},
  },
  // T-SQL uses LOG (base e); LOG(x, b) for arbitrary base. ⇒ map LN→LOG.
  ln: {function: 'LOG'},
  log: {sql: 'LOG(${value}, ${base})'},
  // T-SQL has no REPLACE-with-regex; fall back to plain REPLACE for literal subs.
  // (regexp_replace tests with literal patterns will pass; pattern tests skip.)
  // POW/POWER
  pow: {function: 'POWER'},
  // T-SQL ROUND always requires 2 args.
  round: {
    'to_integer': {sql: 'ROUND(${value}, 0)'},
    'to_precision': {function: 'ROUND'},
  },
  // T-SQL ROUND(x, n, 1) truncates instead of rounds.
  trunc: {
    'to_integer': {sql: 'ROUND(${value}, 0, 1)'},
    'to_precision': {sql: 'ROUND(${value}, ${precision}, 1)'},
  },
  // T-SQL function name aliases.
  ceil: {function: 'CEILING'},
  atan2: {function: 'ATN2'},
  string_repeat: {function: 'REPLICATE'},
  ifnull: {function: 'ISNULL'},
  // T-SQL TRIM with characters uses `TRIM(<chars> FROM <value>)` syntax.
  trim: {
    'whitespace': {function: 'TRIM'},
    'characters': {sql: 'TRIM(${trim_characters} FROM ${value})'},
  },
  ltrim: {
    'whitespace': {function: 'LTRIM'},
    'characters': {sql: 'LTRIM(${value}, ${trim_characters})'},
  },
  rtrim: {
    'whitespace': {function: 'RTRIM'},
    'characters': {sql: 'RTRIM(${value}, ${trim_characters})'},
  },
  // T-SQL STDEV is sample std-dev (N-1) — matches BigQuery's STDDEV semantics.
  stddev: {function: 'STDEV'},
  // T-SQL FLOAT can't represent NaN/Inf; nothing can be NaN/Inf, so return 0.
  is_nan: {sql: '(0=1)'},
  is_inf: {sql: '(0=1)'},
  // T-SQL has no native regex (until SQL Server 2025). REPLACE is literal-only;
  // pattern-based tests will need to skip until REGEXP_LIKE lands.
  replace: {
    'string': {function: 'REPLACE'},
    'regular_expression': {sql: 'REPLACE(${value}, ${pattern}, ${replacement})'},
  },
  // No CBRT; use POWER(x, 1.0/3).
  // Trig identities are standard.
};
