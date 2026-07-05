import type { config as SqlConfig } from 'mssql';

/** Whether the server refuses anything but SELECT / WITH queries. */
export const READONLY =
  (process.env.MSSQL_READONLY ?? 'true').toLowerCase() !== 'false';

const bool = (v: string | undefined, dflt: boolean) =>
  v === undefined ? dflt : v.toLowerCase() !== 'false';

/** Build the mssql connection config from environment variables. */
export function buildConfig(): SqlConfig {
  const user = process.env.MSSQL_USER;
  const password = process.env.MSSQL_PASSWORD;
  if (!user || !password) {
    throw new Error(
      'MSSQL_USER and MSSQL_PASSWORD must be set (the SQL login you use in SSMS).'
    );
  }

  return {
    server: process.env.MSSQL_SERVER ?? 'localhost',
    port: Number(process.env.MSSQL_PORT ?? '1433'),
    user,
    password,
    database: process.env.MSSQL_DATABASE ?? 'master',
    options: {
      // Local Colima/Docker SQL Server presents a self-signed cert,
      // so we encrypt but trust it. Flip these for a managed/cloud server.
      encrypt: bool(process.env.MSSQL_ENCRYPT, true),
      trustServerCertificate: bool(process.env.MSSQL_TRUST_SERVER_CERT, true),
      enableArithAbort: true,
    },
    pool: { max: 5, min: 0, idleTimeoutMillis: 30_000 },
    connectionTimeout: 15_000,
    requestTimeout: Number(process.env.MSSQL_REQUEST_TIMEOUT ?? '30000'),
  };
}
