/**
 * tui-plan-review.ts — Plan review view for the wombo-combo TUI.
 *
 * Shows proposed tasks from the quest planner agent, allowing the user
 * to accept, reject, edit, reorder, and approve the plan.
 *
 * Layout:
 *   +-----------------------------------------------------------+
 *   | WOMBO-COMBO Plan Review  | quest: auth-overhaul | 8 tasks  |
 *   +---------------------------+-------------------------------+
 *   |   1. setup-auth-db  HIGH  | Title: Setup auth database    |
 *   | > 2. user-model     MED   | Priority: medium              |
 *   |   3. login-api      MED   | Difficulty: easy              |
 *   |   4. session-mgmt   MED   | Depends: setup-auth-db        |
 *   |   5. [REJECTED]          | Description:                   |
 *   |                           |   Create the user model...     |
 *   +---------------------------+-------------------------------+
 *   | Space:toggle  E:edit  U/D:move  A:approve  Q:cancel       |
 *   +-----------------------------------------------------------+
 *
 * Keybinds:
 *   Space      — toggle accept/reject for the selected task
 *   E          — edit selected task fields (inline modal)
 *   K / Up     — move selected task up in order
 *   J / Down   — move selected task down in order
 *   A          — approve plan (apply accepted tasks to quest)
 *   V          — view validation issues
 *   Q / Esc    — cancel and discard plan (back to quest picker)
 */

import blessed from "neo-blessed";
import type { Widgets } from "neo-blessed";
import type { ProposedTask, PlanResult, PlanValidationIssue } from "./quest-planner.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PlanReviewAction =
  | { type: "approve"; tasks: ProposedTask[]; knowledge: string | null }
  | { type: "cancel" };

export interface PlanReviewOptions {
  /** The quest ID being planned */
  questId: string;
  /** The quest title */
  questTitle: string;
  /** The planner result to review */
  planResult: PlanResult;
  /** Called when user approves the plan */
  onApprove: (tasks: ProposedTask[], knowledge: string | null) => void;
  /** Called when user cancels/discards the plan */
  onCancel: () => void;
}

// ---------------------------------------------------------------------------
// Display helpers
// ---------------------------------------------------------------------------

const PRIORITY_ABBREV: Record<string, string> = {
  critical: "CRIT",
  high: "HIGH",
  medium: "MED ",
  low: "LOW ",
  wishlist: "WISH",
};

const PRIORITY_COLORS: Record<string, string> = {
  critical: "red",
  high: "yellow",
  medium: "white",
  low: "gray",
  wishlist: "gray",
};

const DIFFICULTY_COLORS: Record<string, string> = {
  trivial: "gray",
  easy: "green",
  medium: "white",
  hard: "yellow",
  very_hard: "red",
};

function escapeBlessedTags(text: string): string {
  return text.replace(/\{/g, "\uFF5B").replace(/\}/g, "\uFF5D");
}

// ---------------------------------------------------------------------------
// Internal task wrapper with accept/reject state
// ---------------------------------------------------------------------------

interface ReviewTask {
  task: ProposedTask;
  accepted: boolean;
}

// ---------------------------------------------------------------------------
// PlanReview Class
// ---------------------------------------------------------------------------

export class PlanReview {
  private screen: Widgets.Screen;
  private headerBox: Widgets.BoxElement;
  private taskList: Widgets.ListElement;
  private detailBox: Widgets.BoxElement;
  private statusBar: Widgets.BoxElement;

  private questId: string;
  private questTitle: string;
  private planResult: PlanResult;
  private onApprove: (tasks: ProposedTask[], knowledge: string | null) => void;
  private onCancel: () => void;

  private items: ReviewTask[] = [];
  private selectedIndex: number = 0;

  /** Whether a modal is currently showing (blocks other key handlers) */
  private modalOpen = false;

