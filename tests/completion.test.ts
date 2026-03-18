/**
 * completion.test.ts — Tests for shell completion script generation and
 * install/uninstall logic.
 *
 * Regression coverage for the postinstall-checkshellcompletions fix:
 * ensures completion.ts exports the correct public API and that the
 * removed checkShellCompletions function does not reappear.
 */

import { describe, test, expect, spyOn, beforeEach, afterEach } from "bun:test";

// ---------------------------------------------------------------------------
// Regression: verify module exports (the original bug was a missing export)
// ---------------------------------------------------------------------------

describe("completion module exports", () => {
  test("exports cmdCompletion function", async () => {
    const mod = await import("../src/commands/completion");
    expect(typeof mod.cmdCompletion).toBe("function");
  });

  test("exports installCompletions function", async () => {
    const mod = await import("../src/commands/completion");
    expect(typeof mod.installCompletions).toBe("function");
  });

  test("exports uninstallCompletions function", async () => {
    const mod = await import("../src/commands/completion");
    expect(typeof mod.uninstallCompletions).toBe("function");
  });

  test("does NOT export checkShellCompletions (removed function)", async () => {
    const mod = await import("../src/commands/completion");
    expect((mod as any).checkShellCompletions).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Regression: verify index.ts does not import checkShellCompletions
// ---------------------------------------------------------------------------

describe("index.ts regression", () => {
  test("index.ts does not reference checkShellCompletions", async () => {
    const indexSource = await Bun.file("src/index.ts").text();
    expect(indexSource).not.toContain("checkShellCompletions");
  });

  test("index.ts does not reference postinstall", async () => {
    const indexSource = await Bun.file("src/index.ts").text();
    expect(indexSource).not.toContain("postinstall");
  });

  test("no postinstall.ts file exists", async () => {
    const file = Bun.file("src/postinstall.ts");
    expect(await file.exists()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// cmdCompletion: writes completion scripts to stdout
// ---------------------------------------------------------------------------

describe("cmdCompletion", () => {
  let stdoutSpy: ReturnType<typeof spyOn>;
  let stderrSpy: ReturnType<typeof spyOn>;
  let exitSpy: ReturnType<typeof spyOn>;
  let captured: string;

  beforeEach(() => {
    captured = "";
    stdoutSpy = spyOn(process.stdout, "write").mockImplementation((chunk: any) => {
      captured += typeof chunk === "string" ? chunk : chunk.toString();
      return true;
    });
    stderrSpy = spyOn(console, "error").mockImplementation(() => {});
    exitSpy = spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit called");
    });
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
    exitSpy.mockRestore();
  });

  test("generates bash completion script", async () => {
    const { cmdCompletion } = await import("../src/commands/completion");
    cmdCompletion({ shell: "bash" });
    expect(captured).toContain("_woco_completions");
    expect(captured).toContain("complete -o default -F _woco_completions woco");
  });

  test("generates zsh completion script", async () => {
    const { cmdCompletion } = await import("../src/commands/completion");
    cmdCompletion({ shell: "zsh" });
    expect(captured).toContain("#compdef woco");
    expect(captured).toContain("_woco()");
    expect(captured).toContain("compdef _woco woco");
  });

  test("generates fish completion script", async () => {
    const { cmdCompletion } = await import("../src/commands/completion");
    cmdCompletion({ shell: "fish" });
    expect(captured).toContain("complete -c");
    expect(captured).toContain("woco");
  });

  test("exits with error for unsupported shell", async () => {
    const { cmdCompletion } = await import("../src/commands/completion");
    expect(() => cmdCompletion({ shell: "powershell" })).toThrow("process.exit called");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  test("bash script contains command completions from registry", async () => {
    const { cmdCompletion } = await import("../src/commands/completion");
    cmdCompletion({ shell: "bash" });
    // Should include common commands
    expect(captured).toContain("init");
    expect(captured).toContain("launch");
    expect(captured).toContain("status");
    expect(captured).toContain("tasks");
  });

  test("zsh script contains command completions from registry", async () => {
    const { cmdCompletion } = await import("../src/commands/completion");
    cmdCompletion({ shell: "zsh" });
    expect(captured).toContain("init");
    expect(captured).toContain("launch");
    expect(captured).toContain("status");
    expect(captured).toContain("tasks");
  });

  test("fish script contains command completions from registry", async () => {
    const { cmdCompletion } = await import("../src/commands/completion");
    cmdCompletion({ shell: "fish" });
    expect(captured).toContain("init");
    expect(captured).toContain("launch");
    expect(captured).toContain("status");
    expect(captured).toContain("tasks");
  });
});

// ---------------------------------------------------------------------------
// Script content validation
// ---------------------------------------------------------------------------

describe("completion script content", () => {
  let stdoutSpy: ReturnType<typeof spyOn>;
  let captured: string;

  beforeEach(() => {
    captured = "";
    stdoutSpy = spyOn(process.stdout, "write").mockImplementation((chunk: any) => {
      captured += typeof chunk === "string" ? chunk : chunk.toString();
      return true;
    });
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
  });

  test("bash script has proper header comment", async () => {
    const { cmdCompletion } = await import("../src/commands/completion");
    cmdCompletion({ shell: "bash" });
    expect(captured).toMatch(/^# woco.*bash completion/);
  });

  test("zsh script has #compdef directive", async () => {
    const { cmdCompletion } = await import("../src/commands/completion");
    cmdCompletion({ shell: "zsh" });
    expect(captured.startsWith("#compdef woco")).toBe(true);
  });

  test("fish script has proper header comment", async () => {
    const { cmdCompletion } = await import("../src/commands/completion");
    cmdCompletion({ shell: "fish" });
    expect(captured).toMatch(/^# woco.*fish completion/);
  });

  test("bash script includes subcommand completions for tasks", async () => {
    const { cmdCompletion } = await import("../src/commands/completion");
    cmdCompletion({ shell: "bash" });
    // tasks has subcommands (list, add, set-status, etc.)
    expect(captured).toContain("tasks");
    expect(captured).toContain("list");
    expect(captured).toContain("add");
  });

  test("bash script includes completion/install/uninstall subcommands", async () => {
    const { cmdCompletion } = await import("../src/commands/completion");
    cmdCompletion({ shell: "bash" });
    expect(captured).toContain("install");
    expect(captured).toContain("uninstall");
  });

  test("zsh script includes subcommand completions for tasks", async () => {
    const { cmdCompletion } = await import("../src/commands/completion");
    cmdCompletion({ shell: "zsh" });
    expect(captured).toContain("tasks");
    expect(captured).toContain("list");
    expect(captured).toContain("add");
  });

  test("fish script disables file completions by default", async () => {
    const { cmdCompletion } = await import("../src/commands/completion");
    cmdCompletion({ shell: "fish" });
    expect(captured).toContain("complete -c $cmd -f");
  });
});

// ---------------------------------------------------------------------------
// removeMarkerBlock: rc file marker block removal
// ---------------------------------------------------------------------------

describe("removeMarkerBlock", () => {
  test("removes marker block from middle of content", async () => {
    const { removeMarkerBlock, RC_MARKER, RC_MARKER_END } = await import(
      "../src/commands/completion"
    );
    const content = [
      "line1",
      RC_MARKER,
      'eval "$(woco completion bash)"',
      RC_MARKER_END,
      "line2",
    ].join("\n");
    const result = removeMarkerBlock(content);
    expect(result).not.toContain(RC_MARKER);
    expect(result).not.toContain(RC_MARKER_END);
    expect(result).not.toContain("woco completion bash");
    expect(result).toContain("line1");
    expect(result).toContain("line2");
  });

  test("returns content unchanged when no marker present", async () => {
    const { removeMarkerBlock } = await import("../src/commands/completion");
    const content = "line1\nline2\nline3";
    expect(removeMarkerBlock(content)).toBe(content);
  });

  test("removes marker block at the start of content", async () => {
    const { removeMarkerBlock, RC_MARKER, RC_MARKER_END } = await import(
      "../src/commands/completion"
    );
    const content = [RC_MARKER, "some woco stuff", RC_MARKER_END, "rest of rc"].join(
      "\n"
    );
    const result = removeMarkerBlock(content);
    expect(result).not.toContain(RC_MARKER);
    expect(result).toContain("rest of rc");
  });

  test("removes marker block at the end of content", async () => {
    const { removeMarkerBlock, RC_MARKER, RC_MARKER_END } = await import(
      "../src/commands/completion"
    );
    const content = ["my config", RC_MARKER, "woco stuff", RC_MARKER_END].join("\n");
    const result = removeMarkerBlock(content);
    expect(result).not.toContain("woco stuff");
    expect(result).toContain("my config");
  });

  test("collapses triple blank lines left by removal", async () => {
    const { removeMarkerBlock, RC_MARKER, RC_MARKER_END } = await import(
      "../src/commands/completion"
    );
    const content = [
      "before",
      "",
      RC_MARKER,
      "woco block",
      RC_MARKER_END,
      "",
      "after",
    ].join("\n");
    const result = removeMarkerBlock(content);
    // Should not have 3+ consecutive newlines
    expect(result).not.toMatch(/\n{3,}/);
  });

  test("handles empty content", async () => {
    const { removeMarkerBlock } = await import("../src/commands/completion");
    expect(removeMarkerBlock("")).toBe("");
  });
});

// ---------------------------------------------------------------------------
// detectShell: shell detection from SHELL env
// ---------------------------------------------------------------------------

describe("detectShell", () => {
  const originalShell = process.env.SHELL;

  afterEach(() => {
    if (originalShell !== undefined) {
      process.env.SHELL = originalShell;
    } else {
      delete process.env.SHELL;
    }
  });

  test("detects bash from SHELL env", async () => {
    process.env.SHELL = "/bin/bash";
    // Re-import to get fresh module? No, detectShell reads env at call time
    const { detectShell } = await import("../src/commands/completion");
    expect(detectShell()).toBe("bash");
  });

  test("detects zsh from SHELL env", async () => {
    process.env.SHELL = "/bin/zsh";
    const { detectShell } = await import("../src/commands/completion");
    expect(detectShell()).toBe("zsh");
  });

  test("detects fish from SHELL env", async () => {
    process.env.SHELL = "/usr/bin/fish";
    const { detectShell } = await import("../src/commands/completion");
    expect(detectShell()).toBe("fish");
  });

  test("defaults to bash when SHELL is unset", async () => {
    delete process.env.SHELL;
    const { detectShell } = await import("../src/commands/completion");
    expect(detectShell()).toBe("bash");
  });

  test("defaults to bash for unknown shells", async () => {
    process.env.SHELL = "/usr/bin/csh";
    const { detectShell } = await import("../src/commands/completion");
    expect(detectShell()).toBe("bash");
  });
});
