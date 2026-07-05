import sql from 'mssql';
import { buildConfig } from './config.js';

let poolPromise: Promise<sql.ConnectionPool> | null = null;

/**
 * Lazily create and reuse a single connection pool. Reusing the pool is what
 * gives us persistent state across tool calls (no reconnect per query).
 */
export function getPool(): Promise<sql.ConnectionPool> {
  if (!poolPromise) {
    const pool = new sql.ConnectionPool(buildConfig());
    poolPromise = pool.connect().catch((err) => {
      poolPromise = null; // allow a later retry after a failed connect
      throw err;
    });
  }
  return poolPromise;
}

export async function closePool(): Promise<void> {
  if (!poolPromise) return;
  const pool = await poolPromise.catch(() => null);
  if (pool) await pool.close();
  poolPromise = null;
}
