/**
 * blessed-textarea-patch.ts — Monkey-patch for neo-blessed textarea/textbox
 *
 * Adds cursor navigation (arrow keys, Home, End) and proper insert/delete
 * at cursor position.  Also enables Ctrl+E to open $EDITOR for full editing.
 *
 * blessed's built-in textarea has a TODO comment where arrow keys are
 * supposed to be handled — they're explicitly ignored.  The cursor is always
 * rendered at the end of the text.  This patch fixes both problems.
 *
 * Usage:
 *   import { patchTextarea } from "./blessed-textarea-patch.js";
 *   const ta = blessed.textarea({ ... });
 *   patchTextarea(ta);
 *
 * The patch is idempotent — calling it twice on the same widget is safe.
 */

import type { Widgets } from "neo-blessed";

// We work with the widget as `any` internally because blessed's TS types are
// incomplete — they don't expose _clines, _cursorPos, _listener, strWidth,
// childBase, etc.  The public API uses the proper blessed types.

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

/**
 * Total number of lines in the value.
 */
function lineCount(value: string): number {
  return value.split("\n").length;
}

// -------------------------------------------------------------------------
// Patched _listener — handles arrow keys + insert at cursor position
// -------------------------------------------------------------------------

function patchedListener(this: any, ch: string, key: any): void {
  const value = this.value;

  // Clamp cursor position to valid range
  if (this._cursorPos > this.value.length) this._cursorPos = this.value.length;
  if (this._cursorPos < 0) this._cursorPos = 0;

  // -------------------------------------------------------------------
  // Arrow keys
  // -------------------------------------------------------------------

  if (key.name === "left") {
    if (this._cursorPos > 0) {
      this._cursorPos--;
    }
    this._updateCursor();
    this.screen.render();
    return;
  }

  if (key.name === "right") {
    if (this._cursorPos < this.value.length) {
      this._cursorPos++;
    }
    this._updateCursor();
    this.screen.render();
    return;
  }

  if (key.name === "up") {
    const { line, col } = posToLineCol(this.value, this._cursorPos);
    if (line > 0) {
      this._cursorPos = lineColToPos(this.value, line - 1, col);
    }
    this._updateCursor();
    this.screen.render();
    return;
  }

  if (key.name === "down") {
    const { line, col } = posToLineCol(this.value, this._cursorPos);
    const total = lineCount(this.value);
    if (line < total - 1) {
      this._cursorPos = lineColToPos(this.value, line + 1, col);
    }
    this._updateCursor();
    this.screen.render();
    return;
  }

  // -------------------------------------------------------------------
  // Home / End
  // -------------------------------------------------------------------

  if (key.name === "home") {
    const { line } = posToLineCol(this.value, this._cursorPos);
    this._cursorPos = lineColToPos(this.value, line, 0);
    this._updateCursor();
    this.screen.render();
    return;
  }

  if (key.name === "end") {
    const { line } = posToLineCol(this.value, this._cursorPos);
    const lines = this.value.split("\n");
    this._cursorPos = lineColToPos(this.value, line, lines[line]?.length ?? 0);
    this._updateCursor();
    this.screen.render();
    return;
  }

  // -------------------------------------------------------------------
  // Ctrl+E — open external editor
  // -------------------------------------------------------------------

  if (key.ctrl && key.name === "e") {
    return this.readEditor();
  }

  // -------------------------------------------------------------------
  // Enter (newline for textarea, submit for textbox)
  // -------------------------------------------------------------------

  if (key.name === "return") return; // blessed internal — ignore

  if (key.name === "enter") {
    // Textbox: Enter submits — handled by textbox's own override which runs
    // before this listener. If we reach here in a textbox, bail out.
    if (this.type === "textbox") return;

    // Textarea: Insert newline at cursor position
    this.value =
      this.value.slice(0, this._cursorPos) + "\n" + this.value.slice(this._cursorPos);
    this._cursorPos++;
    this.screen.render();
    return;
  }

  // -------------------------------------------------------------------
  // Escape — cancel/exit reading mode
  // -------------------------------------------------------------------

  if (key.name === "escape") {
    this._done(null, null);
    return;
  }

  // -------------------------------------------------------------------
  // Backspace — delete character before cursor
  // -------------------------------------------------------------------

  if (key.name === "backspace") {
    if (this._cursorPos > 0) {
      // Handle unicode surrogate pairs
      let deleteCount = 1;
      if (
        this.screen.fullUnicode &&
        this._cursorPos >= 2 &&
        /[\uD800-\uDBFF]/.test(this.value[this._cursorPos - 2])
      ) {
        deleteCount = 2;
      }
      this.value =
        this.value.slice(0, this._cursorPos - deleteCount) +
        this.value.slice(this._cursorPos);
      this._cursorPos -= deleteCount;
    }
    if (this.value !== value) {
      this.screen.render();
    }
    return;
  }

  // -------------------------------------------------------------------
  // Delete key — delete character after cursor
  // -------------------------------------------------------------------

  if (key.name === "delete") {
    if (this._cursorPos < this.value.length) {
      let deleteCount = 1;
      if (
        this.screen.fullUnicode &&
        /[\uD800-\uDBFF]/.test(this.value[this._cursorPos])
      ) {
        deleteCount = 2;
      }
      this.value =
        this.value.slice(0, this._cursorPos) +
        this.value.slice(this._cursorPos + deleteCount);
    }
    if (this.value !== value) {
      this.screen.render();
    }
    return;
  }

  // -------------------------------------------------------------------
  // Regular character — insert at cursor position
  // -------------------------------------------------------------------

  if (ch) {
    // Filter control characters (same regex as blessed's original)
    if (/^[\x00-\x08\x0b-\x0c\x0e-\x1f\x7f]$/.test(ch)) {
      return;
    }
    this.value =
      this.value.slice(0, this._cursorPos) + ch + this.value.slice(this._cursorPos);
    this._cursorPos += ch.length;
  }

  if (this.value !== value) {
    this.screen.render();
  }
}

