/**
 * ink/index.ts — Barrel re-exports for the Ink app shell.
 */

export { App, type AppProps } from "./app.js";
export { Shell, type ShellProps } from "./shell.js";
export { StatusView, type StatusViewProps } from "./status-view.js";
export { runApp, type RunAppOptions } from "./run-app.js";
export { TextBuffer } from "./text-buffer.js";
export { TextInput, type TextInputProps } from "./text-input.js";
export {
  useTextInput,
  type UseTextInputOptions,
  type UseTextInputResult,
} from "./use-text-input.js";
