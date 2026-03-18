/**
 * wishlist-picker.test.tsx — Tests for the WishlistPicker Ink component.
 *
 * Verifies:
 *   - Renders header with item count
 *   - Renders item list
 *   - Renders detail pane for selected item
 *   - Shows empty state when no items
 *   - Renders keybind hints in status bar
 *   - E key triggers onPromoteErrand callback
 *   - P key triggers onPromoteQuest callback
 *   - G key triggers onPromoteGenesis callback
 *   - D key deletes the selected item
 *   - Escape triggers onBack callback
 *   - Q triggers onQuit callback
 */

import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test";
import React from "react";
import { render, renderToString } from "ink";
import { PassThrough } from "node:stream";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addItem, loadWishlist } from "../lib/wishlist-store";
import { WishlistPicker } from "./wishlist-picker";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createTestStreams() {
  const stdout = new PassThrough() as unknown as NodeJS.WriteStream;
  (stdout as any).columns = 120;
  (stdout as any).rows = 40;
  const stdin = new PassThrough() as unknown as NodeJS.ReadStream;
  (stdin as any).isTTY = true;
  (stdin as any).setRawMode = () => stdin;
  (stdin as any).ref = () => stdin;
  (stdin as any).unref = () => stdin;
  return { stdin, stdout };
}

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

let tempRoot: string;

beforeEach(() => {
  tempRoot = mkdtempSync(join(tmpdir(), "woco-picker-test-"));
});

