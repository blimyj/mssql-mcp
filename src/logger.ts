import { appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

// Enabled via .env: MSSQL_LOG=true. Log file defaults to mssql-mcp/mcp.log,
// overridable with MSSQL_LOG_FILE. Long payloads are clipped (MSSQL_LOG_MAX).
const enabled = (process.env.MSSQL_LOG ?? 'false').toLowerCase() === 'true';
const here = dirname(fileURLToPath(import.meta.url));
const logFile = process.env.MSSQL_LOG_FILE
  ? resolve(process.env.MSSQL_LOG_FILE)
  : resolve(here, '../mcp.log');
const MAX = Number(process.env.MSSQL_LOG_MAX ?? '20000');

export const logging = { enabled, logFile };

const ts = () => new Date().toISOString();

function write(text: string): void {
  try {
    appendFileSync(logFile, text);
  } catch {
    // Logging must never break the server.
  }
}

function clip(s: string): string {
  return s.length <= MAX
    ? s
    : s.slice(0, MAX) + `\n  … [truncated ${s.length - MAX} more chars]`;
}

const indent = (s: string) =>
  s
    .split('\n')
    .map((l) => '  ' + l)
    .join('\n');

let seq = 0;

/**
 * Log the arguments a client sent for a tool call (before it runs).
 * Returns a call id to pass to logOutput so interleaved calls stay pairable.
 */
export function logInput(tool: string, args: unknown): number {
  const id = ++seq;
  if (!enabled) return id;
  write(
    `\n${'═'.repeat(72)}\n[${ts()}]  ← CALL #${id}  ${tool}\n${'─'.repeat(72)}\n` +
      `INPUT (from client):\n${indent(clip(JSON.stringify(args, null, 2)))}\n`
  );
  return id;
}

/** Log the result returned to the client (after the call completes). */
export function logOutput(
  id: number,
  tool: string,
  output: string,
  ms: number,
  isError: boolean
): void {
  if (!enabled) return;
  write(
    `[${ts()}]  → DONE #${id}  ${tool}${isError ? '  [ERROR]' : ''}  ·  ${ms} ms\n` +
      `OUTPUT (to client):\n${indent(clip(output))}\n`
  );
}

/** Log a one-off informational line (startup, shutdown, ...). */
export function logInfo(msg: string): void {
  if (!enabled) return;
  write(`[${ts()}]  ${msg}\n`);
}
