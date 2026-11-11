import type { DbEntry } from './config.js';

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Blank out string literals so text inside them can't trip the schema check. */
function stripStrings(sql: string): string {
  return sql.replace(/N?'(?:[^']|'')*'/g, "''");
}

/**
 * Reject a query that names an excluded schema (`audit.X`, `[audit].X`,
 * `Db.audit.X`). Best-effort, like the read-only guard: it cannot see schemas
 * reached through views, synonyms, or unqualified names resolved to the
 * login's default schema. Database permissions are the real boundary.
 */
export function assertSchemasAllowed(db: DbEntry, sql: string): void {
  if (!db.excludeSchemas.length) return;
  const text = stripStrings(sql);
  for (const s of db.excludeSchemas) {
    const re = new RegExp(`(^|[^\\w@#$])(\\[${escapeRe(s)}\\]|"${escapeRe(s)}"|${escapeRe(s)})\\s*\\.`, 'i');
    if (re.test(text)) {
      throw excludedError(db, s);
    }
  }
}

/** SQL fragment + parameters filtering `<col>` (a schema-name column) by the exclude list. */
export function schemaFilter(db: DbEntry, col: string) {
  const params = db.excludeSchemas.map((s, i) => [`xs${i}`, s] as const);
  const clause = params.length
    ? ` AND LOWER(${col}) NOT IN (${params.map(([k]) => '@' + k).join(', ')})`
    : '';
  return { clause, params };
}

/**
 * Apply a tool call's includeExcludedSchemas flag. Returns the entry unchanged
 * when the flag is off, or a copy with no exclusions when the flag is on and the
 * database allows it. Throws when the database has locked the override.
 */
export function withOverride(db: DbEntry, include?: boolean): DbEntry {
  if (!include || !db.excludeSchemas.length) return db;
  if (!db.allowExcludedOverride) {
    throw new Error(
      `includeExcludedSchemas is disabled on database "${db.name}" (allowExcludedOverride: false).`
    );
  }
  return { ...db, excludeSchemas: [], revealedSchemas: db.excludeSchemas };
}

/** Error for a blocked schema, pointing at the override when one is available. */
export function excludedError(db: DbEntry, schema: string): Error {
  return new Error(
    `Schema "${schema}" is excluded on database "${db.name}".` +
      (db.allowExcludedOverride
        ? ' If the user really needs it, retry with includeExcludedSchemas: true.'
        : '')
  );
}
