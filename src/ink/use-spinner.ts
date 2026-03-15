/**
 * use-spinner.ts — Hook for animated braille spinner in Ink.
 *
 * Returns a frame counter that increments at 120ms intervals when active.
 * Use with ProgressView's spinFrame prop to animate the spinner.
 *
 * Usage:
 *   const frame = useSpinner(isSpinning);
 *   <ProgressView spinning spinFrame={frame} ... />
 */

import { useState, useEffect, useRef } from "react";

/** Default spinner interval in milliseconds. */
const SPIN_INTERVAL_MS = 120;

/**
 * useSpinner — returns an incrementing frame counter when active.
 *
 * @param active  Whether the spinner should be animating.
 * @param intervalMs  Interval between frames (default: 120ms).
 * @returns The current frame number (starts at 0).
 */
export function useSpinner(active: boolean, intervalMs: number = SPIN_INTERVAL_MS): number {
  const [frame, setFrame] = useState(0);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (active) {
      intervalRef.current = setInterval(() => {
        setFrame((prev) => prev + 1);
      }, intervalMs);
    } else {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    }

    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, [active, intervalMs]);

  return frame;
}
