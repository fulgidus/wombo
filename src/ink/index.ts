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
export { InitForm, FIELDS, type InitFormProps, type InitFormDefaults, type FieldDef } from "./init-form";
export { InitApp, renderInitApp, type InitAppProps } from "./init-app";
export {
  detectProjectName,
  detectBaseBranch,
  detectBuildCommand,
  detectInstallCommand,
} from "./init-detect";
export { writeInitFiles, type InitWriterConfig, type InitWriterResult } from "./init-writer";
