import sql from 'mssql';
import { resolveDb, type DbEntry } from './config.js';

const pools = new Map<string, Promise<sql.ConnectionPool>>();

/**
 * Lazily create and reuse one connection pool per configured database.
 * Reusing pools gives persistent state across tool calls (no reconnect per query).
 */
export function getPool(db: DbEntry | string | undefined): Promise<sql.ConnectionPool> {
  const entry = typeof db === 'object' ? db : resolveDb(db);
  let p = pools.get(entry.name);
  if (!p) {
    const pool = new sql.ConnectionPool(entry.sql);
    p = pool.connect().catch((err) => {
      pools.delete(entry.name); // allow a later retry after a failed connect
      throw err;
    });
    pools.set(entry.name, p);
  }
  return p;
}

export async function closePools(): Promise<void> {
  const all = [...pools.values()];
  pools.clear();
  await Promise.all(
    all.map(async (p) => {
      const pool = await p.catch(() => null);
      if (pool) await pool.close();
    })
  );
}
