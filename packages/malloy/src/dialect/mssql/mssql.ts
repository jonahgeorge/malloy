/*
 * Copyright 2026 Light Labs.
 *
 * Licensed under the MIT license. See LICENSE in the project root.
 *
 * Microsoft SQL Server (T-SQL) dialect for Malloy.
 *
 * Implements simple SELECT generation, type mapping, time math, casting,
 * sampling, identifier quoting, and JSON-based nesting via JSON_OBJECT /
 * STRING_AGG / OPENJSON. Requires SQL Server 2022+ for JSON_OBJECT and
 * JSON_ARRAY; older versions would need a `FOR JSON PATH` rewrite.
 */

import type {
  Sampling,
  MeasureTimeExpr,
  RegexMatchExpr,
  TimeExtractExpr,
  TypecastExpr,
  BasicAtomicTypeDef,
  AtomicTypeDef,
  TimestampTypeDef,
  ArrayLiteralNode,
  RecordLiteralNode,
} from '../../model/malloy_types';
import {
  isSamplingEnable,
  isSamplingRows,
  isSamplingPercent,
  TD,
} from '../../model/malloy_types';
import type {
  BooleanTypeSupport,
  CompiledOrderBy,
  DialectFieldList,
  FieldReferenceType,
  OrderByClauseType,
  QueryInfo,
} from '../dialect';
import {Dialect, qtz} from '../dialect';
import type {DialectFunctionOverloadDef} from '../functions';
import {expandBlueprintMap, expandOverrideMap} from '../functions';
import {MSSQL_DIALECT_FUNCTIONS} from './dialect_functions';
import {MSSQL_MALLOY_STANDARD_OVERLOADS} from './function_overrides';

// DATEPART unit names for T-SQL. Malloy passes lowercase units like
// 'day_of_week', 'day_of_year', etc.
const datePartMap: Record<string, string> = {
  day_of_week: 'weekday',
  day_of_year: 'dayofyear',
};

// T-SQL's AT TIME ZONE accepts only Windows zone names. Map a small set of
// IANA zones used by Malloy tests; unknown zones pass through unchanged so
// failures surface as T-SQL errors rather than silent corruption.
const ianaToWindowsTz: Record<string, string> = {
  'UTC': 'UTC',
  'America/Los_Angeles': 'Pacific Standard Time',
  'America/Denver': 'Mountain Standard Time',
  'America/Chicago': 'Central Standard Time',
  'America/New_York': 'Eastern Standard Time',
  'America/Mexico_City': 'Central Standard Time (Mexico)',
  'Europe/London': 'GMT Standard Time',
  'Europe/Paris': 'Romance Standard Time',
  'Europe/Berlin': 'W. Europe Standard Time',
  'Asia/Tokyo': 'Tokyo Standard Time',
  'Asia/Shanghai': 'China Standard Time',
  'Asia/Kolkata': 'India Standard Time',
  'Australia/Sydney': 'AUS Eastern Standard Time',
};

function tsqlZone(tz: string): string {
  return ianaToWindowsTz[tz] ?? tz;
}

const mssqlToMalloyTypes: {[key: string]: BasicAtomicTypeDef} = {
  'bit': {type: 'boolean'},
  'tinyint': {type: 'number', numberType: 'integer'},
  'smallint': {type: 'number', numberType: 'integer'},
  'int': {type: 'number', numberType: 'integer'},
  'bigint': {type: 'number', numberType: 'bigint'},
  'real': {type: 'number', numberType: 'float'},
  'float': {type: 'number', numberType: 'float'},
  'decimal': {type: 'number', numberType: 'float'},
  'numeric': {type: 'number', numberType: 'float'},
  'money': {type: 'number', numberType: 'float'},
  'smallmoney': {type: 'number', numberType: 'float'},
  'char': {type: 'string'},
  'varchar': {type: 'string'},
  'text': {type: 'string'},
  'nchar': {type: 'string'},
  'nvarchar': {type: 'string'},
  'ntext': {type: 'string'},
  'uniqueidentifier': {type: 'string'},
  'date': {type: 'date'},
  'datetime': {type: 'timestamp'},
  'datetime2': {type: 'timestamp'},
  'smalldatetime': {type: 'timestamp'},
  'datetimeoffset': {type: 'timestamp'},
  'time': {type: 'string'},
};

