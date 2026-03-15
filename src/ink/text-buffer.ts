/**
 * text-buffer.ts — Pure data class for text content and cursor management.
 *
 * Extracted from blessed-textarea-patch.ts, this class encapsulates all
 * text manipulation logic (insert, delete, cursor navigation) in a
 * framework-agnostic way. Used by the Ink TextInput component.
 *
 * Features:
 *   - Insert/delete at cursor position
 *   - Arrow key navigation (left/right/up/down)
 *   - Home/End to jump within lines
 *   - Line/column tracking for multiline text
 */

// -------------------------------------------------------------------------
// Helpers
// -------------------------------------------------------------------------

/**
 * Given a value string and a cursor position (character index), find
 * the line number and column the cursor is on.
 */
function posToLineCol(value: string, pos: number): { line: number; col: number } {
  const before = value.slice(0, pos);
  const lines = before.split("\n");
  return {
    line: lines.length - 1,
    col: lines[lines.length - 1].length,
  };
}

/**
 * Given a value string, a target line number, and a target column,
 * return the character index into the string.
 */
function lineColToPos(value: string, targetLine: number, targetCol: number): number {
  const lines = value.split("\n");
  let pos = 0;
  for (let i = 0; i < targetLine && i < lines.length; i++) {
    pos += lines[i].length + 1; // +1 for '\n'
  }
  const lineLen = lines[targetLine]?.length ?? 0;
  pos += Math.min(targetCol, lineLen);
  return pos;
}

// -------------------------------------------------------------------------
// TextBuffer class
// -------------------------------------------------------------------------

/**
 * TextBuffer — manages text content and cursor position.
 *
 * All mutations are done via method calls that update `value` and
 * `cursorPos` in sync. The class is entirely synchronous and has no
 * side effects — it is a pure data structure.
 */
export class TextBuffer {
  /** The current text content. */
  value: string;
  /** The cursor position (character index into `value`). */
  cursorPos: number;

  constructor(initialValue: string = "", cursorPos?: number) {
    this.value = initialValue;
    if (cursorPos === undefined) {
      this.cursorPos = initialValue.length;
    } else {
      this.cursorPos = Math.max(0, Math.min(cursorPos, initialValue.length));
    }
  }

  // -----------------------------------------------------------------------
  // Computed properties
  // -----------------------------------------------------------------------

  /** All lines in the buffer. */
  get lines(): string[] {
    return this.value.split("\n");
  }

  /** Number of lines in the buffer. */
  get lineCount(): number {
    return this.lines.length;
  }

  /** Current line and column of the cursor. */
  get lineCol(): { line: number; col: number } {
    return posToLineCol(this.value, this.cursorPos);
  }

  // -----------------------------------------------------------------------
  // Text mutations
  // -----------------------------------------------------------------------

  /** Insert text at the current cursor position. */
  insert(text: string): void {
    this.value =
      this.value.slice(0, this.cursorPos) + text + this.value.slice(this.cursorPos);
    this.cursorPos += text.length;
  }

  /** Delete one character before the cursor (backspace). */
  deleteBack(): void {
    if (this.cursorPos > 0) {
      this.value =
        this.value.slice(0, this.cursorPos - 1) + this.value.slice(this.cursorPos);
      this.cursorPos--;
    }
  }

  /** Delete one character after the cursor (delete key). */
  deleteForward(): void {
    if (this.cursorPos < this.value.length) {
      this.value =
        this.value.slice(0, this.cursorPos) + this.value.slice(this.cursorPos + 1);
    }
  }

  /** Replace the entire value, moving cursor to the end. */
  setValue(newValue: string): void {
    this.value = newValue;
    this.cursorPos = newValue.length;
  }

  // -----------------------------------------------------------------------
  // Cursor movement
  // -----------------------------------------------------------------------

  /** Move cursor one position to the left. */
  moveLeft(): void {
    if (this.cursorPos > 0) {
      this.cursorPos--;
    }
  }

  /** Move cursor one position to the right. */
  moveRight(): void {
    if (this.cursorPos < this.value.length) {
      this.cursorPos++;
    }
  }

  /** Move cursor up one line, preserving column where possible. */
  moveUp(): void {
    const { line, col } = this.lineCol;
    if (line > 0) {
      this.cursorPos = lineColToPos(this.value, line - 1, col);
    }
  }

  /** Move cursor down one line, preserving column where possible. */
  moveDown(): void {
    const { line, col } = this.lineCol;
    if (line < this.lineCount - 1) {
      this.cursorPos = lineColToPos(this.value, line + 1, col);
    }
  }

  /** Move cursor to the start of the current line. */
  moveHome(): void {
    const { line } = this.lineCol;
    this.cursorPos = lineColToPos(this.value, line, 0);
  }

  /** Move cursor to the end of the current line. */
  moveEnd(): void {
    const { line } = this.lineCol;
    const lines = this.lines;
    this.cursorPos = lineColToPos(this.value, line, lines[line]?.length ?? 0);
  }
}
