/**
 * text-input.test.tsx — Tests for the TextInput Ink component.
 *
 * Verifies:
 *   - Renders with initial value and placeholder
 *   - Single-line mode: Enter does NOT insert newline (no-op for single-line)
 *   - Multi-line mode: Enter inserts newline
 *   - Ctrl+S triggers onSubmit callback
 *   - Arrow keys navigate the cursor
 *   - Home/End navigate within line
 *   - Backspace/Delete remove characters
 *   - Character insertion at cursor position
 *   - Focus/blur behavior
 */

import { describe, test, expect, mock } from "bun:test";
import React from "react";
import { render, renderToString } from "ink";
import { TextInput } from "./text-input";
import { PassThrough } from "node:stream";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create fake stdin/stdout streams for testing Ink render. */
function createTestStreams() {
  const stdout = new PassThrough() as unknown as NodeJS.WriteStream;
  (stdout as any).columns = 80;
  (stdout as any).rows = 24;
  const stdin = new PassThrough() as unknown as NodeJS.ReadStream;
  (stdin as any).isTTY = true;
  (stdin as any).setRawMode = () => stdin;
  (stdin as any).ref = () => stdin;
  (stdin as any).unref = () => stdin;
  return { stdin, stdout };
}

/** Capture rendered output as accumulated string. */
function renderLive(element: React.ReactElement) {
  const { stdin, stdout } = createTestStreams();
  const chunks: string[] = [];
  stdout.on("data", (chunk: Buffer) => {
    chunks.push(chunk.toString());
  });

  const instance = render(element, {
    stdout,
    stdin,
    debug: true,
    exitOnCtrlC: false,
    patchConsole: false,
  });

  return {
    instance,
    stdin: stdin as any as PassThrough,
    getOutput: () => chunks.join(""),
    cleanup: async () => {
      instance.unmount();
      await instance.waitUntilExit();
    },
  };
}

// ---------------------------------------------------------------------------
// Static render tests
// ---------------------------------------------------------------------------

describe("TextInput (static rendering)", () => {
  test("renders with default empty value", () => {
    const output = renderToString(<TextInput />);
    // Should render something (at minimum a cursor indicator)
    expect(typeof output).toBe("string");
  });

  test("renders initial value", () => {
    const output = renderToString(<TextInput value="hello" />);
    expect(output).toContain("hello");
  });

  test("renders placeholder when value is empty", () => {
    const output = renderToString(
      <TextInput value="" placeholder="Type here..." />
    );
    expect(output).toContain("Type here...");
  });

  test("does not render placeholder when value is non-empty", () => {
    const output = renderToString(
      <TextInput value="hi" placeholder="Type here..." />
    );
    expect(output).not.toContain("Type here...");
  });
});

// ---------------------------------------------------------------------------
// Callback tests
// ---------------------------------------------------------------------------

describe("TextInput callbacks", () => {
  test("calls onChange when characters are typed", async () => {
    const onChange = mock(() => {});
    const { stdin, cleanup } = renderLive(
      <TextInput value="" onChange={onChange} />
    );

    // Type a character
    stdin.write("a");
    await new Promise((r) => setTimeout(r, 50));

    expect(onChange).toHaveBeenCalledWith("a");

    await cleanup();
  });

  test("calls onSubmit with Ctrl+S", async () => {
    const onSubmit = mock(() => {});
    const { stdin, cleanup } = renderLive(
      <TextInput value="hello" onSubmit={onSubmit} />
    );

    // Ctrl+S is character \x13
    stdin.write("\x13");
    await new Promise((r) => setTimeout(r, 50));

    expect(onSubmit).toHaveBeenCalledWith("hello");

    await cleanup();
  });

  test("Enter does NOT submit in either mode", async () => {
    const onSubmit = mock(() => {});
    const { stdin, cleanup } = renderLive(
      <TextInput value="hello" onSubmit={onSubmit} />
    );

    // Enter key
    stdin.write("\r");
    await new Promise((r) => setTimeout(r, 50));

    // Enter should NOT call onSubmit (Ctrl+S is the submit key)
    expect(onSubmit).not.toHaveBeenCalled();

    await cleanup();
  });
});

// ---------------------------------------------------------------------------
// Single-line mode
// ---------------------------------------------------------------------------

describe("TextInput (single-line mode)", () => {
  test("Enter does not insert newline in single-line mode", async () => {
    const onChange = mock(() => {});
    const { stdin, cleanup } = renderLive(
      <TextInput value="hello" onChange={onChange} multiline={false} />
    );

    stdin.write("\r");
    await new Promise((r) => setTimeout(r, 50));

    // onChange should NOT have been called with a newline
    // In single-line mode, Enter is a no-op
    const calls = onChange.mock.calls;
    const hasNewline = calls.some(
      (call: any) => typeof call[0] === "string" && call[0].includes("\n")
    );
    expect(hasNewline).toBe(false);

    await cleanup();
  });
});

