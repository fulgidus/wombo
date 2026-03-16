/**
 * launcher.ts — Process spawning and tmux session management.
 *
 * Responsibilities:
 *   - Launch agent in headless mode (agent run --format json)
 *   - Launch agent in interactive mode (tmux session with TUI)
 *   - Resume sessions for auto-retry
 *   - Manage tmux sessions (create, list, kill)
 *
 * ## Agent Process Lifecycle (audit: wave-detach-audit)
 *
 * **Headless mode** (`launchHeadless`, `retryHeadless`, `launchConflictResolver`):
 *   - Agents are spawned with `detached: false` — they are child processes of
 *     the wombo parent and will be terminated when the parent exits.
 *   - `unref()` is NOT called — the child holds the parent's event loop alive,
 *     which is required for the ProcessMonitor to receive stdout/stderr events.
 *   - `stdio` is `["pipe", "pipe", "pipe"]` — stdout is piped for JSON event
 *     parsing by ProcessMonitor. This further ties the child to the parent.
 *   - **Consequence**: If the parent is killed (SIGKILL, crash, OOM), headless
 *     agents die immediately with no state saved. The SIGINT/SIGTERM handlers
 *     in launch.ts and resume.ts mitigate this for graceful shutdowns by
 *     calling `monitor.killAll()` and `saveState()` before exiting.
 *   - **Recovery**: `woco resume` detects dead-but-productive agents (worktree
 *     exists with commits) and runs build verification on their output, or
 *     re-launches agents that died without producing code.
 *
 * **Interactive mode** (`launchInteractive`):
 *   - Agents run inside tmux sessions, which are independent of the
 *     parent process. They survive parent death naturally.
 *   - The `process` field in LaunchResult is `null as any` — no direct
 *     ChildProcess handle exists. PID is obtained via `tmuxGetPanePid()`.
 *
 * **Design rationale for `detached: false`**:
 *   Headless agents MUST have their stdout piped to the parent for real-time
 *   JSON event parsing (session ID extraction, completion detection, activity
 *   tracking). Using `detached: true` + `unref()` would allow agents to
 *   outlive the parent, but the piped stdio streams would break when the
 *   parent exits, potentially causing agent crashes or lost output. The
 *   current design trades survivability for reliable monitoring. If agent
 *   persistence across parent restarts is needed, the interactive (tmux)
 *   mode should be used instead.
 */

