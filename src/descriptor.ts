import type { DbEntry } from './config.js';
import { getPool } from './db.js';
import { schemaFilter } from './schemas.js';

/** The description, minus its first line when that line is already shown as the summary. */
function notes(db: DbEntry): string | undefined {
  const d = db.description;
  if (!d) return undefined;
  const [first, ...rest] = d.split('\n');
  const same = first.replace(/\s+/g, ' ').trim() === db.summary;
  return (same ? rest.join('\n') : d).trim() || undefined;
}

/** sys.types name + sizes -> "nvarchar(50)", "decimal(10,2)", "varchar(max)". */
function typeLabel(c: any): string {
  const t: string = c.type;
  if (['nvarchar', 'nchar'].includes(t)) {
    return `${t}(${c.max_length === -1 ? 'max' : c.max_length / 2})`;
  }
  if (['varchar', 'char', 'varbinary', 'binary'].includes(t)) {
    return `${t}(${c.max_length === -1 ? 'max' : c.max_length})`;
  }
  if (['decimal', 'numeric'].includes(t)) return `${t}(${c.precision},${c.scale})`;
  return t;
}

/**
 * Compact, LLM-oriented description of a database: the configured notes,
 * then one line per table/view listing columns, primary keys (PK), nullable
 * columns (?), foreign keys (->), and approximate row counts.
 */
export async function describeDatabase(db: DbEntry, schema?: string): Promise<string> {
  const pool = await getPool(db);
  const { clause, params } = schemaFilter(db, 's.name');
  const req = pool.request();
  for (const [k, v] of params) req.input(k, v);
  let where = `o.type IN ('U','V') AND o.is_ms_shipped = 0${clause}`;
  if (schema) {
    req.input('schema', schema);
    where += ' AND s.name = @schema';
  }

  const r: any = await req.query(`
    SELECT s.name AS sch, o.name AS obj, o.type AS kind, o.object_id AS oid
    FROM sys.objects o JOIN sys.schemas s ON s.schema_id = o.schema_id
    WHERE ${where};

    SELECT c.object_id AS oid, c.name AS col, ty.name AS type, c.max_length,
           c.precision, c.scale, c.is_nullable,
           CASE WHEN pk.column_id IS NULL THEN 0 ELSE 1 END AS is_pk
    FROM sys.columns c
    JOIN sys.objects o ON o.object_id = c.object_id
    JOIN sys.schemas s ON s.schema_id = o.schema_id
    JOIN sys.types ty ON ty.user_type_id = c.user_type_id
    LEFT JOIN (SELECT ic.object_id, ic.column_id FROM sys.indexes i
               JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
               WHERE i.is_primary_key = 1) pk
      ON pk.object_id = c.object_id AND pk.column_id = c.column_id
    WHERE ${where}
    ORDER BY c.object_id, c.column_id;

    SELECT fkc.parent_object_id AS oid, pc.name AS col,
           rs.name AS ref_sch, ro.name AS ref_obj, rc.name AS ref_col
    FROM sys.foreign_key_columns fkc
    JOIN sys.columns pc ON pc.object_id = fkc.parent_object_id AND pc.column_id = fkc.parent_column_id
    JOIN sys.objects ro ON ro.object_id = fkc.referenced_object_id
    JOIN sys.schemas rs ON rs.schema_id = ro.schema_id
    JOIN sys.columns rc ON rc.object_id = fkc.referenced_object_id AND rc.column_id = fkc.referenced_column_id;

    SELECT p.object_id AS oid, SUM(p.rows) AS row_count
    FROM sys.partitions p WHERE p.index_id IN (0, 1) GROUP BY p.object_id;
  `);

  const [objects, columns, fks, counts] = r.recordsets as any[][];
  const colsBy = new Map<number, any[]>();
  for (const c of columns) (colsBy.get(c.oid) ?? colsBy.set(c.oid, []).get(c.oid)!).push(c);
  const fkBy = new Map<string, string>();
  for (const f of fks) fkBy.set(`${f.oid}:${f.col}`, `${f.ref_sch}.${f.ref_obj}.${f.ref_col}`);
  const countBy = new Map<number, number>(counts.map((c: any) => [c.oid, Number(c.row_count)]));

  const lines = objects
    .sort((a, b) => `${a.sch}.${a.obj}`.localeCompare(`${b.sch}.${b.obj}`))
    .map((o) => {
      const cols = (colsBy.get(o.oid) ?? []).map((c) => {
        let s = `${c.col} ${typeLabel(c)}`;
        if (c.is_pk) s += ' PK';
        if (c.is_nullable) s += '?';
        const ref = fkBy.get(`${o.oid}:${c.col}`);
        if (ref) s += ` -> ${ref}`;
        return s;
      });
      const kind = o.kind.trim() === 'V' ? 'view' : `table ~${countBy.get(o.oid) ?? 0} rows`;
      return `${o.sch}.${o.obj} (${kind}): ${cols.join(', ')}`;
    });

  const head = [
    `Database "${db.name}" (${db.sql.database} on ${db.sql.server}), ${db.readonly ? 'read-only' : 'read-write'}.`,
    db.excludeSchemas.length ? `Excluded schemas: ${db.excludeSchemas.join(', ')}.` : '',
    db.revealedSchemas?.length
      ? `Including normally excluded schemas: ${db.revealedSchemas.join(', ')}.`
      : '',
    db.summary ? `Summary: ${db.summary}` : '',
    notes(db) ? `\nNotes:\n${notes(db)}\n` : '',
    `Objects (${lines.length}). Legend: PK primary key, ? nullable, -> foreign key.`,
  ].filter(Boolean);
  return [...head, ...lines].join('\n');
}