export class MSSQLDialect extends Dialect {
  name = 'mssql';
  defaultNumberType = 'FLOAT';
  defaultDecimalType = 'DECIMAL';
  udfPrefix = 'dbo.__udf';
  hasFinalStage = false;
  stringTypeName = 'NVARCHAR(MAX)';
  divisionIsInteger = true;
  supportsSumDistinctFunction = false;
  unnestWithNumbers = false;
  defaultSampling = {rows: 50000};
  supportsAggDistinct = false;
  supportsCTEinCoorelatedSubQueries = true;
  supportsSafeCast = true; // T-SQL has TRY_CAST
  dontUnionIndex = false;
  supportsQualify = false;
  supportsNesting = true;
  supportUnnestArrayAgg = true;
  experimental = false;
  supportsFullJoin = true;
  supportsPipelinesInViews = false;
  readsNestedData = false;
  supportsComplexFilteredSources = false;
  supportsArraysInData = true;
  compoundObjectInSchema = false;
  booleanType: BooleanTypeSupport = 'simulated'; // T-SQL has BIT, not BOOLEAN
  // T-SQL accepts ordinals or output-column aliases in ORDER BY but NOT
  // arbitrary aggregate expressions referencing inner-stage `base.*` columns.
  // Use ordinal references so multi-stage queries don't bind back into
  // already-collapsed CTEs.
  orderByClause: OrderByClauseType = 'ordinal';
  groupByExpression = true;
  boolPredicatesNotValues = true;

  // T-SQL has no LIMIT. The full pagination clause is
  // `ORDER BY ... OFFSET 0 ROWS FETCH NEXT n ROWS ONLY`. `sqlOrderBy` for
  // query-context already appends `OFFSET 0 ROWS`, so when hasOrderBy is
  // true we only need FETCH; when false we synthesize the whole tail.
  sqlLimit(limit: number, hasOrderBy: boolean): string {
    if (hasOrderBy) {
      return `FETCH NEXT ${limit} ROWS ONLY`;
    }
    return `ORDER BY (SELECT NULL) OFFSET 0 ROWS FETCH NEXT ${limit} ROWS ONLY`;
  }

  // Top-level/CTE ORDER BY in T-SQL is illegal in subqueries unless followed
  // by OFFSET/FETCH; appending `OFFSET 0 ROWS` makes it legal everywhere
  // sqlOrderBy is used as a query clause. ORDER BY *inside* aggregate
  // expressions (turtle/analytical/WITHIN GROUP) must NOT have OFFSET.
  sqlOrderBy(
    orderTerms: string[],
    orderFor?: import('../dialect').OrderByRequest
  ): string {
    const tail = orderFor === 'query' ? ' OFFSET 0 ROWS' : '';
    return `ORDER BY ${orderTerms.join(', ')}${tail}`;
  }
  maxIdentifierLength = 128;

  malloyTypeToSQLType(malloyType: AtomicTypeDef): string {
    switch (malloyType.type) {
      case 'number':
        if (malloyType.numberType === 'integer') return 'INT';
        if (malloyType.numberType === 'bigint') return 'BIGINT';
        return 'FLOAT';
      case 'string':
        return 'NVARCHAR(MAX)';
      case 'boolean':
        return 'BIT';
      case 'timestamp':
        return 'DATETIME2';
      case 'date':
        return 'DATE';
      default:
        return malloyType.type;
    }
  }

  sqlTypeToMalloyType(sqlType: string): BasicAtomicTypeDef {
    const baseSqlType = sqlType.match(/^(\w+)/)?.at(0) ?? sqlType;
    return (
      mssqlToMalloyTypes[baseSqlType.toLowerCase()] || {
        type: 'sql native',
        rawType: baseSqlType,
      }
    );
  }

  quoteTablePath(tablePath: string): string {
    return tablePath
      .split('.')
      .map(part => this.sqlMaybeQuoteIdentifier(part))
      .join('.');
  }

