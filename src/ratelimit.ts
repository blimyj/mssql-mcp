// Protects the DB server from spamming. Two independent limits, both from .env:
//   MSSQL_RATE_MAX        max calls per window (0 = unlimited)
//   MSSQL_RATE_WINDOW_MS  the sliding window, ms
//   MSSQL_MAX_CONCURRENT  max simultaneous in-flight calls (0 = unlimited)
const WINDOW_MS = Number(process.env.MSSQL_RATE_WINDOW_MS ?? '60000');
const MAX = Number(process.env.MSSQL_RATE_MAX ?? '30');
const MAX_CONCURRENT = Number(process.env.MSSQL_MAX_CONCURRENT ?? '4');

export const rateLimit = {
  WINDOW_MS,
  MAX,
  MAX_CONCURRENT,
  enabled: MAX > 0 || MAX_CONCURRENT > 0,
};

let hits: number[] = []; // timestamps of recent calls, within the window
let inFlight = 0;

/**
 * Reserve a slot for one call. Throws (with a helpful retry hint) if either
 * limit would be exceeded. On success the caller MUST later call release().
 */
export function acquire(): void {
  const now = Date.now();

  if (MAX > 0) {
    hits = hits.filter((t) => now - t < WINDOW_MS);
    if (hits.length >= MAX) {
      const retryS = Math.ceil((WINDOW_MS - (now - hits[0])) / 1000);
      throw new Error(
        `Rate limit exceeded: ${MAX} requests per ${Math.round(
          WINDOW_MS / 1000
        )}s. Retry in ~${retryS}s.`
      );
    }
  }

  if (MAX_CONCURRENT > 0 && inFlight >= MAX_CONCURRENT) {
    throw new Error(
      `Too many concurrent queries (max ${MAX_CONCURRENT}). Wait for one to finish and retry.`
    );
  }

  // Both checks passed — record the reservation.
  if (MAX > 0) hits.push(now);
  inFlight++;
}

/** Release a slot reserved by acquire(). */
export function release(): void {
  if (inFlight > 0) inFlight--;
}

/** Human-readable summary of the active limits, for the client/LLM. */
export function limitsSummary(): string {
  const parts: string[] = [];
  if (MAX > 0) {
    parts.push(
      `${MAX} request${MAX === 1 ? '' : 's'} per ${Math.round(WINDOW_MS / 1000)}s`
    );
  }
  if (MAX_CONCURRENT > 0) {
    parts.push(`${MAX_CONCURRENT} concurrent`);
  }
  return parts.length ? parts.join(', ') : 'none';
}
