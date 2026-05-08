/*
 * Copyright 2026 Light Labs.
 *
 * Licensed under the MIT license. See LICENSE in the project root.
 *
 * Microsoft SQL Server connection for Malloy. Uses the `mssql` npm package
 * (which wraps `tedious` — pure JS, no native deps).
 *
 * MVP scope: connect, run a SELECT, fetch table/select schema. Persistence,
 * streaming, and cost estimation are stubbed.
 */

import type {
  AtomicTypeDef,
  AtomicFieldDef,
  Connection,
  FieldDef,
  MalloyQueryData,
  PersistSQLResults,
  PooledConnection,
  QueryRunStats,
  RunSQLOptions,
  StreamingConnection,
  StructDef,
  QueryOptionsReader,
  QueryData,
  SQLSourceDef,
  TableSourceDef,
  SQLSourceRequest,
} from '@malloydata/malloy';
import {
  MSSQLDialect,
  mkFieldDef,
  sqlKey,
  makeDigest,
} from '@malloydata/malloy';
import {BaseConnection} from '@malloydata/malloy/connection';
import * as MSSQL from 'mssql';

export interface MSSQLConfiguration {
  server?: string;
  port?: number;
  database?: string;
  user?: string;
  password?: string;
  /** When true, uses encrypted TLS connection (default: true). */
  encrypt?: boolean;
  /** Skip server cert validation — handy for local dev. */
  trustServerCertificate?: boolean;
  /** Optional T-SQL to run when the connection is established. */
  setupSQL?: string;
}

export class MSSQLExecutor {
  public static getConnectionOptionsFromEnv(): MSSQLConfiguration {
    const user = process.env['MSSQL_USER'];
    if (user) {
      return {
        server: process.env['MSSQL_SERVER'] ?? process.env['MSSQL_HOST'],
        port: process.env['MSSQL_PORT']
          ? Number(process.env['MSSQL_PORT'])
          : undefined,
        user,
        password: process.env['MSSQL_PASSWORD'],
        database: process.env['MSSQL_DATABASE'],
        encrypt: process.env['MSSQL_ENCRYPT'] !== 'false',
        trustServerCertificate:
          process.env['MSSQL_TRUST_SERVER_CERT'] === 'true',
      };
    }
    return {};
  }
}

