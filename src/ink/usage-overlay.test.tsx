/**
 * usage-overlay.test.tsx — Tests for the UsageOverlay Ink component.
 *
 * Verifies:
 *   - Renders "Token Usage" title
 *   - Displays "No token usage data" when data is empty
 *   - Renders overall usage summary with formatted numbers
 *   - Renders grouped items by task_id (default)
 *   - Tab key cycles grouping field
 *   - Escape key calls onClose
 *   - U key calls onClose
 *   - Up/Down navigation highlights different items
 *   - formatTokenCount helper formats correctly
 *   - formatCost helper formats correctly
 */

import { describe, test, expect, mock } from "bun:test";
import React from "react";
import { render, renderToString, Text } from "ink";
import {
  UsageOverlayView,
  formatTokenCount,
  formatCost,
} from "./usage-overlay";
import type { UsageTotals, GroupableField } from "../lib/token-usage";
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

function makeTotals(overrides: Partial<UsageTotals> = {}): UsageTotals {
  return {
    input_tokens: 1200000,
    output_tokens: 450300,
    cache_read: 800000,
    cache_write: 10000,
    reasoning_tokens: 50200,
    total_tokens: 2500500,
    total_cost: 12.34,
    record_count: 42,
    ...overrides,
  };
}

function makeGroups(): Array<{ key: string; totals: UsageTotals }> {
  return [
    {
      key: "auth-service",
      totals: makeTotals({
        input_tokens: 200000,
        output_tokens: 100000,
        total_tokens: 300000,
        total_cost: 2.5,
        record_count: 10,
      }),
    },
    {
      key: "search-api",
      totals: makeTotals({
        input_tokens: 150000,
        output_tokens: 80000,
        total_tokens: 230000,
        total_cost: 1.8,
        record_count: 8,
      }),
    },
  ];
}

// ---------------------------------------------------------------------------
// Format helper tests
// ---------------------------------------------------------------------------

describe("formatTokenCount", () => {
  test("returns '0' for zero", () => {
    expect(formatTokenCount(0)).toBe("0");
  });

  test("returns raw number for < 1000", () => {
    expect(formatTokenCount(500)).toBe("500");
  });

  test("formats thousands as k", () => {
    expect(formatTokenCount(1500)).toBe("1.5k");
  });

  test("formats millions as M", () => {
    expect(formatTokenCount(1200000)).toBe("1.20M");
  });

  test("formats exact thousands", () => {
    expect(formatTokenCount(1000)).toBe("1.0k");
  });
});

describe("formatCost", () => {
  test("returns '$0.00' for zero", () => {
    expect(formatCost(0)).toBe("$0.00");
  });

  test("formats small costs with 4 decimal places", () => {
    expect(formatCost(0.005)).toBe("$0.0050");
  });

  test("formats normal costs with 2 decimal places", () => {
    expect(formatCost(12.34)).toBe("$12.34");
  });
});

// ---------------------------------------------------------------------------
// Static render tests
// ---------------------------------------------------------------------------

