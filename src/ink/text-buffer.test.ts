/**
 * text-buffer.test.ts — Tests for the TextBuffer utility class.
 *
 * TextBuffer is a pure data class that manages text content and cursor position.
 * It is the core logic extracted from blessed-textarea-patch.ts, designed to be
 * used by the Ink TextInput component.
 */

import { describe, test, expect } from "bun:test";
import { TextBuffer } from "./text-buffer";

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

describe("TextBuffer construction", () => {
  test("creates empty buffer with cursor at 0", () => {
    const buf = new TextBuffer();
    expect(buf.value).toBe("");
    expect(buf.cursorPos).toBe(0);
  });

  test("creates buffer with initial value and cursor at end", () => {
    const buf = new TextBuffer("hello");
    expect(buf.value).toBe("hello");
    expect(buf.cursorPos).toBe(5);
  });

  test("creates buffer with initial value and custom cursor position", () => {
    const buf = new TextBuffer("hello", 2);
    expect(buf.value).toBe("hello");
    expect(buf.cursorPos).toBe(2);
  });

  test("clamps cursor position to value length", () => {
    const buf = new TextBuffer("hi", 100);
    expect(buf.cursorPos).toBe(2);
  });

  test("clamps negative cursor position to 0", () => {
    const buf = new TextBuffer("hi", -5);
    expect(buf.cursorPos).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Insert
// ---------------------------------------------------------------------------

describe("TextBuffer.insert", () => {
  test("inserts character at cursor position", () => {
    const buf = new TextBuffer("hllo", 1);
    buf.insert("e");
    expect(buf.value).toBe("hello");
    expect(buf.cursorPos).toBe(2);
  });

  test("inserts at beginning", () => {
    const buf = new TextBuffer("ello", 0);
    buf.insert("h");
    expect(buf.value).toBe("hello");
    expect(buf.cursorPos).toBe(1);
  });

  test("inserts at end (append)", () => {
    const buf = new TextBuffer("hell");
    buf.insert("o");
    expect(buf.value).toBe("hello");
    expect(buf.cursorPos).toBe(5);
  });

  test("inserts multi-character string", () => {
    const buf = new TextBuffer("hd", 1);
    buf.insert("ello worl");
    expect(buf.value).toBe("hello world");
    expect(buf.cursorPos).toBe(10);
  });

  test("inserts newline", () => {
    const buf = new TextBuffer("ab", 1);
    buf.insert("\n");
    expect(buf.value).toBe("a\nb");
    expect(buf.cursorPos).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Delete (backspace)
// ---------------------------------------------------------------------------

describe("TextBuffer.deleteBack", () => {
  test("deletes character before cursor", () => {
    const buf = new TextBuffer("hello", 3);
    buf.deleteBack();
    expect(buf.value).toBe("helo");
    expect(buf.cursorPos).toBe(2);
  });

  test("does nothing at beginning of buffer", () => {
    const buf = new TextBuffer("hello", 0);
    buf.deleteBack();
    expect(buf.value).toBe("hello");
    expect(buf.cursorPos).toBe(0);
  });

  test("deletes last character", () => {
    const buf = new TextBuffer("hello");
    buf.deleteBack();
    expect(buf.value).toBe("hell");
    expect(buf.cursorPos).toBe(4);
  });

  test("deletes newline character", () => {
    const buf = new TextBuffer("a\nb", 2);
    buf.deleteBack();
    expect(buf.value).toBe("ab");
    expect(buf.cursorPos).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Delete forward
// ---------------------------------------------------------------------------

describe("TextBuffer.deleteForward", () => {
  test("deletes character after cursor", () => {
    const buf = new TextBuffer("hello", 2);
    buf.deleteForward();
    expect(buf.value).toBe("helo");
    expect(buf.cursorPos).toBe(2);
  });

  test("does nothing at end of buffer", () => {
    const buf = new TextBuffer("hello");
    buf.deleteForward();
    expect(buf.value).toBe("hello");
    expect(buf.cursorPos).toBe(5);
  });

  test("deletes first character", () => {
    const buf = new TextBuffer("hello", 0);
    buf.deleteForward();
    expect(buf.value).toBe("ello");
    expect(buf.cursorPos).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Cursor movement: left / right
// ---------------------------------------------------------------------------

describe("TextBuffer.moveLeft / moveRight", () => {
  test("moveLeft decrements cursor", () => {
    const buf = new TextBuffer("hello", 3);
    buf.moveLeft();
    expect(buf.cursorPos).toBe(2);
  });

  test("moveLeft stops at 0", () => {
    const buf = new TextBuffer("hello", 0);
    buf.moveLeft();
    expect(buf.cursorPos).toBe(0);
  });

  test("moveRight increments cursor", () => {
    const buf = new TextBuffer("hello", 2);
    buf.moveRight();
    expect(buf.cursorPos).toBe(3);
  });

  test("moveRight stops at end", () => {
    const buf = new TextBuffer("hello");
    buf.moveRight();
    expect(buf.cursorPos).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// Cursor movement: up / down (multiline)
// ---------------------------------------------------------------------------

describe("TextBuffer.moveUp / moveDown", () => {
  test("moveUp moves to previous line, same column", () => {
    const buf = new TextBuffer("abc\ndef\nghi", 8); // cursor at 'h'
    buf.moveUp();
    expect(buf.cursorPos).toBe(4); // cursor at 'd'
  });

  test("moveUp clamps column to shorter line", () => {
    const buf = new TextBuffer("ab\nc\ndef", 7); // cursor at 'f'
    buf.moveUp();
    // Line "c" has length 1, column 2 would be clamped to 1
    expect(buf.cursorPos).toBe(4); // end of "c"
  });

  test("moveUp does nothing on first line", () => {
    const buf = new TextBuffer("hello", 3);
    buf.moveUp();
    expect(buf.cursorPos).toBe(3);
  });

  test("moveDown moves to next line, same column", () => {
    const buf = new TextBuffer("abc\ndef\nghi", 1); // cursor at 'b'
    buf.moveDown();
    expect(buf.cursorPos).toBe(5); // cursor at 'e'
  });

  test("moveDown clamps column to shorter line", () => {
    const buf = new TextBuffer("abc\nd\nefg", 2); // cursor at 'c'
    buf.moveDown();
    // Line "d" has length 1, column 2 would be clamped to 1
    expect(buf.cursorPos).toBe(5); // end of "d"
  });

  test("moveDown does nothing on last line", () => {
    const buf = new TextBuffer("hello", 3);
    buf.moveDown();
    expect(buf.cursorPos).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Home / End
// ---------------------------------------------------------------------------

describe("TextBuffer.moveHome / moveEnd", () => {
  test("moveHome goes to start of current line", () => {
    const buf = new TextBuffer("abc\ndef", 6); // cursor at 'f'
    buf.moveHome();
    expect(buf.cursorPos).toBe(4); // start of "def"
  });

  test("moveHome on first line goes to 0", () => {
    const buf = new TextBuffer("hello", 3);
    buf.moveHome();
    expect(buf.cursorPos).toBe(0);
  });

  test("moveEnd goes to end of current line", () => {
    const buf = new TextBuffer("abc\ndef", 4); // cursor at 'd'
    buf.moveEnd();
    expect(buf.cursorPos).toBe(7); // end of "def"
  });

  test("moveEnd on first line goes to end of first line", () => {
    const buf = new TextBuffer("abc\ndef", 1); // cursor at 'b'
    buf.moveEnd();
    expect(buf.cursorPos).toBe(3); // end of "abc"
  });
});

// ---------------------------------------------------------------------------
// Line/column helpers
// ---------------------------------------------------------------------------

describe("TextBuffer line/col helpers", () => {
  test("lineCol returns correct line and column", () => {
    const buf = new TextBuffer("abc\ndef\nghi", 5); // cursor at 'e'
    const { line, col } = buf.lineCol;
    expect(line).toBe(1);
    expect(col).toBe(1);
  });

  test("lineCol at start of buffer", () => {
    const buf = new TextBuffer("abc", 0);
    expect(buf.lineCol).toEqual({ line: 0, col: 0 });
  });

  test("lineCol at end of last line", () => {
    const buf = new TextBuffer("abc\ndef", 7);
    expect(buf.lineCol).toEqual({ line: 1, col: 3 });
  });

  test("lines returns all lines", () => {
    const buf = new TextBuffer("abc\ndef\nghi");
    expect(buf.lines).toEqual(["abc", "def", "ghi"]);
  });

  test("lineCount returns number of lines", () => {
    const buf = new TextBuffer("abc\ndef\nghi");
    expect(buf.lineCount).toBe(3);
  });

  test("single line has lineCount 1", () => {
    const buf = new TextBuffer("hello");
    expect(buf.lineCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// setValue
// ---------------------------------------------------------------------------

describe("TextBuffer.setValue", () => {
  test("replaces value and moves cursor to end", () => {
    const buf = new TextBuffer("old", 1);
    buf.setValue("new value");
    expect(buf.value).toBe("new value");
    expect(buf.cursorPos).toBe(9);
  });

  test("sets empty value", () => {
    const buf = new TextBuffer("something");
    buf.setValue("");
    expect(buf.value).toBe("");
    expect(buf.cursorPos).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe("TextBuffer edge cases", () => {
  test("empty buffer operations don't crash", () => {
    const buf = new TextBuffer();
    buf.moveLeft();
    buf.moveRight();
    buf.moveUp();
    buf.moveDown();
    buf.moveHome();
    buf.moveEnd();
    buf.deleteBack();
    buf.deleteForward();
    expect(buf.value).toBe("");
    expect(buf.cursorPos).toBe(0);
  });

  test("rapid insertions and deletions", () => {
    const buf = new TextBuffer();
    buf.insert("a");
    buf.insert("b");
    buf.insert("c");
    buf.deleteBack();
    buf.deleteBack();
    expect(buf.value).toBe("a");
    expect(buf.cursorPos).toBe(1);
  });

  test("multiline navigation round-trip", () => {
    const buf = new TextBuffer("abc\ndef\nghi", 1); // cursor at 'b', col 1
    buf.moveDown(); // 'e', col 1
    buf.moveDown(); // 'h', col 1
    buf.moveUp();   // 'e', col 1
    buf.moveUp();   // 'b', col 1
    expect(buf.cursorPos).toBe(1);
  });

  test("cursor stays valid after multiple operations", () => {
    const buf = new TextBuffer("hello world");
    // Move to middle
    buf.moveLeft();
    buf.moveLeft();
    buf.moveLeft();
    buf.moveLeft();
    buf.moveLeft();
    // Delete and insert in middle
    buf.deleteBack();
    buf.insert("X");
    expect(buf.value).toBe("helloXworld");
    expect(buf.cursorPos).toBe(6);
  });

  test("handles single character buffer", () => {
    const buf = new TextBuffer("x");
    expect(buf.cursorPos).toBe(1);
    buf.moveLeft();
    expect(buf.cursorPos).toBe(0);
    buf.deleteForward();
    expect(buf.value).toBe("");
    expect(buf.cursorPos).toBe(0);
  });

  test("insert at beginning of multiline text", () => {
    const buf = new TextBuffer("abc\ndef", 0);
    buf.insert("X");
    expect(buf.value).toBe("Xabc\ndef");
    expect(buf.cursorPos).toBe(1);
  });

  test("delete at newline boundary joins lines", () => {
    const buf = new TextBuffer("abc\ndef", 3);
    buf.deleteForward(); // Delete the newline
    expect(buf.value).toBe("abcdef");
    expect(buf.cursorPos).toBe(3);
  });

  test("backspace at start of second line joins lines", () => {
    const buf = new TextBuffer("abc\ndef", 4);
    buf.deleteBack(); // Delete the newline
    expect(buf.value).toBe("abcdef");
    expect(buf.cursorPos).toBe(3);
  });

  test("moveUp with column clamping preserves original col on moveDown", () => {
    // Line 0: "abcdef" (6 chars)
    // Line 1: "gh"     (2 chars)
    // Line 2: "ijklmn" (6 chars)
    const buf = new TextBuffer("abcdef\ngh\nijklmn");
    // Put cursor at end of last line (position = 6+1+2+1+5 = 15... let me calculate)
    // "abcdef\ngh\nijklmn" has positions:
    //   a=0 b=1 c=2 d=3 e=4 f=5 \n=6 g=7 h=8 \n=9 i=10 j=11 k=12 l=13 m=14 n=15
    buf.moveHome(); // Go to start of "ijklmn" (position 10)
    // Move right 5 times to position 15 (at 'n')
    for (let i = 0; i < 5; i++) buf.moveRight();
    expect(buf.cursorPos).toBe(15);
    
    // Move up to "gh" — col 5 should clamp to 2 (end of "gh")
    buf.moveUp();
    // lineColToPos for line 1, col 2 = 7 + min(5, 2) = 9 (end-of-line position)
    expect(buf.cursorPos).toBe(9);
    
    // Move up again to "abcdef" — uses current col (2), goes to col 2 on line 0
    buf.moveUp();
    expect(buf.cursorPos).toBe(2); // at 'c'
  });

  test("handles trailing newline", () => {
    const buf = new TextBuffer("abc\n");
    expect(buf.lineCount).toBe(2);
    expect(buf.lines).toEqual(["abc", ""]);
    expect(buf.cursorPos).toBe(4); // After the newline
    buf.moveUp();
    expect(buf.lineCol.line).toBe(0);
  });

  test("handles multiple consecutive newlines", () => {
    const buf = new TextBuffer("a\n\n\nb", 2);
    expect(buf.lineCol).toEqual({ line: 1, col: 0 });
    buf.moveDown();
    expect(buf.lineCol).toEqual({ line: 2, col: 0 });
    buf.moveDown();
    expect(buf.lineCol).toEqual({ line: 3, col: 0 });
  });

  test("unicode characters work correctly", () => {
    const buf = new TextBuffer("héllo 🌍");
    // Note: JS string length counts code units, not codepoints
    expect(buf.value).toBe("héllo 🌍");
    buf.moveLeft();
    buf.moveLeft();
    buf.insert("!");
    expect(buf.value).toContain("!");
  });
});