  constructor(opts: PlanReviewOptions) {
    this.questId = opts.questId;
    this.questTitle = opts.questTitle;
    this.planResult = opts.planResult;
    this.onApprove = opts.onApprove;
    this.onCancel = opts.onCancel;

    // Initialize review items — all accepted by default
    this.items = opts.planResult.tasks.map((task) => ({
      task: { ...task },
      accepted: true,
    }));

    // Create screen
    this.screen = blessed.screen({
      smartCSR: true,
      title: "wombo-combo -- Plan Review",
      fullUnicode: true,
    });

    // Header
    this.headerBox = blessed.box({
      top: 0,
      left: 0,
      width: "100%",
      height: 3,
      tags: true,
      style: { fg: "white", bg: "black" },
    });

    // Task list (left pane)
    this.taskList = blessed.list({
      top: 3,
      left: 0,
      width: "50%",
      height: "100%-6",
      tags: true,
      scrollable: true,
      mouse: true,
      keys: true,
      vi: true,
      border: { type: "line" },
      style: {
        border: { fg: "gray" },
        selected: { bg: "blue", fg: "white", bold: true },
        item: { fg: "white" },
      },
      label: " Proposed Tasks ",
    });

    // Detail pane (right pane)
    this.detailBox = blessed.box({
      top: 3,
      left: "50%",
      width: "50%",
      height: "100%-6",
      tags: true,
      scrollable: true,
      mouse: true,
      border: { type: "line" },
      style: {
        border: { fg: "gray" },
        fg: "white",
      },
      label: " Details ",
    });

    // Status bar
    this.statusBar = blessed.box({
      bottom: 0,
      left: 0,
      width: "100%",
      height: 3,
      tags: true,
      style: { fg: "white", bg: "black" },
    });

    // Assemble
    this.screen.append(this.headerBox);
    this.screen.append(this.taskList);
    this.screen.append(this.detailBox);
    this.screen.append(this.statusBar);
    this.taskList.focus();

    this.bindKeys();
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  start(): void {
    this.refreshAll();
    this.screen.render();
  }

  stop(): void {
    this.screen.destroy();
  }

  destroy(): void {
    this.screen.destroy();
    process.stdout.write("\x1B[2J\x1B[H");
  }

  // -----------------------------------------------------------------------
  // Key Bindings
  // -----------------------------------------------------------------------

  private bindKeys(): void {
    // Navigate
    this.taskList.on("select item", (_item: any, index: number) => {
      this.selectedIndex = index;
      this.refreshDetail();
      this.screen.render();
    });

    // Cancel / Back
    this.screen.key(["q", "escape", "C-c"], () => {
      if (this.modalOpen) return;
      this.destroy();
      this.onCancel();
    });

    // Space — toggle accept/reject
    this.screen.key(["space"], () => {
      if (this.modalOpen) return;
      this.toggleAccept();
    });

    // E — edit selected task
    this.screen.key(["e"], () => {
      if (this.modalOpen) return;
      this.showEditModal();
    });

    // K / Up — move task up in order
    this.screen.key(["S-k"], () => {
      if (this.modalOpen) return;
      this.moveTask(-1);
    });

    // J / Down — move task down in order
    this.screen.key(["S-j"], () => {
      if (this.modalOpen) return;
      this.moveTask(1);
    });

    // A — approve plan
    this.screen.key(["a"], () => {
      if (this.modalOpen) return;
      this.approvePlan();
    });

    // V — view validation issues
    this.screen.key(["v"], () => {
      if (this.modalOpen) return;
      this.showValidationIssues();
    });

    // R — reject all / accept all toggle
    this.screen.key(["r"], () => {
      if (this.modalOpen) return;
      this.toggleAll();
    });
  }

  // -----------------------------------------------------------------------
  // Actions
  // -----------------------------------------------------------------------

  private toggleAccept(): void {
    const item = this.items[this.selectedIndex];
    if (!item) return;
    item.accepted = !item.accepted;
    this.refreshList();
    this.refreshDetail();
    this.refreshHeader();
    this.screen.render();
  }

  private toggleAll(): void {
    const allAccepted = this.items.every((i) => i.accepted);
    for (const item of this.items) {
      item.accepted = !allAccepted;
    }
    this.refreshAll();
    this.screen.render();
  }

  private moveTask(direction: -1 | 1): void {
    const idx = this.selectedIndex;
    const newIdx = idx + direction;
    if (newIdx < 0 || newIdx >= this.items.length) return;

    // Swap
    const temp = this.items[idx];
    this.items[idx] = this.items[newIdx];
    this.items[newIdx] = temp;

    this.selectedIndex = newIdx;
    this.refreshList();
    this.refreshDetail();
    this.taskList.select(newIdx);
    this.screen.render();
  }

  private approvePlan(): void {
    const accepted = this.items.filter((i) => i.accepted).map((i) => i.task);

    if (accepted.length === 0) {
      // Show a brief message
      this.showMessagePopup(
        "No Tasks Accepted",
        "You must accept at least one task before approving the plan.\n\n" +
        "Use {bold}Space{/bold} to toggle tasks, or {bold}R{/bold} to accept all.",
        "yellow"
      );
      return;
    }

    // Re-validate: check if accepted tasks have valid dependencies
    // (deps must be in the accepted set)
    const acceptedIds = new Set(accepted.map((t) => t.id));
    const brokenDeps: string[] = [];
    for (const task of accepted) {
      for (const dep of task.depends_on) {
        if (!acceptedIds.has(dep)) {
          brokenDeps.push(`"${task.id}" depends on rejected task "${dep}"`);
        }
      }
    }

    if (brokenDeps.length > 0) {
      this.showMessagePopup(
        "Broken Dependencies",
        "The following accepted tasks depend on rejected tasks:\n\n" +
        brokenDeps.map((b) => `  - ${b}`).join("\n") +
        "\n\nEither accept the dependencies or remove the depends_on references " +
        "by editing the tasks (E key).",
        "red"
      );
      return;
    }

    // Confirm
    this.showConfirmPopup(
      "Approve Plan",
      `Apply ${accepted.length} task${accepted.length !== 1 ? "s" : ""} to quest "${this.questId}"?\n\n` +
      "This will:\n" +
      "  - Create task files in the task store\n" +
      "  - Update the quest with task IDs\n" +
      "  - Set the quest status to 'active'\n" +
      "  - Save any planner knowledge",
      () => {
        this.destroy();
        this.onApprove(accepted, this.planResult.knowledge);
      }
    );
  }

  // -----------------------------------------------------------------------
  // Edit Modal
  // -----------------------------------------------------------------------

  private showEditModal(): void {
    const item = this.items[this.selectedIndex];
    if (!item) return;
    this.modalOpen = true;

    const task = item.task;

    // Editable fields
    type EditField = "title" | "priority" | "difficulty" | "depends_on" | "description";
    const fields: EditField[] = ["title", "priority", "difficulty", "depends_on", "description"];
    let fieldIdx = 0;

    const modal = blessed.box({
      parent: this.screen,
      top: "center",
      left: "center",
      width: "70%",
      height: "80%",
      tags: true,
      border: { type: "line" },
      style: {
        border: { fg: "magenta" },
        fg: "white",
        bg: "black",
      },
      label: ` {magenta-fg}Edit: ${escapeBlessedTags(task.id)}{/magenta-fg} `,
      shadow: true,
    });

    const content = blessed.box({
      parent: modal,
      top: 0,
      left: 1,
      right: 1,
      height: 3,
      tags: true,
      style: { fg: "white", bg: "black" },
    });

    const textbox = blessed.textbox({
      parent: modal,
      top: 3,
      left: 1,
      right: 1,
      height: 3,
      border: { type: "line" },
      style: {
        border: { fg: "cyan" },
        fg: "white",
        bg: "black",
        focus: { border: { fg: "magenta" } },
      },
      inputOnFocus: true,
    });

    const textarea = blessed.textarea({
      parent: modal,
      top: 3,
      left: 1,
      right: 1,
      height: 10,
      border: { type: "line" },
      style: {
        border: { fg: "cyan" },
        fg: "white",
        bg: "black",
        focus: { border: { fg: "magenta" } },
      },
      inputOnFocus: true,
      hidden: true,
    });

    const selectList = blessed.list({
      parent: modal,
      top: 3,
      left: 1,
      right: 1,
      height: "100%-8",
      tags: true,
      keys: true,
      vi: true,
      border: { type: "line" },
      style: {
        border: { fg: "cyan" },
        selected: { bg: "blue", fg: "white", bold: true },
        item: { fg: "white" },
        bg: "black",
      },
      hidden: true,
    });

    const statusLine = blessed.box({
      parent: modal,
      bottom: 0,
      left: 1,
      right: 1,
      height: 1,
      tags: true,
      style: { fg: "gray", bg: "black" },
    });

    const cleanup = () => {
      modal.destroy();
      this.modalOpen = false;
      this.refreshAll();
      this.taskList.focus();
      this.screen.render();
    };

    const VALID_PRIORITIES = ["critical", "high", "medium", "low", "wishlist"];
    const VALID_DIFFICULTIES = ["trivial", "easy", "medium", "hard", "very_hard"];

    const showField = (field: EditField) => {
      textbox.hide();
      textarea.hide();
      selectList.hide();

      const stepLabel = `Field ${fieldIdx + 1}/${fields.length}`;

      switch (field) {
        case "title":
          content.setContent(
            `{bold}${stepLabel} — Title{/bold}\n` +
            `{gray-fg}Current: ${escapeBlessedTags(task.title)}{/gray-fg}\n` +
            `{gray-fg}Enter to save, Esc to skip{/gray-fg}`
          );
          statusLine.setContent(`{gray-fg}Edit task title{/gray-fg}`);
          textbox.setValue(task.title);
          textbox.show();
          textbox.focus();
          break;

        case "priority":
          content.setContent(
            `{bold}${stepLabel} — Priority{/bold}\n` +
            `{gray-fg}Current: ${task.priority}{/gray-fg}\n` +
            `{gray-fg}Enter to select, Esc to skip{/gray-fg}`
          );
          statusLine.setContent(`{gray-fg}Select priority level{/gray-fg}`);
          selectList.setItems(
            VALID_PRIORITIES.map((p) => {
              const dot = PRIORITY_COLORS[p] ?? "white";
              const marker = p === task.priority ? " {cyan-fg}(current){/cyan-fg}" : "";
              return `  {${dot}-fg}\u25CF{/${dot}-fg}  ${p}${marker}`;
            }) as any
          );
          selectList.select(VALID_PRIORITIES.indexOf(task.priority));
          selectList.show();
          selectList.focus();
          break;

        case "difficulty":
          content.setContent(
            `{bold}${stepLabel} — Difficulty{/bold}\n` +
            `{gray-fg}Current: ${task.difficulty}{/gray-fg}\n` +
            `{gray-fg}Enter to select, Esc to skip{/gray-fg}`
          );
          statusLine.setContent(`{gray-fg}Select difficulty level{/gray-fg}`);
          selectList.setItems(
            VALID_DIFFICULTIES.map((d) => {
              const marker = d === task.difficulty ? " {cyan-fg}(current){/cyan-fg}" : "";
              return `  ${d}${marker}`;
            }) as any
          );
          selectList.select(VALID_DIFFICULTIES.indexOf(task.difficulty));
          selectList.show();
          selectList.focus();
          break;

        case "depends_on":
          content.setContent(
            `{bold}${stepLabel} — Dependencies{/bold}\n` +
            `{gray-fg}Current: ${task.depends_on.length > 0 ? task.depends_on.join(", ") : "(none)"}{/gray-fg}\n` +
            `{gray-fg}Comma-separated task IDs, Enter to save, Esc to skip{/gray-fg}`
          );
          statusLine.setContent(`{gray-fg}Edit dependency list{/gray-fg}`);
          textbox.setValue(task.depends_on.join(", "));
          textbox.show();
          textbox.focus();
          break;

        case "description":
          content.setContent(
            `{bold}${stepLabel} — Description{/bold}\n` +
            `{gray-fg}Enter to save, Esc to skip{/gray-fg}`
          );
          statusLine.setContent(`{gray-fg}Edit task description (Ctrl+S to submit in textarea){/gray-fg}`);
          textarea.setValue(task.description);
          textarea.show();
          textarea.focus();
          break;
      }

      this.screen.render();
    };

    const nextField = () => {
      fieldIdx++;
      if (fieldIdx >= fields.length) {
        cleanup();
        return;
      }
      showField(fields[fieldIdx]);
    };

    // --- Textbox handlers (title, depends_on) ---
    textbox.on("submit", (value: string) => {
      const trimmed = (value ?? "").trim();
      const field = fields[fieldIdx];

      if (field === "title" && trimmed) {
        task.title = trimmed;
      } else if (field === "depends_on") {
        if (trimmed) {
          task.depends_on = trimmed.split(",").map((s) => s.trim()).filter(Boolean);
        } else {
          task.depends_on = [];
        }
      }
      nextField();
    });

    textbox.on("cancel", () => {
      nextField(); // Skip this field
    });

    // --- Textarea handlers (description) ---
    textarea.key(["enter"], () => {
      const val = (textarea.getValue() ?? "").trim();
      if (val) {
        task.description = val;
      }
      nextField();
    });

    textarea.key(["escape"], () => {
      nextField(); // Skip
    });

    // --- Select list handlers (priority, difficulty) ---
    selectList.key(["enter", "space"], () => {
      const field = fields[fieldIdx];
      const idx = (selectList as any).selected ?? 0;

      if (field === "priority") {
        task.priority = VALID_PRIORITIES[idx] as any;
      } else if (field === "difficulty") {
        task.difficulty = VALID_DIFFICULTIES[idx] as any;
      }
      nextField();
    });

    selectList.key(["escape"], () => {
      nextField(); // Skip
    });

    // Global escape for the modal itself
    modal.key(["escape"], () => {
      cleanup();
    });

    // Start editing
    showField(fields[0]);
  }

  // -----------------------------------------------------------------------
  // Validation Issues Popup
  // -----------------------------------------------------------------------

  private showValidationIssues(): void {
    const issues = this.planResult.issues;
    if (issues.length === 0) {
      this.showMessagePopup(
        "Validation",
        "No validation issues found. The plan looks good!",
        "green"
      );
      return;
    }

    const lines: string[] = [];
    const errors = issues.filter((i) => i.level === "error");
    const warnings = issues.filter((i) => i.level === "warning");

    if (errors.length > 0) {
      lines.push(`{red-fg}{bold}Errors (${errors.length}):{/bold}{/red-fg}`);
      for (const e of errors) {
        const prefix = e.taskId ? `[${e.taskId}] ` : "";
        lines.push(`  {red-fg}\u2718{/red-fg} ${prefix}${escapeBlessedTags(e.message)}`);
      }
      lines.push("");
    }

    if (warnings.length > 0) {
      lines.push(`{yellow-fg}{bold}Warnings (${warnings.length}):{/bold}{/yellow-fg}`);
      for (const w of warnings) {
        const prefix = w.taskId ? `[${w.taskId}] ` : "";
        lines.push(`  {yellow-fg}\u26A0{/yellow-fg} ${prefix}${escapeBlessedTags(w.message)}`);
      }
    }

    this.showMessagePopup(
      "Validation Issues",
      lines.join("\n"),
      errors.length > 0 ? "red" : "yellow"
    );
  }

  // -----------------------------------------------------------------------
  // Generic Popups
  // -----------------------------------------------------------------------

  private showMessagePopup(title: string, body: string, borderColor: string): void {
    this.modalOpen = true;

    const popup = blessed.box({
      parent: this.screen,
      top: "center",
      left: "center",
      width: "60%",
      height: "60%",
      tags: true,
      scrollable: true,
      mouse: true,
      border: { type: "line" },
      style: {
        border: { fg: borderColor },
        fg: "white",
        bg: "black",
      },
      label: ` {${borderColor}-fg}${title}{/${borderColor}-fg} `,
      shadow: true,
      content: `\n${body}\n\n{gray-fg}Press Esc or Enter to close{/gray-fg}`,
    });

    popup.focus();

    popup.key(["escape", "enter", "q"], () => {
      popup.destroy();
      this.modalOpen = false;
      this.taskList.focus();
      this.screen.render();
    });

    this.screen.render();
  }

  private showConfirmPopup(
    title: string,
    body: string,
    onConfirm: () => void
  ): void {
    this.modalOpen = true;

    const popup = blessed.box({
      parent: this.screen,
      top: "center",
      left: "center",
      width: "60%",
      height: "50%",
      tags: true,
      border: { type: "line" },
      style: {
        border: { fg: "green" },
        fg: "white",
        bg: "black",
      },
      label: ` {green-fg}${title}{/green-fg} `,
      shadow: true,
      content:
        `\n${body}\n\n` +
        `{bold}{green-fg}Y{/green-fg}{/bold} — Confirm  |  ` +
        `{bold}{red-fg}N{/red-fg}{/bold} / Esc — Cancel`,
    });

    popup.focus();

    popup.key(["y"], () => {
      popup.destroy();
      this.modalOpen = false;
      onConfirm();
    });

    popup.key(["n", "escape", "q"], () => {
      popup.destroy();
      this.modalOpen = false;
      this.taskList.focus();
      this.screen.render();
    });

    this.screen.render();
  }

  // -----------------------------------------------------------------------
  // Refresh Logic
  // -----------------------------------------------------------------------

  private refreshAll(): void {
    this.refreshHeader();
    this.refreshList();
    this.refreshDetail();
    this.refreshStatusBar();
  }

  private refreshHeader(): void {
    const total = this.items.length;
    const accepted = this.items.filter((i) => i.accepted).length;
    const rejected = total - accepted;

    let line1 = ` {bold}wombo-combo{/bold} {magenta-fg}Plan Review{/magenta-fg}`;
    line1 += `  {gray-fg}|{/gray-fg}  quest: {white-fg}${escapeBlessedTags(this.questId)}{/white-fg}`;
    line1 += `  {gray-fg}|{/gray-fg}  {green-fg}${accepted}{/green-fg} accepted`;
    if (rejected > 0) {
      line1 += `  {red-fg}${rejected}{/red-fg} rejected`;
    }

    const hasErrors = this.planResult.issues.some((i) => i.level === "error");
    const warnCount = this.planResult.issues.filter((i) => i.level === "warning").length;
    const errCount = this.planResult.issues.filter((i) => i.level === "error").length;

    let line2 = ` {gray-fg}${escapeBlessedTags(this.questTitle)}{/gray-fg}`;
    if (errCount > 0) {
      line2 += `  {red-fg}${errCount} error${errCount !== 1 ? "s" : ""}{/red-fg}`;
    }
    if (warnCount > 0) {
      line2 += `  {yellow-fg}${warnCount} warning${warnCount !== 1 ? "s" : ""}{/yellow-fg}`;
    }

    this.headerBox.setContent(`${line1}\n${line2}`);
  }

  private refreshList(): void {
    const listItems: string[] = [];

    for (let i = 0; i < this.items.length; i++) {
      const { task, accepted } = this.items[i];

      // Order number
      const num = `${i + 1}.`.padEnd(4);

      // Accept/reject indicator
      const indicator = accepted
        ? `{green-fg}\u2714{/green-fg}`
        : `{red-fg}\u2718{/red-fg}`;

      // Priority badge
      const pColor = PRIORITY_COLORS[task.priority] ?? "white";
      const pAbbr = PRIORITY_ABBREV[task.priority] ?? task.priority.slice(0, 4).toUpperCase();
      const prioBadge = `{${pColor}-fg}${pAbbr}{/${pColor}-fg}`;

      // Task ID (truncated)
      const maxIdLen = 24;
      const id = task.id.length > maxIdLen
        ? task.id.slice(0, maxIdLen - 1) + "\u2026"
        : task.id.padEnd(maxIdLen);

      // Deps indicator
      const depIcon = task.depends_on.length > 0
        ? ` {gray-fg}\u2192${task.depends_on.length}{/gray-fg}`
        : "";

      if (accepted) {
        listItems.push(` ${indicator} ${num} ${id} ${prioBadge}${depIcon}`);
      } else {
        listItems.push(` ${indicator} ${num} {gray-fg}${escapeBlessedTags(task.id)}{/gray-fg} {red-fg}REJECTED{/red-fg}`);
      }
    }

    if (listItems.length === 0) {
      listItems.push(" {gray-fg}No tasks in plan{/gray-fg}");
    }

    const prevSelected = this.selectedIndex;
    this.taskList.setItems(listItems as any);
    if (prevSelected < listItems.length) {
      this.taskList.select(prevSelected);
    }
  }

  private refreshDetail(): void {
    const item = this.items[this.selectedIndex];
    if (!item) {
      this.detailBox.setContent("{gray-fg}No task selected{/gray-fg}");
      this.detailBox.setLabel(" Details ");
      return;
    }

    const { task, accepted } = item;
    const lines: string[] = [];

    // Title
    lines.push(`{bold}{white-fg}${escapeBlessedTags(task.title)}{/white-fg}{/bold}`);
    lines.push("");

    // Status
    if (accepted) {
      lines.push(`  Status:     {green-fg}ACCEPTED{/green-fg}`);
    } else {
      lines.push(`  Status:     {red-fg}REJECTED{/red-fg}`);
    }

    // Priority
    const pColor = PRIORITY_COLORS[task.priority] ?? "white";
    lines.push(`  Priority:   {${pColor}-fg}${task.priority}{/${pColor}-fg}`);

    // Difficulty
    const dColor = DIFFICULTY_COLORS[task.difficulty] ?? "white";
    lines.push(`  Difficulty: {${dColor}-fg}${task.difficulty}{/${dColor}-fg}`);

    // Effort
    if (task.effort) {
      lines.push(`  Effort:     ${task.effort}`);
    }

    lines.push("");

    // Dependencies
    if (task.depends_on.length > 0) {
      lines.push("{bold}Depends on:{/bold}");
      for (const dep of task.depends_on) {
        // Check if dependency is accepted
        const depItem = this.items.find((i) => i.task.id === dep);
        if (depItem) {
          const icon = depItem.accepted ? "{green-fg}\u2714{/green-fg}" : "{red-fg}\u2718{/red-fg}";
          lines.push(`  ${icon} ${dep}`);
        } else {
          lines.push(`  {yellow-fg}?{/yellow-fg} ${dep} {gray-fg}(unknown){/gray-fg}`);
        }
      }
      lines.push("");
    }

    // Description
    if (task.description) {
      lines.push("{bold}Description:{/bold}");
      const descText = escapeBlessedTags(task.description.trim());
      // Word-wrap at ~42 chars
      const words = descText.split(/\s+/);
      let line = " ";
      for (const w of words) {
        if (line.length + w.length > 42) {
          lines.push(line);
          line = " " + w;
        } else {
          line += " " + w;
        }
      }
      if (line.trim()) lines.push(line);
      lines.push("");
    }

    // Constraints
    if (task.constraints.length > 0) {
      lines.push("{bold}Constraints:{/bold}");
      for (const c of task.constraints) {
        lines.push(`  + ${escapeBlessedTags(c)}`);
      }
      lines.push("");
    }

    // Forbidden
    if (task.forbidden.length > 0) {
      lines.push("{bold}Forbidden:{/bold}");
      for (const f of task.forbidden) {
        lines.push(`  - ${escapeBlessedTags(f)}`);
      }
      lines.push("");
    }

    // References
    if (task.references.length > 0) {
      lines.push("{bold}References:{/bold}");
      for (const r of task.references) {
        lines.push(`  ${escapeBlessedTags(r)}`);
      }
      lines.push("");
    }

    // Notes
    if (task.notes.length > 0) {
      lines.push("{bold}Notes:{/bold}");
      for (const n of task.notes) {
        lines.push(`  ${escapeBlessedTags(n)}`);
      }
      lines.push("");
    }

    // Agent
    if (task.agent) {
      lines.push("{bold}Agent:{/bold}");
      lines.push(`  ${task.agent}`);
      lines.push("");
    }

    // Validation issues for this task
    const taskIssues = this.planResult.issues.filter(
      (i) => i.taskId === task.id
    );
    if (taskIssues.length > 0) {
      lines.push("{bold}Validation Issues:{/bold}");
      for (const issue of taskIssues) {
        const icon = issue.level === "error"
          ? "{red-fg}\u2718{/red-fg}"
          : "{yellow-fg}\u26A0{/yellow-fg}";
        lines.push(`  ${icon} ${escapeBlessedTags(issue.message)}`);
      }
    }

    this.detailBox.setContent(lines.join("\n"));
    this.detailBox.setLabel(` ${task.id} `);
  }

  private refreshStatusBar(): void {
    let line1 = ` {bold}Keys:{/bold}`;
    line1 += `  {gray-fg}Space{/gray-fg} toggle`;
    line1 += `  {gray-fg}E{/gray-fg} edit`;
    line1 += `  {gray-fg}Shift+J/K{/gray-fg} reorder`;
    line1 += `  {gray-fg}R{/gray-fg} toggle all`;
    line1 += `  {gray-fg}V{/gray-fg} validation`;
    line1 += `  {gray-fg}A{/gray-fg} approve`;
    line1 += `  {gray-fg}Q{/gray-fg} cancel`;

    const accepted = this.items.filter((i) => i.accepted).length;
    let line2 = ` {gray-fg}${accepted} task${accepted !== 1 ? "s" : ""} will be created on approval{/gray-fg}`;

    const hasErrors = this.planResult.issues.some((i) => i.level === "error");
    if (hasErrors) {
      line2 += `  {red-fg}| Plan has validation errors — review with V{/red-fg}`;
    }

    this.statusBar.setContent(`${line1}\n${line2}`);
  }
}
