/**
 * upgrade.ts — Self-upgrade wombo-combo.
 *
 * Supports both npm and GitHub installs. Detects the current install source
 * and uses the same channel for upgrades. Checks npm registry first (primary),
 * falls back to GitHub tags.
 *
 * Usage:
 *   woco upgrade              # Check for updates and prompt to install
 *   woco upgrade --force      # Skip confirmation prompt
 *   woco upgrade --tag v0.1.0 # Install a specific version
 *   woco upgrade --check      # Only check, don't install
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";
import { createInterface } from "node:readline";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface UpgradeOptions {
  force: boolean;
  tag?: string;
  checkOnly: boolean;
}

type InstallSource = "npm" | "github" | "local";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const PKG_NAME = "wombo-combo";
const REPO = "fulgidus/wombo-combo";
const NPM_REGISTRY = "https://registry.npmjs.org";

/**
 * Get the locally installed version from package.json.
 * Uses import.meta to find the package.json relative to this source file,
 * which works whether running from local source or global install.
 */
function getLocalVersion(): string {
  const pkgPath = resolve(import.meta.dir, "../../package.json");
  const raw = readFileSync(pkgPath, "utf-8");
  return JSON.parse(raw).version as string;
}

/**
 * Detect how wombo-combo was installed globally.
 *
 * Checks bun's global lockfile for the package entry:
 * - npm installs look like:  "wombo-combo@0.2.5"
 * - github installs look like: "wombo-combo@github:fulgidus/wombo-combo#<hash>"
 * - If the binary resolves to a local working tree, it's "local" (dev symlink).
 */
function detectInstallSource(): InstallSource {
  // Check if woco points to a local dev checkout
  const binTarget = resolve(import.meta.dir, "../../");
  const cwd = process.cwd();
  try {
    // If we can find a .git directory at the package root, it's a local checkout
    if (existsSync(resolve(binTarget, ".git"))) {
      return "local";
    }
  } catch {
    // ignore
  }

  // Check bun's global lockfile
  const lockPath = resolve(homedir(), ".bun/install/global/bun.lock");
  try {
    const raw = readFileSync(lockPath, "utf-8");
    // bun.lock is JSONC — the wombo-combo entry tells us the source
    // npm:    "wombo-combo": ["wombo-combo@0.2.5", ...]
    // github: "wombo-combo": ["wombo-combo@github:fulgidus/wombo-combo#abc123", ...]
    if (raw.includes(`${PKG_NAME}@github:`)) {
      return "github";
    }
    if (raw.includes(`"${PKG_NAME}"`)) {
      return "npm";
    }
  } catch {
    // No lockfile — can't determine, assume npm
  }

  return "npm";
}

/**
 * Fetch the latest version from the npm registry.
 * Returns the version string (without 'v' prefix) or null on failure.
 */