describe("UsageOverlayView (static rendering)", () => {
  test("renders 'Token Usage' title", () => {
    const output = renderToString(
      <UsageOverlayView
        overall={null}
        groups={[]}
        groupField="task_id"
        selectedIndex={0}
        onClose={() => {}}
        onCycleGrouping={() => {}}
        onSelectIndex={() => {}}
      />
    );
    expect(output).toContain("Token Usage");
  });

  test("shows 'No token usage data' when overall is null", () => {
    const output = renderToString(
      <UsageOverlayView
        overall={null}
        groups={[]}
        groupField="task_id"
        selectedIndex={0}
        onClose={() => {}}
        onCycleGrouping={() => {}}
        onSelectIndex={() => {}}
      />
    );
    expect(output).toContain("No token usage data");
  });

  test("renders overall usage summary", () => {
    const output = renderToString(
      <UsageOverlayView
        overall={makeTotals()}
        groups={makeGroups()}
        groupField="task_id"
        selectedIndex={0}
        onClose={() => {}}
        onCycleGrouping={() => {}}
        onSelectIndex={() => {}}
      />
    );
    expect(output).toContain("1.20M"); // input_tokens
    expect(output).toContain("450.3k"); // output_tokens
  });

  test("renders group items", () => {
    const output = renderToString(
      <UsageOverlayView
        overall={makeTotals()}
        groups={makeGroups()}
        groupField="task_id"
        selectedIndex={0}
        onClose={() => {}}
        onCycleGrouping={() => {}}
        onSelectIndex={() => {}}
      />
    );
    expect(output).toContain("auth-service");
    expect(output).toContain("search-api");
  });

  test("renders total cost in header", () => {
    const output = renderToString(
      <UsageOverlayView
        overall={makeTotals()}
        groups={makeGroups()}
        groupField="task_id"
        selectedIndex={0}
        onClose={() => {}}
        onCycleGrouping={() => {}}
        onSelectIndex={() => {}}
      />
    );
    expect(output).toContain("$12.34");
  });

  test("renders footer keybind hints", () => {
    const output = renderToString(
      <UsageOverlayView
        overall={makeTotals()}
        groups={makeGroups()}
        groupField="task_id"
        selectedIndex={0}
        onClose={() => {}}
        onCycleGrouping={() => {}}
        onSelectIndex={() => {}}
      />
    );
    expect(output).toContain("Tab");
    expect(output).toContain("Esc");
  });

  test("renders grouping label", () => {
    const output = renderToString(
      <UsageOverlayView
        overall={makeTotals()}
        groups={makeGroups()}
        groupField="model"
        selectedIndex={0}
        onClose={() => {}}
        onCycleGrouping={() => {}}
        onSelectIndex={() => {}}
      />
    );
    expect(output).toContain("Model");
  });

  test("shows cache count when cache_read > 0", () => {
    const output = renderToString(
      <UsageOverlayView
        overall={makeTotals({ cache_read: 800000 })}
        groups={[]}
        groupField="task_id"
        selectedIndex={0}
        onClose={() => {}}
        onCycleGrouping={() => {}}
        onSelectIndex={() => {}}
      />
    );
    expect(output).toContain("Cache");
    expect(output).toContain("800.0k");
  });

  test("hides cache count when cache_read is 0", () => {
    const output = renderToString(
      <UsageOverlayView
        overall={makeTotals({ cache_read: 0 })}
        groups={[]}
        groupField="task_id"
        selectedIndex={0}
        onClose={() => {}}
        onCycleGrouping={() => {}}
        onSelectIndex={() => {}}
      />
    );
    // "Cache" label should not appear (no cache data)
    expect(output).not.toContain("Cache");
  });

  test("shows reasoning tokens when reasoning_tokens > 0", () => {
    const output = renderToString(
      <UsageOverlayView
        overall={makeTotals({ reasoning_tokens: 50200 })}
        groups={[]}
        groupField="task_id"
        selectedIndex={0}
        onClose={() => {}}
        onCycleGrouping={() => {}}
        onSelectIndex={() => {}}
      />
    );
    expect(output).toContain("Reasoning");
    expect(output).toContain("50.2k");
  });

  test("hides reasoning label when reasoning_tokens is 0", () => {
    const output = renderToString(
      <UsageOverlayView
        overall={makeTotals({ reasoning_tokens: 0 })}
        groups={[]}
        groupField="task_id"
        selectedIndex={0}
        onClose={() => {}}
        onCycleGrouping={() => {}}
        onSelectIndex={() => {}}
      />
    );
    expect(output).not.toContain("Reasoning");
  });

  test("truncates long group keys with ellipsis", () => {
    const longKey = "this-is-a-very-long-task-id-that-exceeds-24-chars";
    const output = renderToString(
      <UsageOverlayView
        overall={makeTotals()}
        groups={[{ key: longKey, totals: makeTotals() }]}
        groupField="task_id"
        selectedIndex={0}
        onClose={() => {}}
        onCycleGrouping={() => {}}
        onSelectIndex={() => {}}
      />
    );
    // Should truncate to 23 chars + ellipsis
    expect(output).toContain("…");
    // Full key should NOT appear
    expect(output).not.toContain(longKey);
  });

  test("shows 'No usage data to group' when groups is empty but overall exists", () => {
    const output = renderToString(
      <UsageOverlayView
        overall={makeTotals()}
        groups={[]}
        groupField="task_id"
        selectedIndex={0}
        onClose={() => {}}
        onCycleGrouping={() => {}}
        onSelectIndex={() => {}}
      />
    );
    expect(output).toContain("No usage data to group");
  });

  test("renders selected item with indicator", () => {
    const output = renderToString(
      <UsageOverlayView
        overall={makeTotals()}
        groups={makeGroups()}
        groupField="task_id"
        selectedIndex={0}
        onClose={() => {}}
        onCycleGrouping={() => {}}
        onSelectIndex={() => {}}
      />
    );
    // Selected item should have the ▸ indicator
    expect(output).toContain("▸");
  });
});

// ---------------------------------------------------------------------------
// Interaction tests
// ---------------------------------------------------------------------------

