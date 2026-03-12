/**
 * dependency-graph.ts — Dependency graph construction, cycle detection, and
 * topological ordering for dependency-aware sequential scheduling.
 *
 * Responsibilities:
 *   - Parse depends_on fields across all features to build a DAG
 *   - Detect circular dependencies and report them before launch
 *   - Compute topological ordering for sequential scheduling
 *   - Identify dependency chains (A -> B -> C) for same-worktree reuse
 *   - Identify diamond dependencies (C depends on both A and B)
 *   - Group features into independent streams for parallel execution
 *
 * IMPORTANT: All dependency resolution is fully programmatic — no LLM calls.
 */

import type { Feature, FeaturesFile } from "./features.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * A node in the dependency graph. Wraps a Feature with graph metadata.
 */
export interface DepGraphNode {
  /** Feature ID */
  id: string;
  /** The underlying feature */
  feature: Feature;
  /** IDs this feature depends on (predecessors) */
  dependsOn: string[];
  /** IDs that depend on this feature (successors) */
  dependedOnBy: string[];
}

/**
 * Result of building the dependency graph.
 */
export interface DepGraph {
  /** All nodes keyed by feature ID */
  nodes: Map<string, DepGraphNode>;
  /** Topological ordering (features sorted so deps come before dependents) */
  topologicalOrder: string[];
  /** Detected cycles (each is a path of IDs forming the cycle) */
  cycles: string[][];
  /** Dangling dependency references (depend on IDs that don't exist in the selected set) */
  danglingDeps: Array<{ featureId: string; missingDep: string }>;
  /** Root nodes (features with no dependencies) */
  roots: string[];
  /** Leaf nodes (features with no dependents) */
  leaves: string[];
}

/**
 * A chain of features that form a linear dependency sequence.
 * These should be executed sequentially in the same worktree.
 */
export interface DepChain {
  /** Feature IDs in execution order (first has no deps within the chain) */
  featureIds: string[];
}

/**
 * A scheduling plan that groups features into parallel streams
 * and sequential chains within those streams.
 */
export interface SchedulePlan {
  /**
   * Independent streams that can run in parallel.
   * Each stream is a chain of features to execute sequentially.
   */
  streams: DepChain[];
  /**
   * Features that have diamond dependencies (depend on features from
   * multiple different streams). These must wait until all their
   * dependencies are verified/merged before starting.
   */
  mergeGates: MergeGate[];
  /**
   * Topological order of all features for reference.
   */
  topologicalOrder: string[];
}

/**
 * A merge gate for diamond dependencies.
 * Feature C depends on A (stream 1) and B (stream 2).
 * C cannot start until both A and B are verified/merged.
 */
export interface MergeGate {
  /** The feature that must wait */
  featureId: string;
  /** The features it depends on (from different streams) */
  waitFor: string[];
}

// ---------------------------------------------------------------------------
// Graph Construction
// ---------------------------------------------------------------------------

/**
 * Build a dependency graph from a set of features.
 *
 * @param features - The features to include in the graph (typically selected features)
 * @param allFeatures - All features in the features file (for resolving external deps)
 * @returns The constructed dependency graph with cycle detection results
 */
export function buildDepGraph(
  features: Feature[],
  allFeatures?: Feature[]
): DepGraph {
  const nodes = new Map<string, DepGraphNode>();
  const selectedIds = new Set(features.map((f) => f.id));
  const allIds = new Set(
    allFeatures ? allFeatures.map((f) => f.id) : features.map((f) => f.id)
  );

  // Create nodes for all selected features
  for (const feature of features) {
    nodes.set(feature.id, {
      id: feature.id,
      feature,
      dependsOn: [...(feature.depends_on ?? [])],
      dependedOnBy: [],
    });
  }

  // Build reverse edges (dependedOnBy) and detect dangling deps
  const danglingDeps: Array<{ featureId: string; missingDep: string }> = [];

  for (const [id, node] of nodes) {
    for (const dep of node.dependsOn) {
      if (nodes.has(dep)) {
        // Both endpoints are in our selected set — add reverse edge
        nodes.get(dep)!.dependedOnBy.push(id);
      } else if (!allIds.has(dep)) {
        // Dependency doesn't exist at all
        danglingDeps.push({ featureId: id, missingDep: dep });
      }
      // If dep exists in allFeatures but not in selected set,
      // it's an external dependency — not dangling, just not in scope
    }
  }

  // Detect cycles using DFS
  const cycles = detectCycles(nodes);

  // Compute topological order (only valid if no cycles)
  const topologicalOrder = cycles.length === 0
    ? computeTopologicalOrder(nodes)
    : [];

  // Find roots and leaves
  const roots: string[] = [];
  const leaves: string[] = [];
  for (const [id, node] of nodes) {
    // A root has no dependencies within the selected set
    const internalDeps = node.dependsOn.filter((d) => selectedIds.has(d));
    if (internalDeps.length === 0) {
      roots.push(id);
    }
    if (node.dependedOnBy.length === 0) {
      leaves.push(id);
    }
  }

  return {
    nodes,
    topologicalOrder,
    cycles,
    danglingDeps,
    roots,
    leaves,
  };
}

