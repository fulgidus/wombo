/**
 * ink/index.ts — Barrel re-exports for the Ink app shell.
 */

export { App, type AppProps } from "./app";
export { Shell, type ShellProps } from "./shell";
export { StatusView, type StatusViewProps } from "./status-view";
export { runApp, type RunAppOptions } from "./run-app";
export { TextBuffer } from "./text-buffer";
export { TextInput, type TextInputProps } from "./text-input";
export {
  useTextInput,
  type UseTextInputOptions,
  type UseTextInputResult,
} from "./use-text-input";
export {
  openEditor,
  getEditorCommand,
  type OpenEditorOptions,
} from "./open-editor";
export { Modal, type ModalProps } from "./modal";
export {
  ProgressView,
  type ProgressViewProps,
  type ProgressResult,
} from "./progress";
export { useSpinner } from "./use-spinner";
export { ConfirmDialog, type ConfirmDialogProps } from "./confirm";
export {
  UsageOverlayView,
  type UsageOverlayViewProps,
  formatTokenCount,
  formatCost,
} from "./usage-overlay";
export {
  QuestionPopupView,
  type QuestionPopupViewProps,
  timeAgo,
} from "./question-popup";
export {
  SelectInput,
  type SelectInputItem,
  type SelectInputProps,
} from "./select-input";
export {
  QuestWizard,
  type QuestWizardProps,
  type QuestWizardPrefill,
} from "./quest-wizard";
export {
  runQuestWizardInk,
  type RunQuestWizardOptions,
} from "./run-quest-wizard";
export { formatDate, truncateText } from "./wishlist-helpers";
export {
  useWishlistStore,
  type UseWishlistStoreOptions,
  type UseWishlistStoreResult,
} from "./use-wishlist-store";
export {
  WishlistPicker,
  type WishlistPickerProps,
} from "./wishlist-picker";
export {
  WishlistOverlay,
  type WishlistOverlayProps,
} from "./wishlist-overlay";
export { InitForm, FIELDS, type InitFormProps, type InitFormDefaults, type FieldDef } from "./init-form";
export { InitApp, renderInitApp, type InitAppProps } from "./init-app";
export {
  detectProjectName,
  detectBaseBranch,
  detectBuildCommand,
  detectInstallCommand,
} from "./init-detect";
export { writeInitFiles, type InitWriterConfig, type InitWriterResult } from "./init-writer";

// Onboarding wizard components
// Note: ConfirmDialog, ProgressView, and ProgressResult are intentionally
// omitted here to avoid collisions with the general-purpose versions from
// ./confirm and ./progress. Import from "./onboarding" directly if you
// need the onboarding-specific variants.
export {
  OnboardingWizard,
  type OnboardingWizardProps,
  StepWizard,
  type StepWizardProps,
  SectionPicker,
  type SectionPickerProps,
  FieldEditor,
  type FieldEditorProps,
  ProfileReview,
  type ProfileReviewProps,
  OnboardingApp,
  type OnboardingAppProps,
  runOnboardingInk,
  type OnboardingResult,
  type RunOnboardingOptions,
  type RawInputs,
  type InputStep,
  INPUT_STEPS,
  SECTION_NAMES,
  structureRawInputs,
} from "./onboarding";

// Review screen components (shared ReviewList + genesis/plan adapters)
export {
  type ReviewItem,
  type ReviewListConfig,
  type EditFieldDef,
  type DetailField,
  type DetailSection,
  type ReviewValidationIssue,
  PRIORITY_ABBREV,
  PRIORITY_COLORS,
  DIFFICULTY_COLORS,
  HITL_COLORS,
} from "./review-list-types";
export {
  createReviewState,
  toggleAccept,
  toggleAll,
  moveItem,
  selectItem,
  updateItem,
  getAcceptedItems,
  getCounts,
  type ReviewState,
} from "./use-review-list";
export { ReviewList, type ReviewListProps } from "./review-list";
export {
  questToReviewItem,
  reviewItemToQuest,
  buildGenesisConfig,
  GENESIS_EDIT_FIELDS,
  GenesisReviewApp,
  type GenesisReviewAppProps,
} from "./genesis-review";
export {
  taskToReviewItem,
  reviewItemToTask,
  buildPlanConfig,
  PLAN_EDIT_FIELDS,
  PlanReviewApp,
  type PlanReviewAppProps,
} from "./plan-review";
export {
  runGenesisReviewInk,
  runPlanReviewInk,
  type GenesisReviewAction,
  type PlanReviewAction,
  type RunGenesisReviewOptions,
  type RunPlanReviewOptions,
} from "./run-review";