// -------------------------------------------------------------------------
// Patched _updateCursor — positions cursor at _cursorPos, not at end
// -------------------------------------------------------------------------

function patchedUpdateCursor(this: any, get?: boolean): void {
  if (this.screen.focused !== this) return;

  const lpos = get ? this.lpos : this._getCoords();
  if (!lpos) return;

  const clines: string[] = this._clines;
  if (!clines || clines.length === 0) return;

  // Walk _clines to find which cline row + column corresponds to _cursorPos.
  //
  // _clines is the value split by '\n' AND by word-wrap.  We walk through
  // the value character by character, advancing through _clines, until we
  // reach _cursorPos.
  const valueLines = this.value.split("\n");
  let globalChar = 0;
  let clineIdx = 0;
  let foundClineIdx = 0;
  let foundColInCline = 0;
  let found = false;

  outer:
  for (let vl = 0; vl < valueLines.length; vl++) {
    const vline = valueLines[vl];
    let consumed = 0;

    while (clineIdx < clines.length) {
      const cline = clines[clineIdx];

      for (let ci = 0; ci < cline.length; ci++) {
        if (globalChar === this._cursorPos) {
          foundClineIdx = clineIdx;
          foundColInCline = ci;
          found = true;
          break outer;
        }
        globalChar++;
        consumed++;
      }

      clineIdx++;

      // If we haven't consumed the full value-line, this was a word-wrap
      // break (no newline char consumed).  Continue to the next cline.
      if (consumed < vline.length) {
        continue;
      }

      // We've consumed the full value-line.
      break;
    }

    // Cursor at end of this value line (before the '\n')
    if (globalChar === this._cursorPos) {
      foundClineIdx = Math.max(0, clineIdx - 1);
      foundColInCline = clines[foundClineIdx]?.length ?? 0;
      found = true;
      break;
    }

    // Consume the '\n' between value lines
    if (vl < valueLines.length - 1) {
      globalChar++;
    }
  }

  // If cursor is at the very end
  if (!found) {
    foundClineIdx = clines.length - 1;
    // Handle empty trailing cline from _typeScroll
    if (
      clines[foundClineIdx] === "" &&
      this.value.length > 0 &&
      this.value[this.value.length - 1] !== "\n" &&
      foundClineIdx > 0
    ) {
      foundClineIdx--;
    }
    foundColInCline = clines[foundClineIdx]?.length ?? 0;
  }

  const program = this.screen.program;

  // Account for scrolling (childBase)
  const visibleLine = foundClineIdx - (this.childBase || 0);
  const maxVisibleLine = (lpos.yl - lpos.yi) - this.iheight - 1;

  // Auto-scroll if cursor is off-screen
  if (visibleLine < 0) {
    const delta = foundClineIdx - (this.childBase || 0);
    this.scroll(delta);
    this.screen.render();
    return;
  }
  if (visibleLine > maxVisibleLine) {
    const scrollTo = foundClineIdx - maxVisibleLine;
    const delta = scrollTo - (this.childBase || 0);
    this.scroll(delta);
    this.screen.render();
    return;
  }

  const cy = lpos.yi + this.itop + Math.max(0, Math.min(visibleLine, maxVisibleLine));
  const clineText = clines[foundClineIdx] || "";
  const cx = lpos.xi + this.ileft + this.strWidth(clineText.slice(0, foundColInCline));

  if (cy === program.y && cx === program.x) return;

  if (cy === program.y) {
    if (cx > program.x) {
      program.cuf(cx - program.x);
    } else if (cx < program.x) {
      program.cub(program.x - cx);
    }
  } else if (cx === program.x) {
    if (cy > program.y) {
      program.cud(cy - program.y);
    } else if (cy < program.y) {
      program.cuu(program.y - cy);
    }
  } else {
    program.cup(cy, cx);
  }
}

// -------------------------------------------------------------------------
// Public API
// -------------------------------------------------------------------------

/**
 * Patch a blessed textarea or textbox widget to support:
 * - Arrow key cursor navigation (left, right, up, down)
 * - Home / End
 * - Insert at cursor position (not just append)
 * - Delete key
 * - Ctrl+E to open $EDITOR
 *
 * Idempotent — safe to call multiple times on the same widget.
 */
export function patchTextarea(
  widget: Widgets.TextareaElement | Widgets.TextboxElement,
): void {
  const w = widget as any;
  if (w._patched) return;
  w._patched = true;

  // Initialize cursor position at end of current value
  w._cursorPos = (w.value || "").length;

  // Save originals
  w._origListener = w._listener.bind(w);
  w._origUpdateCursor = w._updateCursor.bind(w);

  // Replace _listener and _updateCursor on the instance (not prototype)
  w._listener = patchedListener.bind(w);
  w._updateCursor = patchedUpdateCursor.bind(w);

  // Wrap setValue to keep _cursorPos in sync
  const origSetValue = w.setValue.bind(w);
  w.setValue = function (value?: string) {
    origSetValue(value);
    // After setValue, place cursor at end
    w._cursorPos = (w.value || "").length;
  };
}
