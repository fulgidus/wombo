/**
 * esc-menu.tsx — Global ESC-triggered floating overlay menu.
 *
 * Provides a floating overlay that appears when Escape is pressed anywhere
 * in the TUI (unless a more specific Escape handler fires first).
 *
 * Components:
 *   EscMenuItem      — a single selectable menu row
 *   EscMenu          — the floating menu box (controlled: open/closed)
 *   EscMenuProvider  — wraps the TUI root; owns keyboard listener + state
 *
 * Hooks:
 *   useEscMenu()     — returns { open, openMenu, closeMenu } from context
 *
 * Integration:
 *   Wrap your TUI root in <EscMenuProvider> (inside ScreenRouter so it can
 *   call useNavigation()). EscMenuProvider renders <EscMenu> on top of
 *   children when open.
 *
 *   <ScreenRouter screens={...} initialScreen="dashboard">
 *     <EscMenuProvider>
 *       <ChromeLayout ...>
 *         {children}
 *       </ChromeLayout>
 *     </EscMenuProvider>
 *   </ScreenRouter>
 */

import React, {
  createContext,
  useContext,
  useState,
  useCallback,
  type ReactNode,
} from "react";
import { Box, Text, useInput } from "ink";
import { t } from "./i18n";

// ---------------------------------------------------------------------------
// EscMenuContext
// ---------------------------------------------------------------------------

export interface EscMenuState {
  open: boolean;
  openMenu: () => void;
  closeMenu: () => void;
}

const defaultEscMenuState: EscMenuState = {
  open: false,
  openMenu: () => {},
  closeMenu: () => {},
};

const EscMenuContext = createContext<EscMenuState>(defaultEscMenuState);

/**
 * Hook to access the ESC menu open/close controls from anywhere in the tree.
 * Returns default no-op values if used outside an EscMenuProvider.
 */
export function useEscMenu(): EscMenuState {
  return useContext(EscMenuContext);
}

// ---------------------------------------------------------------------------
// EscMenuItem
// ---------------------------------------------------------------------------

export interface EscMenuItemProps {
  label: string;
  onSelect: () => void;
  selected: boolean;
}

/**
 * A single selectable row inside the EscMenu.
 * Shows ">" prefix when selected.
 */
export function EscMenuItem({
  label,
  onSelect: _onSelect,
  selected,
}: EscMenuItemProps): React.ReactElement {
  return (
    <Box flexDirection="row" gap={1}>
      <Text color={selected ? "cyan" : undefined}>{selected ? ">" : " "}</Text>
      <Text color={selected ? "cyan" : undefined} bold={selected}>
        {label}
      </Text>
    </Box>
  );
}

// ---------------------------------------------------------------------------
// EscMenu (controlled)
// ---------------------------------------------------------------------------

export interface EscMenuProps {
  /** Whether the menu is currently open. */
  open: boolean;
  /** Called when the user selects "Return to app" or presses Escape. */
  onClose: () => void;
  /**
   * Called when the user selects a navigation item.
   * Receives the action key: 'settings' | 'quit'.
   */
  onNavigate: (action: "settings" | "quit") => void;
}

const MENU_ITEMS: Array<{ key: string; label: () => string; action: "close" | "settings" | "quit" }> = [
  { key: "return",   label: () => t("menu.returnToApp"), action: "close" },
  { key: "settings", label: () => t("menu.settings"),   action: "settings" },
  { key: "quit",     label: () => t("menu.quit"),        action: "quit" },
];

/**
 * Floating overlay menu. Renders null when open=false.
 *
 * This is a controlled component — pass open/onClose/onNavigate from outside.
 * For the full integrated experience with keyboard handling use EscMenuProvider.
 */
export function EscMenu({
  open,
  onClose,
  onNavigate,
}: EscMenuProps): React.ReactElement | null {
  const [cursor, setCursor] = useState(0);

  // Keyboard: arrow keys + enter + escape
  useInput(
    (input, key) => {
      if (!open) return;
      if (key.upArrow) {
        setCursor((c) => Math.max(0, c - 1));
      } else if (key.downArrow) {
        setCursor((c) => Math.min(MENU_ITEMS.length - 1, c + 1));
      } else if (key.return) {
        const item = MENU_ITEMS[cursor];
        if (item.action === "close") {
          onClose();
        } else {
          onNavigate(item.action);
        }
      } else if (key.escape) {
        onClose();
      }
    },
    { isActive: open }
  );

  if (!open) return null;

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="cyan"
      paddingX={2}
      paddingY={1}
      minWidth={30}
    >
      {/* Title */}
      <Box marginBottom={1}>
        <Text bold color="cyan">
          {t("menu.title")}
        </Text>
      </Box>

      {/* Items */}
      {MENU_ITEMS.map((item, i) => (
        <EscMenuItem
          key={item.key}
          label={item.label()}
          selected={i === cursor}
          onSelect={() => {
            if (item.action === "close") {
              onClose();
            } else {
              onNavigate(item.action);
            }
          }}
        />
      ))}
    </Box>
  );
}

// ---------------------------------------------------------------------------
// EscMenuProvider
// ---------------------------------------------------------------------------

export interface EscMenuProviderProps {
  children?: ReactNode;
  /**
   * Optional callback when the user selects a navigation action.
   * If not provided, navigation items are still rendered but no-op.
   */
  onNavigate?: (action: "settings" | "quit") => void;
}

/**
 * EscMenuProvider — wraps the TUI root and owns the ESC menu state.
 *
 * Listens for Escape key globally (isActive=true) to toggle the menu.
 * Renders EscMenu on top of children when open.
 */
export function EscMenuProvider({
  children,
  onNavigate,
}: EscMenuProviderProps): React.ReactElement {
  const [open, setOpen] = useState(false);

  const openMenu = useCallback(() => setOpen(true), []);
  const closeMenu = useCallback(() => setOpen(false), []);

  // Global ESC handler (fires only when menu is closed; EscMenu handles ESC when open)
  useInput(
    (_input, key) => {
      if (key.escape && !open) {
        setOpen(true);
      }
    },
    { isActive: !open }
  );

  const handleNavigate = useCallback(
    (action: "settings" | "quit") => {
      setOpen(false);
      onNavigate?.(action);
    },
    [onNavigate]
  );

  const ctxValue: EscMenuState = { open, openMenu, closeMenu };

  return (
    <EscMenuContext.Provider value={ctxValue}>
      {children}
      <EscMenu open={open} onClose={closeMenu} onNavigate={handleNavigate} />
    </EscMenuContext.Provider>
  );
}
