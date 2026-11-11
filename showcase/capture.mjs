// Regenerate the showcase page from live tool calls: node showcase/capture.mjs
// Needs the local test setup: a built server (npm run build), a reachable test
// SQL Server, and a databases.json with "testshop" and "inventory" entries.
// Each scenario starts the server once per config variant (via MSSQL_CONFIG and
// env overrides) and records the real responses, so the page shows exactly how
// each setting changes what an agent sees.
import { Client } from '../node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js';
import { StdioClientTransport } from '../node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js';
import { writeFileSync, readFileSync, mkdirSync } from 'node:fs';

const here = (p) => new URL(p, import.meta.url).pathname;
const SERVER = here('../dist/index.js');
const BASE = JSON.parse(readFileSync(here('../databases.json'), 'utf8'));
mkdirSync(here('./configs'), { recursive: true });

/** BASE with a mutation applied, written to configs/<name>.json. */
function configFile(name, mutate) {
  const cfg = structuredClone(BASE);
  // Configs are written to showcase/configs/, so anchor relative descriptionFile paths to the project root.
  for (const d of Object.values(cfg.databases)) {
    if (d.descriptionFile && !d.descriptionFile.startsWith('/')) d.descriptionFile = here('../' + d.descriptionFile);
  }
  mutate?.(cfg);
  const path = here(`./configs/${name}.json`);
  writeFileSync(path, JSON.stringify(cfg, null, 2));
  return path;
}

async function run({ config, env = {}, calls }) {
  const c = new Client({ name: 'showcase', version: '1' });
  await c.connect(
    new StdioClientTransport({
      command: 'node',
      args: [SERVER],
      env: { ...process.env, MSSQL_RATE_MAX: '0', MSSQL_CONFIG: config, ...env },
      stderr: 'ignore',
    })
  );
  const out = { instructions: c.getInstructions(), calls: [] };
  for (const [tool, args] of calls) {
    const r = await c.callTool({ name: tool, arguments: args });
    out.calls.push({ tool, args, isError: !!r.isError, text: r.content.map((x) => x.text).join('') });
  }
  await c.close();
  return out;
}

const base = configFile('base');
const audit = { sql: 'SELECT TOP 2 EventId, CustomerId, Ip FROM audit.LoginEvents' };
const orders = {
  sql: 'SELECT TOP 4 o.OrderId, c.Name AS Customer, o.Status FROM dbo.Orders o JOIN dbo.Customers c ON c.CustomerId = o.CustomerId ORDER BY o.OrderId',
};

