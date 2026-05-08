/*
 * Copyright 2026 Light Labs.
 *
 * Licensed under the MIT license. See LICENSE in the project root.
 */

export {MSSQLConnection, MSSQLExecutor} from './mssql_connection';

import {registerConnectionType} from '@malloydata/malloy';
import type {ConnectionConfig} from '@malloydata/malloy';
import {MSSQLConnection} from './mssql_connection';

registerConnectionType('mssql', {
  displayName: 'Microsoft SQL Server',
  factory: async (config: ConnectionConfig) => {
    return new MSSQLConnection(config.name, {
      server:
        typeof config['server'] === 'string'
          ? config['server']
          : typeof config['host'] === 'string'
            ? config['host']
            : undefined,
      port: typeof config['port'] === 'number' ? config['port'] : undefined,
      database:
        typeof config['database'] === 'string' ? config['database'] : undefined,
      user: typeof config['user'] === 'string' ? config['user'] : undefined,
      password:
        typeof config['password'] === 'string' ? config['password'] : undefined,
      encrypt:
        typeof config['encrypt'] === 'boolean' ? config['encrypt'] : undefined,
      trustServerCertificate:
        typeof config['trustServerCertificate'] === 'boolean'
          ? config['trustServerCertificate']
          : undefined,
      setupSQL:
        typeof config['setupSQL'] === 'string' ? config['setupSQL'] : undefined,
    });
  },
  properties: [
    {name: 'server', displayName: 'Server', type: 'string', optional: true},
    {
      name: 'port',
      displayName: 'Port',
      type: 'number',
      optional: true,
      default: 1433,
    },
    {name: 'database', displayName: 'Database', type: 'string', optional: true},
    {name: 'user', displayName: 'User', type: 'string', optional: true},
    {
      name: 'password',
      displayName: 'Password',
      type: 'password',
      optional: true,
    },
    {
      name: 'encrypt',
      displayName: 'Encrypt',
      type: 'boolean',
      optional: true,
      default: true,
    },
    {
      name: 'trustServerCertificate',
      displayName: 'Trust Server Certificate',
      type: 'boolean',
      optional: true,
      default: false,
      advanced: true,
    },
    {
      name: 'setupSQL',
      displayName: 'Setup SQL',
      type: 'text',
      optional: true,
      advanced: true,
      description: 'T-SQL to run when the connection is established',
    },
  ],
});
