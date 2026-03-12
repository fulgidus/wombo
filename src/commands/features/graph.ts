/**
 * features/graph.ts — Visualize the feature dependency graph.
 *
 * Usage:
 *   wombo features graph                     # show full dependency graph
 *   wombo features graph --status backlog    # filter by status
 *   wombo features graph --ascii             # ASCII-only rendering
 *   wombo features graph --output json       # emit mermaid source as JSON
 *   wombo features graph --mermaid           # emit raw mermaid source text
 *   wombo features graph --subtasks          # include subtask-level nodes
 *
 * Builds a Mermaid flowchart from the features dependency graph and renders
 * it as a Unicode box diagram in the terminal using mermaidtui.
 */

import type { WomboConfig } from "../../config.js";
import {
  loadFeatures,
  type Feature,
  type Subtask,
  type FeatureStatus,
  type FeaturesFile,
} from "../../lib/features.js";
import { output, type OutputFormat } from "../../lib/output.js";

// mermaidtui has no type declarations — import the JS module directly
// @ts-ignore — no .d.ts published
import { renderMermaidToTui } from "mermaidtui";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FeaturesGraphOptions {
  projectRoot: string;
  config: WomboConfig;
  status?: FeatureStatus;
  ascii?: boolean;
  mermaid?: boolean;
  subtasks?: boolean;
  outputFmt?: OutputFormat;
}

// ---------------------------------------------------------------------------
// Status styling for Mermaid classDef
// ---------------------------------------------------------------------------

// Short status badge for node labels
const STATUS_BADGE: Record<FeatureStatus, string> = {
  backlog: "BL",
  planned: "PL",
  in_progress: "IP",
  blocked: "BK",
  in_review: "IR",
  done: "DN",
  cancelled: "XX",
};

// ---------------------------------------------------------------------------
// Mermaid generation
// ---------------------------------------------------------------------------

/**
 * Sanitize a string for use inside Mermaid labels.
 * Mermaid uses square brackets for labels — we need to escape them.
 */
