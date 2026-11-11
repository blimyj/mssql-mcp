#!/usr/bin/env node
import './env.js'; // must be first: loads mssql-mcp/.env before config is read
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { getPool, closePools } from './db.js';
import { assertReadOnly, cleanForExecution } from './readonly.js';
import { runQuery, runAnalyze } from './runner.js';
import { DATABASES, DEFAULT_DB, CONFIG_SOURCE, PRETTY, resolveDb as lookupDb, isExcluded, type DbEntry } from './config.js';
import { logInput, logOutput, logInfo, logging } from './logger.js';
import { acquire, release, rateLimit, limitsSummary } from './ratelimit.js';
import { serialize, shapeRows } from './output.js';
import { assertSchemasAllowed, schemaFilter, withOverride, excludedError } from './schemas.js';
import { describeDatabase } from './descriptor.js';

const text = (obj: any) => ({
  content: [{ type: 'text' as const, text: typeof obj === 'string' ? obj : serialize(obj) }],
});
const fail = (err: any) => ({
  content: [{ type: 'text' as const, text: `Error: ${err?.message ?? String(err)}` }],
  isError: true,
});

/** Apply the read-only and excluded-schema guards before executing user SQL. */
function prepare(db: DbEntry, sqlText: string) {
  const cleaned = db.readonly ? assertReadOnly(sqlText) : cleanForExecution(sqlText);
  assertSchemasAllowed(db, cleaned);
  return cleaned;
}

const MULTI = DATABASES.length > 1;

/** Resolve the `db` argument and apply the includeExcludedSchemas flag. */
const resolveDb = (db?: string, includeExcluded?: boolean) =>
  withOverride(lookupDb(db), includeExcluded);

const anyExcluded = DATABASES.some((d) => d.excludeSchemas.length);

/** Optional `db` and `includeExcludedSchemas` arguments shared by every database tool. */
const dbArg = {
  includeExcludedSchemas: z
    .boolean()
    .optional()
    .describe(
      anyExcluded
        ? 'Default false. Set true ONLY when the user explicitly needs data from an excluded ' +
            'schema; it lifts the schema exclusions for this one call (if the database allows it).'
        : 'No schemas are excluded on this server; leave unset.'
    ),
  db: z
    .string()
    .optional()
    .describe(
      MULTI
        ? `Database to use: ${DATABASES.map((d) => d.name).join(', ')}. Default "${DEFAULT_DB}".`
        : 'Database to use (only one is configured; omit).'
    ),
};

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

const dbSummary = DATABASES.map(
  (d) =>
    `- ${d.name} (${d.name === DEFAULT_DB ? 'default; ' : ''}${d.sql.database}, ` +
    `${d.readonly ? 'read-only' : 'READ-WRITE'})` +
    (d.summary ? `: ${d.summary}` : '')
).join('\n');

const server = new McpServer(
  { name: 'mssql-mcp', version: '0.2.0' },
  {
    instructions:
      `Microsoft SQL Server access. Databases (pass as the "db" argument):\n${dbSummary}\n` +
      'Pick the database whose summary fits the question. ' +
      'Call describe_database first to learn its schema and full notes in one step. ' +
      'Read-only databases accept only a single SELECT / WITH query.' +
      (PRETTY ? '' : ' Results are compact: "columns" names each position in every "rows" array.') +
      rateNote,
  }
);

