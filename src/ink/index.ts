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
  ConfirmDialog,
  type ConfirmDialogProps,
  ProgressView,
  type ProgressViewProps,
  type ProgressResult,
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
