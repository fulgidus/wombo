/**
 * use-terminal-size.ts — React hook that tracks terminal dimensions.
 *
 * Returns `{ rows, columns }` and re-renders automatically when the
 * terminal is resized.  Falls back to 24x80 when stdout is not a TTY.
 */

import { useState, useEffect } from "react";

export interface TerminalSize {
  rows: number;
  columns: number;
}

export function useTerminalSize(): TerminalSize {
  const [size, setSize] = useState<TerminalSize>(() => ({
    rows: process.stdout.rows ?? 24,
    columns: process.stdout.columns ?? 80,
  }));

  useEffect(() => {
    const onResize = () => {
      setSize({
        rows: process.stdout.rows ?? 24,
        columns: process.stdout.columns ?? 80,
      });
    };

    process.stdout.on("resize", onResize);
    return () => {
      process.stdout.removeListener("resize", onResize);
    };
  }, []);

  return size;
}
