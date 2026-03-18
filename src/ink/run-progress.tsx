/**
 * run-progress.tsx — Standalone launcher for progress screens and confirmations.
 *
 * Provides helper functions to run a progress spinner screen or a confirm
 * dialog as standalone Ink instances that return Promises.
 */

import React, { useState, useEffect, useCallback } from "react";
import { render, useInput } from "ink";
import { ProgressView, type ProgressResult } from "./progress";
import { ConfirmDialog } from "./confirm";
import { useSpinner } from "./use-spinner";

// ---------------------------------------------------------------------------
// Progress Screen
// ---------------------------------------------------------------------------

export interface RunProgressOptions {
  /** Title of the operation. */
  title: string;
  /** Optional context string. */
  context?: string;
}

/**
 * A progress controller returned by `runProgressInk`.
 *
 * Call `update()` to change the status text, `finish()` to display a result
 * and wait for the user to dismiss.
 */
export interface ProgressController {
  /** Update the status text while the operation is running. */
  update: (status: string) => void;
  /** Show a result and wait for the user to press any key. Unmounts when dismissed. */
  finish: (result: ProgressResult) => Promise<void>;
  /** Force-unmount (e.g., on error). */
  unmount: () => void;
}

/** Internal component that bridges imperative controller → React props. */
function ProgressApp({
  title,
  context,
  statusRef,
  resultRef,
  onDismiss,
}: {
  title: string;
  context?: string;
  statusRef: React.MutableRefObject<string>;
  resultRef: React.MutableRefObject<ProgressResult | undefined>;
  onDismiss: () => void;
}) {
  const frame = useSpinner(!resultRef.current);
  const [status, setStatus] = useState(statusRef.current);
  const [result, setResult] = useState<ProgressResult | undefined>(resultRef.current);

  // Poll for updates from the imperative controller
  useEffect(() => {
    const interval = setInterval(() => {
      if (statusRef.current !== status) setStatus(statusRef.current);
      if (resultRef.current !== result) setResult(resultRef.current);
    }, 100);
    return () => clearInterval(interval);
  }, [status, result, statusRef, resultRef]);

  useInput(() => {
    if (result) onDismiss();
  });

  return (
    <ProgressView
      title={title}
      context={context}
      spinning={!result}
      spinFrame={frame}
      status={status}
      result={result}
      showDismiss={!!result}
    />
  );
}

/**
 * Launch a progress screen. Returns a controller for updating status
 * and finishing with a result.
 */
export function runProgressInk(opts: RunProgressOptions): ProgressController {
  const statusRef = { current: "" };
  const resultRef = { current: undefined as ProgressResult | undefined };
  let dismissResolve: (() => void) | null = null;

  process.stdin.resume(); // keep event loop alive between renders
  const instance = render(
    <ProgressApp
      title={opts.title}
      context={opts.context}
      statusRef={statusRef}
      resultRef={resultRef}
      onDismiss={() => {
        instance.unmount();
        dismissResolve?.();
      }}
    />,
    { exitOnCtrlC: false }
  );

  return {
    update(status: string) {
      statusRef.current = status;
    },
    finish(result: ProgressResult): Promise<void> {
      resultRef.current = result;
      return new Promise<void>((resolve) => {
        dismissResolve = resolve;
      });
    },
    unmount() {
      instance.unmount();
      dismissResolve?.();
    },
  };
}

// ---------------------------------------------------------------------------
// Confirm Dialog
// ---------------------------------------------------------------------------

export interface RunConfirmOptions {
  /** Title for the confirm modal. */
  title: string;
  /** The confirmation message/question. */
  message: string;
}

/**
 * Show a confirm dialog as a standalone Ink instance.
 * Returns true if the user confirmed (Y), false if cancelled (N/Escape).
 */
export function runConfirmInk(opts: RunConfirmOptions): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let instance: ReturnType<typeof render>;

    process.stdin.resume(); // keep event loop alive between renders
    instance = render(
      <ConfirmDialog
        title={opts.title}
        message={opts.message}
        onConfirm={(confirmed) => {
          instance.unmount();
          resolve(confirmed);
        }}
      />,
      { exitOnCtrlC: false }
    );
  });
}
