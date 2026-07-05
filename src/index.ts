#!/usr/bin/env node
import './env.js'; // must be first: loads mssql-mcp/.env before config is read
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { getPool, closePool } from './db.js';
import { assertReadOnly, cleanForExecution } from './readonly.js';
import { runQuery, runAnalyze } from './runner.js';
import { READONLY } from './config.js';
import { logInput, logOutput, logInfo, logging } from './logger.js';
import { acquire, release, rateLimit, limitsSummary } from './ratelimit.js';

/** JSON-safe rendering of driver values (Buffers -> hex, BigInt -> string). */
function jsonReplacer(_k: string, v: any) {
  if (typeof v === 'bigint') return v.toString();
  if (v && v.type === 'Buffer' && Array.isArray(v.data)) {
    return '0x' + Buffer.from(v.data).toString('hex');
  }
  return v;
}

const text = (obj: any) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(obj, jsonReplacer, 2) }],
});
const fail = (err: any) => ({
  content: [{ type: 'text' as const, text: `Error: ${err?.message ?? String(err)}` }],
  isError: true,
});

/** Apply the read-only guard (or just normalize) before executing user SQL. */
const prepare = (sqlText: string) =>
  READONLY ? assertReadOnly(sqlText) : cleanForExecution(sqlText);

/** Wrap a tool handler so its input/output is logged (when logging is on). */
function logged(name: string, handler: (args: any) => Promise<any>) {
  return async (args: any) => {
    const id = logInput(name, args);
    const start = Date.now();
    let res: any;
    try {
      acquire(); // throws if a rate/concurrency limit would be exceeded
      try {
        res = await handler(args);
      } finally {
        release();
      }
    } catch (e) {
      res = fail(e);
    }
    const out = res?.content?.[0]?.text ?? '';
    logOutput(id, name, out, Date.now() - start, !!res?.isError);
    return res;
  };
}

const rateNote =
  rateLimit.MAX > 0 || rateLimit.MAX_CONCURRENT > 0
    ? ` Rate limit: ${limitsSummary()}; exceeding it returns an error with a retry time, so pace your calls.`
    : '';

const server = new McpServer(
  { name: 'mssql-mcp', version: '0.1.0' },
  {
    instructions:
      `Read-only Microsoft SQL Server access.` +
      (READONLY ? ' Only single SELECT / WITH queries are permitted.' : '') +
      rateNote,
  }
);

server.registerTool(
  'query',
  {
    title: 'Run a SQL query',
    description:
      'Execute a single SELECT query against SQL Server and return rows as JSON. ' +
      (READONLY
        ? 'Read-only: only SELECT / WITH statements are permitted.'
        : 'Read-write is ENABLED on this server.') +
      rateNote,
    inputSchema: {
      sql: z.string().describe('A single SELECT query.'),
      maxRows: z
        .number()
        .int()
        .positive()
        .max(10000)
        .optional()
        .describe('Max rows to return (default 100).'),
    },
  },
  logged('query', async ({ sql, maxRows }) => {
    try {
      return text(await runQuery(prepare(sql), maxRows ?? 100));
    } catch (e) {
      return fail(e);
    }
  })
);

server.registerTool(
  'analyze_query',
  {
    title: 'Run a query with SSMS-style performance stats',
    description:
      'Execute a SELECT under SET STATISTICS XML/IO/TIME and return structured performance ' +
      'data: per-operator estimated vs actual rows, logical/physical reads, statement timing, ' +
      'missing-index suggestions, and plan warnings. Use this to explain why a query is slow.' +
      rateNote,
    inputSchema: {
      sql: z.string().describe('A single SELECT query to analyze.'),
      maxRows: z
        .number()
        .int()
        .positive()
        .max(10000)
        .optional()
        .describe('Max result rows to include (default 50).'),
      includePlanXml: z
        .boolean()
        .optional()
        .describe('Include the raw showplan XML (large). Default false.'),
    },
  },
  logged('analyze_query', async ({ sql, maxRows, includePlanXml }) => {
    try {
      return text(await runAnalyze(prepare(sql), maxRows ?? 50, includePlanXml ?? false));
    } catch (e) {
      return fail(e);
    }
  })
);

server.registerTool(
  'list_tables',
  {
    title: 'List tables and views',
    description: 'List tables and views in the current database (INFORMATION_SCHEMA).',
    inputSchema: {
      schema: z.string().optional().describe('Filter by schema, e.g. "dbo".'),
    },
  },
  logged('list_tables', async ({ schema }) => {
    try {
      const req = (await getPool()).request();
      let q =
        'SELECT TABLE_SCHEMA AS [schema], TABLE_NAME AS [name], TABLE_TYPE AS [type] ' +
        'FROM INFORMATION_SCHEMA.TABLES';
      if (schema) {
        req.input('schema', schema);
        q += ' WHERE TABLE_SCHEMA = @schema';
      }
      q += ' ORDER BY TABLE_SCHEMA, TABLE_NAME';
      const r: any = await req.query(q);
      return text({ tables: r.recordset });
    } catch (e) {
      return fail(e);
    }
  })
);

server.registerTool(
  'describe_table',
  {
    title: 'Describe a table',
    description: 'Return columns, types, nullability and defaults for a table.',
    inputSchema: {
      table: z.string().describe('Table name (without schema).'),
      schema: z.string().optional().describe('Schema name (default dbo).'),
    },
  },
  logged('describe_table', async ({ table, schema }) => {
    try {
      const req = (await getPool()).request();
      req.input('table', table);
      req.input('schema', schema ?? 'dbo');
      const r: any = await req.query(
        `SELECT COLUMN_NAME AS [column], DATA_TYPE AS [type],
                CHARACTER_MAXIMUM_LENGTH AS [max_length],
                IS_NULLABLE AS [nullable], COLUMN_DEFAULT AS [default]
         FROM INFORMATION_SCHEMA.COLUMNS
         WHERE TABLE_NAME = @table AND TABLE_SCHEMA = @schema
         ORDER BY ORDINAL_POSITION`
      );
      if (!r.recordset.length) {
        return fail(new Error(`Table ${schema ?? 'dbo'}.${table} not found.`));
      }
      return text({ table: `${schema ?? 'dbo'}.${table}`, columns: r.recordset });
    } catch (e) {
      return fail(e);
    }
  })
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // NB: never write to stdout — it is the MCP transport. Logs go to stderr.
  console.error(
    `mssql-mcp ready (read-only: ${READONLY}` +
      (rateLimit.MAX > 0
        ? `, rate: ${rateLimit.MAX}/${Math.round(rateLimit.WINDOW_MS / 1000)}s`
        : '') +
      (rateLimit.MAX_CONCURRENT > 0 ? `, concurrency: ${rateLimit.MAX_CONCURRENT}` : '') +
      (logging.enabled ? `, logging -> ${logging.logFile}` : '') +
      `).`
  );
  logInfo(`─── server started (read-only: ${READONLY}) ───`);

  const shutdown = async () => {
    logInfo('─── server stopping ───');
    await closePool();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
