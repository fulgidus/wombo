/**
 * use-text-input.ts — Convenience hook for managing TextInput state.
 *
 * Provides a simple API for controlled text input:
 *   - `value` — current text value
 *   - `onChange` — handler to update the value
 *   - `reset` — restore to initial value
 *
 * Usage:
 *   const { value, onChange, reset } = useTextInput({ initialValue: "" });
 *   return <TextInput value={value} onChange={onChange} />;
 */

import { useState, useCallback } from "react";

export interface UseTextInputOptions {
  /** Initial value for the text input. Default: "" */
  initialValue?: string;
}

export interface UseTextInputResult {
  /** Current text value. */
  value: string;
  /** Handler to update the text value (pass directly to TextInput onChange). */
  onChange: (newValue: string) => void;
  /** Reset the value to the initial value. */
  reset: () => void;
  /** Programmatically set the value. */
  setValue: (newValue: string) => void;
}

/**
 * useTextInput — manages controlled state for a TextInput component.
 *
 * @param options - Configuration options
 * @returns Object with value, onChange, reset, and setValue
 */
export function useTextInput(
  options: UseTextInputOptions = {}
): UseTextInputResult {
  const { initialValue = "" } = options;
  const [value, setValueState] = useState(initialValue);

  const onChange = useCallback((newValue: string) => {
    setValueState(newValue);
  }, []);

  const reset = useCallback(() => {
    setValueState(initialValue);
  }, [initialValue]);

  const setValue = useCallback((newValue: string) => {
    setValueState(newValue);
  }, []);

  return { value, onChange, reset, setValue };
}