async function fetchNpmLatest(): Promise<string | null> {
  try {
    const res = await fetch(`${NPM_REGISTRY}/${PKG_NAME}/latest`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { version?: string };
    return data.version ?? null;
  } catch {
    return null;
  }
}

/**
 * Check if a specific version exists on npm.
 */
async function npmVersionExists(version: string): Promise<boolean> {
  try {
    const v = version.replace(/^v/, "");
    const res = await fetch(`${NPM_REGISTRY}/${PKG_NAME}/${v}`, {
      method: "HEAD",
      signal: AbortSignal.timeout(10_000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Fetch all v* tags from the remote GitHub repo using git ls-remote.
 * Returns tags sorted by semver descending (latest first).
 */
async function fetchRemoteTags(): Promise<string[]> {
  const proc = Bun.spawn(["git", "ls-remote", "--tags", `https://github.com/${REPO}.git`], {
    stdout: "pipe",
    stderr: "pipe",
  });

  const stdout = await new Response(proc.stdout).text();
  const exitCode = await proc.exited;

  if (exitCode !== 0) {
    return []; // Don't throw — this is a fallback
  }

  // Parse lines like: "abc123\trefs/tags/v0.0.1"
  const tags: string[] = [];
  for (const line of stdout.split("\n")) {
    const match = line.match(/refs\/tags\/(v\d+\.\d+\.\d+)$/);
    if (match) {
      tags.push(match[1]);
    }
  }

  // Sort descending by semver
  tags.sort((a, b) => {
    const pa = a.slice(1).split(".").map(Number);
    const pb = b.slice(1).split(".").map(Number);
    for (let i = 0; i < 3; i++) {
      if (pa[i] !== pb[i]) return pb[i] - pa[i];
    }
    return 0;
  });

  return tags;
}

/**
 * Compare two semver strings. Returns:
 *   -1 if a < b
 *    0 if a === b
 *    1 if a > b
 */
function compareSemver(a: string, b: string): number {
  const pa = a.replace(/^v/, "").split(".").map(Number);
  const pb = b.replace(/^v/, "").split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if (pa[i] < pb[i]) return -1;
    if (pa[i] > pb[i]) return 1;
  }
  return 0;
}

/**
 * Prompt the user for yes/no confirmation.
 */
async function confirm(message: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise<boolean>((resolve) => {
    rl.question(`${message} [y/N] `, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase() === "y");
    });
  });
}

/**
 * Resolve the latest available version.
 * Checks npm first, falls back to GitHub tags.
 * Returns { version, source } where version includes 'v' prefix.
 */
async function resolveLatestVersion(): Promise<{ version: string; source: "npm" | "github" } | null> {
  // Try npm first
  const npmVersion = await fetchNpmLatest();
  if (npmVersion) {
    return { version: `v${npmVersion}`, source: "npm" };
  }

  // Fall back to GitHub tags
  const tags = await fetchRemoteTags();
  if (tags.length > 0) {
    return { version: tags[0], source: "github" };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Install
// ---------------------------------------------------------------------------

/**
 * Build the bun install specifier for a given version and source.
 */
function installSpecifier(version: string, source: InstallSource): string {
  const v = version.replace(/^v/, "");
  if (source === "github") {
    return `github:${REPO}#v${v}`;
  }
  // npm (or local — upgrade from local always goes to npm)
  return `${PKG_NAME}@${v}`;
}

/**
 * Remove then reinstall to avoid bun's dependency loop when switching
 * between npm and github sources (or even upgrading within the same source).
 */
async function installVersion(version: string, source: InstallSource): Promise<void> {
  const spec = installSpecifier(version, source);
  const sourceLabel = source === "github" ? "GitHub" : "npm";
  console.log(`\nInstalling ${PKG_NAME}@${version} from ${sourceLabel}...`);

  // Step 1: Remove existing global install to prevent dependency loops
  const rmProc = Bun.spawn(["bun", "remove", "-g", PKG_NAME], {
    stdout: "pipe",
    stderr: "pipe",
  });
  await rmProc.exited; // Ignore exit code — might not be installed

  // Step 2: Install the new version
  const addProc = Bun.spawn(["bun", "add", "-g", spec], {
    stdout: "inherit",
    stderr: "inherit",
  });

  const exitCode = await addProc.exited;

  if (exitCode !== 0) {
    console.error(`\nInstallation failed (exit code ${exitCode}).`);
    console.error(`You can try manually: bun add -g ${spec}`);
    process.exit(1);
    return;
  }

  console.log(`\nSuccessfully upgraded to ${version}.`);
  checkShellCompletions();
}

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

export async function cmdUpgrade(opts: UpgradeOptions): Promise<void> {
  const localVersion = getLocalVersion();
  const source = detectInstallSource();
  const sourceLabel = source === "github" ? " (GitHub)" : source === "local" ? " (local dev)" : " (npm)";

  console.log(`Current version: v${localVersion}${sourceLabel}`);

  if (source === "local") {
    console.log("You are running from a local checkout. Use 'git pull' to update.");
    if (!opts.force) return;
    console.log("--force: continuing anyway...");
  }

  // If a specific version is requested, skip the check
  if (opts.tag) {
    const targetTag = opts.tag.startsWith("v") ? opts.tag : `v${opts.tag}`;
    console.log(`Requested version: ${targetTag}`);

    if (compareSemver(localVersion, targetTag) === 0) {
      console.log("Already at the requested version.");
      return;
    }

    // Determine install source for the specific version:
    // prefer npm if available, otherwise github
    let targetSource: InstallSource = source === "github" ? "github" : "npm";
    if (targetSource === "npm") {
      const exists = await npmVersionExists(targetTag);
      if (!exists) {
        // Not on npm — try github
        console.log(`Version ${targetTag} not found on npm, trying GitHub...`);
        targetSource = "github";
      }
    }

    if (!opts.force) {
      const ok = await confirm(`Install ${targetTag}?`);
      if (!ok) {
        console.log("Upgrade cancelled.");
        return;
      }
    }

    await installVersion(targetTag, targetSource);
    return;
  }

  // Fetch latest version
  console.log(`Checking for updates...`);

  const latest = await resolveLatestVersion();

  if (!latest) {
    console.error("Failed to check for updates (neither npm nor GitHub responded).");
    process.exit(1);
    return;
  }

  const latestVersion = latest.version.replace(/^v/, "");
  const latestLabel = latest.source === "npm" ? "(npm)" : "(GitHub)";
  console.log(`Latest version:  v${latestVersion} ${latestLabel}`);

  const cmp = compareSemver(localVersion, latestVersion);
  if (cmp > 0) {
    console.log(`Local version is ahead of latest release (v${localVersion} > v${latestVersion}).`);
    return;
  }
  if (cmp === 0) {
    console.log("You are already up to date.");
    return;
  }

  if (opts.checkOnly) {
    console.log(`\nUpdate available: v${localVersion} -> v${latestVersion}`);
    console.log(`Run 'woco upgrade' to install.`);
    return;
  }

  console.log(`\nUpdate available: v${localVersion} -> v${latestVersion}`);

  // Decide install source: use same source if version is available there,
  // otherwise use whatever source we found the latest on
  let upgradeSource: InstallSource = source === "github" ? "github" : "npm";
  if (upgradeSource === "npm" && latest.source === "github") {
    // npm didn't have it, we found it on github
    upgradeSource = "github";
  }

  if (!opts.force) {
    const ok = await confirm(`Upgrade to v${latestVersion}?`);
    if (!ok) {
      console.log("Upgrade cancelled.");
      return;
    }
  }

  await installVersion(latest.version, upgradeSource);
}

// ---------------------------------------------------------------------------
// Shell completion check
// ---------------------------------------------------------------------------

/** Marker strings that woco completion injects into rc files. */
const COMPLETION_MARKERS: Record<string, string> = {
  bash: "woco completion bash",
  zsh: "woco completion zsh",
  fish: "woco completion fish", // covers both eval and source
};

/** Well-known rc file paths per shell (relative to $HOME). */
const RC_FILES: Record<string, string[]> = {
  bash: [".bashrc", ".bash_profile", ".profile"],
  zsh: [".zshrc", ".zprofile"],
};

/**
 * Result of shell completion check.
 *   - `rcPath`: absolute path to the rc file where completions are configured (null if not found)
 *   - `shell`: detected shell name (null if unknown)
 */
export interface CompletionCheckResult {
  shell: string | null;
  rcPath: string | null;
}

/**
 * Check whether the user's shell has woco completions set up.
 * Prints a hint if not. Returns info about what was found so callers
 * (e.g. postinstall) can source the rc file.
 */
export function checkShellCompletions(): CompletionCheckResult {
  const home = homedir();
  const shell = detectCurrentShell();
  const result: CompletionCheckResult = { shell, rcPath: null };

  if (!shell) return result; // Unknown shell — don't nag

  // Fish: check for the completions file instead of rc
  if (shell === "fish") {
    const fishCompFile = resolve(home, ".config/fish/completions/woco.fish");
    if (existsSync(fishCompFile)) {
      result.rcPath = fishCompFile;
    } else {
      console.log("");
      console.log("Tip: Shell completions are not installed for fish.");
      console.log("  To enable tab-completion, run:");
      console.log("    woco completion fish > ~/.config/fish/completions/woco.fish");
    }
    return result;
  }

  // Bash / Zsh: scan rc files for the marker
  const rcCandidates = RC_FILES[shell] ?? [];
  const marker = COMPLETION_MARKERS[shell];
  if (!marker) return result;

  for (const rc of rcCandidates) {
    const rcPath = resolve(home, rc);
    try {
      if (!existsSync(rcPath)) continue;
      const content = readFileSync(rcPath, "utf-8");
      if (content.includes(marker)) {
        result.rcPath = rcPath;
        return result; // Already set up
      }
    } catch {
      // Can't read — skip
    }
  }

  // Not found in any rc file
  const rcFile = shell === "zsh" ? "~/.zshrc" : "~/.bashrc";
  const evalLine = `eval "$(woco completion ${shell})"`;
  console.log("");
  console.log(`Tip: Shell completions are not installed for ${shell}.`);
  console.log(`  Add this line to ${rcFile}:`);
  console.log(`    ${evalLine}`);
  console.log(`  Then reload your shell:`);
  console.log(`    source ${rcFile}`);
  return result;
}

function detectCurrentShell(): string | null {
  const shellPath = process.env.SHELL || "";
  const name = shellPath.split("/").pop() || "";
  if (name === "bash" || name === "zsh" || name === "fish") return name;
  return null;
}