  sqlMaybeQuoteIdentifier(identifier: string): string {
    return '[' + identifier.replace(/]/g, ']]') + ']';
  }

  // T-SQL doesn't recognize `true`/`false` keywords. Emit a predicate form
  // (1=1 / 1=0) — works in WHERE, HAVING, CASE WHEN, and ON. SELECT-list
  // contexts that need a value wrap separately via `sqlBoolValueOf`.
  sqlBoolean(bv: boolean): string {
    return bv ? '(1=1)' : '(1=0)';
  }

  // Predicate → BIT value (e.g. for SELECT lists, JSON values).
  sqlBoolValueOf(predicate: string): string {
    return `IIF(${predicate}, CAST(1 AS BIT), CAST(0 AS BIT))`;
  }

  // BIT value → T-SQL predicate (e.g. for WHERE/HAVING). `<> 0` accepts BIT,
  // INT, and any numeric so it tolerates incidental non-BIT booleans.
  sqlBoolPredicateOf(value: string): string {
    return `(${value}) <> 0`;
  }

  resultBoolean(bv: boolean) {
    return bv ? 1 : 0;
  }

  // T-SQL: build a virtual table of group_set values via VALUES list.
  // We avoid using `group_set` as the table alias too — when SELECT * pulls
  // the column up through CTEs, T-SQL reports binding errors against
  // `group_set.group_set` in outer aggregates.
  sqlGroupSetTable(groupSetCount: number): string {
    const values: string[] = [];
    for (let i = 0; i <= groupSetCount; i++) {
      values.push(`(${i})`);
    }
    return `CROSS JOIN (VALUES ${values.join(', ')}) AS __gs(group_set)`;
  }

  sqlAnyValue(_groupSet: number, fieldName: string): string {
    return `MAX(${fieldName})`;
  }

  // Build the `'key':value` pair list for a JSON_OBJECT call. For null-valued
  // skeleton objects we emit literal NULLs.
  private mapFieldsForJsonObject(
    fieldList: DialectFieldList,
    nullValues = false
  ): string {
    return fieldList
      .map(
        f =>
          `${this.sqlLiteralString(f.sqlOutputName.replace(/[`[\]]/g, ''))}:${
            nullValues ? 'NULL' : f.sqlExpression
          }`
      )
      .join(', ');
  }

  sqlAggregateTurtle(
    groupSet: number,
    fieldList: DialectFieldList,
    orderBy: CompiledOrderBy[] | undefined
  ): string {
    const obj = `JSON_OBJECT(${this.mapFieldsForJsonObject(fieldList)})`;
    // T-SQL: STRING_AGG ignores NULLs by default — perfect for the IIF gate.
    // Ordering for STRING_AGG uses WITHIN GROUP (ORDER BY ...), not inline.
    let agg = `STRING_AGG(IIF(group_set=${groupSet}, ${obj}, NULL), ',')`;
    if (orderBy) {
      const terms = orderBy
        .map(o => `${o.field} ${o.dir.toUpperCase()}`)
        .join(', ');
      agg += ` WITHIN GROUP (ORDER BY ${terms})`;
    }
    // Wrap as a JSON array string. COALESCE handles the empty-group case.
    return `COALESCE('[' + ${agg} + ']', '[]')`;
  }

  sqlAnyValueTurtle(groupSet: number, fieldList: DialectFieldList): string {
    const fields = this.mapFieldsForJsonObject(fieldList);
    return `MAX(CASE WHEN group_set=${groupSet} THEN JSON_OBJECT(${fields}) END)`;
  }

  sqlAnyValueLastTurtle(
    name: string,
    groupSet: number,
    sqlName: string
  ): string {
    return `MAX(CASE WHEN group_set=${groupSet} AND ${name} IS NOT NULL THEN ${name} END) as ${sqlName}`;
  }

  sqlCoaleseMeasuresInline(
    groupSet: number,
    fieldList: DialectFieldList
  ): string {
    const fields = this.mapFieldsForJsonObject(fieldList);
    const nullValues = this.mapFieldsForJsonObject(fieldList, true);
    return `COALESCE(MAX(CASE WHEN group_set=${groupSet} THEN JSON_OBJECT(${fields}) END), JSON_OBJECT(${nullValues}))`;
  }

  // OPENJSON's WITH clause column-spec: `[name] type '$.path' [AS JSON]`.
  private unnestColumns(fieldList: DialectFieldList): string {
    return fieldList
      .map(f => {
        const isJson = f.typeDef.type === 'array' || f.typeDef.type === 'record';
        const tsqlType = isJson
          ? 'NVARCHAR(MAX)'
          : this.malloyTypeToSQLType(f.typeDef);
        const asJson = isJson ? ' AS JSON' : '';
        return `${this.sqlMaybeQuoteIdentifier(f.sqlOutputName)} ${tsqlType} '$.${
          f.rawName
        }'${asJson}`;
      })
      .join(', ');
  }

  // Produces a derived-table expression that exposes __row_id + columns.
  // Two shapes:
  //   - singleton (array of scalars): one [value] column carrying the element.
  //   - object array: each named column extracted via OPENJSON WITH.
  private jsonTable(
    source: string,
    fieldList: DialectFieldList,
    isSingleton: boolean
  ): string {
    if (isSingleton) {
      return `(SELECT CAST(arr.[key] AS INT) AS __row_id, arr.[value] AS [value] FROM OPENJSON(${source}) AS arr)`;
    }
    const cols = this.unnestColumns(fieldList);
    // OPENJSON WITH doesn't expose the array index, so we get it from an outer
    // OPENJSON pass and CROSS APPLY into the per-element WITH-shaped one.
    return `(SELECT CAST(arr.[key] AS INT) AS __row_id, fields.* FROM OPENJSON(${source}) AS arr CROSS APPLY OPENJSON(arr.[value]) WITH (${cols}) AS fields)`;
  }

  sqlUnnestAlias(
    source: string,
    alias: string,
    fieldList: DialectFieldList,
    _needDistinctKey: boolean,
    isArray: boolean,
    _isInNestedPipeline: boolean
  ): string {
    // T-SQL has no `LEFT JOIN <derived> ON 1=1` for correlated table fns;
    // OUTER APPLY is the proper construct (preserves outer rows on null/empty).
    return `OUTER APPLY ${this.jsonTable(source, fieldList, isArray)} AS ${alias}`;
  }

  sqlUnnestPipelineHead(
    isSingleton: boolean,
    sourceSQLExpression: string,
    fieldList: DialectFieldList
  ): string {
    return this.jsonTable(sourceSQLExpression, fieldList, isSingleton);
  }

  // Maps an arbitrary distinct key to a stable BIGINT for the SUM(DISTINCT)
  // symmetric-aggregate trick. HASHBYTES('MD5', ...) returns 16 bytes; we take
  // the first 8 bytes and convert to a signed 64-bit int.
  sqlSumDistinctHashedKey(sqlDistinctKey: string): string {
    // Take the first 7 bytes of the MD5 to fit comfortably within signed
    // BIGINT range (8 bytes can produce the most-negative value, which
    // overflows on SUM aggregation).
    return `CONVERT(BIGINT, SUBSTRING(HASHBYTES('MD5', CAST(${sqlDistinctKey} AS NVARCHAR(MAX)) + ''), 1, 7))`;
  }

  sqlGenerateUUID(): string {
    return 'CONVERT(NVARCHAR(36), NEWID())';
  }

  sqlFieldReference(
    parentAlias: string,
    parentType: FieldReferenceType,
    childName: string,
    childType: string
  ): string {
    if (parentType === 'array[scalar]') {
      // jsonTable's singleton form exposes a single [value] column.
      return this.castJsonScalar(`${parentAlias}.[value]`, childType);
    }
    if (parentType === 'record') {
      // Parent is a JSON object literal/string; extract by path.
      if (childType === 'record' || childType === 'array') {
        return `JSON_QUERY(${parentAlias}, '$.${childName}')`;
      }
      const raw = `JSON_VALUE(${parentAlias}, '$.${childName}')`;
      return this.castJsonScalar(raw, childType);
    }
    return `${parentAlias}.${this.sqlMaybeQuoteIdentifier(childName)}`;
  }

  // JSON_VALUE / OPENJSON [value] return NVARCHAR; cast to the target type
  // so downstream arithmetic and comparisons behave as expected.
  private castJsonScalar(expr: string, childType: string): string {
    switch (childType) {
      case 'number':
        return `CAST(${expr} AS FLOAT)`;
      case 'boolean':
        return `CAST(${expr} AS BIT)`;
      case 'date':
        return `CAST(${expr} AS DATE)`;
      case 'timestamp':
        return `CAST(${expr} AS DATETIME2)`;
      case 'string':
        return expr;
      default:
        return expr;
    }
  }

  sqlCreateFunction(_id: string, _funcText: string): string {
    throw new Error('MSSQL CREATE FUNCTION is not implemented.');
  }

  sqlCreateFunctionCombineLastStage(_lastStageName: string): string {
    throw new Error('MSSQL CREATE FUNCTION is not implemented.');
  }

  sqlSelectAliasAsStruct(_alias: string, _fieldList: DialectFieldList): string {
    throw new Error('MSSQL select alias as struct is not implemented.');
  }

  sqlCreateTableAsSelect(tableName: string, sql: string): string {
    // T-SQL pattern: SELECT ... INTO target FROM (subquery) src
    return `SELECT * INTO ${tableName} FROM (${sql}) AS src`;
  }

  sqlNowExpr(): string {
    return 'SYSUTCDATETIME()';
  }

  sqlConvertToCivilTime(
    expr: string,
    timezone: string,
    _typeDef: AtomicTypeDef
  ): {sql: string; typeDef: AtomicTypeDef} {
    // AT TIME ZONE produces a DATETIMEOFFSET; cast back to DATETIME2 to drop tz.
    return {
      sql: `CAST((${expr}) AT TIME ZONE 'UTC' AT TIME ZONE '${tsqlZone(timezone)}' AS DATETIME2)`,
      typeDef: {type: 'timestamp'},
    };
  }

  sqlConvertFromCivilTime(
    expr: string,
    timezone: string,
    _destTypeDef: TimestampTypeDef
  ): string {
    return `CAST((${expr}) AT TIME ZONE '${tsqlZone(timezone)}' AT TIME ZONE 'UTC' AS DATETIME2)`;
  }

  sqlTruncate(
    expr: string,
    unit: string,
    _typeDef: AtomicTypeDef,
    _inCivilTime: boolean,
    _timezone?: string
  ): string {
    // SQL Server 2022+ has DATETRUNC. For broader compat, use DATEADD/DATEDIFF.
    const tsqlUnit = (() => {
      switch (unit) {
        case 'second':
          return 'second';
        case 'minute':
          return 'minute';
        case 'hour':
          return 'hour';
        case 'day':
          return 'day';
        case 'week':
          return 'week';
        case 'month':
          return 'month';
        case 'quarter':
          return 'quarter';
        case 'year':
          return 'year';
        default:
          throw new Error(`MSSQL truncate: unsupported unit ${unit}`);
      }
    })();
    // DATEADD(unit, DATEDIFF(unit, anchor, expr), anchor) truncates to the
    // start of the unit. T-SQL forbids implicit int->datetime2 cast, so we use
    // an explicit anchor string instead of 0.
    const anchor = "CAST('1900-01-01' AS DATETIME2)";
    return `DATEADD(${tsqlUnit}, DATEDIFF(${tsqlUnit}, ${anchor}, ${expr}), ${anchor})`;
  }

  sqlOffsetTime(
    expr: string,
    op: '+' | '-',
    magnitude: string,
    unit: string,
    _typeDef: AtomicTypeDef,
    _inCivilTime: boolean,
    _timezone?: string
  ): string {
    const signedMag = op === '-' ? `-(${magnitude})` : magnitude;
    return `DATEADD(${unit}, ${signedMag}, ${expr})`;
  }

  sqlTimeExtractExpr(qi: QueryInfo, te: TimeExtractExpr): string {
    const tsqlUnit = datePartMap[te.units] ?? te.units;
    let extractFrom = te.e.sql;
    if (TD.isTimestamp(te.e.typeDef)) {
      const tz = qtz(qi);
      if (tz) {
        extractFrom = `CAST((${extractFrom}) AT TIME ZONE 'UTC' AT TIME ZONE '${tsqlZone(tz)}' AS DATETIME2)`;
      }
    }
    return `DATEPART(${tsqlUnit}, ${extractFrom})`;
  }

  sqlCast(qi: QueryInfo, cast: TypecastExpr): string {
    const srcSQL = cast.e.sql || 'internal-error-in-sql-generation';
    const {op, srcTypeDef, dstTypeDef, dstSQLType} = this.sqlCastPrep(cast);
    const tz = qtz(qi);
    if (op === 'timestamp::date' && tz) {
      return `CAST(CAST((${srcSQL}) AT TIME ZONE 'UTC' AT TIME ZONE '${tsqlZone(tz)}' AS DATETIME2) AS DATE)`;
    }
    if (op === 'date::timestamp' && tz) {
      return `CAST((${srcSQL}) AT TIME ZONE '${tsqlZone(tz)}' AT TIME ZONE 'UTC' AS DATETIME2)`;
    }
    if (!TD.eq(srcTypeDef, dstTypeDef)) {
      const fn = cast.safe ? 'TRY_CAST' : 'CAST';
      return `${fn}(${srcSQL} AS ${dstSQLType})`;
    }
    return srcSQL;
  }

  sqlRegexpMatch(_df: RegexMatchExpr): string {
    // T-SQL has no native regex. SQL Server 2025 introduces REGEXP_LIKE; until
    // then users must rely on LIKE. Throw for now to surface clearly.
    throw new Error('MSSQL dialect does not support regexp matching.');
  }

  sqlDateLiteral(_qi: QueryInfo, literal: string): string {
    return `CAST('${literal}' AS DATE)`;
  }

  sqlTimestampLiteral(
    qi: QueryInfo,
    literal: string,
    timezone: string | undefined
  ): string {
    const tz = timezone || qtz(qi);
    if (tz) {
      return `CAST(CAST('${literal}' AS DATETIME2) AT TIME ZONE '${tsqlZone(tz)}' AT TIME ZONE 'UTC' AS DATETIME2)`;
    }
    return `CAST('${literal}' AS DATETIME2)`;
  }

  sqlTimestamptzLiteral(
    _qi: QueryInfo,
    literal: string,
    timezone: string
  ): string {
    return `CAST('${literal}' AS DATETIME2) AT TIME ZONE '${tsqlZone(timezone)}'`;
  }

  sqlMeasureTimeExpr(df: MeasureTimeExpr): string {
    const lVal = df.kids.left.sql;
    const rVal = df.kids.right.sql;
    // DATEDIFF_BIG returns BIGINT and supports second/minute/hour/day/etc.
    return `DATEDIFF_BIG(${df.units}, ${lVal}, ${rVal})`;
  }

  sqlAggDistinct(
    _key: string,
    _values: string[],
    _func: (valNames: string[]) => string
  ): string {
    throw new Error('MSSQL dialect does not support nested AGG DISTINCT.');
  }

  sqlSampleTable(tableSQL: string, sample: Sampling | undefined): string {
    if (sample !== undefined) {
      if (isSamplingEnable(sample) && sample.enable) {
        sample = this.defaultSampling;
      }
      if (isSamplingRows(sample)) {
        return `(SELECT TOP ${sample.rows} * FROM ${tableSQL} ORDER BY NEWID())`;
      } else if (isSamplingPercent(sample)) {
        return `(SELECT * FROM ${tableSQL} TABLESAMPLE (${sample.percent} PERCENT))`;
      }
    }
    return tableSQL;
  }

  sqlLiteralString(literal: string): string {
    // N'...' for unicode-safe string literals; '' escapes single quotes.
    return "N'" + literal.replace(/'/g, "''") + "'";
  }

  sqlLiteralRegexp(literal: string): string {
    return "'" + literal.replace(/'/g, "''") + "'";
  }

  getDialectFunctionOverrides(): {
    [name: string]: DialectFunctionOverloadDef[];
  } {
    return expandOverrideMap(MSSQL_MALLOY_STANDARD_OVERLOADS);
  }

  getDialectFunctions(): {[name: string]: DialectFunctionOverloadDef[]} {
    return expandBlueprintMap(MSSQL_DIALECT_FUNCTIONS);
  }

  castToString(expression: string): string {
    return `CAST(${expression} AS NVARCHAR(MAX))`;
  }

  concat(...values: string[]): string {
    return `CONCAT(${values.join(', ')})`;
  }

  validateTypeName(sqlType: string): boolean {
    return sqlType.match(/^[A-Za-z\s(),0-9]*$/) !== null;
  }

  // T-SQL 2022+: JSON_ARRAY and JSON_OBJECT produce JSON strings directly.
  sqlLiteralArray(lit: ArrayLiteralNode): string {
    const vals = lit.kids.values.map(v => v.sql).join(', ');
    return `JSON_ARRAY(${vals})`;
  }

  sqlLiteralRecord(lit: RecordLiteralNode): string {
    const pairs = Object.entries(lit.kids).map(
      ([propName, propVal]) =>
        `${this.sqlLiteralString(propName)}:${propVal.sql}`
    );
    return `JSON_OBJECT(${pairs.join(', ')})`;
  }
}
