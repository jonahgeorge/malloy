/*
 * Copyright 2026 Light Labs.
 *
 * Licensed under the MIT license. See LICENSE in the project root.
 */

import {MSSQLConnection} from './mssql_connection';

const config = {
  server: process.env['MSSQL_SERVER'] ?? 'localhost',
  port: Number(process.env['MSSQL_PORT'] ?? '11433'),
  user: process.env['MSSQL_USER'] ?? 'sa',
  password: process.env['MSSQL_PASSWORD'] ?? 'Malloy_Test_123',
  database: process.env['MSSQL_DATABASE'] ?? 'malloytest',
  encrypt: false,
  trustServerCertificate: true,
};

describe('db:MSSQL', () => {
  const connection = new MSSQLConnection('mssql', config);

  afterAll(async () => {
    await connection.close();
  });

  it('runs a SQL query', async () => {
    const res = await connection.runSQL('SELECT 1 as t');
    expect(res.rows[0]['t']).toBe(1);
  });

  it('fetches table schema', async () => {
    const struct = await connection.fetchTableSchema(
      'carriers',
      'malloytest.carriers'
    );
    const names = struct.fields.map(f => f.name);
    expect(names).toEqual(expect.arrayContaining(['code', 'name', 'nickname']));
  });

  it('fetches sql_select schema', async () => {
    const struct = await connection.fetchSelectSchema({
      connection: 'mssql',
      selectStr: 'SELECT 1 as one, CAST(2.5 AS FLOAT) as two',
    });
    const byName = Object.fromEntries(struct.fields.map(f => [f.name, f]));
    expect(byName['one'].type).toBe('number');
    expect(byName['two'].type).toBe('number');
  });
});
