import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { config as SqlConfig } from 'mssql';

const bool = (v: unknown, dflt: boolean) =>
  v === undefined || v === null || v === ''
    ? dflt
    : String(v).toLowerCase() !== 'false';

const list = (v: string | undefined) =>
  (v ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

/** Project root (mssql-mcp/), derived from dist/config.js. */
export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Writes are enabled only by an explicit false (JSON false, or the text "false"
 * in any case). Anything else, including a missing, empty, or mistyped value,
 * keeps the database read-only.
 */
const writesEnabled = (v: unknown) =>
  v === false || (typeof v === 'string' && v.trim().toLowerCase() === 'false');

/** Global default: refuse anything but SELECT / WITH. A database entry may override. */
export const READONLY = !writesEnabled(process.env.MSSQL_READONLY);

/**
 * Output style. "compact" (default): single-line JSON, rows as arrays under a
 * shared "columns" header. "pretty": indented JSON, rows as objects.
 */
export const PRETTY = (process.env.MSSQL_OUTPUT ?? 'compact').toLowerCase() === 'pretty';

/** Schemas hidden from every database, on top of each entry's own list. */
const GLOBAL_EXCLUDED = list(process.env.MSSQL_EXCLUDE_SCHEMAS);

/** Global default for whether tools may pass includeExcludedSchemas=true. */
const ALLOW_OVERRIDE = bool(process.env.MSSQL_ALLOW_EXCLUDED_OVERRIDE, true);

export interface DbEntry {
  /** Key clients pass as the `db` argument. */
  name: string;
  /** Short summary: what the database is and when to use it. Sent on connect. Falls back to the description's first line. */
  summary?: string;
  /** Full notes (how to query it, codes, key tables). Shown only by describe_database. */
  description?: string;
  readonly: boolean;
  /** Lower-cased schema names hidden from listings and blocked in queries. */
  excludeSchemas: string[];
  /** Whether a tool call may reveal excluded schemas with includeExcludedSchemas=true. */
  allowExcludedOverride: boolean;
  /** Set on a per-call copy when the override is in effect: the schemas it revealed. */
  revealedSchemas?: string[];
  sql: SqlConfig;
}

/** Shape of one entry (and of "defaults") in databases.json. */
interface RawEntry {
  server?: string;
  port?: number | string;
  user?: string;
  password?: string;
  /** Name of an env var (e.g. from .env) holding the password. */
  passwordEnv?: string;
  database?: string;
  encrypt?: boolean;
  trustServerCertificate?: boolean;
  /** Only an explicit false enables writes; see writesEnabled. */
  readonly?: boolean | string;
  excludeSchemas?: string[];
  allowExcludedOverride?: boolean;
  summary?: string;
  description?: string;
  /** Path (relative to databases.json) to a text/markdown description. */
  descriptionFile?: string;
  requestTimeout?: number;
}

function readDescription(raw: RawEntry, baseDir: string): string | undefined {
  if (raw.descriptionFile) {
    const p = isAbsolute(raw.descriptionFile)
      ? raw.descriptionFile
      : resolve(baseDir, raw.descriptionFile);
    return readFileSync(p, 'utf8').trim();
  }
  return raw.description?.trim() || undefined;
}

const oneLine = (s?: string) => s?.replace(/\s+/g, ' ').trim() || undefined;

/** summary + description, with summary defaulting to the description's first line. */
function describeFields(raw: RawEntry, baseDir: string) {
  const description = readDescription(raw, baseDir);
  return {
    summary: oneLine(raw.summary) ?? oneLine(description?.split('\n')[0]),
    description,
  };
}

function toEntry(name: string, raw: RawEntry, baseDir: string): DbEntry {
  const password =
    raw.password ??
    (raw.passwordEnv ? process.env[raw.passwordEnv] : undefined) ??
    process.env.MSSQL_PASSWORD;
  const user = raw.user ?? process.env.MSSQL_USER;
  if (!user || !password) {
    throw new Error(
      `Database "${name}": no user/password. Set "user" and "password" or "passwordEnv" ` +
        `(or MSSQL_USER / MSSQL_PASSWORD in .env).`
    );
  }
  return {
    name,
    ...describeFields(raw, baseDir),
    readonly: raw.readonly === undefined || raw.readonly === null ? READONLY : !writesEnabled(raw.readonly),
    excludeSchemas: [...GLOBAL_EXCLUDED, ...(raw.excludeSchemas ?? [])].map((s) =>
      s.toLowerCase()
    ),
    allowExcludedOverride: raw.allowExcludedOverride ?? ALLOW_OVERRIDE,
    sql: {
      server: raw.server ?? 'localhost',
      port: Number(raw.port ?? 1433),
      user,
      password,
      database: raw.database ?? 'master',
      options: {
        encrypt: bool(raw.encrypt, true),
        trustServerCertificate: bool(raw.trustServerCertificate, true),
        enableArithAbort: true,
      },
      pool: { max: 5, min: 0, idleTimeoutMillis: 30_000 },
      connectionTimeout: 15_000,
      requestTimeout: Number(
        raw.requestTimeout ?? process.env.MSSQL_REQUEST_TIMEOUT ?? '30000'
      ),
    },
  };
}

/** Single database described entirely by .env (the original setup). */
function fromEnv(): { entries: DbEntry[]; defaultName: string } {
  const e = process.env;
  const entry = toEntry(
    'default',
    {
      server: e.MSSQL_SERVER,
      port: e.MSSQL_PORT,
      user: e.MSSQL_USER,
      password: e.MSSQL_PASSWORD,
      database: e.MSSQL_DATABASE,
      encrypt: e.MSSQL_ENCRYPT as any,
      trustServerCertificate: e.MSSQL_TRUST_SERVER_CERT as any,
      summary: e.MSSQL_SUMMARY,
      description: e.MSSQL_DESCRIPTION,
      descriptionFile: e.MSSQL_DESCRIPTION_FILE,
    },
    ROOT
  );
  return { entries: [entry], defaultName: 'default' };
}

/**
 * databases.json (path overridable via MSSQL_CONFIG):
 *   { "default": "sales",
 *     "defaults": { "server": "...", "user": "...", "passwordEnv": "MSSQL_PASSWORD" },
 *     "databases": { "sales": { "database": "Sales", "description": "..." }, ... } }
 */
function fromFile(path: string): { entries: DbEntry[]; defaultName: string } {
  let json: any;
  try {
    json = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err: any) {
    throw new Error(`Could not read ${path}: ${err.message}`);
  }
  const defaults: RawEntry = json.defaults ?? {};
  const dbs: Record<string, RawEntry> = json.databases ?? {};
  const names = Object.keys(dbs);
  if (!names.length) throw new Error(`${path} has no entries under "databases".`);

  const baseDir = dirname(path);
  const entries = names.map((n) => {
    const raw = { ...defaults, ...dbs[n] };
    // Lists merge rather than replace, so "defaults" can hide schemas everywhere.
    raw.excludeSchemas = [...(defaults.excludeSchemas ?? []), ...(dbs[n].excludeSchemas ?? [])];
    return toEntry(n, raw, baseDir);
  });
  const defaultName = json.default ?? names[0];
  if (!names.includes(defaultName)) {
    throw new Error(`${path}: "default" is "${defaultName}", which is not under "databases".`);
  }
  return { entries, defaultName };
}

function load() {
  const explicit = process.env.MSSQL_CONFIG;
  const path = explicit
    ? isAbsolute(explicit)
      ? explicit
      : resolve(ROOT, explicit)
    : resolve(ROOT, 'databases.json');
  if (explicit && !existsSync(path)) throw new Error(`MSSQL_CONFIG not found: ${path}`);
  return { ...(existsSync(path) ? fromFile(path) : fromEnv()), source: existsSync(path) ? path : '.env' };
}

const loaded = load();

export const DATABASES: DbEntry[] = loaded.entries;
export const DEFAULT_DB: string = loaded.defaultName;
export const CONFIG_SOURCE: string = loaded.source;

/** Look up a database by name (case-insensitive); undefined → the default. */
export function resolveDb(name?: string): DbEntry {
  const want = (name ?? DEFAULT_DB).toLowerCase();
  const hit = DATABASES.find((d) => d.name.toLowerCase() === want);
  if (!hit) {
    throw new Error(
      `Unknown database "${name}". Available: ${DATABASES.map((d) => d.name).join(', ')}.`
    );
  }
  return hit;
}

/** True when the schema is configured to be skipped for this database. */
export const isExcluded = (db: DbEntry, schema: string) =>
  db.excludeSchemas.includes(schema.toLowerCase());
