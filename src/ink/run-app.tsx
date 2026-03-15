/**
 * run-app.tsx — Entry point for launching the Ink app shell.
 *
 * Provides a `runApp()` function that mounts the Shell component with
 * optional children and returns an Ink Instance for lifecycle control.
 *
 * Usage:
 *   import { runApp } from "./run-app.js";
 *   const instance = runApp();
 *   await instance.waitUntilExit();
 */

import React, { type ReactNode } from "react";
import { render, type Instance, type RenderOptions } from "ink";
import { Shell } from "./shell.js";

export interface RunAppOptions extends RenderOptions {
  /** Optional children to render inside the Shell. */
  children?: ReactNode;
}

/**
 * Mount the Ink app shell and return the Instance for lifecycle control.
 *
 * The returned instance exposes:
 *   - `unmount()` — manually tear down the app
 *   - `waitUntilExit()` — promise that resolves when the app exits
 *   - `rerender()` — update the rendered tree
 *   - `clear()` — clear output
 */
export function runApp(options: RunAppOptions = {}): Instance {
  const { children, ...renderOptions } = options;

  return render(<Shell>{children}</Shell>, renderOptions);
}
