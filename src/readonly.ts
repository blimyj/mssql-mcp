/**
 * Best-effort read-only guard. This is a convenience safety net, NOT a security
 * boundary — the real guarantee is connecting with a DB login that only has
 * read permissions (see README). It blocks the obvious foot-guns.
 */

const FORBIDDEN =
  /\b(insert|update|delete|drop|alter|create|truncate|merge|grant|revoke|deny|exec|execute|sp_configure|reconfigure|backup|restore|shutdown|dbcc|kill|waitfor|openrowset|openquery|openxml|bulk|into|writetext|updatetext|readtext)\b/i;

function stripComments(s: string): string {
  return s.replace(/--[^\n]*/g, ' ').replace(/\/\*[\s\S]*?\*\//g, ' ');
}

/** Normalize whitespace/comments and drop a single trailing semicolon. */
export function cleanForExecution(raw: string): string {
  return stripComments(raw).trim().replace(/;\s*$/, '').trim();
}

/** Validate a single read-only statement, returning the cleaned SQL. */
export function assertReadOnly(raw: string): string {
  const cleaned = cleanForExecution(raw);
  if (!cleaned) throw new Error('Empty query.');

  if (/;/.test(cleaned)) {
    throw new Error(
      'Multiple statements are not allowed in read-only mode. Submit a single SELECT.'
    );
  }
  if (!/^(select|with)\b/i.test(cleaned)) {
    throw new Error(
      'Only SELECT (or WITH ... SELECT) queries are allowed in read-only mode.'
    );
  }
  const m = cleaned.match(FORBIDDEN);
  if (m) {
    throw new Error(
      `Disallowed keyword "${m[1]}" in read-only mode. Set MSSQL_READONLY=false to allow writes.`
    );
  }
  return cleaned;
}
