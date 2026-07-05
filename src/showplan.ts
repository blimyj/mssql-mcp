import { XMLParser } from 'fast-xml-parser';

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  allowBooleanAttributes: true,
});

const num = (v: any): number | undefined =>
  v === undefined || v === null ? undefined : Number(v);

/** Recursively gather every value stored under `key` anywhere in the tree. */
function collect(node: any, key: string, out: any[]): void {
  if (node == null || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const n of node) collect(n, key, out);
    return;
  }
  for (const k of Object.keys(node)) {
    if (k === key) {
      const v = node[k];
      if (Array.isArray(v)) out.push(...v);
      else out.push(v);
    }
    collect(node[k], key, out);
  }
}

function first(node: any, key: string): any {
  const out: any[] = [];
  collect(node, key, out);
  return out[0];
}

function asArray<T>(v: T | T[] | undefined): T[] {
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? v : [v];
}

/** Direct child RelOps of a RelOp: the nearest nested RelOps, no deeper. */
function childRelOps(node: any, out: any[]): void {
  if (node == null || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const n of node) childRelOps(n, out);
    return;
  }
  for (const k of Object.keys(node)) {
    if (k.startsWith('@_')) continue;
    if (k === 'RelOp') {
      const v = node[k];
      if (Array.isArray(v)) out.push(...v);
      else out.push(v);
      // stop — these are the next level down, don't descend further
    } else {
      childRelOps(node[k], out);
    }
  }
}

export interface OperatorSummary {
  node_id?: number;
  parent_node_id?: number;
  depth?: number;
  physical_op?: string;
  logical_op?: string;
  est_rows?: number;
  actual_rows?: number;
  rows_read?: number;
  est_vs_actual?: string;
  actual_logical_reads?: number;
  actual_physical_reads?: number;
  executions?: number;
  cost_pct?: number;
}

/** Parse a SHOWPLAN XML string into a compact, LLM-friendly summary. */
export function parseShowplan(xml: string) {
  const doc = parser.parse(xml);

  // --- Statement level ---
  const stmt = first(doc, 'StmtSimple') ?? {};
  const stmtSubtreeCost = num(stmt['@_StatementSubTreeCost']);
  const statement = {
    text: typeof stmt['@_StatementText'] === 'string'
      ? stmt['@_StatementText'].trim()
      : undefined,
    est_rows: num(stmt['@_StatementEstRows']),
    subtree_cost: stmtSubtreeCost,
  };

  // --- Statement timing (SQL 2016+) ---
  const qts = first(doc, 'QueryTimeStats');
  const timing = qts
    ? { cpu_ms: num(qts['@_CpuTime']), elapsed_ms: num(qts['@_ElapsedTime']) }
    : undefined;

  // --- Per-operator estimated + actual metrics ---
  const buildOp = (
    r: any,
    depth: number,
    parentId: number | undefined
  ): OperatorSummary => {
    const threads = asArray(r?.RunTimeInformation?.RunTimeCountersPerThread);
    const hasRuntime = threads.length > 0;
    // Parallel plans report one row per thread — sum them.
    const sum = (attr: string) =>
      threads.reduce((acc, t) => acc + (Number(t?.[attr]) || 0), 0);

    const est = num(r['@_EstimateRows']);
    const actual = hasRuntime ? sum('@_ActualRows') : undefined;
    const cost = num(r['@_EstimatedTotalSubtreeCost']);

    let skew: string | undefined;
    if (est !== undefined && actual !== undefined && est > 0) {
      const ratio = actual / est;
      if (ratio >= 10 || ratio <= 0.1) skew = `${ratio.toFixed(1)}x off`;
    }

    return {
      node_id: num(r['@_NodeId']),
      parent_node_id: parentId,
      depth,
      physical_op: r['@_PhysicalOp'],
      logical_op: r['@_LogicalOp'],
      est_rows: est,
      actual_rows: actual,
      rows_read: hasRuntime ? sum('@_ActualRowsRead') || undefined : undefined,
      est_vs_actual: skew,
      actual_logical_reads: hasRuntime ? sum('@_ActualLogicalReads') : undefined,
      actual_physical_reads: hasRuntime ? sum('@_ActualPhysicalReads') : undefined,
      executions: hasRuntime ? sum('@_ActualExecutions') : undefined,
      cost_pct:
        cost !== undefined && stmtSubtreeCost
          ? Math.round((cost / stmtSubtreeCost) * 1000) / 10
          : undefined,
    };
  };

  // Walk the plan tree depth-first (pre-order) so operators come out in tree
  // order: root first (node_id 0, runs last), each child indented one level
  // deeper. Data flows from the deepest leaves up toward the root.
  const operators: OperatorSummary[] = [];
  const visit = (r: any, depth: number, parentId: number | undefined) => {
    const op = buildOp(r, depth, parentId);
    operators.push(op);
    const kids: any[] = [];
    childRelOps(r, kids);
    for (const k of kids) visit(k, depth + 1, op.node_id);
  };
  const root = first(doc, 'RelOp');
  if (root) visit(root, 0, undefined);

  // --- Missing index suggestions ---
  const clean = (s?: string) => (s ? s.replace(/^\[|\]$/g, '') : s);
  const miGroups: any[] = [];
  collect(doc, 'MissingIndexGroup', miGroups);
  const missing_indexes = miGroups.flatMap((g) => {
    const impact = num(g['@_Impact']);
    return asArray(g.MissingIndex).map((mi: any) => {
      const eq: string[] = [];
      const ineq: string[] = [];
      const incl: string[] = [];
      for (const cg of asArray(mi.ColumnGroup)) {
        const cols = asArray(cg.Column).map((c: any) => c['@_Name']);
        if (cg['@_Usage'] === 'EQUALITY') eq.push(...cols);
        else if (cg['@_Usage'] === 'INEQUALITY') ineq.push(...cols);
        else if (cg['@_Usage'] === 'INCLUDE') incl.push(...cols);
      }
      const keyCols = [...eq, ...ineq];
      const create =
        keyCols.length > 0
          ? `CREATE INDEX IX_${clean(mi['@_Table'])}_${keyCols
              .map(clean)
              .join('_')} ON ${mi['@_Schema']}.${mi['@_Table']} (${keyCols.join(
              ', '
            )})${incl.length ? ` INCLUDE (${incl.join(', ')})` : ''};`
          : undefined;
      return {
        impact_pct: impact,
        table: `${clean(mi['@_Schema'])}.${clean(mi['@_Table'])}`,
        equality: eq,
        inequality: ineq,
        include: incl,
        create,
      };
    });
  });
  missing_indexes.sort((a, b) => (b.impact_pct ?? 0) - (a.impact_pct ?? 0));

  // --- Warnings (spills, missing stats, implicit conversions, ...) ---
  const warningNodes: any[] = [];
  collect(doc, 'Warnings', warningNodes);
  const warnings = new Set<string>();
  for (const w of warningNodes) {
    for (const k of Object.keys(w)) {
      if (!k.startsWith('@_')) warnings.add(k);
    }
  }

  return { statement, timing, operators, missing_indexes, warnings: [...warnings] };
}