server.registerTool(
  'query',
  {
    title: 'Run a SQL query',
    description:
      'Execute a single SELECT query against SQL Server and return rows as JSON. ' +
      'Read-only databases permit only SELECT / WITH statements.' +
      rateNote,
    inputSchema: {
      ...dbArg,
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
  logged('query', async ({ db, sql, maxRows, includeExcludedSchemas }) => {
    try {
      const entry = resolveDb(db, includeExcludedSchemas);
      return text(await runQuery(entry, prepare(entry, sql), maxRows ?? 100));
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
      ...dbArg,
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
  logged('analyze_query', async ({ db, sql, maxRows, includePlanXml, includeExcludedSchemas }) => {
    try {
      const entry = resolveDb(db, includeExcludedSchemas);
      return text(
        await runAnalyze(entry, prepare(entry, sql), maxRows ?? 50, includePlanXml ?? false)
      );
    } catch (e) {
      return fail(e);
    }
  })
);

server.registerTool(
  'list_databases',
  {
    title: 'List configured databases',
    description: 'List the databases this server can query, with their summaries.',
    inputSchema: {},
  },
  logged('list_databases', async () =>
    text({
      default: DEFAULT_DB,
      databases: DATABASES.map((d) => ({
        name: d.name,
        database: d.sql.database,
        server: d.sql.server,
        readonly: d.readonly,
        ...(d.excludeSchemas.length
          ? { excluded_schemas: d.excludeSchemas, override_allowed: d.allowExcludedOverride }
          : {}),
        ...(d.summary ? { summary: d.summary } : {}),
      })),
    })
  )
);

server.registerTool(
  'describe_database',
  {
    title: 'Describe a database',
    description:
      'One-call overview of a database: its configured notes, then one line per table/view ' +
      'with columns and types, primary keys, nullability, foreign keys and approximate row ' +
      'counts. Call this before writing queries against an unfamiliar database.' +
      rateNote,
    inputSchema: {
      ...dbArg,
      schema: z.string().optional().describe('Only include this schema, e.g. "dbo".'),
    },
  },
  logged('describe_database', async ({ db, schema, includeExcludedSchemas }) => {
    try {
      const entry = resolveDb(db, includeExcludedSchemas);
      if (schema && isExcluded(entry, schema)) {
        throw excludedError(entry, schema);
      }
      return text(await describeDatabase(entry, schema));
    } catch (e) {
      return fail(e);
    }
  })
);

server.registerTool(
  'list_tables',
  {
    title: 'List tables and views',
    description: 'List tables and views in a database (INFORMATION_SCHEMA).',
    inputSchema: {
      ...dbArg,
      schema: z.string().optional().describe('Filter by schema, e.g. "dbo".'),
    },
  },
  logged('list_tables', async ({ db, schema, includeExcludedSchemas }) => {
    try {
      const entry = resolveDb(db, includeExcludedSchemas);
      const req = (await getPool(entry)).request();
      const { clause, params } = schemaFilter(entry, 'TABLE_SCHEMA');
      for (const [k, v] of params) req.input(k, v);
      let q =
        'SELECT TABLE_SCHEMA AS [schema], TABLE_NAME AS [name], TABLE_TYPE AS [type] ' +
        `FROM INFORMATION_SCHEMA.TABLES WHERE 1 = 1${clause}`;
      if (schema) {
        req.input('schema', schema);
        q += ' AND TABLE_SCHEMA = @schema';
      }
      q += ' ORDER BY TABLE_SCHEMA, TABLE_NAME';
      const r: any = await req.query(q);
      return text({ tables: shapeRows(r.recordset, r.recordset.columns) });
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
      ...dbArg,
      table: z.string().describe('Table name (without schema).'),
      schema: z.string().optional().describe('Schema name (default dbo).'),
    },
  },
  logged('describe_table', async ({ db, table, schema, includeExcludedSchemas }) => {
    try {
      const entry = resolveDb(db, includeExcludedSchemas);
      const sch = schema ?? 'dbo';
      if (isExcluded(entry, sch)) {
        throw excludedError(entry, sch);
      }
      const req = (await getPool(entry)).request();
      req.input('table', table);
      req.input('schema', sch);
      const r: any = await req.query(
        `SELECT COLUMN_NAME AS [column], DATA_TYPE AS [type],
                CHARACTER_MAXIMUM_LENGTH AS [max_length],
                IS_NULLABLE AS [nullable], COLUMN_DEFAULT AS [default]
         FROM INFORMATION_SCHEMA.COLUMNS
         WHERE TABLE_NAME = @table AND TABLE_SCHEMA = @schema
         ORDER BY ORDINAL_POSITION`
      );
      if (!r.recordset.length) {
        return fail(new Error(`Table ${sch}.${table} not found.`));
      }
      return text({ table: `${sch}.${table}`, columns: shapeRows(r.recordset, r.recordset.columns) });
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
    `mssql-mcp ready (dbs: ${DATABASES.map((d) => d.name + (d.readonly ? '' : ' [rw]')).join(', ')} from ${CONFIG_SOURCE}` +
      (rateLimit.MAX > 0
        ? `, rate: ${rateLimit.MAX}/${Math.round(rateLimit.WINDOW_MS / 1000)}s`
        : '') +
      (rateLimit.MAX_CONCURRENT > 0 ? `, concurrency: ${rateLimit.MAX_CONCURRENT}` : '') +
      (logging.enabled ? `, logging -> ${logging.logFile}` : '') +
      `).`
  );
  for (const d of DATABASES.filter((d) => !d.readonly)) {
    console.error(`WARNING: database "${d.name}" is READ-WRITE (readonly: false).`);
  }
  logInfo(`─── server started (dbs: ${DATABASES.map((d) => d.name).join(', ')}) ───`);

  const shutdown = async () => {
    logInfo('─── server stopping ───');
    await closePools();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
