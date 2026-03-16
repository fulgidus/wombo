/**
 * review-list-types.ts — Shared types for the ReviewList Ink component.
 *
 * Provides the abstraction layer that unifies genesis review (quests)
 * and plan review (tasks) into a single configurable component.
 *
 * The ReviewItem interface captures the common shape, while
 * ReviewListConfig lets callers customize labels, fields, and callbacks.
 */

// ---------------------------------------------------------------------------
// Display Constants (shared between genesis and plan review)
// ---------------------------------------------------------------------------

export const PRIORITY_ABBREV: Record<string, string> = {
  critical: "CRIT",
  high: "HIGH",
  medium: "MED ",
  low: "LOW ",
  wishlist: "WISH",
};

export const PRIORITY_COLORS: Record<string, string> = {
  critical: "red",
  high: "yellow",
  medium: "white",
  low: "gray",
  wishlist: "gray",
};

export const DIFFICULTY_COLORS: Record<string, string> = {
  trivial: "gray",
  easy: "green",
  medium: "white",
  hard: "yellow",
  very_hard: "red",
};

export const HITL_COLORS: Record<string, string> = {
  yolo: "green",
  cautious: "yellow",
  supervised: "red",
};

// ---------------------------------------------------------------------------
// Validation Issue
// ---------------------------------------------------------------------------

/** A validation issue attached to a specific item or the plan as a whole. */
export interface ReviewValidationIssue {
  level: "error" | "warning";
  /** The item ID this issue is about, or undefined for plan-level issues. */
  itemId?: string;
  message: string;
}

// ---------------------------------------------------------------------------
// Edit Field Definition
// ---------------------------------------------------------------------------

/** Defines a single editable field in the edit modal. */
export interface EditFieldDef {
  /** Internal field key (used to get/set values). */
  key: string;
  /** Display label for the field. */
  label: string;
  /** The type of editor to show. */
  type: "text" | "select" | "textarea";
  /** For select fields: the list of options. */
  options?: Array<{ label: string; value: string }>;
  /** Hint shown below the field label. */
  hint?: string;
}

// ---------------------------------------------------------------------------
// ReviewItem — the common shape for items in the review list
// ---------------------------------------------------------------------------

/** A single item in the review list, with accept/reject state. */
export interface ReviewItem {
  /** Unique identifier. */
  id: string;
  /** Human-readable title. */
  title: string;
  /** Priority level. */
  priority: string;
  /** Difficulty level. */
  difficulty: string;
  /** IDs of items this one depends on. */
  dependsOn: string[];
  /** Whether this item is accepted (true) or rejected (false). */
  accepted: boolean;
  /** Additional display fields shown in the detail pane. */
  detailFields: DetailField[];
  /** Additional sections shown in the detail pane (lists of strings). */
  detailSections: DetailSection[];
}

/** A simple key-value field for the detail pane. */
export interface DetailField {
  label: string;
  value: string;
  color?: string;
}

/** A section with a title and list of text lines for the detail pane. */
export interface DetailSection {
  label: string;
  items: string[];
  /** Prefix for each item (e.g., "+" for constraints, "-" for forbidden). */
  prefix?: string;
}

// ---------------------------------------------------------------------------
// ReviewListConfig — customizes the ReviewList for different data shapes
// ---------------------------------------------------------------------------

/** Configuration for the ReviewList component. */
export interface ReviewListConfig {
  /** Title shown in the header (e.g., "Genesis Review" or "Plan Review"). */
  title: string;
  /** Subtitle shown below the title (e.g., quest title or project name). */
  subtitle?: string;
  /** Label for the item type, singular (e.g., "quest" or "task"). */
  itemLabel: string;
  /** Label for the item type, plural (e.g., "quests" or "tasks"). */
  itemLabelPlural: string;
  /** Label for the list pane header (e.g., "Proposed Quests"). */
  listLabel: string;
  /** Validation issues for the entire plan. */
  issues: ReviewValidationIssue[];
  /** Edit field definitions for the edit modal. */
  editFields: EditFieldDef[];
  /** Called to get the current value of an edit field for an item. */
  getEditFieldValue: (item: ReviewItem, fieldKey: string) => string;
  /** Called to apply an edited field value to an item. */
  setEditFieldValue: (item: ReviewItem, fieldKey: string, value: string) => ReviewItem;
  /** Text for the approve confirmation dialog. */
  approveTitle: string;
  /** Body text for the approve confirmation dialog. */
  approveBody: (acceptedCount: number) => string;
  /** Called with accepted items and knowledge when user approves. */
  onApprove: (items: ReviewItem[]) => void;
  /** Called when user cancels/discards. */
  onCancel: () => void;
  /** Optional knowledge string from the planner. */
  knowledge?: string | null;
}
