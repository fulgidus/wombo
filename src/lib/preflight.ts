/**
 * preflight.ts — Pre-launch confirmation dialog.
 *
 * Shows every launch — a confirmation step displaying:
 *   - Tasks being launched
 *   - Agent assignments (generalist or specialized)
 *   - Registry mode (auto/monitored/disabled)
 *   - Ability to change mode or reject specific agents
 *
 * Two implementations:
 *   - tuiPreflightConfirm()     — blessed screen (default, rich UI)
 *   - consolePreflightConfirm() — plain console fallback
 *
 * The preflight screen is destroyed before the monitoring TUI starts.
 */

import blessed from "neo-blessed";
import type { AgentResolution, ResolvedAgent } from "./agent-registry.js";
import { isSpecializedAgent } from "./agent-registry.js";
import type { Task } from "./tasks.js";
import type { AgentRegistryMode, WomboConfig } from "../config.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PreflightResult {
  /** Whether the user confirmed and wants to proceed */
  proceed: boolean;
  /**
   * Final agent assignments after user edits.
   * Task IDs mapped to their resolutions. Rejected agents are replaced
   * with generalist fallbacks (name: null).
   */
  agents: Map<string, AgentResolution>;
  /** Final registry mode (may differ from config if user changed it) */
  mode: AgentRegistryMode;
}

/** Row data for display */
interface PreflightRow {
  taskId: string;
  taskTitle: string;
  agentName: string; // display name: "generalist" or the specialized name
  agentType: string | null;
  isSpecialized: boolean;
  rejected: boolean;
}

// ---------------------------------------------------------------------------
// Console Preflight (fallback)
// ---------------------------------------------------------------------------

/**
 * Console-based preflight confirmation.
 * Displays the launch plan and asks for y/n confirmation.
 * Does NOT support interactive agent rejection (that's TUI-only).
 */
export async function consolePreflightConfirm(
  tasks: Task[],
  agents: Map<string, AgentResolution>,
  config: WomboConfig
): Promise<PreflightResult> {
  const mode = config.agentRegistry.mode;

  console.log(`\n${"═".repeat(60)}`);
  console.log(`  LAUNCH PREFLIGHT`);
  console.log(`${"═".repeat(60)}`);
  console.log(`  Registry mode: ${mode}`);
  console.log(`  Tasks: ${tasks.length}`);
  console.log(`${"─".repeat(60)}`);

  for (const task of tasks) {
    const resolution = agents.get(task.id);
    const agentLabel = resolution && isSpecializedAgent(resolution)
      ? `${resolution.name} (${resolution.fromCache ? "cached" : "fetched"})`
      : "generalist";
    console.log(`  ${task.id.padEnd(30)} → ${agentLabel}`);
  }

  console.log(`${"─".repeat(60)}`);

  // In non-interactive environments (piped stdin), just proceed
  if (!process.stdin.isTTY) {
    console.log(`  Non-interactive mode — proceeding automatically.\n`);
    return { proceed: true, agents, mode };
  }

  const answer = await new Promise<string>((resolve) => {
    process.stdout.write("  Proceed? [Y/n] ");
    process.stdin.setEncoding("utf-8");
    process.stdin.resume();
    process.stdin.once("data", (data) => {
      process.stdin.pause();
      resolve(data.toString().trim().toLowerCase());
    });
  });

  const proceed = answer === "" || answer === "y" || answer === "yes";
  if (!proceed) {
    console.log("  Launch cancelled.\n");
  }

  return { proceed, agents, mode };
}

// ---------------------------------------------------------------------------
// TUI Preflight (blessed)
// ---------------------------------------------------------------------------

/**
 * TUI-based preflight confirmation using blessed.
 *
 * Layout:
 *   ┌──────────────────────────────────────────┐
 *   │ LAUNCH PREFLIGHT           mode: auto    │
 *   ├──────────────────────────────────────────┤
 *   │ Task ID          Agent          Status   │
 *   │ ─────────────────────────────────────── │
 *   │ > my-task        frontend-dev   ✓       │
 *   │   other-task     generalist     ✓       │
 *   ├──────────────────────────────────────────┤
 *   │ Enter: launch  Tab: cycle mode  x: reject│
 *   │ Esc: cancel    ↑/↓: navigate             │
 *   └──────────────────────────────────────────┘
 *
 * In monitored mode, users can navigate tasks and press 'x' to reject
 * specific specialized agents (falling back to generalist).
 */