afterEach(() => {
  try {
    rmSync(tempRoot, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

// ---------------------------------------------------------------------------
// Static render tests
// ---------------------------------------------------------------------------

describe("WishlistPicker (static rendering)", () => {
  test("renders header with app name", () => {
    const output = renderToString(
      <WishlistPicker
        projectRoot={tempRoot}
        onPromoteErrand={() => {}}
        onPromoteGenesis={() => {}}
        onPromoteQuest={() => {}}
        onBack={() => {}}
        onQuit={() => {}}
      />
    );
    expect(output).toContain("wombo-combo");
    expect(output).toContain("Wishlist");
  });

  test("renders empty state when no items", () => {
    const output = renderToString(
      <WishlistPicker
        projectRoot={tempRoot}
        onPromoteErrand={() => {}}
        onPromoteGenesis={() => {}}
        onPromoteQuest={() => {}}
        onBack={() => {}}
        onQuit={() => {}}
      />
    );
    expect(output).toContain("0 items");
  });

  test("renders item count", () => {
    addItem(tempRoot, "Item A");
    addItem(tempRoot, "Item B");

    const output = renderToString(
      <WishlistPicker
        projectRoot={tempRoot}
        onPromoteErrand={() => {}}
        onPromoteGenesis={() => {}}
        onPromoteQuest={() => {}}
        onBack={() => {}}
        onQuit={() => {}}
      />
    );
    expect(output).toContain("2 items");
  });

  test("renders item text in the list", () => {
    addItem(tempRoot, "Fix login timeout");

    const output = renderToString(
      <WishlistPicker
        projectRoot={tempRoot}
        onPromoteErrand={() => {}}
        onPromoteGenesis={() => {}}
        onPromoteQuest={() => {}}
        onBack={() => {}}
        onQuit={() => {}}
      />
    );
    expect(output).toContain("Fix login timeout");
  });

  test("renders keybind hints", () => {
    const output = renderToString(
      <WishlistPicker
        projectRoot={tempRoot}
        onPromoteErrand={() => {}}
        onPromoteGenesis={() => {}}
        onPromoteQuest={() => {}}
        onBack={() => {}}
        onQuit={() => {}}
      />
    );
    // Should show key hints
    expect(output).toContain("errand");
    expect(output).toContain("quest");
    expect(output).toContain("genesis");
    expect(output).toContain("delete");
  });

  test("renders detail pane for selected item", () => {
    addItem(tempRoot, "Detailed item description here");

    const output = renderToString(
      <WishlistPicker
        projectRoot={tempRoot}
        onPromoteErrand={() => {}}
        onPromoteGenesis={() => {}}
        onPromoteQuest={() => {}}
        onBack={() => {}}
        onQuit={() => {}}
      />
    );
    expect(output).toContain("Description");
    expect(output).toContain("Detailed item description here");
  });

  test("renders tags for items that have them", () => {
    addItem(tempRoot, "Tagged item", ["auth", "ux"]);

    const output = renderToString(
      <WishlistPicker
        projectRoot={tempRoot}
        onPromoteErrand={() => {}}
        onPromoteGenesis={() => {}}
        onPromoteQuest={() => {}}
        onBack={() => {}}
        onQuit={() => {}}
      />
    );
    expect(output).toContain("auth");
    expect(output).toContain("ux");
  });
});

// ---------------------------------------------------------------------------
// Keybind tests (live render)
// ---------------------------------------------------------------------------

describe("WishlistPicker keybinds", () => {
  test("E key triggers onPromoteErrand", async () => {
    addItem(tempRoot, "Promote me");
    const onPromoteErrand = mock(() => {});

    const { stdin, cleanup } = renderLive(
      <WishlistPicker
        projectRoot={tempRoot}
        onPromoteErrand={onPromoteErrand}
        onPromoteGenesis={() => {}}
        onPromoteQuest={() => {}}
        onBack={() => {}}
        onQuit={() => {}}
      />
    );

    await new Promise((r) => setTimeout(r, 50));
    stdin.write("e");
    await new Promise((r) => setTimeout(r, 50));

    expect(onPromoteErrand).toHaveBeenCalled();
    const call = onPromoteErrand.mock.calls[0] as any;
    expect(call[0].text).toBe("Promote me");

    await cleanup();
  });

  test("G key triggers onPromoteGenesis", async () => {
    addItem(tempRoot, "Genesis item");
    const onPromoteGenesis = mock(() => {});

    const { stdin, cleanup } = renderLive(
      <WishlistPicker
        projectRoot={tempRoot}
        onPromoteErrand={() => {}}
        onPromoteGenesis={onPromoteGenesis}
        onPromoteQuest={() => {}}
        onBack={() => {}}
        onQuit={() => {}}
      />
    );

    await new Promise((r) => setTimeout(r, 50));
    stdin.write("g");
    await new Promise((r) => setTimeout(r, 50));

    expect(onPromoteGenesis).toHaveBeenCalled();
    const call = onPromoteGenesis.mock.calls[0] as any;
    expect(call[0].text).toBe("Genesis item");

    await cleanup();
  });

  test("P key triggers onPromoteQuest", async () => {
    addItem(tempRoot, "Quest item");
    const onPromoteQuest = mock(() => {});

    const { stdin, cleanup } = renderLive(
      <WishlistPicker
        projectRoot={tempRoot}
        onPromoteErrand={() => {}}
        onPromoteGenesis={() => {}}
        onPromoteQuest={onPromoteQuest}
        onBack={() => {}}
        onQuit={() => {}}
      />
    );

    await new Promise((r) => setTimeout(r, 50));
    stdin.write("p");
    await new Promise((r) => setTimeout(r, 50));

    expect(onPromoteQuest).toHaveBeenCalled();
    const call = onPromoteQuest.mock.calls[0] as any;
    expect(call[0].text).toBe("Quest item");

    await cleanup();
  });

  test("Q key triggers onQuit", async () => {
    const onQuit = mock(() => {});

    const { stdin, cleanup } = renderLive(
      <WishlistPicker
        projectRoot={tempRoot}
        onPromoteErrand={() => {}}
        onPromoteGenesis={() => {}}
        onPromoteQuest={() => {}}
        onBack={() => {}}
        onQuit={onQuit}
      />
    );

    await new Promise((r) => setTimeout(r, 50));
    stdin.write("q");
    await new Promise((r) => setTimeout(r, 50));

    expect(onQuit).toHaveBeenCalled();

    await cleanup();
  });

  test("Escape triggers onBack", async () => {
    const onBack = mock(() => {});

    const { stdin, cleanup } = renderLive(
      <WishlistPicker
        projectRoot={tempRoot}
        onPromoteErrand={() => {}}
        onPromoteGenesis={() => {}}
        onPromoteQuest={() => {}}
        onBack={onBack}
        onQuit={() => {}}
      />
    );

    await new Promise((r) => setTimeout(r, 50));
    stdin.write("\x1b");
    await new Promise((r) => setTimeout(r, 50));

    expect(onBack).toHaveBeenCalled();

    await cleanup();
  });

  test("+ key moves the selected item down", async () => {
    addItem(tempRoot, "First item");
    addItem(tempRoot, "Second item");

    const { stdin, cleanup } = renderLive(
      <WishlistPicker
        projectRoot={tempRoot}
        onPromoteErrand={() => {}}
        onPromoteGenesis={() => {}}
        onPromoteQuest={() => {}}
        onBack={() => {}}
        onQuit={() => {}}
      />
    );

    await new Promise((r) => setTimeout(r, 50));

    // Press + to move first item down
    stdin.write("+");
    await new Promise((r) => setTimeout(r, 100));

    // Verify reorder happened on disk
    const items = loadWishlist(tempRoot);
    expect(items[0].text).toBe("Second item");
    expect(items[1].text).toBe("First item");

    await cleanup();
  });

  test("- key moves the selected item up", async () => {
    addItem(tempRoot, "First item");
    addItem(tempRoot, "Second item");

    const { stdin, cleanup } = renderLive(
      <WishlistPicker
        projectRoot={tempRoot}
        onPromoteErrand={() => {}}
        onPromoteGenesis={() => {}}
        onPromoteQuest={() => {}}
        onBack={() => {}}
        onQuit={() => {}}
      />
    );

    await new Promise((r) => setTimeout(r, 50));

    // Move to second item
    stdin.write("\x1b[B"); // down arrow
    await new Promise((r) => setTimeout(r, 50));

    // Press - to move second item up
    stdin.write("-");
    await new Promise((r) => setTimeout(r, 100));

    // Verify reorder happened on disk
    const items = loadWishlist(tempRoot);
    expect(items[0].text).toBe("Second item");
    expect(items[1].text).toBe("First item");

    await cleanup();
  });

  test("footer shows +/- for reorder hint", () => {
    const output = renderToString(
      <WishlistPicker
        projectRoot={tempRoot}
        onPromoteErrand={() => {}}
        onPromoteGenesis={() => {}}
        onPromoteQuest={() => {}}
        onBack={() => {}}
        onQuit={() => {}}
      />
    );
    // Should show +/- hint, NOT S-↑/↓
    expect(output).toContain("+");
    expect(output).toContain("-");
    expect(output).toContain("reorder");
    expect(output).not.toContain("S-");
  });

  test("D key deletes the selected item", async () => {
    addItem(tempRoot, "Keep");
    addItem(tempRoot, "Delete me");

    const { stdin, getOutput, cleanup } = renderLive(
      <WishlistPicker
        projectRoot={tempRoot}
        onPromoteErrand={() => {}}
        onPromoteGenesis={() => {}}
        onPromoteQuest={() => {}}
        onBack={() => {}}
        onQuit={() => {}}
      />
    );

    await new Promise((r) => setTimeout(r, 50));

    // Move to second item
    stdin.write("\x1b[B"); // down arrow
    await new Promise((r) => setTimeout(r, 50));

    // Delete it
    stdin.write("d");
    await new Promise((r) => setTimeout(r, 100));

    const output = getOutput();
    expect(output).toContain("1 item");

    await cleanup();
  });

  test("promote does nothing on empty list", async () => {
    const onPromoteErrand = mock(() => {});

    const { stdin, cleanup } = renderLive(
      <WishlistPicker
        projectRoot={tempRoot}
        onPromoteErrand={onPromoteErrand}
        onPromoteGenesis={() => {}}
        onPromoteQuest={() => {}}
        onBack={() => {}}
        onQuit={() => {}}
      />
    );

    await new Promise((r) => setTimeout(r, 50));
    stdin.write("e");
    await new Promise((r) => setTimeout(r, 50));

    expect(onPromoteErrand).not.toHaveBeenCalled();

    await cleanup();
  });
});