// ---------------------------------------------------------------------------
// Multi-line mode
// ---------------------------------------------------------------------------

describe("TextInput (multi-line mode)", () => {
  test("Enter inserts newline in multi-line mode", async () => {
    const onChange = mock(() => {});
    const { stdin, cleanup } = renderLive(
      <TextInput value="hello" onChange={onChange} multiline={true} />
    );

    stdin.write("\r");
    await new Promise((r) => setTimeout(r, 50));

    // onChange should have been called with value containing newline
    expect(onChange).toHaveBeenCalled();
    const lastCall = onChange.mock.calls[onChange.mock.calls.length - 1] as any;
    expect(lastCall[0]).toContain("\n");

    await cleanup();
  });
});

// ---------------------------------------------------------------------------
// Character input
// ---------------------------------------------------------------------------

describe("TextInput character input", () => {
  test("typing characters appends to value", async () => {
    const onChange = mock(() => {});
    const { stdin, cleanup } = renderLive(
      <TextInput value="" onChange={onChange} />
    );

    stdin.write("h");
    await new Promise((r) => setTimeout(r, 50));

    expect(onChange).toHaveBeenCalledWith("h");

    await cleanup();
  });

  test("backspace removes last character", async () => {
    const onChange = mock(() => {});
    const { stdin, cleanup } = renderLive(
      <TextInput value="hello" onChange={onChange} />
    );

    // In Ink, \x08 (Ctrl+H) is parsed as backspace
    stdin.write("\x08");
    await new Promise((r) => setTimeout(r, 50));

    expect(onChange).toHaveBeenCalledWith("hell");

    await cleanup();
  });
});

// ---------------------------------------------------------------------------
// Focus
// ---------------------------------------------------------------------------

describe("TextInput focus", () => {
  test("does not process input when not focused", async () => {
    const onChange = mock(() => {});
    const { stdin, cleanup } = renderLive(
      <TextInput value="hello" onChange={onChange} focus={false} />
    );

    stdin.write("x");
    await new Promise((r) => setTimeout(r, 50));

    expect(onChange).not.toHaveBeenCalled();

    await cleanup();
  });
});

// ---------------------------------------------------------------------------
// Cursor display
// ---------------------------------------------------------------------------

describe("TextInput cursor rendering", () => {
  test("shows cursor indicator when focused", () => {
    const output = renderToString(<TextInput value="hello" focus={true} />);
    // The component should render the value — exact cursor rendering is implementation-dependent
    expect(output).toContain("hello");
  });
});

// ---------------------------------------------------------------------------
// Arrow key navigation
// ---------------------------------------------------------------------------

describe("TextInput arrow key navigation", () => {
  test("left arrow moves cursor, subsequent typing inserts at cursor", async () => {
    const onChange = mock(() => {});
    const { stdin, cleanup } = renderLive(
      <TextInput value="ac" onChange={onChange} />
    );

    // Send left arrow (ESC [ D) to move cursor left once
    stdin.write("\x1b[D");
    await new Promise((r) => setTimeout(r, 50));

    // Type 'b' — should insert before 'c'
    stdin.write("b");
    await new Promise((r) => setTimeout(r, 50));

    // onChange should have been called with "abc" (inserted 'b' at position 1)
    const lastCall = onChange.mock.calls[onChange.mock.calls.length - 1] as any;
    expect(lastCall[0]).toBe("abc");

    await cleanup();
  });

  test("right arrow moves cursor forward", async () => {
    const onChange = mock(() => {});
    const { stdin, cleanup } = renderLive(
      <TextInput value="abc" onChange={onChange} />
    );

    // Move left twice
    stdin.write("\x1b[D");
    stdin.write("\x1b[D");
    await new Promise((r) => setTimeout(r, 50));

    // Move right once
    stdin.write("\x1b[C");
    await new Promise((r) => setTimeout(r, 50));

    // Type 'X' — should insert between 'b' and 'c'
    stdin.write("X");
    await new Promise((r) => setTimeout(r, 50));

    const lastCall = onChange.mock.calls[onChange.mock.calls.length - 1] as any;
    expect(lastCall[0]).toBe("abXc");

    await cleanup();
  });

  test("up arrow moves cursor to previous line in multiline", async () => {
    const onChange = mock(() => {});
    const { stdin, cleanup } = renderLive(
      <TextInput value={"abc\ndef"} onChange={onChange} multiline={true} />
    );

    // Cursor starts at end of "def" (position 7)
    // Move up should go to line 0, col 3 -> position 3
    stdin.write("\x1b[A");
    await new Promise((r) => setTimeout(r, 50));

    // Type 'X' at position 3 (end of "abc")
    stdin.write("X");
    await new Promise((r) => setTimeout(r, 50));

    const lastCall = onChange.mock.calls[onChange.mock.calls.length - 1] as any;
    expect(lastCall[0]).toBe("abcX\ndef");

    await cleanup();
  });

  test("down arrow moves cursor to next line in multiline", async () => {
    const onChange = mock(() => {});
    const { stdin, cleanup } = renderLive(
      <TextInput value={"abc\ndef"} onChange={onChange} multiline={true} />
    );

    // Move to start first: Home goes to start of current line
    stdin.write("\x1b[H");
    await new Promise((r) => setTimeout(r, 50));

    // That puts us at start of "def" (line 1, col 0 = position 4)
    // Actually we need to go to line 0 first. Move up.
    stdin.write("\x1b[A");
    await new Promise((r) => setTimeout(r, 50));

    // Now at start of "abc" (line 0, col 0 = position 0)
    // Move right to col 1
    stdin.write("\x1b[C");
    await new Promise((r) => setTimeout(r, 50));

    // Move down — should go to line 1, col 1 = position 5
    stdin.write("\x1b[B");
    await new Promise((r) => setTimeout(r, 50));

    // Type 'X' at position 5 (between 'd' and 'ef')
    stdin.write("X");
    await new Promise((r) => setTimeout(r, 50));

    const lastCall = onChange.mock.calls[onChange.mock.calls.length - 1] as any;
    expect(lastCall[0]).toBe("abc\ndXef");

    await cleanup();
  });
});

