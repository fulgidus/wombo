/**
 * upgrade.ts — Self-upgrade wombo-combo.
 *
 * Supports both npm and GitHub installs. Detects the current install source
 * and checks that channel first. Never silently switches channels — if an
 * update is only available on the other channel (e.g. npm hasn't propagated
 * yet but GitHub has the tag), the user is warned and prompted to confirm
 * before switching.
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
 * Prompt the user for yes/no confirmation (defaults to yes).
 */
async function confirm(message: string): Promise<boolean> {
  if (!process.stdin.isTTY) return true; // non-interactive → proceed

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise<boolean>((resolve) => {
    rl.question(`${message} [Y/n] `, (answer) => {
      rl.close();
      const a = answer.trim().toLowerCase();
      resolve(a === "" || a === "y" || a === "yes");
    });
  });
}

interface ChannelResult {
  version: string; // includes 'v' prefix
  source: "npm" | "github";
}

/** Check the npm channel for the latest version. */
async function checkNpmLatest(): Promise<ChannelResult | null> {
  const v = await fetchNpmLatest();
  return v ? { version: `v${v}`, source: "npm" } : null;
}

/** Check the GitHub channel for the latest version. */
async function checkGithubLatest(): Promise<ChannelResult | null> {
  const tags = await fetchRemoteTags();
  return tags.length > 0 ? { version: tags[0], source: "github" } : null;
}

