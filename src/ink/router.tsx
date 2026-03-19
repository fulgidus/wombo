/**
 * router.tsx — Screen router for the Ink TUI.
 *
 * Provides a single-render-lifetime stack navigator. Instead of each
 * command spawning its own `inkRender()` call (the 9 separate run-*.tsx
 * pattern), all TUI screens live inside one `ScreenRouter` component tree
 * that is rendered once and stays mounted for the full TUI session.
 *
 * API:
 *   - `ScreenMap`         — map of screen key → React component
 *   - `NavigationContext` — React context carrying nav helpers
 *   - `useNavigation()`   — hook to access push/pop/replace/reset
 *   - `ScreenRouter`      — component that owns the stack and renders the
 *                           current screen
 *
 * Navigation model:
 *   Stack-based. Each entry is `{ key, props }`. `push` appends, `pop`
 *   removes the top entry. `replace` swaps the top entry. `reset` replaces
 *   the entire stack with a single entry.
 *
 * Children of ScreenRouter (e.g. overlays, chrome bars) are rendered on
 * top of the current screen so they are always visible regardless of which
 * screen is active.
 */

import React, {
  createContext,
  useContext,
  useState,
  useCallback,
  type ReactNode,
  type ComponentType,
} from "react";
import { Text } from "ink";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A key identifying a screen in the ScreenMap. */
export type ScreenKey = string;

/** Any component that can be used as a screen. Props are passed through. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ScreenComponent = ComponentType<any>;

/** Registry of all screens available to the router. */
export type ScreenMap = Record<ScreenKey, ScreenComponent>;

/** A single entry in the navigation stack. */
export interface StackEntry {
  key: ScreenKey;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  props: Record<string, any>;
}

/** The value exposed by NavigationContext. */
export interface NavigationState {
  /** Key of the screen currently shown. */
  currentScreen: ScreenKey;
  /** Number of entries in the stack (1 = at root). */
  stackDepth: number;
  /**
   * Push a new screen onto the stack. Optionally pass props to the screen
   * component.
   */
  push: (key: ScreenKey, props?: Record<string, unknown>) => void;
  /**
   * Pop the current screen off the stack. No-op if already at the root.
   */
  pop: () => void;
  /**
   * Replace the current (top) screen without adding a new stack entry.
   * Useful for "redirects" that shouldn't be back-navigable.
   */
  replace: (key: ScreenKey, props?: Record<string, unknown>) => void;
  /**
   * Clear the entire stack and navigate to the given screen.
   * The result is a stack with depth 1.
   */
  reset: (key: ScreenKey, props?: Record<string, unknown>) => void;
}

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

const defaultNav: NavigationState = {
  currentScreen: "",
  stackDepth: 0,
  push: () => {},
  pop: () => {},
  replace: () => {},
  reset: () => {},
};

export const NavigationContext = createContext<NavigationState>(defaultNav);

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

/**
 * Access the navigation state and actions from any component inside a
 * `ScreenRouter`.
 */
export function useNavigation(): NavigationState {
  return useContext(NavigationContext);
}

// ---------------------------------------------------------------------------
// ScreenRouter props
// ---------------------------------------------------------------------------

export interface ScreenRouterProps {
  /** Map of all screens available for navigation. */
  screens: ScreenMap;
  /** The screen to show on initial mount. */
  initialScreen: ScreenKey;
  /** Optional initial props to pass to the initial screen. */
  initialProps?: Record<string, unknown>;
  /**
   * Optional children rendered on top of the current screen (e.g. chrome
   * bars, overlay menus). They receive NavigationContext.
   */
  children?: ReactNode;
}

// ---------------------------------------------------------------------------
// ScreenRouter
// ---------------------------------------------------------------------------

/**
 * ScreenRouter — owns the navigation stack and renders the current screen.
 *
 * Mount this once for the entire TUI session. Do not unmount and remount it
 * to switch screens — use `push`, `pop`, `replace`, or `reset` instead.
 */
export function ScreenRouter({
  screens,
  initialScreen,
  initialProps = {},
  children,
}: ScreenRouterProps): React.ReactElement {
  const [stack, setStack] = useState<StackEntry[]>([
    { key: initialScreen, props: initialProps },
  ]);

  const push = useCallback(
    (key: ScreenKey, props: Record<string, unknown> = {}) => {
      setStack((prev) => [...prev, { key, props }]);
    },
    []
  );

  const pop = useCallback(() => {
    setStack((prev) => {
      if (prev.length <= 1) return prev; // no-op at root
      return prev.slice(0, -1);
    });
  }, []);

  const replace = useCallback(
    (key: ScreenKey, props: Record<string, unknown> = {}) => {
      setStack((prev) => {
        const next = [...prev];
        next[next.length - 1] = { key, props };
        return next;
      });
    },
    []
  );

  const reset = useCallback(
    (key: ScreenKey, props: Record<string, unknown> = {}) => {
      setStack([{ key, props }]);
    },
    []
  );

  const top = stack[stack.length - 1];
  const ScreenComponent = screens[top.key];

  const navValue: NavigationState = {
    currentScreen: top.key,
    stackDepth: stack.length,
    push,
    pop,
    replace,
    reset,
  };

  return (
    <NavigationContext.Provider value={navValue}>
      {ScreenComponent ? (
        <ScreenComponent {...top.props} />
      ) : (
        <Text color="red">Unknown screen: {top.key}</Text>
      )}
      {children}
    </NavigationContext.Provider>
  );
}