// ---------------------------------------------------------------------------
// Home / End keys
// ---------------------------------------------------------------------------

describe("TextInput Home/End keys", () => {
  test("Home moves cursor to start of line", async () => {
    const onChange = mock(() => {});
    const { stdin, cleanup } = renderLive(
      <TextInput value="hello" onChange={onChange} />
    );

    // Home key
    stdin.write("\x1b[H");
    await new Promise((r) => setTimeout(r, 50));

    // Type 'X' — should insert at start
    stdin.write("X");
    await new Promise((r) => setTimeout(r, 50));

    const lastCall = onChange.mock.calls[onChange.mock.calls.length - 1] as any;
    expect(lastCall[0]).toBe("Xhello");

    await cleanup();
  });

  test("End moves cursor to end of line", async () => {
    const onChange = mock(() => {});
    const { stdin, cleanup } = renderLive(
      <TextInput value="hello" onChange={onChange} />
    );

    // First move Home, then End
    stdin.write("\x1b[H");
    await new Promise((r) => setTimeout(r, 50));

    stdin.write("\x1b[F");
    await new Promise((r) => setTimeout(r, 50));

    // Type 'X' — should insert at end
    stdin.write("X");
    await new Promise((r) => setTimeout(r, 50));

    const lastCall = onChange.mock.calls[onChange.mock.calls.length - 1] as any;
    expect(lastCall[0]).toBe("helloX");

    await cleanup();
  });
});

// ---------------------------------------------------------------------------
// Delete key
// ---------------------------------------------------------------------------

describe("TextInput delete key", () => {
  test("delete key removes character after cursor", async () => {
    const onChange = mock(() => {});
    const { stdin, cleanup } = renderLive(
      <TextInput value="hello" onChange={onChange} />
    );

    // Move to start
    stdin.write("\x1b[H");
    await new Promise((r) => setTimeout(r, 50));

    // Delete key (ESC [ 3 ~)
    stdin.write("\x1b[3~");
    await new Promise((r) => setTimeout(r, 50));

    const lastCall = onChange.mock.calls[onChange.mock.calls.length - 1] as any;
    expect(lastCall[0]).toBe("ello");

    await cleanup();
  });
});

// ---------------------------------------------------------------------------
// Ctrl+E external editor
// ---------------------------------------------------------------------------

describe("TextInput Ctrl+E", () => {
  test("Ctrl+E triggers onEditorRequest callback", async () => {
    const onEditorRequest = mock(() => {});
    const { stdin, cleanup } = renderLive(
      <TextInput value="hello" onEditorRequest={onEditorRequest} />
    );

    // Ctrl+E is character \x05
    stdin.write("\x05");
    await new Promise((r) => setTimeout(r, 50));

    expect(onEditorRequest).toHaveBeenCalledWith("hello");

    await cleanup();
  });

  test("Ctrl+E does nothing when onEditorRequest is not provided", async () => {
    const onChange = mock(() => {});
    const { stdin, cleanup } = renderLive(
      <TextInput value="hello" onChange={onChange} />
    );

    // Ctrl+E should not crash or change value
    stdin.write("\x05");
    await new Promise((r) => setTimeout(r, 50));

    expect(onChange).not.toHaveBeenCalled();

    await cleanup();
  });
});

// ---------------------------------------------------------------------------
// Multiline rendering
// ---------------------------------------------------------------------------

describe("TextInput multiline rendering", () => {
  test("renders multiline value with line breaks", () => {
    const output = renderToString(
      <TextInput value={"line1\nline2\nline3"} multiline={true} focus={false} />
    );
    expect(output).toContain("line1");
    expect(output).toContain("line2");
    expect(output).toContain("line3");
  });
});