import { spawn, execSync, type ChildProcess } from "node:child_process";
import { writeFileSync, unlinkSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import type { WomboConfig } from "../config";
import { resolveAgentBin } from "../config";
import {
  ensureTmux,
  tmuxNewSession,
  tmuxHasSession,
  tmuxKillSession,
  tmuxListSessions,
  tmuxGetPanePid,
  tmuxLoadBuffer,
  tmuxPasteBuffer,
  tmuxSendKeys,
} from "./tmux";
import { portlessEnv } from "./portless";
import { hitlDir } from "./hitl-channel";
import { resolve, dirname, join, basename } from "node:path";

// ---------------------------------------------------------------------------
// Agent Type Detection
// ---------------------------------------------------------------------------

/**
 * Supported agent CLI types. Each has different CLI argument syntax:
 *
 * - **opencode**: TUI via `opencode [project]` (positional path),
 *   headless via `opencode run --dir PATH --format json`.
 *   `--dir` is ONLY valid on the `run` subcommand.
 *
 * - **claude**: TUI via `claude` (uses cwd, no path flag),
 *   headless via `claude -p --output-format stream-json`.
 *   Has NO `--dir` flag — always uses cwd.
 *
 * - **unknown**: Falls back to opencode-style args.
 */
export type AgentType = "opencode" | "claude" | "unknown";

/**
 * Detect agent type from the resolved binary path.
 *
 * Inspects the basename of the binary (stripping extension) to determine
 * whether it's opencode or claude. This is intentionally simple — we match
 * on the binary name, not on probing `--help` output.
 */
export function detectAgentType(binPath: string): AgentType {
  const name = basename(binPath).replace(/\.(exe|cmd|bat)$/i, "").toLowerCase();
  if (name === "opencode" || name.startsWith("opencode")) return "opencode";
  if (name === "claude" || name.startsWith("claude")) return "claude";
  return "unknown";
}

// ---------------------------------------------------------------------------
// Fake Agent
// ---------------------------------------------------------------------------

/**
 * Sentinel agent name that triggers the built-in fake-agent-runner instead of
 * the real agent binary. Tasks with `agent: "fake-agent"` are executed by
 * `src/lib/fake-agent-runner.ts` — zero LLM calls, deterministic commits,
 * configurable sleep duration via FAKE_SLEEP_MS in the prompt.
 */
export const FAKE_AGENT_SENTINEL = "fake-agent";

/**
 * Resolve the fake-agent-runner script path relative to this module.
 * Both files live in `src/lib/`, so we use `import.meta.dir` to get a
 * stable path regardless of how wombo-combo was installed.
 */
function resolveFakeAgentBin(): string {
  // import.meta.dir gives the directory of the current source file in Bun
  return join(import.meta.dir, "fake-agent-runner.ts");
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface LaunchResult {
  pid: number;
  process: ChildProcess;
  sessionId?: string;
}

export interface LaunchOptions {
  worktreePath: string;
  featureId: string;
  prompt: string;
  model?: string;
  interactive?: boolean;
  config: WomboConfig;
  /** Override the agent name (for specialized agents from the registry) */
  agentName?: string;
  /** HITL mode for this agent (from quest or config) */
  hitlMode?: string;
  /** Project root (for HITL directory path) */
  projectRoot?: string;
}

export interface RetryOptions {
  worktreePath: string;
  featureId: string;
  sessionId: string;
  buildErrors: string;
  model?: string;
  interactive?: boolean;
  config: WomboConfig;
  /** HITL mode for this agent (from quest or config) */
  hitlMode?: string;
  /** Project root (for HITL directory path) */
  projectRoot?: string;
  /** Agent name (used to detect fake-agent sentinel) */
  agentName?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Get the tmux session name for a feature.
 */
function tmuxSessionName(featureId: string, config: WomboConfig): string {
  return `${config.agent.tmuxPrefix}-${featureId}`;
}

/**
 * Ensure tmux is available for this config.
 */
function checkTmux(): void {
  ensureTmux();
}

function runSilent(cmd: string): string {
  try {
    return execSync(cmd, { encoding: "utf-8", stdio: "pipe" }).trim();
  } catch {
    return "";
  }
}

/**
 * Maximum prompt size (in bytes) that can safely be passed as a CLI argument.
 * Linux's ARG_MAX is ~2MB, but env vars also count against it. Using 128KB
 * as a safe threshold leaves ample room for environment variables.
 */
const PROMPT_ARG_MAX = 128 * 1024;

/**
 * Spawn an agent process, passing the prompt either as a CLI argument (small
 * prompts) or via stdin (large prompts). This prevents E2BIG errors from
 * exceeding the OS argument length limit.
 *
 * @returns The spawned child process
 */
function spawnWithPrompt(
  agentBin: string,
  args: string[],
  prompt: string,
  spawnOpts: {
    cwd?: string;
    env?: Record<string, string | undefined>;
  }
): ChildProcess {
  const promptBytes = Buffer.byteLength(prompt, "utf-8");

  if (promptBytes <= PROMPT_ARG_MAX) {
    // Small prompt — pass as CLI argument (simpler, more reliable)
    const child = spawn(agentBin, [...args, prompt], {
      stdio: ["pipe", "pipe", "pipe"],
      detached: false,
      cwd: spawnOpts.cwd,
      env: spawnOpts.env,
    });
    child.stdin?.end();
    return child;
  }

  // Large prompt — write to temp file and pipe via stdin to avoid E2BIG
  const tmpDir = mkdtempSync(join(tmpdir(), "woco-prompt-"));
  const tmpFile = join(tmpDir, "prompt.txt");
  writeFileSync(tmpFile, prompt);

  const child = spawn(agentBin, args, {
    stdio: ["pipe", "pipe", "pipe"],
    detached: false,
    cwd: spawnOpts.cwd,
    env: spawnOpts.env,
  });

  // Pipe the prompt via stdin
  child.stdin?.write(prompt);
  child.stdin?.end();

  // Clean up temp file after process exits (or after 60s as fallback)
  const cleanup = () => {
    try { unlinkSync(tmpFile); } catch {}
    try { unlinkSync(tmpDir); } catch {}
  };
  child.on("exit", cleanup);
  setTimeout(cleanup, 60_000);

  console.log(`[launcher] Prompt too large for CLI arg (${Math.round(promptBytes / 1024)}KB) — piped via stdin`);

  return child;
}

/**
 * Build environment variables for an agent process.
 * Merges process.env with OPENCODE_DIR, portless env vars, and HITL env vars.
 */
function agentEnv(
  worktreePath: string,
  featureId: string,
  config: WomboConfig,
  hitlMode?: string,
  projectRoot?: string
): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {
    ...process.env,
    OPENCODE_DIR: worktreePath,
    ...portlessEnv(featureId, config),
  };

  // HITL environment — always set so the hitl-ask script is available,
  // but the prompt controls whether the agent actually uses it.
  if (projectRoot) {
    env.WOMBO_HITL_DIR = hitlDir(projectRoot);
    env.WOMBO_AGENT_ID = featureId;
    env.WOMBO_HITL_MODE = hitlMode ?? "yolo";
    // Path to the hitl-ask script (relative to this module)
    // In development: src/lib/hitl-ask.ts
    // In production (bundled): same dir as this file
    const hitlAskPath = resolve(import.meta.dir, "hitl-ask.ts");
    env.WOMBO_HITL_ASK = hitlAskPath;
  }

  return env;
}

// ---------------------------------------------------------------------------
// Headless Launch
// ---------------------------------------------------------------------------

/**
 * Launch agent in headless mode with JSON output.
 *
 * The child process is spawned with `detached: false` — it is tied to the
 * parent process and will die when the parent exits. This is intentional:
 * stdout must be piped for ProcessMonitor to parse JSON events in real-time.
 * See module-level documentation for the full lifecycle analysis.
 */
export function launchHeadless(opts: LaunchOptions): LaunchResult {
  const isFake = opts.agentName === FAKE_AGENT_SENTINEL;
  const agentBin = isFake ? "bun" : resolveAgentBin(opts.config);
  const agentType = isFake ? "unknown" : detectAgentType(agentBin);

  const args: string[] = [];

  // When using fake-agent, the binary is `bun` and first arg is the script path
  if (isFake) {
    args.push(resolveFakeAgentBin());
  }

  // Agent-type-specific headless CLI construction:
  //
  // opencode: `opencode run --format json --agent NAME --dir PATH --title TITLE PROMPT`
  // claude:   `claude -p --output-format stream-json --agent NAME PROMPT`
  //           (uses cwd for directory, set via spawn options)
  //
  if (agentType === "claude") {
    args.push(
      "-p",
      "--output-format", "stream-json",
      "--agent", opts.agentName ?? opts.config.agent.name,
    );
  } else {
    // opencode / unknown / fake-agent
    args.push(
      "run",
      "--format", "json",
      "--agent", opts.agentName ?? opts.config.agent.name,
      "--dir", opts.worktreePath,
      "--title", `woco: ${opts.featureId}`,
    );
  }

  if (opts.model) {
    args.push("--model", opts.model);
  }

  const child = spawnWithPrompt(agentBin, args, opts.prompt, {
    cwd: agentType === "claude" ? opts.worktreePath : undefined,
    env: agentEnv(opts.worktreePath, opts.featureId, opts.config, opts.hitlMode, opts.projectRoot),
  });

  return {
    pid: child.pid!,
    process: child,
  };
}

/**
 * Resume a headless session with a retry message (build errors).
 *
 * Same lifecycle as `launchHeadless` — spawned with `detached: false`,
 * piped stdio, no `unref()`. The child is tied to the parent process.
 */
export function retryHeadless(opts: RetryOptions): LaunchResult {
  const isFake = opts.agentName === FAKE_AGENT_SENTINEL;
  const agentBin = isFake ? "bun" : resolveAgentBin(opts.config);
  const agentType = isFake ? "unknown" : detectAgentType(agentBin);

  const retryMessage = `The build failed. Please fix the following errors and run \`${opts.config.build.command}\` again:\n\n\`\`\`\n${opts.buildErrors}\n\`\`\`\n\nFix all errors, then verify the build passes.`;

  const args: string[] = [];

  if (isFake) {
    args.push(resolveFakeAgentBin());
  }

  // Agent-type-specific retry CLI construction:
  //
  // opencode: `opencode run --format json --session ID --continue --dir PATH MSG`
  // claude:   `claude -p --output-format stream-json --resume ID --continue MSG`
  //           (uses cwd for directory)
  //
  if (agentType === "claude") {
    args.push(
      "-p",
      "--output-format", "stream-json",
      "--resume", opts.sessionId,
      "--continue",
    );
  } else {
    // opencode / unknown / fake-agent
    args.push(
      "run",
      "--format", "json",
      "--session", opts.sessionId,
      "--continue",
      "--dir", opts.worktreePath,
    );
  }

  if (opts.model) {
    args.push("--model", opts.model);
  }

  const child = spawnWithPrompt(agentBin, args, retryMessage, {
    cwd: agentType === "claude" ? opts.worktreePath : undefined,
    env: agentEnv(opts.worktreePath, opts.featureId, opts.config, opts.hitlMode, opts.projectRoot),
  });

  return {
    pid: child.pid!,
    process: child,
  };
}

// ---------------------------------------------------------------------------
// Conflict Resolution Launch
// ---------------------------------------------------------------------------

export interface ConflictResolverOptions {
  worktreePath: string;
  featureId: string;
  prompt: string;
  model?: string;
  config: WomboConfig;
  /** Override the agent name for conflict resolution (default: merge-resolver-agent) */
  agentName?: string;
}

/**
 * Launch a headless agent to resolve merge conflicts.
 *
 * This is similar to `launchHeadless`, but the prompt is a conflict-resolution
 * prompt generated by `generateConflictResolutionPrompt()`. The agent runs in
 * the feature worktree where `git merge <baseBranch>` has already been run,
 * leaving conflict markers in the working tree.
 *
 * By default uses the specialized "merge-resolver-agent" definition, which
 * has minimal context and is focused solely on conflict resolution. Falls back
 * to the generalist agent if no merge-resolver-agent is available.
 *
 * Same lifecycle as `launchHeadless` — spawned with `detached: false`,
 * piped stdio, no `unref()`. Note: conflict resolver processes are NOT
 * added to the ProcessMonitor (to avoid infinite recursion with
 * handleBuildVerification). They are awaited directly via process.on('exit').
 */
export function launchConflictResolver(opts: ConflictResolverOptions): LaunchResult {
  const agentBin = resolveAgentBin(opts.config);
  const agentType = detectAgentType(agentBin);

  // Use the specialized merge-resolver agent by default
  const agentName = opts.agentName ?? "merge-resolver-agent";

  // Agent-type-specific conflict resolver CLI:
  //
  // opencode: `opencode run --format json --agent NAME --dir PATH --title TITLE PROMPT`
  // claude:   `claude -p --output-format stream-json --agent NAME PROMPT`
  //
  const args: string[] = [];

  if (agentType === "claude") {
    args.push(
      "-p",
      "--output-format", "stream-json",
      "--agent", agentName,
    );
  } else {
    args.push(
      "run",
      "--format", "json",
      "--agent", agentName,
      "--dir", opts.worktreePath,
      "--title", `woco: conflict-resolve ${opts.featureId}`,
    );
  }

  if (opts.model) {
    args.push("--model", opts.model);
  }

  const child = spawnWithPrompt(agentBin, args, opts.prompt, {
    cwd: agentType === "claude" ? opts.worktreePath : undefined,
    env: agentEnv(opts.worktreePath, opts.featureId, opts.config),
  });

  return {
    pid: child.pid!,
    process: child,
  };
}

// ---------------------------------------------------------------------------
// Interactive (tmux) Launch
// ---------------------------------------------------------------------------

/**
 * Launch agent in a tmux session for interactive use.
 *
 * Unlike headless mode, the agent runs inside a tmux session that is
 * fully independent of the parent process. The session survives parent death,
 * SIGINT, and crashes. The trade-off is that there is no direct ChildProcess
 * handle — monitoring is limited to checking the pane PID and session existence.
 *
 * The returned `process` field is `null as any` because the agent is managed
 * by tmux, not by Node's child_process module.
 */
export function launchInteractive(opts: LaunchOptions): LaunchResult {
  const agentBin = resolveAgentBin(opts.config);
  const agentType = detectAgentType(agentBin);
  checkTmux();
  const sessionName = tmuxSessionName(opts.featureId, opts.config);

  // Kill existing session if any
  killMuxSession(opts.featureId, opts.config);

  // Build the agent command to run inside the tmux session.
  // Include portless env vars so any server started in the session
  // is routed through the portless proxy.
  const pEnv = portlessEnv(opts.featureId, opts.config);
  const envPrefix = Object.entries(pEnv)
    .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
    .join(" ");

  // Agent-type-specific CLI arg construction:
  //
  // opencode TUI: `opencode [project]`
  //   - Path is a POSITIONAL argument (NOT --dir, which is only for `run`)
  //   - Supports --agent, --model, --session, --continue
  //
  // claude TUI: `claude`
  //   - Has NO --dir flag at all — uses the cwd of the process
  //   - The cwd is set by tmuxNewSession's cwd parameter
  //   - Supports --agent, --model, --resume, --continue
  //
  const ocArgs = [agentBin];

  if (agentType === "opencode" || agentType === "unknown") {
    // opencode: project path is a positional argument
    ocArgs.push(JSON.stringify(opts.worktreePath));
  }
  // claude: no path arg needed — tmuxNewSession sets cwd to worktreePath

  // Pass agent name if specified (specialized agent from registry or per-task override)
  if (opts.agentName) {
    ocArgs.push("--agent", JSON.stringify(opts.agentName));
  }

  if (opts.model) {
    ocArgs.push("--model", JSON.stringify(opts.model));
  }

  const tmuxCmd = envPrefix ? `${envPrefix} ${ocArgs.join(" ")}` : ocArgs.join(" ");

  // Create a detached session running the agent
  // Note: cwd is set to worktreePath — this handles claude's path requirement
  // and also provides a sensible fallback cwd for opencode.
  tmuxNewSession(sessionName, opts.worktreePath, tmuxCmd);

  // Send the prompt as initial message after a brief delay
  setTimeout(() => {
    try {
      const tmpFile = `/tmp/woco-prompt-${opts.featureId}.txt`;
      writeFileSync(tmpFile, opts.prompt);
      tmuxLoadBuffer(tmpFile);
      tmuxPasteBuffer(sessionName);
      tmuxSendKeys(sessionName, "Enter");
      try { unlinkSync(tmpFile); } catch {}
    } catch (err: any) {
      // If prompt sending fails, user can type manually — but log it so
      // debugging "why didn't my agent get the prompt?" isn't a mystery
      console.warn(`[launcher] Failed to send prompt to tmux session ${sessionName}: ${err?.message ?? err}`);
    }
  }, 3000);

  // Get the PID of the pane process
  const panePid = tmuxGetPanePid(sessionName);

  return {
    pid: panePid,
    process: null as any, // No direct process handle in tmux mode
  };
}

/**
 * Resume an interactive session with retry message.
 */
export function retryInteractive(opts: RetryOptions): LaunchResult {
  checkTmux();
  const sessionName = tmuxSessionName(opts.featureId, opts.config);

  const exists = muxSessionExists(opts.featureId, opts.config);

  if (exists) {
    const retryMsg = `The build failed. Fix these errors:\n${opts.buildErrors}`;
    const tmpFile = `/tmp/woco-retry-${opts.featureId}.txt`;
    writeFileSync(tmpFile, retryMsg);
    tmuxLoadBuffer(tmpFile);
    tmuxPasteBuffer(sessionName);
    tmuxSendKeys(sessionName, "Enter");
    try { unlinkSync(tmpFile); } catch {}

    const panePid = tmuxGetPanePid(sessionName);

    return {
      pid: panePid,
      process: null as any,
    };
  }

  // Session doesn't exist — launch a new interactive session
  return launchInteractive({
    worktreePath: opts.worktreePath,
    featureId: opts.featureId,
    prompt: `Continue from session ${opts.sessionId}. The build failed:\n${opts.buildErrors}\n\nFix all errors and verify the build passes.`,
    model: opts.model,
    interactive: true,
    config: opts.config,
  });
}

// ---------------------------------------------------------------------------
// Tmux Session Management
// ---------------------------------------------------------------------------

/**
 * Check if a tmux session exists for a feature.
 */
export function muxSessionExists(
  featureId: string,
  config: WomboConfig
): boolean {
  const sessionName = tmuxSessionName(featureId, config);
  return tmuxHasSession(sessionName);
}

/**
 * Kill a tmux session for a feature.
 */
export function killMuxSession(
  featureId: string,
  config: WomboConfig
): void {
  const sessionName = tmuxSessionName(featureId, config);
  tmuxKillSession(sessionName);
}

/**
 * List all woco-related tmux sessions.
 */
export function listMuxSessions(config: WomboConfig): string[] {
  const sessions = tmuxListSessions();
  return sessions.filter((s: string) => s.startsWith(config.agent.tmuxPrefix + "-"));
}

/**
 * Kill all woco-related tmux sessions.
 */
export function killAllMuxSessions(config: WomboConfig): number {
  const sessions = listMuxSessions(config);
  for (const s of sessions) {
    tmuxKillSession(s);
  }
  return sessions.length;
}

/**
 * Check if a process is still running by PID.
 */
export function isProcessRunning(pid: number): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
