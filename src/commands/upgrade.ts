/**
 * upgrade.ts — Self-upgrade wombo from GitHub.
 *
 * Usage:
 *   wombo upgrade              # Check for updates and prompt to install
 *   wombo upgrade --force      # Skip confirmation prompt
 *   wombo upgrade --version v0.1.0  # Install a specific version
 *   wombo upgrade --check      # Only check, don't install
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface UpgradeOptions {
  force: boolean;
  version?: string;
  checkOnly: boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const REPO = "fulgidus/wombo";

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
    const stderr = await new Response(proc.stderr).text();
    throw new Error(`Failed to fetch remote tags: ${stderr.trim()}`);
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

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

export async function cmdUpgrade(opts: UpgradeOptions): Promise<void> {
  const localVersion = getLocalVersion();
  console.log(`Current version: v${localVersion}`);

  // If a specific version is requested, skip the check
  if (opts.version) {
    const targetTag = opts.version.startsWith("v") ? opts.version : `v${opts.version}`;
    console.log(`Requested version: ${targetTag}`);

    if (compareSemver(localVersion, targetTag) === 0) {
      console.log("Already at the requested version.");
      return;
    }

    if (!opts.force) {
      const ok = await confirm(`Install ${targetTag}?`);
      if (!ok) {
        console.log("Upgrade cancelled.");
        return;
      }
    }

    await installVersion(targetTag);
    return;
  }

  // Fetch latest from GitHub
  console.log(`Checking for updates from github.com/${REPO}...`);

  let tags: string[];
  try {
    tags = await fetchRemoteTags();
  } catch (err: any) {
    console.error(`Failed to check for updates: ${err.message}`);
    process.exit(1);
    return;
  }

  if (tags.length === 0) {
    console.error("No release tags found on the remote repository.");
    process.exit(1);
    return;
  }

  const latestTag = tags[0];
  const latestVersion = latestTag.slice(1); // strip 'v'
  console.log(`Latest version:  ${latestTag}`);

  const cmp = compareSemver(localVersion, latestVersion);
  if (cmp >= 0) {
    console.log("You are already up to date.");
    return;
  }

  if (opts.checkOnly) {
    console.log(`\nUpdate available: v${localVersion} → ${latestTag}`);
    console.log(`Run 'wombo upgrade' to install.`);
    return;
  }

  console.log(`\nUpdate available: v${localVersion} → ${latestTag}`);

  if (!opts.force) {
    const ok = await confirm(`Upgrade to ${latestTag}?`);
    if (!ok) {
      console.log("Upgrade cancelled.");
      return;
    }
  }

  await installVersion(latestTag);
}

async function installVersion(tag: string): Promise<void> {
  console.log(`\nInstalling wombo@${tag}...`);

  const proc = Bun.spawn(
    ["bun", "install", "-g", `github:${REPO}#${tag}`],
    {
      stdout: "inherit",
      stderr: "inherit",
    }
  );

  const exitCode = await proc.exited;

  if (exitCode !== 0) {
    console.error(`\nInstallation failed (exit code ${exitCode}).`);
    process.exit(1);
    return;
  }

  console.log(`\nSuccessfully upgraded to ${tag}.`);
}