const SCENARIOS = [
  {
    id: 'output',
    title: 'Output format',
    setting: 'MSSQL_OUTPUT',
    blurb: 'How results are serialized. Compact sends column names once and each row as an array, on one line.',
    variants: [
      { label: 'compact (default)', snippet: 'MSSQL_OUTPUT=compact', config: base, calls: [['query', orders]] },
      { label: 'pretty', snippet: 'MSSQL_OUTPUT=pretty', config: base, env: { MSSQL_OUTPUT: 'pretty' }, calls: [['query', orders]] },
    ],
  },
  {
    id: 'exclude',
    title: 'Excluding a schema',
    setting: 'excludeSchemas',
    blurb: 'Excluded schemas disappear from listings and the descriptor, and queries naming them are refused.',
    variants: [
      {
        label: 'audit excluded',
        snippet: '"testshop": {\n  "database": "TestShop",\n  "excludeSchemas": ["audit"]\n}',
        config: base,
        calls: [['list_tables', {}], ['query', audit]],
      },
      {
        label: 'nothing excluded',
        snippet: '"testshop": {\n  "database": "TestShop"\n}',
        config: configFile('no-exclude', (c) => delete c.databases.testshop.excludeSchemas),
        calls: [['list_tables', {}], ['query', audit]],
      },
    ],
  },
  {
    id: 'override',
    title: 'Seeing an excluded schema when really needed',
    setting: 'includeExcludedSchemas (tool flag)',
    blurb: 'Same config. The agent passes includeExcludedSchemas: true on one call to lift the exclusion for that call only. The refusal message tells it the flag exists.',
    variants: [
      { label: 'flag not set', snippet: '"excludeSchemas": ["audit"]', config: base, calls: [['query', audit], ['describe_table', { table: 'LoginEvents', schema: 'audit' }]] },
      {
        label: 'includeExcludedSchemas: true',
        snippet: '"excludeSchemas": ["audit"]',
        config: base,
        calls: [
          ['query', { ...audit, includeExcludedSchemas: true }],
          ['describe_table', { table: 'LoginEvents', schema: 'audit', includeExcludedSchemas: true }],
          ['list_tables', { schema: 'audit', includeExcludedSchemas: true }],
        ],
      },
    ],
  },
  {
    id: 'locked',
    title: 'Locking the override',
    setting: 'allowExcludedOverride',
    blurb: 'Set allowExcludedOverride: false on a database (or MSSQL_ALLOW_EXCLUDED_OVERRIDE=false globally) and the flag is refused. The refusal no longer suggests it.',
    variants: [
      { label: 'allowed (default)', snippet: '"excludeSchemas": ["audit"]', config: base, calls: [['query', { ...audit, includeExcludedSchemas: true }]] },
      {
        label: 'locked',
        snippet: '"excludeSchemas": ["audit"],\n"allowExcludedOverride": false',
        config: configFile('locked', (c) => (c.databases.testshop.allowExcludedOverride = false)),
        calls: [['query', { ...audit, includeExcludedSchemas: true }], ['query', audit]],
      },
    ],
  },
  {
    id: 'default-db',
    title: 'Default database',
    setting: '"default"',
    blurb: 'Calls without a db argument go to the default. Any call can still name another database.',
    variants: [
      { label: 'default: testshop', snippet: '"default": "testshop"', config: base, calls: [['list_tables', {}], ['list_tables', { db: 'inventory' }]] },
      {
        label: 'default: inventory',
        snippet: '"default": "inventory"',
        config: configFile('default-inventory', (c) => (c.default = 'inventory')),
        calls: [['list_tables', {}], ['list_tables', { db: 'testshop' }]],
      },
    ],
  },
  {
    id: 'description',
    title: 'Telling the agent what a database is for',
    setting: 'summary / description',
    blurb: 'The summary is sent on connect, so the agent sees it before choosing a database. The description is loaded by describe_database. Without them the agent gets just the database name.',
    variants: [
      {
        label: 'guidance configured',
        snippet: '"descriptionFile": "descriptions/testshop.md"\n\n' + readFileSync(here('../descriptions/testshop.md'), 'utf8').trim(),
        config: base,
        calls: [['describe_database', {}]],
        showInstructions: true,
      },
      {
        label: 'nothing configured',
        snippet: '(no summary, description or descriptionFile)',
        config: configFile('no-guidance', (c) => {
          for (const d of Object.values(c.databases)) for (const k of ['summary', 'description', 'descriptionFile']) delete d[k];
        }),
        calls: [['describe_database', {}]],
        showInstructions: true,
      },
    ],
  },
  {
    id: 'readonly',
    title: 'Read-only guard',
    setting: 'readonly / MSSQL_READONLY',
    blurb: 'Read-only unless a database explicitly says "readonly": false (or MSSQL_READONLY=false); missing or mistyped values stay read-only. With the guard on, writes are refused before reaching SQL Server. With it off, the statement is sent, and the login\'s own permissions decide (here mcp_reader only has db_datareader, so SQL Server refuses).',
    variants: [
      { label: 'not set (read-only by default)', snippet: '(no "readonly" key, no MSSQL_READONLY)', config: base, calls: [['query', { sql: 'UPDATE dbo.Products SET Price = Price WHERE 1 = 0' }]] },
      {
        label: 'readonly: false',
        snippet: '"readonly": false',
        config: configFile('readwrite', (c) => (c.databases.testshop.readonly = false)),
        calls: [['query', { sql: 'UPDATE dbo.Products SET Price = Price WHERE 1 = 0' }]],
      },
    ],
  },
  {
    id: 'rate',
    title: 'Rate limiting',
    setting: 'MSSQL_RATE_MAX / MSSQL_RATE_WINDOW_MS',
    blurb: 'Protects the server from an agent firing many queries. Calls over the limit return an error with a retry time and never reach the database.',
    variants: [
      { label: 'unlimited', snippet: 'MSSQL_RATE_MAX=0', config: base, calls: [['query', { sql: 'SELECT 1 AS a' }], ['query', { sql: 'SELECT 2 AS a' }]] },
      {
        label: '1 per 10s',
        snippet: 'MSSQL_RATE_MAX=1\nMSSQL_RATE_WINDOW_MS=10000',
        config: base,
        env: { MSSQL_RATE_MAX: '1', MSSQL_RATE_WINDOW_MS: '10000' },
        calls: [['query', { sql: 'SELECT 1 AS a' }], ['query', { sql: 'SELECT 2 AS a' }]],
      },
    ],
  },
];

const scenarios = [];
for (const s of SCENARIOS) {
  const variants = [];
  for (const v of s.variants) {
    const r = await run(v);
    variants.push({ label: v.label, snippet: v.snippet, calls: r.calls, instructions: v.showInstructions ? r.instructions : undefined });
  }
  scenarios.push({ id: s.id, title: s.title, setting: s.setting, blurb: s.blurb, variants });
  console.log('captured', s.id);
}

const tour = await run({
  config: base,
  calls: [
    ['list_databases', {}],
    ['describe_database', {}],
    ['analyze_query', { sql: 'SELECT o.OrderId, o.Status FROM dbo.Orders o WHERE o.CustomerId = 42', maxRows: 5 }],
  ],
});

const data = JSON.stringify({ scenarios, tour, base: BASE, capturedAt: new Date().toISOString() }).replace(/</g, '\\u003c');
const tpl = readFileSync(here('./template.html'), 'utf8');
writeFileSync(here('./index.html'), tpl.replace('__DATA__', () => data));
console.log('wrote showcase/index.html');