// Complex TUI screen components (quest picker, task browser, wave monitor)
export {
  QUEST_STATUS_COLORS,
  QUEST_STATUS_ABBREV,
  TASK_STATUS_COLORS,
  TASK_STATUS_ABBREV,
  AGENT_STATUS_COLORS,
  AGENT_STATUS_ICONS,
  TASK_PRIORITY_COLORS,
  elapsed,
  progressBar,
} from "./tui-constants";
export {
  ErrandWizard,
  type ErrandWizardProps,
} from "./errand-wizard";
export {
  QuestPickerView,
  type QuestPickerViewProps,
  type QuestSummary,
} from "./quest-picker";
export {
  TaskBrowserView,
  type TaskBrowserViewProps,
  type TaskNode,
} from "./task-browser";
export {
  WaveMonitorView,
  type WaveMonitorViewProps,
  type AgentInfo,
  type AgentCounts,
} from "./wave-monitor";

// Standalone launchers
export {
  runQuestPickerInk,
  type QuestPickerAction,
  type RunQuestPickerOptions,
} from "./run-quest-picker";
export {
  runTaskBrowserInk,
  type TaskBrowserAction,
  type RunTaskBrowserOptions,
} from "./run-task-browser";
export {
  runWishlistPickerInk,
  type WishlistPickerAction,
  type RunWishlistPickerOptions,
} from "./run-wishlist-picker";
export {
  runErrandWizardInk,
  type RunErrandWizardOptions,
} from "./run-errand-wizard";
export {
  runProgressInk,
  runConfirmInk,
  type RunProgressOptions,
  type RunConfirmOptions,
  type ProgressController,
} from "./run-progress";

// Wave monitor adapter (imperative wrapper for launch.ts / resume.ts)
export {
  InkWomboTUI,
  WaveMonitorShell,
  type InkTUIOptions,
  type WaveMonitorShellProps,
} from "./run-wave-monitor";

// Daemon-backed wave monitor adapter (WebSocket client for daemon TUI)
export {
  InkDaemonTUI,
  DaemonMonitorShell,
  type InkDaemonTUIOptions,
  type DaemonMonitorShellProps,
} from "./run-daemon-monitor";

// Task graph utilities
export {
  buildTaskGraph,
  sortStreams,
  flattenStreams,
  type Stream,
} from "./task-graph";

// Terminal utilities (alt-screen buffer, terminal size hook)
export {
  enterAltScreen,
  exitAltScreen,
  isAltScreenActive,
  clearScreen,
  installAltScreenGuard,
} from "./alt-screen";
export {
  useTerminalSize,
  type TerminalSize,
} from "./use-terminal-size";

// TUI session lifecycle manager (alt-screen + guard ownership)
export {
  TuiSession,
  getStdin,
  stdinIsTTY,
  type TuiSessionOptions,
} from "./tui-session";

// Persistent chrome: top/bottom status bars
export {
  ChromeLayout,
  ChromeTopBar,
  ChromeBottomBar,
  ChromeTitleContext,
  useChromTitle,
  type ChromeLayoutProps,
  type ChromeTopBarProps,
  type ChromeBottomBarProps,
  type WaveSummary,
  type KeybindHint,
} from "./chrome";

// Screen router (single render() lifetime, stack-based navigator)
export {
  NavigationContext,
  useNavigation,
  ScreenRouter,
  type ScreenKey,
  type ScreenMap,
  type StackEntry,
  type NavigationState,
  type ScreenRouterProps,
} from "./router";

// Theme system (swappable color/icon tokens)
export {
  THEMES,
  getTheme,
  ThemeContext,
  useTheme,
  type ThemeTokens,
  type ThemeName,
} from "./theme";

// i18n skeleton (t() helper, English strings, locale context)
export {
  t,
  createI18n,
  getLocaleT,
  I18nContext,
  useI18n,
  EN_STRINGS,
  type TFunction,
  type StringsMap,
} from "./i18n";

// ESC menu overlay (global floating menu, keyboard-driven)
export {
  EscMenu,
  EscMenuItem,
  EscMenuProvider,
  useEscMenu,
  type EscMenuProps,
  type EscMenuItemProps,
  type EscMenuProviderProps,
  type EscMenuState,
} from "./esc-menu";

// Settings screen (view/edit config.json interactively)
export {
  SettingsScreen,
  SettingsSection,
  SettingsField,
  type SettingsScreenProps,
  type SettingsSectionProps,
  type SettingsFieldProps,
  type SettingsScreenConfig,
} from "./settings-screen";

// Animated splash screen (shown on TUI startup)
export {
  SplashScreen,
  SPLASH_TEXTS,
  type SplashScreenProps,
} from "./splash-screen";

// Dashboard screen (default screen after splash, context-driven live state)
export {
  DashboardScreen,
  DashboardAgentRow,
  DashboardStoreContext,
  useDashboardStore,
  type DashboardScreenProps,
  type DashboardAgentRowProps,
  type DashboardStore,
  type DashboardAgent,
} from "./dashboard";
