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
  type RawInputs,
  type InputStep,
  INPUT_STEPS,
  SECTION_NAMES,
  structureRawInputs,
} from "./onboarding";
