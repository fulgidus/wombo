/**
 * init-app.tsx — Ink application wrapper for `woco init`.
 *
 * Wires together auto-detection, the InitForm component, and file writing.
 * This component:
 *   1. Auto-detects project name, base branch, build/install commands
 *   2. Renders the InitForm with detected defaults
 *   3. On confirm, calls writeInitFiles and installs the agent template
 *   4. On cancel, exits cleanly
 *
 * Usage from cmdInit:
 *   render(<InitApp projectRoot={root} force={force} />)
 */

import React, { useState, useCallback, useMemo } from "react";
import { Box, Text, useApp, render } from "ink";
import { InitForm, type InitFormDefaults } from "./init-form";
import {
  detectProjectName,
  detectBaseBranch,
  detectBuildCommand,
  detectInstallCommand,
} from "./init-detect";
import { writeInitFiles } from "./init-writer";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface InitAppProps {
  /** Absolute path to the project root. */
  projectRoot: string;
  /** Whether to overwrite existing config. */
  force: boolean;
}

type InitState =
  | { phase: "form" }
  | { phase: "done"; createdFiles: string[] }
  | { phase: "error"; message: string }
  | { phase: "cancelled" };

// ---------------------------------------------------------------------------
// InitApp
// ---------------------------------------------------------------------------

/**
 * InitApp — top-level Ink component for `woco init`.
 *
 * Auto-detects project settings, shows confirmation form, writes files.
 */
export function InitApp({ projectRoot, force }: InitAppProps): React.ReactElement {
  const app = useApp();

  // Auto-detect defaults (computed once on mount)
  const detected = useMemo(
    (): InitFormDefaults => ({
      baseBranch: detectBaseBranch(projectRoot),
      buildCommand: detectBuildCommand(projectRoot),
      installCommand: detectInstallCommand(projectRoot),
    }),
    [projectRoot],
  );

  const projectName = useMemo(
    () => detectProjectName(projectRoot),
    [projectRoot],
  );

  const [state, setState] = useState<InitState>({ phase: "form" });

  const handleConfirm = useCallback(
    (values: InitFormDefaults) => {
      try {
        const result = writeInitFiles(projectRoot, values, force);

        // Install agent template
        try {
          installAgentTemplate(projectRoot);
          result.createdFiles.push(".opencode/agents/generalist-agent.md");
        } catch {
          // Non-fatal — agent template install is optional
        }

        setState({ phase: "done", createdFiles: result.createdFiles });

        // Exit after a short delay to let the user see the result
        setTimeout(() => app.exit(), 500);
      } catch (err: any) {
        setState({ phase: "error", message: err.message });
        setTimeout(() => app.exit(), 1000);
      }
    },
    [projectRoot, force, app],
  );

  const handleCancel = useCallback(() => {
    setState({ phase: "cancelled" });
    setTimeout(() => app.exit(), 200);
  }, [app]);

  // --- Render based on state ---

  if (state.phase === "done") {
    return (
      <Box flexDirection="column" padding={1}>
        <Box marginBottom={1}>
          <Text bold color="green">
            ✓ Project initialized!
          </Text>
        </Box>
        <Box flexDirection="column">
          {state.createdFiles.map((file, idx) => (
            <Text key={idx} dimColor>
              Created {file}
            </Text>
          ))}
        </Box>
        <Box marginTop={1}>
          <Text>
            Run <Text bold>woco help</Text> to see available commands.
          </Text>
        </Box>
      </Box>
    );
  }

  if (state.phase === "error") {
    return (
      <Box flexDirection="column" padding={1}>
        <Text bold color="red">
          ✗ Init failed: {state.message}
        </Text>
      </Box>
    );
  }

  if (state.phase === "cancelled") {
    return (
      <Box padding={1}>
        <Text dimColor>Init cancelled.</Text>
      </Box>
    );
  }

  return (
    <InitForm
      projectName={projectName}
      defaults={detected}
      onConfirm={handleConfirm}
      onCancel={handleCancel}
    />
  );
}

// ---------------------------------------------------------------------------
// Render entry point
// ---------------------------------------------------------------------------

/**
 * Mount the InitApp and wait for it to exit.
 *
 * This is the entry point called by cmdInit. It renders the Ink app,
 * waits for the user to confirm/cancel, then resolves.
 */
export async function renderInitApp(props: InitAppProps): Promise<void> {
  const instance = render(<InitApp {...props} />);
  await instance.waitUntilExit();
}

// ---------------------------------------------------------------------------
// Agent template helper
// ---------------------------------------------------------------------------

/**
 * Install the generalist agent template into .opencode/agents/.
 * This is a simplified version — the full template rendering is in
 * src/lib/templates.ts but we import it lazily to avoid circular deps.
 */
function installAgentTemplate(projectRoot: string): void {
  // Lazy import to avoid pulling in the entire template system at module load
  const { existsSync, mkdirSync, writeFileSync } = require("node:fs");
  const { resolve } = require("node:path");
  const { loadConfig } = require("../config");
  const { renderAgentTemplate } = require("../lib/templates");

  const config = loadConfig(projectRoot);
  const agentDir = resolve(projectRoot, ".opencode", "agents");
  const agentDefPath = resolve(agentDir, `${config.agent.name}.md`);

  mkdirSync(agentDir, { recursive: true });
  const template = renderAgentTemplate(config, projectRoot);
  writeFileSync(agentDefPath, template, "utf-8");
}