describe("UsageOverlayView (interactions)", () => {
  test("Escape calls onClose", async () => {
    const { stdin, stdout } = createTestStreams();
    const onClose = mock(() => {});

    const instance = render(
      <UsageOverlayView
        overall={makeTotals()}
        groups={makeGroups()}
        groupField="task_id"
        selectedIndex={0}
        onClose={onClose}
        onCycleGrouping={() => {}}
        onSelectIndex={() => {}}
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

  test("U key calls onClose", async () => {
    const { stdin, stdout } = createTestStreams();
    const onClose = mock(() => {});

    const instance = render(
      <UsageOverlayView
        overall={makeTotals()}
        groups={makeGroups()}
        groupField="task_id"
        selectedIndex={0}
        onClose={onClose}
        onCycleGrouping={() => {}}
        onSelectIndex={() => {}}
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
    (stdin as any as PassThrough).write("u");
    await new Promise((r) => setTimeout(r, 50));

    expect(onClose).toHaveBeenCalled();

    instance.unmount();
    await instance.waitUntilExit();
  });

  test("Tab calls onCycleGrouping", async () => {
    const { stdin, stdout } = createTestStreams();
    const onCycleGrouping = mock(() => {});

    const instance = render(
      <UsageOverlayView
        overall={makeTotals()}
        groups={makeGroups()}
        groupField="task_id"
        selectedIndex={0}
        onClose={() => {}}
        onCycleGrouping={onCycleGrouping}
        onSelectIndex={() => {}}
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

    expect(onCycleGrouping).toHaveBeenCalled();

    instance.unmount();
    await instance.waitUntilExit();
  });

  test("Down arrow calls onSelectIndex with next index", async () => {
    const { stdin, stdout } = createTestStreams();
    const onSelectIndex = mock(() => {});

    const instance = render(
      <UsageOverlayView
        overall={makeTotals()}
        groups={makeGroups()}
        groupField="task_id"
        selectedIndex={0}
        onClose={() => {}}
        onCycleGrouping={() => {}}
        onSelectIndex={onSelectIndex}
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
    (stdin as any as PassThrough).write("\x1b[B"); // Down arrow
    await new Promise((r) => setTimeout(r, 50));

    expect(onSelectIndex).toHaveBeenCalledWith(1);

    instance.unmount();
    await instance.waitUntilExit();
  });

  test("Up arrow calls onSelectIndex with previous index", async () => {
    const { stdin, stdout } = createTestStreams();
    const onSelectIndex = mock(() => {});

    const instance = render(
      <UsageOverlayView
        overall={makeTotals()}
        groups={makeGroups()}
        groupField="task_id"
        selectedIndex={1}
        onClose={() => {}}
        onCycleGrouping={() => {}}
        onSelectIndex={onSelectIndex}
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
    (stdin as any as PassThrough).write("\x1b[A"); // Up arrow
    await new Promise((r) => setTimeout(r, 50));

    expect(onSelectIndex).toHaveBeenCalledWith(0);

    instance.unmount();
    await instance.waitUntilExit();
  });

  test("Up arrow at index 0 clamps to 0", async () => {
    const { stdin, stdout } = createTestStreams();
    const onSelectIndex = mock(() => {});

    const instance = render(
      <UsageOverlayView
        overall={makeTotals()}
        groups={makeGroups()}
        groupField="task_id"
        selectedIndex={0}
        onClose={() => {}}
        onCycleGrouping={() => {}}
        onSelectIndex={onSelectIndex}
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
    (stdin as any as PassThrough).write("\x1b[A"); // Up arrow
    await new Promise((r) => setTimeout(r, 50));

    expect(onSelectIndex).toHaveBeenCalledWith(0);

    instance.unmount();
    await instance.waitUntilExit();
  });

  test("Down arrow at last index clamps to last", async () => {
    const { stdin, stdout } = createTestStreams();
    const onSelectIndex = mock(() => {});
    const groups = makeGroups();

    const instance = render(
      <UsageOverlayView
        overall={makeTotals()}
        groups={groups}
        groupField="task_id"
        selectedIndex={groups.length - 1}
        onClose={() => {}}
        onCycleGrouping={() => {}}
        onSelectIndex={onSelectIndex}
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
    (stdin as any as PassThrough).write("\x1b[B"); // Down arrow
    await new Promise((r) => setTimeout(r, 50));

    expect(onSelectIndex).toHaveBeenCalledWith(groups.length - 1);

    instance.unmount();
    await instance.waitUntilExit();
  });

  test("j key navigates down (vi keys)", async () => {
    const { stdin, stdout } = createTestStreams();
    const onSelectIndex = mock(() => {});

    const instance = render(
      <UsageOverlayView
        overall={makeTotals()}
        groups={makeGroups()}
        groupField="task_id"
        selectedIndex={0}
        onClose={() => {}}
        onCycleGrouping={() => {}}
        onSelectIndex={onSelectIndex}
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
    (stdin as any as PassThrough).write("j");
    await new Promise((r) => setTimeout(r, 50));

    expect(onSelectIndex).toHaveBeenCalledWith(1);

    instance.unmount();
    await instance.waitUntilExit();
  });

  test("k key navigates up (vi keys)", async () => {
    const { stdin, stdout } = createTestStreams();
    const onSelectIndex = mock(() => {});

    const instance = render(
      <UsageOverlayView
        overall={makeTotals()}
        groups={makeGroups()}
        groupField="task_id"
        selectedIndex={1}
        onClose={() => {}}
        onCycleGrouping={() => {}}
        onSelectIndex={onSelectIndex}
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
    (stdin as any as PassThrough).write("k");
    await new Promise((r) => setTimeout(r, 50));

    expect(onSelectIndex).toHaveBeenCalledWith(0);

    instance.unmount();
    await instance.waitUntilExit();
  });
});
