/**
 * question-popup.test.tsx — Tests for the QuestionPopupView Ink component.
 *
 * Verifies:
 *   - Renders "HITL Questions" title with count
 *   - Shows "No pending questions" when list is empty
 *   - Displays agent ID and question text
 *   - Displays context when provided
 *   - Shows navigation hints when multiple questions
 *   - timeAgo helper formats correctly
 *   - Escape calls onClose
 *   - Ctrl+S calls onAnswer with input text
 *   - Tab cycles to next question
 *   - Shift+Tab cycles to previous question
 *   - Empty answer is rejected (does not call onAnswer)
 */

import { describe, test, expect, mock } from "bun:test";
import React from "react";
import { render, renderToString, Text } from "ink";
import { QuestionPopupView, timeAgo } from "./question-popup";
import type { HitlQuestion } from "../lib/hitl-channel";
import { PassThrough } from "node:stream";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

function makeQuestion(overrides: Partial<HitlQuestion> = {}): HitlQuestion {
  return {
    id: "q-1",
    agentId: "auth-service",
    text: "How should I handle the edge case?",
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

function makeQuestions(): HitlQuestion[] {
  return [
    makeQuestion({ id: "q-1", agentId: "auth-service", text: "Question one?" }),
    makeQuestion({
      id: "q-2",
      agentId: "search-api",
      text: "Question two?",
      context: "Working on search indexing",
    }),
  ];
}

// ---------------------------------------------------------------------------
// timeAgo helper tests
// ---------------------------------------------------------------------------

describe("timeAgo", () => {
  test("formats seconds ago", () => {
    const ts = new Date(Date.now() - 30_000).toISOString();
    expect(timeAgo(ts)).toContain("30s ago");
  });

  test("formats minutes ago", () => {
    const ts = new Date(Date.now() - 5 * 60_000).toISOString();
    expect(timeAgo(ts)).toContain("5m ago");
  });

  test("formats hours ago", () => {
    const ts = new Date(Date.now() - 2 * 60 * 60_000).toISOString();
    expect(timeAgo(ts)).toContain("2h");
  });
});

// ---------------------------------------------------------------------------
// Static render tests
// ---------------------------------------------------------------------------

describe("QuestionPopupView (static rendering)", () => {
  test("renders HITL Questions title with count", () => {
    const output = renderToString(
      <QuestionPopupView
        questions={makeQuestions()}
        currentIndex={0}
        answerText=""
        onClose={() => {}}
        onAnswer={() => {}}
        onNavigate={() => {}}
        onAnswerChange={() => {}}
      />
    );
    expect(output).toContain("HITL Questions");
    expect(output).toContain("2");
  });

  test("shows 'No pending questions' when empty", () => {
    const output = renderToString(
      <QuestionPopupView
        questions={[]}
        currentIndex={0}
        answerText=""
        onClose={() => {}}
        onAnswer={() => {}}
        onNavigate={() => {}}
        onAnswerChange={() => {}}
      />
    );
    expect(output).toContain("No pending questions");
  });

  test("displays agent ID", () => {
    const output = renderToString(
      <QuestionPopupView
        questions={[makeQuestion({ agentId: "my-agent" })]}
        currentIndex={0}
        answerText=""
        onClose={() => {}}
        onAnswer={() => {}}
        onNavigate={() => {}}
        onAnswerChange={() => {}}
      />
    );
    expect(output).toContain("my-agent");
  });

  test("displays question text", () => {
    const output = renderToString(
      <QuestionPopupView
        questions={[makeQuestion({ text: "What about edge cases?" })]}
        currentIndex={0}
        answerText=""
        onClose={() => {}}
        onAnswer={() => {}}
        onNavigate={() => {}}
        onAnswerChange={() => {}}
      />
    );
    expect(output).toContain("What about edge cases?");
  });

  test("displays context when provided", () => {
    const output = renderToString(
      <QuestionPopupView
        questions={[makeQuestion({ context: "Working on auth middleware" })]}
        currentIndex={0}
        answerText=""
        onClose={() => {}}
        onAnswer={() => {}}
        onNavigate={() => {}}
        onAnswerChange={() => {}}
      />
    );
    expect(output).toContain("Working on auth middleware");
  });

  test("shows navigation hints when multiple questions", () => {
    const output = renderToString(
      <QuestionPopupView
        questions={makeQuestions()}
        currentIndex={0}
        answerText=""
        onClose={() => {}}
        onAnswer={() => {}}
        onNavigate={() => {}}
        onAnswerChange={() => {}}
      />
    );
    expect(output).toContain("Tab");
    expect(output).toContain("1/2");
  });

  test("shows Ctrl+S submit hint", () => {
    const output = renderToString(
      <QuestionPopupView
        questions={[makeQuestion()]}
        currentIndex={0}
        answerText=""
        onClose={() => {}}
        onAnswer={() => {}}
        onNavigate={() => {}}
        onAnswerChange={() => {}}
      />
    );
    expect(output).toContain("Ctrl+S");
  });

  test("renders without crashing", () => {
    expect(() =>
      renderToString(
        <QuestionPopupView
          questions={[]}
          currentIndex={0}
          answerText=""
          onClose={() => {}}
          onAnswer={() => {}}
          onNavigate={() => {}}
          onAnswerChange={() => {}}
        />
      )
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Interaction tests
// ---------------------------------------------------------------------------

describe("QuestionPopupView (interactions)", () => {
  test("Escape calls onClose", async () => {
    const { stdin, stdout } = createTestStreams();
    const onClose = mock(() => {});

    const instance = render(
      <QuestionPopupView
        questions={[makeQuestion()]}
        currentIndex={0}
        answerText=""
        onClose={onClose}
        onAnswer={() => {}}
        onNavigate={() => {}}
        onAnswerChange={() => {}}
      />,
      {
        stdout,
        stdin,
        debug: true,
        exitOnCtrlC: false,
        patchConsole: false,
      }
    );

    await new Promise((r) => setTimeout(r, 50));
    (stdin as any as PassThrough).write("\x1b");
    await new Promise((r) => setTimeout(r, 50));

    expect(onClose).toHaveBeenCalled();

    instance.unmount();
    await instance.waitUntilExit();
  });

  test("Ctrl+S with answer text calls onAnswer", async () => {
    const { stdin, stdout } = createTestStreams();
    const onAnswer = mock(() => {});
    const q = makeQuestion();

    const instance = render(
      <QuestionPopupView
        questions={[q]}
        currentIndex={0}
        answerText="Use an empty array default"
        onClose={() => {}}
        onAnswer={onAnswer}
        onNavigate={() => {}}
        onAnswerChange={() => {}}
      />,
      {
        stdout,
        stdin,
        debug: true,
        exitOnCtrlC: false,
        patchConsole: false,
      }
    );

    await new Promise((r) => setTimeout(r, 50));
    // Ctrl+S is \x13
    (stdin as any as PassThrough).write("\x13");
    await new Promise((r) => setTimeout(r, 50));

    expect(onAnswer).toHaveBeenCalledWith(q.agentId, q.id, "Use an empty array default");

    instance.unmount();
    await instance.waitUntilExit();
  });

  test("Ctrl+S with empty answer does NOT call onAnswer", async () => {
    const { stdin, stdout } = createTestStreams();
    const onAnswer = mock(() => {});

    const instance = render(
      <QuestionPopupView
        questions={[makeQuestion()]}
        currentIndex={0}
        answerText=""
        onClose={() => {}}
        onAnswer={onAnswer}
        onNavigate={() => {}}
        onAnswerChange={() => {}}
      />,
      {
        stdout,
        stdin,
        debug: true,
        exitOnCtrlC: false,
        patchConsole: false,
      }
    );

    await new Promise((r) => setTimeout(r, 50));
    (stdin as any as PassThrough).write("\x13");
    await new Promise((r) => setTimeout(r, 50));

    expect(onAnswer).not.toHaveBeenCalled();

    instance.unmount();
    await instance.waitUntilExit();
  });

  test("Tab calls onNavigate with 'next'", async () => {
    const { stdin, stdout } = createTestStreams();
    const onNavigate = mock(() => {});

    const instance = render(
      <QuestionPopupView
        questions={makeQuestions()}
        currentIndex={0}
        answerText=""
        onClose={() => {}}
        onAnswer={() => {}}
        onNavigate={onNavigate}
        onAnswerChange={() => {}}
      />,
      {
        stdout,
        stdin,
        debug: true,
        exitOnCtrlC: false,
        patchConsole: false,
      }
    );

    await new Promise((r) => setTimeout(r, 50));
    (stdin as any as PassThrough).write("\t");
    await new Promise((r) => setTimeout(r, 50));

    expect(onNavigate).toHaveBeenCalledWith("next");

    instance.unmount();
    await instance.waitUntilExit();
  });

  test("Shift+Tab calls onNavigate with 'prev'", async () => {
    const { stdin, stdout } = createTestStreams();
    const onNavigate = mock(() => {});

    const instance = render(
      <QuestionPopupView
        questions={makeQuestions()}
        currentIndex={1}
        answerText=""
        onClose={() => {}}
        onAnswer={() => {}}
        onNavigate={onNavigate}
        onAnswerChange={() => {}}
      />,
      {
        stdout,
        stdin,
        debug: true,
        exitOnCtrlC: false,
        patchConsole: false,
      }
    );

    await new Promise((r) => setTimeout(r, 50));
    // Shift+Tab is ESC [ Z
    (stdin as any as PassThrough).write("\x1b[Z");
    await new Promise((r) => setTimeout(r, 50));

    expect(onNavigate).toHaveBeenCalledWith("prev");

    instance.unmount();
    await instance.waitUntilExit();
  });

  test("character input calls onAnswerChange with appended char", async () => {
    const { stdin, stdout } = createTestStreams();
    const onAnswerChange = mock(() => {});

    const instance = render(
      <QuestionPopupView
        questions={[makeQuestion()]}
        currentIndex={0}
        answerText="hel"
        onClose={() => {}}
        onAnswer={() => {}}
        onNavigate={() => {}}
        onAnswerChange={onAnswerChange}
      />,
      {
        stdout,
        stdin,
        debug: true,
        exitOnCtrlC: false,
        patchConsole: false,
      }
    );

    await new Promise((r) => setTimeout(r, 50));
    (stdin as any as PassThrough).write("l");
    await new Promise((r) => setTimeout(r, 50));

    expect(onAnswerChange).toHaveBeenCalledWith("hell");

    instance.unmount();
    await instance.waitUntilExit();
  });

  test("backspace calls onAnswerChange with last char removed", async () => {
    const { stdin, stdout } = createTestStreams();
    const onAnswerChange = mock(() => {});

    const instance = render(
      <QuestionPopupView
        questions={[makeQuestion()]}
        currentIndex={0}
        answerText="hello"
        onClose={() => {}}
        onAnswer={() => {}}
        onNavigate={() => {}}
        onAnswerChange={onAnswerChange}
      />,
      {
        stdout,
        stdin,
        debug: true,
        exitOnCtrlC: false,
        patchConsole: false,
      }
    );

    await new Promise((r) => setTimeout(r, 50));
    (stdin as any as PassThrough).write("\x7f"); // Backspace
    await new Promise((r) => setTimeout(r, 50));

    expect(onAnswerChange).toHaveBeenCalledWith("hell");

    instance.unmount();
    await instance.waitUntilExit();
  });

  test("return key inserts newline", async () => {
    const { stdin, stdout } = createTestStreams();
    const onAnswerChange = mock(() => {});

    const instance = render(
      <QuestionPopupView
        questions={[makeQuestion()]}
        currentIndex={0}
        answerText="line1"
        onClose={() => {}}
        onAnswer={() => {}}
        onNavigate={() => {}}
        onAnswerChange={onAnswerChange}
      />,
      {
        stdout,
        stdin,
        debug: true,
        exitOnCtrlC: false,
        patchConsole: false,
      }
    );

    await new Promise((r) => setTimeout(r, 50));
    (stdin as any as PassThrough).write("\r"); // Return/Enter
    await new Promise((r) => setTimeout(r, 50));

    expect(onAnswerChange).toHaveBeenCalledWith("line1\n");

    instance.unmount();
    await instance.waitUntilExit();
  });

  test("Tab with single question does not call onNavigate", async () => {
    const { stdin, stdout } = createTestStreams();
    const onNavigate = mock(() => {});

    const instance = render(
      <QuestionPopupView
        questions={[makeQuestion()]}
        currentIndex={0}
        answerText=""
        onClose={() => {}}
        onAnswer={() => {}}
        onNavigate={onNavigate}
        onAnswerChange={() => {}}
      />,
      {
        stdout,
        stdin,
        debug: true,
        exitOnCtrlC: false,
        patchConsole: false,
      }
    );

    await new Promise((r) => setTimeout(r, 50));
    (stdin as any as PassThrough).write("\t");
    await new Promise((r) => setTimeout(r, 50));

    expect(onNavigate).not.toHaveBeenCalled();

    instance.unmount();
    await instance.waitUntilExit();
  });

  test("displays current answer text in the input area", () => {
    const output = renderToString(
      <QuestionPopupView
        questions={[makeQuestion()]}
        currentIndex={0}
        answerText="my current answer"
        onClose={() => {}}
        onAnswer={() => {}}
        onNavigate={() => {}}
        onAnswerChange={() => {}}
      />
    );
    expect(output).toContain("my current answer");
  });

  test("shows error hint when submitting empty answer", async () => {
    const { stdin, stdout } = createTestStreams();
    const chunks: string[] = [];
    stdout.on("data", (chunk: Buffer) => chunks.push(chunk.toString()));
    const onAnswer = mock(() => {});

    const instance = render(
      <QuestionPopupView
        questions={[makeQuestion()]}
        currentIndex={0}
        answerText=""
        onClose={() => {}}
        onAnswer={onAnswer}
        onNavigate={() => {}}
        onAnswerChange={() => {}}
      />,
      {
        stdout,
        stdin,
        debug: true,
        exitOnCtrlC: false,
        patchConsole: false,
      }
    );

    await new Promise((r) => setTimeout(r, 50));
    (stdin as any as PassThrough).write("\x13"); // Ctrl+S
    await new Promise((r) => setTimeout(r, 100));

    // onAnswer should NOT have been called
    expect(onAnswer).not.toHaveBeenCalled();

    // Should show some indication of empty answer rejection
    const output = chunks.join("");
    expect(output).toContain("empty");

    instance.unmount();
    await instance.waitUntilExit();
  });
});