// ---------------------------------------------------------------------------
// Cycle Detection (DFS-based)
// ---------------------------------------------------------------------------

/**
 * Detect cycles in the dependency graph using iterative DFS with coloring.
 * Returns arrays of ID paths that form cycles.
 *
 * Uses three-color marking:
 * - WHITE (unvisited)
 * - GRAY (in current DFS stack)
 * - BLACK (fully processed)
 */
function detectCycles(nodes: Map<string, DepGraphNode>): string[][] {
  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;

  const color = new Map<string, number>();
  const parent = new Map<string, string | null>();
  const cycles: string[][] = [];

  for (const id of nodes.keys()) {
    color.set(id, WHITE);
  }

  for (const startId of nodes.keys()) {
    if (color.get(startId) !== WHITE) continue;

    // Iterative DFS
    const stack: Array<{ id: string; depIdx: number }> = [
      { id: startId, depIdx: 0 },
    ];
    color.set(startId, GRAY);
    parent.set(startId, null);

    while (stack.length > 0) {
      const top = stack[stack.length - 1];
      const node = nodes.get(top.id);

      if (!node) {
        stack.pop();
        continue;
      }

      // Only consider dependencies that exist in our graph
      const internalDeps = node.dependsOn.filter((d) => nodes.has(d));

      if (top.depIdx < internalDeps.length) {
        const dep = internalDeps[top.depIdx];
        top.depIdx++;

        const depColor = color.get(dep);
        if (depColor === WHITE) {
          color.set(dep, GRAY);
          parent.set(dep, top.id);
          stack.push({ id: dep, depIdx: 0 });
        } else if (depColor === GRAY) {
          // Found a cycle — extract the cycle path
          const cyclePath: string[] = [dep];
          let current = top.id;
          while (current !== dep) {
            cyclePath.push(current);
            current = parent.get(current)!;
          }
          cyclePath.push(dep);
          cyclePath.reverse();
          cycles.push(cyclePath);
        }
        // BLACK nodes are already fully processed — skip
      } else {
        // All deps processed — mark as BLACK
        color.set(top.id, BLACK);
        stack.pop();
      }
    }
  }

  return cycles;
}

// ---------------------------------------------------------------------------
// Topological Sort (Kahn's Algorithm)
// ---------------------------------------------------------------------------

/**
 * Compute topological ordering using Kahn's algorithm (BFS-based).
 * Returns feature IDs in dependency order (deps come first).
 *
 * Precondition: the graph must be acyclic.
 */
