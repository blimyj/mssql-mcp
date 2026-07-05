import { getPool } from './db.js';
import { parseShowplan } from './showplan.js';

/** A SHOWPLAN result set is a single column holding the plan XML. */
function isShowplan(rs: any): boolean {
  if (!rs || !rs.length) return false;
  const row = rs[0];
  const keys = Object.keys(row);
  return (
    keys.length === 1 &&
    typeof row[keys[0]] === 'string' &&
    row[keys[0]].includes('<ShowPlanXML')
  );
}

// Table 'Orders'. Scan count 1, logical reads 1284, physical reads 0, ...
const IO_RE =
  /Table '([^']+)'\. Scan count (\d+), logical reads (\d+), physical reads (\d+)(?:, page server reads \d+)?, read-ahead reads (\d+)/g;

function parseIo(infos: string[]) {
  const text = infos.join('\n');
  const out: any[] = [];
  IO_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = IO_RE.exec(text)) !== null) {
    out.push({
      table: m[1],
      scan_count: Number(m[2]),
      logical_reads: Number(m[3]),
      physical_reads: Number(m[4]),
      read_ahead_reads: Number(m[5]),
    });
  }
  return out;
}

/** Fallback timing from STATISTICS TIME text (last block = execution time). */
function parseTime(infos: string[]) {
  const re = /CPU time = (\d+) ms,\s+elapsed time = (\d+) ms/g;
  let last: { cpu_ms: number; elapsed_ms: number } | undefined;
  let m: RegExpExecArray | null;
  const text = infos.join('\n');
  while ((m = re.exec(text)) !== null) {
    last = { cpu_ms: Number(m[1]), elapsed_ms: Number(m[2]) };
  }
  return last;
}

export async function runQuery(cleanSql: string, maxRows: number) {
  const pool = await getPool();
  const result: any = await pool.request().query(cleanSql);
  const recordsets: any[] = result.recordsets ?? [];
  const data = recordsets.filter((rs) => !isShowplan(rs));
  const rows = data.length ? data[data.length - 1] : [];
  const truncated = rows.length > maxRows;
  return {
    row_count: rows.length,
    truncated,
    rows: truncated ? rows.slice(0, maxRows) : rows,
  };
}

export async function runAnalyze(
  cleanSql: string,
  maxRows: number,
  includePlanXml: boolean
) {
  const pool = await getPool();
  const request = pool.request();

  // STATISTICS IO / TIME arrive on the info-message channel, separate from rows.
  const infos: string[] = [];
  request.on('info', (info: any) => {
    if (info?.message) infos.push(String(info.message));
  });

  const batch = [
    'SET STATISTICS XML ON;',
    'SET STATISTICS IO ON;',
    'SET STATISTICS TIME ON;',
    cleanSql + ';',
    'SET STATISTICS XML OFF;',
    'SET STATISTICS IO OFF;',
    'SET STATISTICS TIME OFF;',
  ].join('\n');

  const result: any = await request.query(batch);
  const recordsets: any[] = result.recordsets ?? [];

  let planXml: string | null = null;
  const data: any[] = [];
  for (const rs of recordsets) {
    if (isShowplan(rs)) planXml = rs[0][Object.keys(rs[0])[0]];
    else data.push(rs);
  }

  const rows = data.length ? data[data.length - 1] : [];
  const truncated = rows.length > maxRows;
  const plan = planXml ? parseShowplan(planXml) : null;

  return {
    row_count: rows.length,
    truncated,
    rows: truncated ? rows.slice(0, maxRows) : rows,
    timing: plan?.timing ?? parseTime(infos),
    io_by_table: parseIo(infos),
    statement: plan?.statement,
    operators: plan?.operators,
    missing_indexes: plan?.missing_indexes,
    warnings: plan?.warnings,
    ...(includePlanXml ? { plan_xml: planXml } : {}),
  };
}
