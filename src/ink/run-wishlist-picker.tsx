/**
 * run-wishlist-picker.tsx — Standalone launcher for the WishlistPicker.
 *
 * Creates and destroys its own Ink render instance, returning a Promise
 * that resolves with the user's action (promote to errand/genesis/quest,
 * or go back).
 */

import React from "react";
import { render } from "ink";
import { WishlistPicker } from "./wishlist-picker";
import type { WishlistItem } from "../lib/wishlist-store";

// ---------------------------------------------------------------------------
// Action Type
// ---------------------------------------------------------------------------

export type WishlistPickerAction =
  | { type: "promoteErrand"; item: WishlistItem }
  | { type: "promoteGenesis"; item: WishlistItem }
  | { type: "promoteQuest"; item: WishlistItem }
  | { type: "back" }
  | { type: "quit" };

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface RunWishlistPickerOptions {
  projectRoot: string;
}

// ---------------------------------------------------------------------------
// Standalone Launcher
// ---------------------------------------------------------------------------

/**
 * Run the wishlist picker as a standalone Ink instance.
 * Returns the user's chosen action.
 */
export function runWishlistPickerInk(
  opts: RunWishlistPickerOptions
): Promise<WishlistPickerAction> {
  const { projectRoot } = opts;

  return new Promise<WishlistPickerAction>((resolve) => {
    let instance: ReturnType<typeof render>;

    const handleAction = (action: WishlistPickerAction) => {
      instance.unmount();
      resolve(action);
    };

    process.stdin.resume(); // keep event loop alive between renders
    instance = render(
      <WishlistPicker
        projectRoot={projectRoot}
        onPromoteErrand={(item) => handleAction({ type: "promoteErrand", item })}
        onPromoteGenesis={(item) => handleAction({ type: "promoteGenesis", item })}
        onPromoteQuest={(item) => handleAction({ type: "promoteQuest", item })}
        onBack={() => handleAction({ type: "back" })}
        onQuit={() => handleAction({ type: "quit" })}
      />,
      { exitOnCtrlC: false }
    );
  });
}