function computeTopologicalOrder(nodes: Map<string, DepGraphNode>): string[] {
  // Calculate in-degree for each node (only counting internal deps)
  const inDegree = new Map<string, number>();
  for (const [id, node] of nodes) {
    const internalDeps = node.dependsOn.filter((d) => nodes.has(d));
    inDegree.set(id, internalDeps.length);
  }

  // Start with nodes that have zero in-degree (roots)
  const queue: string[] = [];
  for (const [id, degree] of inDegree) {
    if (degree === 0) {
      queue.push(id);
    }
  }

  // Sort queue for deterministic ordering (by feature ID)
  queue.sort();

  const result: string[] = [];

  while (queue.length > 0) {
    const id = queue.shift()!;
    result.push(id);

    const node = nodes.get(id)!;
    for (const dependent of node.dependedOnBy) {
      const currentDegree = inDegree.get(dependent)!;
      inDegree.set(dependent, currentDegree - 1);
      if (currentDegree - 1 === 0) {
        queue.push(dependent);
        // Re-sort to maintain deterministic ordering
        queue.sort();
      }
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Scheduling Plan Construction
// ---------------------------------------------------------------------------

/**
 * Build a scheduling plan from a dependency graph.
 *
 * Groups features into:
 * 1. **Streams**: Linear chains of dependent features that execute sequentially
 *    in the same worktree. A -> B -> C becomes one stream.
 * 2. **Merge gates**: Features with diamond dependencies that must wait for
 *    multiple streams to complete. If C depends on A (stream 1) and B (stream 2),
 *    C gets a merge gate.
 *
 * Features with no dependencies and no dependents run as single-feature streams.
 */
export function buildSchedulePlan(graph: DepGraph): SchedulePlan {
  if (graph.cycles.length > 0) {
    throw new Error(
      `Cannot build schedule plan: circular dependencies detected:\n` +
      graph.cycles.map((c) => `  ${c.join(" -> ")}`).join("\n")
    );
  }

  const selectedIds = new Set(graph.nodes.keys());
  const mergeGates: MergeGate[] = [];
  const assigned = new Set<string>();

  // Identify diamond dependencies first:
  // A feature has a diamond dep if it depends on features that belong to
  // different independent sub-graphs (or multiple chains).
  // Strategy: walk the topological order and group features into chains.

  // Step 1: Build chains by following single-dependency paths.
  // A chain is a maximal sequence where each feature has exactly one
  // internal predecessor and that predecessor has exactly one internal successor.
  const chains: DepChain[] = [];

  // Find chain starts: features that either have no internal deps, or whose
  // internal deps have multiple dependents (branch point), or that have
  // multiple internal deps (merge point / diamond).
  for (const id of graph.topologicalOrder) {
    if (assigned.has(id)) continue;

    const node = graph.nodes.get(id)!;
    const internalDeps = node.dependsOn.filter((d) => selectedIds.has(d));

    // Diamond dependency: depends on multiple features
    if (internalDeps.length > 1) {
      mergeGates.push({
        featureId: id,
        waitFor: [...internalDeps],
      });
      // Don't add to any chain yet — it will be its own chain starting
      // after the gate opens. But we need to continue from it.
      // Start a new chain from this node
      const chain = buildChainFrom(id, graph, selectedIds, assigned);
      if (chain.featureIds.length > 0) {
        chains.push(chain);
      }
      continue;
    }

    // If this feature has no internal deps, start a new chain from it
    if (internalDeps.length === 0) {
      const chain = buildChainFrom(id, graph, selectedIds, assigned);
      if (chain.featureIds.length > 0) {
        chains.push(chain);
      }
      continue;
    }

    // Single internal dep — check if the dep has already been assigned
    // (meaning we're starting a new branch)
    const depId = internalDeps[0];
    const depNode = graph.nodes.get(depId);
    if (!depNode) continue;

    // If the dep has multiple internal successors, this is a branch point.
    // This feature starts a new chain.
    const depInternalSuccessors = depNode.dependedOnBy.filter((d) =>
      selectedIds.has(d)
    );
    if (depInternalSuccessors.length > 1 && !assigned.has(id)) {
      const chain = buildChainFrom(id, graph, selectedIds, assigned);
      if (chain.featureIds.length > 0) {
        chains.push(chain);
      }
      continue;
    }

    // Otherwise, this feature should have been picked up by its chain start
    if (!assigned.has(id)) {
      const chain = buildChainFrom(id, graph, selectedIds, assigned);
      if (chain.featureIds.length > 0) {
        chains.push(chain);
      }
    }
  }

  return {
    streams: chains,
    mergeGates,
    topologicalOrder: [...graph.topologicalOrder],
  };
}

/**
 * Build a linear chain starting from a given feature ID.
 * Follows the single-successor path as long as each successor has
 * exactly one internal dependency and the predecessor has exactly one
 * internal successor.
 */
function buildChainFrom(
  startId: string,
  graph: DepGraph,
  selectedIds: Set<string>,
  assigned: Set<string>
): DepChain {
  const chain: string[] = [];
  let currentId: string | null = startId;

  while (currentId && !assigned.has(currentId)) {
    assigned.add(currentId);
    chain.push(currentId);

    const node: DepGraphNode = graph.nodes.get(currentId)!;
    const internalSuccessors: string[] = node.dependedOnBy.filter(
      (d: string) => selectedIds.has(d)
    );

    if (internalSuccessors.length === 1) {
      const nextId: string = internalSuccessors[0];
      const nextNode: DepGraphNode = graph.nodes.get(nextId)!;
      const nextInternalDeps: string[] = nextNode.dependsOn.filter(
        (d: string) => selectedIds.has(d)
      );

      // Only continue the chain if the next node has exactly one dep (us)
      if (nextInternalDeps.length === 1 && !assigned.has(nextId)) {
        currentId = nextId;
      } else {
        currentId = null;
      }
    } else {
      // Multiple successors (branch point) or no successors (leaf) — end chain
      currentId = null;
    }
  }

  return { featureIds: chain };
}

// ---------------------------------------------------------------------------
// Validation Helpers
// ---------------------------------------------------------------------------

/**
 * Validate the dependency graph before launching.
 * Throws descriptive errors if there are cycles or dangling deps.
 *
 * @returns The validated DepGraph (for chaining)
 */
export function validateDepGraph(graph: DepGraph): DepGraph {
  const errors: string[] = [];

  if (graph.cycles.length > 0) {
    errors.push("Circular dependencies detected:");
    for (const cycle of graph.cycles) {
      errors.push(`  ${cycle.join(" → ")}`);
    }
  }

  if (graph.danglingDeps.length > 0) {
    errors.push("Dangling dependencies (reference non-existent features):");
    for (const { featureId, missingDep } of graph.danglingDeps) {
      errors.push(`  ${featureId} depends on "${missingDep}" which does not exist`);
    }
  }

  if (errors.length > 0) {
    throw new Error(
      `Dependency graph validation failed:\n${errors.join("\n")}`
    );
  }

  return graph;
}

/**
 * Format the scheduling plan as a human-readable summary.
 */
export function formatSchedulePlan(plan: SchedulePlan): string {
  const lines: string[] = [];

  lines.push(`Schedule Plan: ${plan.streams.length} stream(s), ${plan.mergeGates.length} merge gate(s)\n`);

  for (let i = 0; i < plan.streams.length; i++) {
    const stream = plan.streams[i];
    if (stream.featureIds.length === 1) {
      lines.push(`  Stream ${i + 1}: ${stream.featureIds[0]}`);
    } else {
      lines.push(
        `  Stream ${i + 1}: ${stream.featureIds.join(" → ")}`
      );
    }
  }

  if (plan.mergeGates.length > 0) {
    lines.push("");
    lines.push("  Merge Gates:");
    for (const gate of plan.mergeGates) {
      lines.push(
        `    ${gate.featureId} waits for: ${gate.waitFor.join(", ")}`
      );
    }
  }

  return lines.join("\n");
}

/**
 * Get the stream index that a feature belongs to.
 * Returns -1 if the feature is not in any stream.
 */
export function getStreamForFeature(
  plan: SchedulePlan,
  featureId: string
): number {
  for (let i = 0; i < plan.streams.length; i++) {
    if (plan.streams[i].featureIds.includes(featureId)) {
      return i;
    }
  }
  return -1;
}

/**
 * Check if a feature's dependencies are all satisfied within the scheduling context.
 * A dependency is satisfied if:
 * - It's not in the selected set (external dep, assumed done) OR
 * - It's in the completedIds set (verified/merged)
 *
 * @param featureId - The feature to check
 * @param graph - The dependency graph
 * @param completedIds - Set of feature IDs that have been completed (verified/merged)
 * @returns true if all dependencies are satisfied
 */
export function areDepsReady(
  featureId: string,
  graph: DepGraph,
  completedIds: Set<string>
): boolean {
  const node = graph.nodes.get(featureId);
  if (!node) return true;

  const selectedIds = new Set(graph.nodes.keys());

  for (const dep of node.dependsOn) {
    if (selectedIds.has(dep) && !completedIds.has(dep)) {
      return false;
    }
  }
  return true;
}
