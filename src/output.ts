import { PRETTY } from './config.js';

/** JSON-safe rendering of driver values (Buffers -> hex, BigInt -> string, Dates -> ISO). */
function jsonReplacer(_k: string, v: any) {
  if (typeof v === 'bigint') return v.toString();
  if (v && v.type === 'Buffer' && Array.isArray(v.data)) {
    return '0x' + Buffer.from(v.data).toString('hex');
  }
  return v;
}

/** Serialize a tool result: one line in compact mode, indented in pretty mode. */
export const serialize = (obj: unknown) =>
  JSON.stringify(obj, jsonReplacer, PRETTY ? 2 : undefined);

/**
 * Shape a recordset for output. Compact mode sends column names once and each
 * row as an array, which removes the per-row key repetition.
 */
export function shapeRows(rows: any[], recordsetColumns?: Record<string, unknown>) {
  if (PRETTY) return { rows };
  const columns = rows.length
    ? Object.keys(rows[0])
    : Object.keys(recordsetColumns ?? {});
  return { columns, rows: rows.map((r) => columns.map((c) => r[c])) };
}