/** Human-readable channel label. */
function channelLabel(source: InstallSource): string {
  return source === "github" ? "GitHub" : source === "local" ? "local dev" : "npm";
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
 * Install a version globally via bun.
 *
 * Always tries `bun add -g` first — this overwrites the existing install
 * in place, preserving any local state outside node_modules. No preemptive
 * remove step. If the add fails due to a source conflict (cross-channel),
 * only then do we try remove + add, and if THAT fails we attempt to
 * restore the previous version.
 */
async function installVersion(version: string, newSource: InstallSource, currentSource?: InstallSource): Promise<void> {
  const spec = installSpecifier(version, newSource);
  const sourceLabel = newSource === "github" ? "GitHub" : "npm";

  console.log(`\nInstalling ${PKG_NAME}@${version} from ${sourceLabel}...`);

  // Try the straightforward install first — works for same-channel and
  // often works for cross-channel too
  const addProc = Bun.spawn(["bun", "add", "-g", spec], {
    stdout: "inherit",
    stderr: "inherit",
  });

  let exitCode = await addProc.exited;

  if (exitCode !== 0) {
    // If this is a cross-channel switch, the failure might be a source
    // conflict. Try remove + add, but only as a last resort.
    const switching = currentSource != null && currentSource !== newSource && currentSource !== "local";

    if (switching) {
      console.log(`\nDirect install failed. Retrying with source switch (${channelLabel(currentSource!)} -> ${sourceLabel})...`);

      const rmProc = Bun.spawn(["bun", "remove", "-g", PKG_NAME], {
        stdout: "pipe",
        stderr: "pipe",
      });
      await rmProc.exited;

      const retryProc = Bun.spawn(["bun", "add", "-g", spec], {
        stdout: "inherit",
        stderr: "inherit",
      });
      exitCode = await retryProc.exited;

      if (exitCode !== 0) {
        // Both attempts failed — try to restore what we just removed
        console.error(`\nInstallation of ${spec} failed. Attempting to restore previous install...`);
        const restoreSpec = installSpecifier(getLocalVersion(), currentSource!);
        const restoreProc = Bun.spawn(["bun", "add", "-g", restoreSpec], {
          stdout: "inherit",
          stderr: "inherit",
        });
        const restoreCode = await restoreProc.exited;
        if (restoreCode === 0) {
          console.error(`Previous version restored. Upgrade aborted.`);
        } else {
          console.error(`Could not restore previous version either.`);
          console.error(`Reinstall manually: bun add -g ${restoreSpec}`);
        }
        process.exit(1);
        return;
      }
    } else {
      // Same-channel failure — nothing was removed, previous install is intact
      console.error(`\nInstallation failed (exit code ${exitCode}).`);
      console.error(`Your current install is unchanged.`);
      console.error(`You can try manually: bun add -g ${spec}`);
      process.exit(1);
      return;
    }
  }

  console.log(`\nSuccessfully upgraded to ${version}.`);

  // Shell out to the NEW binary for completion install — this process is
  // still running old code, so we can't import from our own source.
  try {
    const proc = Bun.spawn(["woco", "completion", "install"], {
      stdout: "inherit",
      stderr: "inherit",
    });
    await proc.exited;
  } catch {
    // New binary might not support completion install yet (upgrading from
    // an older version). Fall back to a one-liner hint.
    console.log("\nRun this to set up shell completions:");
    console.log("  woco completion install && source ~/.zshrc");
  }
}

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

export async function cmdUpgrade(opts: UpgradeOptions): Promise<void> {
  const localVersion = getLocalVersion();
  const source = detectInstallSource();

  console.log(`Current version: v${localVersion} (${channelLabel(source)})`);

  if (source === "local") {
    console.log("You are running from a local checkout. Use 'git pull' to update.");
    if (!opts.force) return;
    console.log("--force: continuing anyway...");
  }

  // The effective channel for checking/installing: local upgrades default to npm
  const ownChannel: "npm" | "github" = source === "github" ? "github" : "npm";
  const otherChannel: "npm" | "github" = ownChannel === "npm" ? "github" : "npm";

  // -----------------------------------------------------------------------
  // --tag: install a specific version
  // -----------------------------------------------------------------------
  if (opts.tag) {
    const targetTag = opts.tag.startsWith("v") ? opts.tag : `v${opts.tag}`;
    console.log(`Requested version: ${targetTag}`);

    if (compareSemver(localVersion, targetTag) === 0) {
      console.log("Already at the requested version.");
      return;
    }

    // Check if the requested version exists on the user's current channel
    let targetSource: InstallSource = ownChannel;

    if (ownChannel === "npm") {
      const exists = await npmVersionExists(targetTag);
      if (!exists) {
        // Not on npm — check GitHub before giving up
        const ghTags = await fetchRemoteTags();
        const onGithub = ghTags.some((t) => compareSemver(t, targetTag) === 0);

        if (onGithub) {
          console.log(`\nVersion ${targetTag} is not available on npm (your current channel).`);
          console.log(`It was found on GitHub. This may mean npm hasn't propagated yet,`);
          console.log(`or the release is GitHub-only.`);

          if (!opts.force) {
            const ok = await confirm(`Switch to GitHub and install ${targetTag}?`);
            if (!ok) {
              console.log("Upgrade cancelled.");
              return;
            }
          }
          targetSource = "github";
        } else {
          console.error(`Version ${targetTag} not found on npm or GitHub.`);
          process.exit(1);
          return;
        }
      }
    } else {
      // Current channel is GitHub — check if the tag exists
      const ghTags = await fetchRemoteTags();
      const onGithub = ghTags.some((t) => compareSemver(t, targetTag) === 0);

      if (!onGithub) {
        // Not on GitHub — check npm
        const onNpm = await npmVersionExists(targetTag);

        if (onNpm) {
          console.log(`\nVersion ${targetTag} is not available on GitHub (your current channel).`);
          console.log(`It was found on npm.`);

          if (!opts.force) {
            const ok = await confirm(`Switch to npm and install ${targetTag}?`);
            if (!ok) {
              console.log("Upgrade cancelled.");
              return;
            }
          }
          targetSource = "npm";
        } else {
          console.error(`Version ${targetTag} not found on GitHub or npm.`);
          process.exit(1);
          return;
        }
      }
    }

    if (!opts.force) {
      const ok = await confirm(`Install ${targetTag} from ${channelLabel(targetSource)}?`);
      if (!ok) {
        console.log("Upgrade cancelled.");
        return;
      }
    }

    await installVersion(targetTag, targetSource, source);
    return;
  }

  // -----------------------------------------------------------------------
  // Default: check for latest version on the user's channel
  // -----------------------------------------------------------------------
  console.log(`Checking for updates on ${channelLabel(ownChannel)}...`);

  // Check both channels in parallel for responsiveness
  const [npmResult, ghResult] = await Promise.all([
    checkNpmLatest(),
    checkGithubLatest(),
  ]);

  const ownResult = ownChannel === "npm" ? npmResult : ghResult;
  const otherResult = ownChannel === "npm" ? ghResult : npmResult;

  // -- Case 1: own channel has an update ------------------------------------
  if (ownResult) {
    const ownVersion = ownResult.version.replace(/^v/, "");
    const cmp = compareSemver(localVersion, ownVersion);

    if (cmp > 0) {
      console.log(`Local version is ahead of latest ${channelLabel(ownChannel)} release (v${localVersion} > v${ownVersion}).`);
      return;
    }
    if (cmp === 0) {
      // Up to date on own channel — but maybe the other channel is ahead
      if (otherResult && compareSemver(localVersion, otherResult.version) < 0) {
        const otherV = otherResult.version.replace(/^v/, "");
        console.log(`You are up to date on ${channelLabel(ownChannel)}.`);
        console.log(`Note: v${otherV} is available on ${channelLabel(otherChannel)}.`);

        if (opts.checkOnly) {
          console.log(`Run 'woco upgrade --tag v${otherV}' to switch channels.`);
          return;
        }

        const ok = await confirm(`Switch to ${channelLabel(otherChannel)} and install v${otherV}?`);
        if (!ok) {
          console.log("No changes made.");
          return;
        }

        await installVersion(otherResult.version, otherChannel, source);
        return;
      }

      console.log("You are already up to date.");
      return;
    }

    // There is a newer version on the own channel
    console.log(`Latest version:  v${ownVersion} (${channelLabel(ownChannel)})`);

    if (opts.checkOnly) {
      console.log(`\nUpdate available: v${localVersion} -> v${ownVersion}`);
      console.log(`Run 'woco upgrade' to install.`);
      return;
    }

    console.log(`\nUpdate available: v${localVersion} -> v${ownVersion}`);

    if (!opts.force) {
      const ok = await confirm(`Upgrade to v${ownVersion}?`);
      if (!ok) {
        console.log("Upgrade cancelled.");
        return;
      }
    }

    await installVersion(ownResult.version, ownChannel, source);
    return;
  }

  // -- Case 2: own channel returned nothing, check the other ----------------
  if (otherResult && compareSemver(localVersion, otherResult.version) < 0) {
    const otherV = otherResult.version.replace(/^v/, "");
    console.log(`Could not reach ${channelLabel(ownChannel)}.`);
    console.log(`However, v${otherV} is available on ${channelLabel(otherChannel)}.`);

    if (opts.checkOnly) {
      console.log(`\nUpdate available: v${localVersion} -> v${otherV} (${channelLabel(otherChannel)})`);
      console.log(`Run 'woco upgrade --tag v${otherV}' to switch channels, or try again later.`);
      return;
    }

    const ok = await confirm(`Switch to ${channelLabel(otherChannel)} and install v${otherV}?`);
    if (!ok) {
      console.log("Upgrade cancelled. Try again later when your channel is reachable.");
      return;
    }

    await installVersion(otherResult.version, otherChannel, source);
    return;
  }

  // -- Case 3: neither channel had anything useful --------------------------
  if (!ownResult && !otherResult) {
    console.error("Failed to check for updates (neither npm nor GitHub responded).");
    process.exit(1);
    return;
  }

  // Both responded but we're up to date (or ahead) on both
  console.log("You are already up to date.");
}