export function tuiPreflightConfirm(
  tasks: Task[],
  agents: Map<string, AgentResolution>,
  config: WomboConfig
): Promise<PreflightResult> {
  return new Promise((resolvePromise) => {
    let currentMode: AgentRegistryMode = config.agentRegistry.mode;
    let selectedIndex = 0;

    // Build rows
    const rows: PreflightRow[] = tasks.map((task) => {
      const resolution = agents.get(task.id);
      const specialized = resolution && isSpecializedAgent(resolution);
      return {
        taskId: task.id,
        taskTitle: task.title,
        agentName: specialized ? resolution.name : "generalist",
        agentType: specialized ? resolution.agentType : null,
        isSpecialized: !!specialized,
        rejected: false,
      };
    });

    // Create screen
    const screen = blessed.screen({
      smartCSR: true,
      title: "Wombo — Launch Preflight",
      fullUnicode: true,
    });

    // Header
    const header = blessed.box({
      top: 0,
      left: 0,
      width: "100%",
      height: 3,
      tags: true,
      content: "",
      style: { fg: "white", bg: "black" },
    });

    // Task table
    const table = blessed.list({
      top: 3,
      left: 0,
      width: "100%",
      height: "100%-6",
      tags: true,
      mouse: true,
      keys: true,
      scrollable: true,
      style: {
        selected: { fg: "black", bg: "white" },
        item: { fg: "white" },
      },
    });

    // Status bar
    const statusBar = blessed.box({
      bottom: 0,
      left: 0,
      width: "100%",
      height: 3,
      tags: true,
      content: "",
      style: { fg: "white", bg: "black" },
    });

    screen.append(header);
    screen.append(table);
    screen.append(statusBar);

    function updateDisplay(): void {
      // Header
      const modeColors: Record<AgentRegistryMode, string> = {
        auto: "green",
        monitored: "yellow",
        disabled: "red",
      };
      header.setContent(
        `{bold} LAUNCH PREFLIGHT{/bold}` +
        `{right}mode: {${modeColors[currentMode]}-fg}{bold}${currentMode}{/bold}{/${modeColors[currentMode]}-fg}  {/right}\n` +
        ` ${tasks.length} task(s) ready to launch`
      );

      // Table rows
      const items: string[] = rows.map((row, i) => {
        const cursor = i === selectedIndex ? "{bold}>{/bold}" : " ";
        const taskCol = row.taskId.substring(0, 28).padEnd(28);
        const agentCol = row.rejected
          ? `{red-fg}(rejected){/red-fg}`.padEnd(30)
          : row.isSpecialized
            ? `{cyan-fg}${row.agentName.substring(0, 20)}{/cyan-fg}`.padEnd(30)
            : `{gray-fg}generalist{/gray-fg}`.padEnd(30);
        const statusCol = row.rejected
          ? "{red-fg}✗{/red-fg}"
          : "{green-fg}✓{/green-fg}";
        return ` ${cursor} ${taskCol} ${agentCol} ${statusCol}`;
      });

      table.setItems(items);
      table.select(selectedIndex);

      // Status bar
      const specializedCount = rows.filter((r) => r.isSpecialized && !r.rejected).length;
      const rejectedCount = rows.filter((r) => r.rejected).length;
      const monitoredHint = currentMode === "monitored" ? "  {yellow-fg}x{/yellow-fg}: reject agent" : "";
      statusBar.setContent(
        ` {green-fg}Enter{/green-fg}: launch  {yellow-fg}Tab{/yellow-fg}: cycle mode  {red-fg}Esc{/red-fg}: cancel${monitoredHint}\n` +
        ` Specialized: ${specializedCount}  Generalist: ${rows.length - specializedCount}  Rejected: ${rejectedCount}`
      );

      screen.render();
    }

    function finish(proceed: boolean): void {
      screen.destroy();

      // Build final agent map with rejections applied
      const finalAgents = new Map<string, AgentResolution>(agents);
      for (const row of rows) {
        if (row.rejected) {
          finalAgents.set(row.taskId, {
            taskId: row.taskId,
            name: null,
            rawContent: null,
            fromCache: false,
            agentType: null,
          });
        }
      }

      resolvePromise({ proceed, agents: finalAgents, mode: currentMode });
    }

    // Key bindings
    screen.key(["escape", "C-c"], () => finish(false));
    screen.key(["enter"], () => finish(true));

    screen.key(["tab"], () => {
      const modes: AgentRegistryMode[] = ["auto", "monitored", "disabled"];
      const idx = modes.indexOf(currentMode);
      currentMode = modes[(idx + 1) % modes.length];
      updateDisplay();
    });

    screen.key(["up", "k"], () => {
      selectedIndex = Math.max(0, selectedIndex - 1);
      updateDisplay();
    });

    screen.key(["down", "j"], () => {
      selectedIndex = Math.min(rows.length - 1, selectedIndex + 1);
      updateDisplay();
    });

    screen.key(["x"], () => {
      if (currentMode !== "monitored") return; // reject only in monitored mode
      const row = rows[selectedIndex];
      if (row && row.isSpecialized) {
        row.rejected = !row.rejected; // toggle
        updateDisplay();
      }
    });

    // Initial render
    updateDisplay();
    table.focus();
  });
}
