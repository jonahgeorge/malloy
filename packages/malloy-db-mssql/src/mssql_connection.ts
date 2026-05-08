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
  Connection,
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
import {MSSQLDialect, sqlKey, makeDigest} from '@malloydata/malloy';
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

    const typeMap: {[name: string]: string} = {};
    for (const row of result.recordset) {
      typeMap[row.name] = row.system_type_name;
    }
    this.fillStructDefFromTypeMap(structDef, typeMap);
    return structDef;
  }

  async runRawSQL(
    sql: string,
    _options?: RunSQLOptions
  ): Promise<MalloyQueryData> {
    const pool = await this.getPool();
    const result = await pool.request().query(sql);
    const rows = result.recordset as unknown as QueryData;
    // Nested aggregations come back as JSON strings (T-SQL has no JSON type).
    // Best-effort parse: any string cell that starts with `[` or `{` is
    // attempted as JSON; on parse failure we leave it untouched. This mirrors
    // the implicit JSON parsing the mysql2 driver does for JSON columns.
    for (const row of rows) {
      for (const k of Object.keys(row)) {
        const v = row[k];
        if (typeof v === 'string' && v.length > 0) {
          const c = v.charCodeAt(0);
          if (c === 0x5b /* [ */ || c === 0x7b /* { */) {
            try {
              row[k] = JSON.parse(v);
            } catch {
              /* leave as string */
            }
          }
        }
      }
    }
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