export class MSSQLConnection
  extends BaseConnection
  implements Connection, PersistSQLResults
{
  private readonly dialect = new MSSQLDialect();
  private pool?: MSSQL.ConnectionPool;
  config: MSSQLConfiguration;
  queryOptions: QueryOptionsReader | undefined;
  public name: string;

  get dialectName(): string {
    return this.dialect.name;
  }

  constructor(
    name: string,
    config: MSSQLConfiguration,
    queryOptions?: QueryOptionsReader
  ) {
    super();
    this.config = config;
    this.queryOptions = queryOptions;
    this.name = name;
  }

  private async getPool(): Promise<MSSQL.ConnectionPool> {
    if (!this.pool) {
      const pool = new MSSQL.ConnectionPool({
        server: this.config.server ?? 'localhost',
        port: this.config.port ?? 1433,
        user: this.config.user,
        password: this.config.password,
        database: this.config.database,
        options: {
          encrypt: this.config.encrypt ?? true,
          trustServerCertificate: this.config.trustServerCertificate ?? false,
        },
      });
      await pool.connect();
      if (this.config.setupSQL) {
        await pool.request().batch(this.config.setupSQL);
      }
      this.pool = pool;
    }
    return this.pool;
  }

  async manifestTemporaryTable(sqlCommand: string): Promise<string> {
    const hash = makeDigest(sqlCommand);
    // T-SQL local temp tables start with `#` and are session-scoped.
    const tableName = `#tt${hash.slice(0, this.dialect.maxIdentifierLength - 3)}`;
    const cmd = `SELECT * INTO ${tableName} FROM (${sqlCommand}) AS src;`;
    await this.runRawSQL(cmd);
    return tableName;
  }

  public async test(): Promise<void> {
    await this.runRawSQL('SELECT 1 AS one');
  }

  runSQL(sql: string, _options?: RunSQLOptions): Promise<MalloyQueryData> {
    return this.runRawSQL(sql);
  }

  isPool(): this is PooledConnection {
    return false;
  }

  public getDigest(): string {
    const {server, port, user, database} = this.config;
    return makeDigest(
      'mssql',
      server,
      port !== undefined ? String(port) : undefined,
      user,
      database,
      this.config.setupSQL
    );
  }

  canPersist(): this is PersistSQLResults {
    return true;
  }

  canStream(): this is StreamingConnection {
    return false;
  }

  async close(): Promise<void> {
    if (this.pool) {
      await this.pool.close();
      this.pool = undefined;
    }
  }

  estimateQueryCost(_sqlCommand: string): Promise<QueryRunStats> {
    throw new Error('MSSQL: estimateQueryCost not implemented.');
  }

  async fetchTableSchema(
    tableName: string,
    tablePath: string
  ): Promise<TableSourceDef> {
    const structDef: TableSourceDef = {
      type: 'table',
      name: tableName,
      tablePath,
      dialect: this.dialectName,
      connection: this.name,
      fields: [],
    };

    // INFORMATION_SCHEMA.COLUMNS understands TABLE_SCHEMA.TABLE_NAME but not
    // bracket-quoted identifiers — pass the raw parts as parameters.
    const parts = tablePath.split('.');
    const [schema, table] =
      parts.length >= 2 ? [parts[0], parts.slice(1).join('.')] : ['dbo', parts[0]];

    const sql = `
      SELECT COLUMN_NAME AS name, DATA_TYPE AS data_type
      FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = ${this.dialect.sqlLiteralString(schema)}
        AND TABLE_NAME = ${this.dialect.sqlLiteralString(table)}
      ORDER BY ORDINAL_POSITION
    `;
    const result = await this.runRawSQL(sql);
    this.fillStructDefFromTypeMap(
      structDef,
      Object.fromEntries(
        result.rows.map(r => [r['name'] as string, r['data_type'] as string])
      )
    );
    return structDef;
  }

  async fetchSelectSchema(sqlRef: SQLSourceRequest): Promise<SQLSourceDef> {
    const structDef: SQLSourceDef = {
      type: 'sql_select',
      ...sqlRef,
      dialect: this.dialectName,
      fields: [],
      name: sqlKey(sqlRef.connection, sqlRef.selectStr),
    };

    // sp_describe_first_result_set returns column metadata without executing.
    const pool = await this.getPool();
    const result = await pool
      .request()
      .input('tsql', MSSQL.NVarChar(MSSQL.MAX), sqlRef.selectStr)
      .execute<{name: string; system_type_name: string}>(
        'sys.sp_describe_first_result_set'
      );

    // Build base atomic types from the description, then upgrade any
    // string-typed columns whose actual data is JSON to array/record types.
    const baseTypes = new Map<string, AtomicTypeDef>();
    const stringCols: string[] = [];
    for (const row of result.recordset) {
      const baseSqlType =
        row.system_type_name.toLowerCase().match(/^(\w+)/)?.[1] ?? '';
      const malloyType = this.dialect.sqlTypeToMalloyType(baseSqlType);
      baseTypes.set(row.name, malloyType);
      if (this.isStringSqlType(baseSqlType)) {
        stringCols.push(row.name);
      }
    }

    const inferredCompound = await this.inferJsonColumnTypes(
      sqlRef.selectStr,
      stringCols
    );

    for (const [name, atomicType] of baseTypes) {
      const compound = inferredCompound.get(name);
      const typeDef = compound ?? atomicType;
      structDef.fields.push(mkFieldDef(typeDef, name));
    }
    return structDef;
  }

  private isStringSqlType(t: string): boolean {
    return /^(n?varchar|n?char|n?text)$/.test(t);
  }

  /**
   * For each candidate string column, probe `ISJSON()` and the first
   * non-whitespace character of the value to decide whether the column
   * actually carries a JSON array or object. For columns that do, dive
   * into the structure with OPENJSON to build a Malloy ArrayTypeDef /
   * RecordTypeDef. T-SQL has no native compound types, so we synthesize
   * them from the data shape.
   */
  private async inferJsonColumnTypes(
    selectStr: string,
    stringCols: string[]
  ): Promise<Map<string, AtomicTypeDef>> {
    const out = new Map<string, AtomicTypeDef>();
    if (stringCols.length === 0) return out;
    const q = (n: string) => this.dialect.sqlMaybeQuoteIdentifier(n);

    // Probe 1: per-column shape detection in a single SELECT TOP 1.
    const shapeProbes = stringCols
      .map(
        c =>
          `CASE WHEN ISJSON(${q(c)})=1 THEN ` +
          `LEFT(LTRIM(CAST(${q(c)} AS NVARCHAR(MAX))), 1) END AS ${q(
            `__shape__${c}`
          )}`
      )
      .join(', ');
    const probeSQL = `SELECT TOP 1 ${shapeProbes} FROM (${selectStr}) AS __probe`;
    let shapeResult: MalloyQueryData;
    try {
      shapeResult = await this.runRawSQL(probeSQL);
    } catch {
      return out;
    }
    if (shapeResult.rows.length === 0) return out;
    const shapeRow = shapeResult.rows[0];

    for (const col of stringCols) {
      const shape = shapeRow[`__shape__${col}`];
      if (shape !== '[' && shape !== '{') continue;
      const inferred = await this.probeJsonStructure(
        selectStr,
        q(col),
        shape === '['
      );
      if (inferred) out.set(col, inferred);
    }
    return out;
  }

  /**
   * Recursively introspect a JSON-bearing column expression. `colExpr` is
   * a T-SQL expression that yields the JSON string (e.g. `[col]`, or
   * `JSON_QUERY([col], '$.address')` when descending into a record).
   */
  private async probeJsonStructure(
    selectStr: string,
    colExpr: string,
    isArray: boolean
  ): Promise<AtomicTypeDef | null> {
    // OPENJSON returns one row per top-level entry: key, value, type.
    // type: 0=null, 1=string, 2=number, 3=bool, 4=array, 5=object.
    const probeSQL = `
      SELECT [key], [type]
      FROM OPENJSON((SELECT TOP 1 ${colExpr} FROM (${selectStr}) AS __probe))
      ORDER BY (CASE WHEN ISNUMERIC([key])=1 THEN CAST([key] AS INT) ELSE 0 END)`;
    let result: MalloyQueryData;
    try {
      result = await this.runRawSQL(probeSQL);
    } catch {
      return null;
    }
    if (result.rows.length === 0) {
      // Empty array/object — default to array<string> / record with no fields.
      return isArray
        ? {type: 'array', elementTypeDef: {type: 'string'}}
        : {type: 'record', fields: []};
    }

    if (isArray) {
      // Take the first element's type as the array's element type.
      const first = result.rows.find(r => String(r['key']) === '0') ??
        result.rows[0];
      const t = Number(first['type']);
      const elemType = await this.openjsonTypeToMalloy(
        t,
        selectStr,
        `JSON_QUERY(${colExpr}, '$[0]')`,
        `JSON_VALUE(${colExpr}, '$[0]')`
      );
      // Repeated-record arrays use a different shape than scalar arrays.
      if (elemType.type === 'record') {
        return {
          type: 'array',
          elementTypeDef: {type: 'record_element'},
          fields: elemType.fields,
        };
      }
      return {type: 'array', elementTypeDef: elemType};
    }

    // Record: each key becomes a field.
    const fields: FieldDef[] = [];
    for (const row of result.rows) {
      const key = String(row['key']);
      const t = Number(row['type']);
      const fieldType = await this.openjsonTypeToMalloy(
        t,
        selectStr,
        `JSON_QUERY(${colExpr}, '$.${key}')`,
        `JSON_VALUE(${colExpr}, '$.${key}')`
      );
      fields.push(mkFieldDef(fieldType, key));
    }
    return {type: 'record', fields};
  }

  private async openjsonTypeToMalloy(
    t: number,
    selectStr: string,
    queryExpr: string, // for compound types — pulls out the JSON sub-tree
    _valueExpr: string // for scalars — pulls out the scalar text
  ): Promise<AtomicTypeDef> {
    switch (t) {
      case 1:
        return {type: 'string'};
      case 2:
        // OPENJSON doesn't distinguish int from float — default to number.
        return {type: 'number'};
      case 3:
        return {type: 'boolean'};
      case 4: {
        const nested = await this.probeJsonStructure(selectStr, queryExpr, true);
        return nested ?? {type: 'array', elementTypeDef: {type: 'string'}};
      }
      case 5: {
        const nested = await this.probeJsonStructure(selectStr, queryExpr, false);
        return nested ?? {type: 'record', fields: []};
      }
      default:
        return {type: 'string'};
    }
  }

  async runRawSQL(
    sql: string,
    _options?: RunSQLOptions
  ): Promise<MalloyQueryData> {
    const pool = await this.getPool();
    const result = await pool.request().query(sql);
    const rows = result.recordset as unknown as QueryData;
    // Nested aggregations come back as JSON strings (T-SQL has no JSON
    // type). The schema-aware mapper in `packages/malloy/src/api/util.ts`
    // parses them when the field type is array/record — so we leave string
    // values untouched here to avoid corrupting actual NVARCHAR columns
    // that happen to start with `[` or `{`.
    return {rows, totalRows: rows.length};
  }

  private fillStructDefFromTypeMap(
    structDef: StructDef,
    typeMap: {[name: string]: string}
  ) {
    for (const fieldName in typeMap) {
      // strip parameters like nvarchar(max), decimal(10,2)
      const baseType = typeMap[fieldName].toLowerCase().split('(')[0].trim();
      const malloyType = this.dialect.sqlTypeToMalloyType(baseType);
      structDef.fields.push({...malloyType, name: fieldName});
    }
  }
}