function sanitizeLabel(s: string): string {
  return s
    .replace(/"/g, "'")
    .replace(/\[/g, "(")
    .replace(/\]/g, ")")
    .replace(/\n/g, " ")
    .slice(0, 40); // keep labels short for terminal rendering
}

/**
 * Generate a safe Mermaid node ID from a feature/subtask ID.
 * Mermaid IDs can't start with numbers and some chars are reserved.
 */
function nodeId(id: string): string {
  return `n_${id.replace(/-/g, "_")}`;
}

/**
 * Collect all node IDs that exist in the graph (for filtering dangling deps).
 */
function collectAllIds(
  features: Feature[],
  includeSubtasks: boolean
): Set<string> {
  const ids = new Set<string>();
  for (const f of features) {
    ids.add(f.id);
    if (includeSubtasks) {
      collectSubtaskIds(f.subtasks, ids);
    }
  }
  return ids;
}

function collectSubtaskIds(subtasks: Subtask[], ids: Set<string>): void {
  for (const st of subtasks) {
    ids.add(st.id);
    collectSubtaskIds(st.subtasks, ids);
  }
}

/**
 * Build the Mermaid flowchart source from the features file.
 * Only includes nodes that participate in at least one dependency edge.
 * Orphan nodes (no deps and nothing depends on them) are excluded from
 * the visual graph and returned separately for a compact summary.
 */
function buildMermaidSource(
  data: FeaturesFile,
  opts: { status?: FeatureStatus; subtasks?: boolean }
): { source: string; nodeCount: number; edgeCount: number; orphanCount: number; orphans: { id: string; title: string; status: FeatureStatus }[] } {
  let features = [...data.features];

  // Filter by status if requested
  if (opts.status) {
    features = features.filter((f) => f.status === opts.status);
  }

  if (features.length === 0) {
    return { source: "", nodeCount: 0, edgeCount: 0, orphanCount: 0, orphans: [] };
  }

  const allIds = collectAllIds(features, !!opts.subtasks);

  // --- First pass: collect all edges to determine connected nodes ---
  const connectedIds = new Set<string>();
  const edges: { from: string; to: string }[] = [];

  for (const f of features) {
    // Feature-level dependency edges
    for (const dep of f.depends_on) {
      if (allIds.has(dep)) {
        edges.push({ from: dep, to: f.id });
        connectedIds.add(dep);
        connectedIds.add(f.id);
      }
    }

    // Subtask edges (parent->child + subtask depends_on)
    if (opts.subtasks && f.subtasks.length > 0) {
      collectSubtaskEdges(f.subtasks, f.id, allIds, edges, connectedIds);
    }
  }

  // If there are no edges at all, every feature is an orphan
  if (edges.length === 0) {
    const orphans = features.map((f) => ({ id: f.id, title: f.title, status: f.status }));
    return { source: "", nodeCount: 0, edgeCount: 0, orphanCount: orphans.length, orphans };
  }

  // --- Second pass: emit only connected nodes and edges ---
  const lines: string[] = ["flowchart LR"];
  let nodeCount = 0;
  const emittedNodes = new Set<string>();
  const orphans: { id: string; title: string; status: FeatureStatus }[] = [];

  // Helper to emit a node if it's connected and not yet emitted
  const emitNode = (id: string, label: string) => {
    if (!emittedNodes.has(id)) {
      lines.push(`    ${nodeId(id)}[${label}]`);
      emittedNodes.add(id);
      nodeCount++;
    }
  };

  for (const f of features) {
    if (connectedIds.has(f.id)) {
      const badge = STATUS_BADGE[f.status];
      emitNode(f.id, `${badge} ${sanitizeLabel(f.title)}`);
    } else if (!opts.subtasks || f.subtasks.length === 0) {
      // Feature has no deps and nothing depends on it — it's an orphan
      orphans.push({ id: f.id, title: f.title, status: f.status });
    }

    // Emit connected subtask nodes
    if (opts.subtasks && f.subtasks.length > 0) {
      emitConnectedSubtasks(f.subtasks, connectedIds, emittedNodes, emitNode, orphans);
    }
  }

  // Emit all edges
  for (const edge of edges) {
    lines.push(`    ${nodeId(edge.from)} --> ${nodeId(edge.to)}`);
  }

  return {
    source: lines.join("\n"),
    nodeCount,
    edgeCount: edges.length,
    orphanCount: orphans.length,
    orphans,
  };
}

/**
 * Recursively collect edges from subtasks (parent->child links + depends_on edges).
 */
function collectSubtaskEdges(
  subtasks: Subtask[],
  parentId: string,
  allIds: Set<string>,
  edges: { from: string; to: string }[],
  connectedIds: Set<string>
): void {
  for (const st of subtasks) {
    // Parent -> subtask link always creates an edge
    edges.push({ from: parentId, to: st.id });
    connectedIds.add(parentId);
    connectedIds.add(st.id);

    // Subtask's own dependencies
    for (const dep of st.depends_on) {
      if (allIds.has(dep)) {
        edges.push({ from: dep, to: st.id });
        connectedIds.add(dep);
        connectedIds.add(st.id);
      }
    }

    // Recurse into nested subtasks
    if (st.subtasks.length > 0) {
      collectSubtaskEdges(st.subtasks, st.id, allIds, edges, connectedIds);
    }
  }
}

/**
 * Emit subtask nodes that are connected, collect orphans.
 */
function emitConnectedSubtasks(
  subtasks: Subtask[],
  connectedIds: Set<string>,
  emittedNodes: Set<string>,
  emitNode: (id: string, label: string) => void,
  orphans: { id: string; title: string; status: FeatureStatus }[]
): void {
  for (const st of subtasks) {
    if (connectedIds.has(st.id)) {
      const badge = STATUS_BADGE[st.status];
      emitNode(st.id, `${badge} ${sanitizeLabel(st.title)}`);
    } else {
      orphans.push({ id: st.id, title: st.title, status: st.status });
    }

    if (st.subtasks.length > 0) {
      emitConnectedSubtasks(st.subtasks, connectedIds, emittedNodes, emitNode, orphans);
    }
  }
}

// ---------------------------------------------------------------------------
// Text rendering helpers
// ---------------------------------------------------------------------------

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const GREEN = "\x1b[32m";
const CYAN = "\x1b[36m";

/**
 * Print a legend explaining the status badges used in the graph.
 */
function printLegend(features: Feature[]): void {
  const statuses = new Set<FeatureStatus>();
  for (const f of features) {
    statuses.add(f.status);
  }

  console.log(`\n${BOLD}Legend:${RESET}`);
  const legendItems: string[] = [];
  for (const [status, badge] of Object.entries(STATUS_BADGE)) {
    if (statuses.has(status as FeatureStatus)) {
      legendItems.push(`  ${badge} = ${status}`);
    }
  }
  console.log(legendItems.join("  |"));
}

/**
 * Detect potential issues in the dependency graph and print warnings.
 */
function printDiagnostics(data: FeaturesFile, includeSubtasks: boolean): void {
  const allIds = collectAllIds(data.features, includeSubtasks);
  const issues: string[] = [];

  // Check for dangling dependencies (pointing to non-existent IDs)
  for (const f of data.features) {
    for (const dep of f.depends_on) {
      if (!allIds.has(dep)) {
        issues.push(`${YELLOW}WARNING${RESET}: ${f.id} depends on "${dep}" which does not exist`);
      }
    }
    if (includeSubtasks) {
      checkSubtaskDeps(f.subtasks, allIds, issues);
    }
  }

  // Check for circular dependencies (simple DFS)
  const circularPaths = detectCycles(data.features, includeSubtasks);
  for (const cycle of circularPaths) {
    issues.push(`${RED}CYCLE${RESET}: ${cycle.join(" -> ")}`);
  }

  // Check for blocked features whose blockers are done
  for (const f of data.features) {
    if (f.status === "blocked") {
      const allDepsDone = f.depends_on.every((dep) => {
        const depFeature = data.features.find((ff) => ff.id === dep);
        return depFeature?.status === "done";
      });
      if (allDepsDone && f.depends_on.length > 0) {
        issues.push(
          `${CYAN}INFO${RESET}: ${f.id} is marked "blocked" but all its dependencies are done`
        );
      }
    }
  }

  if (issues.length > 0) {
    console.log(`\n${BOLD}Diagnostics (${issues.length} issue${issues.length > 1 ? "s" : ""}):${RESET}`);
    for (const issue of issues) {
      console.log(`  ${issue}`);
    }
  }
}

function checkSubtaskDeps(
  subtasks: Subtask[],
  allIds: Set<string>,
  issues: string[]
): void {
  for (const st of subtasks) {
    for (const dep of st.depends_on) {
      if (!allIds.has(dep)) {
        issues.push(
          `${YELLOW}WARNING${RESET}: subtask ${st.id} depends on "${dep}" which does not exist`
        );
      }
    }
    checkSubtaskDeps(st.subtasks, allIds, issues);
  }
}

/**
 * Detect circular dependencies using DFS.
 * Returns arrays of ID paths that form cycles.
 */
function detectCycles(
  features: Feature[],
  includeSubtasks: boolean
): string[][] {
  // Build adjacency list: dep -> [dependents]
  const adj = new Map<string, string[]>();
  const allItems = new Map<string, { depends_on: string[] }>();

  for (const f of features) {
    allItems.set(f.id, f);
    if (includeSubtasks) {
      collectSubtaskItems(f.subtasks, allItems);
    }
  }

  for (const [id, item] of allItems) {
    for (const dep of item.depends_on) {
      if (!adj.has(id)) adj.set(id, []);
      adj.get(id)!.push(dep);
    }
  }

  const visited = new Set<string>();
  const inStack = new Set<string>();
  const cycles: string[][] = [];

  function dfs(node: string, path: string[]): void {
    if (inStack.has(node)) {
      // Found a cycle — extract it
      const cycleStart = path.indexOf(node);
      cycles.push([...path.slice(cycleStart), node]);
      return;
    }
    if (visited.has(node)) return;

    visited.add(node);
    inStack.add(node);
    path.push(node);

    for (const neighbor of adj.get(node) ?? []) {
      dfs(neighbor, path);
    }

    path.pop();
    inStack.delete(node);
  }

  for (const id of allItems.keys()) {
    if (!visited.has(id)) {
      dfs(id, []);
    }
  }

  return cycles;
}

function collectSubtaskItems(
  subtasks: Subtask[],
  map: Map<string, { depends_on: string[] }>
): void {
  for (const st of subtasks) {
    map.set(st.id, st);
    collectSubtaskItems(st.subtasks, map);
  }
}

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

export async function cmdFeaturesGraph(opts: FeaturesGraphOptions): Promise<void> {
  const { projectRoot, config } = opts;
  const data = loadFeatures(projectRoot, config);
  const fmt = opts.outputFmt ?? "text";

  const { source, nodeCount, edgeCount, orphanCount, orphans } = buildMermaidSource(data, {
    status: opts.status,
    subtasks: opts.subtasks,
  });

  if (nodeCount === 0 && orphanCount === 0) {
    output(fmt, { graph: null, nodes: 0, edges: 0, message: "No features to graph" }, () => {
      console.log("No features to graph.");
    });
    return;
  }

  // --mermaid: emit raw mermaid source
  if (opts.mermaid) {
    output(fmt, { mermaid: source || null, nodes: nodeCount, edges: edgeCount, orphans }, () => {
      if (source) {
        console.log(source);
      }
      if (orphans.length > 0) {
        console.log(`\n# ${orphans.length} orphan(s) with no dependency relationships:`);
        for (const o of orphans) {
          console.log(`# ${STATUS_BADGE[o.status]} ${o.id}: ${o.title}`);
        }
      }
    });
    return;
  }

  // --output json: emit structured data
  if (fmt === "json") {
    const rendered = source ? renderMermaidToTui(source, { ascii: true }) as string : null;
    console.log(
      JSON.stringify({
        mermaid: source || null,
        rendered,
        nodes: nodeCount,
        edges: edgeCount,
        orphan_count: orphanCount,
        orphans,
      })
    );
    return;
  }

  // Default: render the graph in the terminal
  console.log(`\n${BOLD}Feature Dependency Graph${RESET}`);

  if (nodeCount > 0 && source) {
    const rendered = renderMermaidToTui(source, { ascii: !!opts.ascii }) as string;
    console.log(`${DIM}${nodeCount} nodes, ${edgeCount} edges${RESET}\n`);
    console.log(rendered);
  } else {
    console.log(`${DIM}No dependency relationships found.${RESET}`);
  }

  // Print orphan summary
  if (orphans.length > 0) {
    console.log(`\n${BOLD}Standalone features${RESET} ${DIM}(${orphans.length} with no dependencies):${RESET}`);
    for (const o of orphans) {
      const badge = STATUS_BADGE[o.status];
      console.log(`  ${DIM}${badge}${RESET} ${o.id} ${DIM}— ${o.title}${RESET}`);
    }
  }

  // Print legend and diagnostics
  printLegend(data.features);
  printDiagnostics(data, !!opts.subtasks);
  console.log("");
}
