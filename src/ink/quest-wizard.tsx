/**
 * quest-wizard.tsx — Ink component for the 6-step quest creation wizard.
 *
 * Migrated from tui-quest-wizard.ts (neo-blessed) to Ink (React-based).
 *
 * Steps: ID → Title → Goal → Priority → Difficulty → HITL
 *
 * Two render modes:
 *   1. Overlay: renders as a child component inside an existing Ink tree.
 *   2. Standalone: use runQuestWizardInk() which creates/destroys its own
 *      Ink instance (see bottom of this file).
 *
 * Usage (overlay):
 *   <QuestWizard
 *     baseBranch="main"
 *     onCreated={(quest) => { ... }}
 *     onCancelled={() => { ... }}
 *     checkDuplicateId={(id) => loadQuest(projectRoot, id)?.status ?? null}
 *     saveQuest={(quest) => saveQuest(projectRoot, quest)}
 *   />
 *
 * Usage (standalone):
 *   const quest = await runQuestWizardInk({
 *     projectRoot: "/path/to/project",
 *     baseBranch: "main",
 *     prefill: { goal: "..." },
 *   });
 */

import React, { useState, useCallback } from "react";
import { Box, Text, useInput } from "ink";
import { TextInput } from "./text-input";
import { SelectInput, type SelectInputItem } from "./select-input";
import { createBlankQuest, type QuestHitlMode, VALID_HITL_MODES } from "../lib/quest";
import { VALID_PRIORITIES, VALID_DIFFICULTIES } from "../lib/task-schema";
import type { Quest } from "../lib/quest";
import type { Priority, Difficulty } from "../lib/tasks";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface QuestWizardPrefill {
  id?: string;
  title?: string;
  goal?: string;
  priority?: Priority;
  difficulty?: Difficulty;
  hitlMode?: QuestHitlMode;
}

export interface QuestWizardProps {
  /** Base branch for the new quest's branch. */
  baseBranch: string;
  /** Optional pre-filled values for wizard fields. */
  prefill?: QuestWizardPrefill;
  /** Called with the newly created Quest after successful creation. */
  onCreated: (quest: Quest) => void;
  /** Called when user cancels (Escape from step 1). */
  onCancelled: () => void;
  /**
   * Check if a quest ID already exists.
   * Returns the quest's status string if it exists, or null if not.
   * This dependency injection allows testing without filesystem access.
   */
  checkDuplicateId: (id: string) => string | null;
  /**
   * Save the quest to persistent storage.
   * Dependency injection for testing without filesystem.
   */
  saveQuest: (quest: Quest) => void;
}

// ---------------------------------------------------------------------------
// Step definitions
// ---------------------------------------------------------------------------

type WizardStep = "id" | "title" | "goal" | "priority" | "difficulty" | "hitl";
const STEPS: WizardStep[] = ["id", "title", "goal", "priority", "difficulty", "hitl"];

type WizardPhase = "editing" | "confirmation" | "error";

// ---------------------------------------------------------------------------
// Priority item config
// ---------------------------------------------------------------------------

const PRIORITY_COLORS: Record<string, string> = {
  critical: "red",
  high: "yellow",
  medium: "white",
  low: "gray",
  wishlist: "gray",
};

function buildPriorityItems(): SelectInputItem<Priority>[] {
  return (VALID_PRIORITIES as readonly Priority[]).map((p) => ({
    label: p,
    value: p,
    hint: p === "medium" ? "(default)" : undefined,
  }));
}

function buildDifficultyItems(): SelectInputItem<Difficulty>[] {
  return (VALID_DIFFICULTIES as readonly Difficulty[]).map((d) => ({
    label: d,
    value: d,
    hint: d === "medium" ? "(default)" : undefined,
  }));
}

const HITL_DESCRIPTIONS: Record<QuestHitlMode, string> = {
  yolo: "Full autonomy, no interruptions",
  cautious: "Agent blocks on uncertainty, user answers in TUI",
  supervised: "Like cautious, but prompt encourages asking often",
};

function buildHitlItems(): SelectInputItem<QuestHitlMode>[] {
  return (VALID_HITL_MODES as readonly QuestHitlMode[]).map((m) => ({
    label: m,
    value: m,
    hint: `${m === "yolo" ? "(default) " : ""}— ${HITL_DESCRIPTIONS[m]}`,
  }));
}

// ---------------------------------------------------------------------------
// ID validation
// ---------------------------------------------------------------------------

const KEBAB_CASE_RE = /^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/;

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * QuestWizard — 6-step quest creation wizard rendered as an Ink component.
 *
 * Can be used as an overlay (child of existing Ink tree) or standalone
 * (via runQuestWizardInk).
 */
export function QuestWizard({
  baseBranch,
  prefill,
  onCreated,
  onCancelled,
  checkDuplicateId,
  saveQuest: saveQuestFn,
}: QuestWizardProps): React.ReactElement {
  // Wizard state
  const [stepIndex, setStepIndex] = useState(0);
  const [phase, setPhase] = useState<WizardPhase>("editing");
  const [error, setError] = useState<string | null>(null);
  const [creationError, setCreationError] = useState<string | null>(null);

  // Collected values
  const [questId, setQuestId] = useState(prefill?.id ?? "");
  const [questTitle, setQuestTitle] = useState(prefill?.title ?? "");
  const [questGoal, setQuestGoal] = useState(prefill?.goal ?? "");
  const [questPriority, setQuestPriority] = useState<Priority>(prefill?.priority ?? "medium");
  const [questDifficulty, setQuestDifficulty] = useState<Difficulty>(prefill?.difficulty ?? "medium");
  const [questHitl, setQuestHitl] = useState<QuestHitlMode>(prefill?.hitlMode ?? "yolo");

  // Created quest (for confirmation display)
  const [createdQuest, setCreatedQuest] = useState<Quest | null>(null);

  const currentStep = STEPS[stepIndex];
  const stepLabel = `Step ${stepIndex + 1}/${STEPS.length}`;

  // -----------------------------------------------------------------------
  // Navigation
  // -----------------------------------------------------------------------

  const goBack = useCallback(() => {
    setError(null);
    if (stepIndex <= 0) {
      onCancelled();
      return;
    }
    setStepIndex((prev) => prev - 1);
  }, [stepIndex, onCancelled]);

  const advanceOrFinish = useCallback(() => {
    setError(null);
    const nextIdx = stepIndex + 1;
    if (nextIdx >= STEPS.length) {
      // All steps done — create quest
      try {
        const quest = createBlankQuest(questId, questTitle, questGoal, baseBranch, {
          priority: questPriority,
          difficulty: questDifficulty,
          hitlMode: questHitl,
        });

        saveQuestFn(quest);
        setCreatedQuest(quest);
        setPhase("confirmation");
        onCreated(quest);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        setCreationError(msg);
        setPhase("error");
      }
      return;
    }
    setStepIndex(nextIdx);
  }, [stepIndex, questId, questTitle, questGoal, baseBranch, questPriority, questDifficulty, questHitl, saveQuestFn, onCreated]);

  // -----------------------------------------------------------------------
  // Text input handlers (ID, Title, Goal)
  // -----------------------------------------------------------------------

  const handleTextSubmit = useCallback(
    (value: string) => {
      const trimmed = value.trim();

      if (currentStep === "id") {
        if (!trimmed) {
          setError("ID cannot be empty");
          return;
        }
        if (!KEBAB_CASE_RE.test(trimmed)) {
          setError("ID must be kebab-case (lowercase letters, numbers, hyphens)");
          return;
        }
        const existing = checkDuplicateId(trimmed);
        if (existing) {
          setError(`Quest "${trimmed}" already exists (${existing})`);
          return;
        }
        setQuestId(trimmed);
        advanceOrFinish();
      } else if (currentStep === "title") {
        if (!trimmed) {
          setError("Title cannot be empty");
          return;
        }
        setQuestTitle(trimmed);
        advanceOrFinish();
      } else if (currentStep === "goal") {
        if (!trimmed) {
          setError("Goal cannot be empty");
          return;
        }
        setQuestGoal(trimmed);
        advanceOrFinish();
      }
    },
    [currentStep, checkDuplicateId, advanceOrFinish]
  );

  // -----------------------------------------------------------------------
  // Escape key handler for text input steps
  // -----------------------------------------------------------------------

  useInput(
    (_input, key) => {
      if (
        key.escape &&
        phase === "editing" &&
        (currentStep === "id" || currentStep === "title" || currentStep === "goal")
      ) {
        goBack();
      }
    },
    { isActive: phase === "editing" && (currentStep === "id" || currentStep === "title" || currentStep === "goal") }
  );

  // -----------------------------------------------------------------------
  // Select input handlers (Priority, Difficulty, HITL)
  // -----------------------------------------------------------------------

  const handlePrioritySelect = useCallback(
    (item: SelectInputItem<Priority>) => {
      setQuestPriority(item.value);
      advanceOrFinish();
    },
    [advanceOrFinish]
  );

  const handleDifficultySelect = useCallback(
    (item: SelectInputItem<Difficulty>) => {
      setQuestDifficulty(item.value);
      advanceOrFinish();
    },
    [advanceOrFinish]
  );

  const handleHitlSelect = useCallback(
    (item: SelectInputItem<QuestHitlMode>) => {
      setQuestHitl(item.value);
      advanceOrFinish();
    },
    [advanceOrFinish]
  );

  // -----------------------------------------------------------------------
  // Error phase — press Escape to cancel
  // -----------------------------------------------------------------------

  useInput(
    (_input, key) => {
      if (key.escape && phase === "error") {
        onCancelled();
      }
    },
    { isActive: phase === "error" }
  );

  // -----------------------------------------------------------------------
  // Render: Confirmation phase
  // -----------------------------------------------------------------------

  if (phase === "confirmation" && createdQuest) {
    return (
      <Box flexDirection="column" borderStyle="round" borderColor="magenta" paddingX={1} paddingY={1}>
        <Box marginBottom={1}>
          <Text bold color="green">
            ✔ Quest created!
          </Text>
        </Box>
        <Box flexDirection="column">
          <Box>
            <Text dimColor>ID: </Text>
            <Text bold>{createdQuest.id}</Text>
            <Text dimColor> — </Text>
            <Text>{createdQuest.title}</Text>
          </Box>
          <Box>
            <Text dimColor>Priority: </Text>
            <Text>{createdQuest.priority}</Text>
            <Text dimColor>  |  Difficulty: </Text>
            <Text>{createdQuest.difficulty}</Text>
            <Text dimColor>  |  HITL: </Text>
            <Text>{createdQuest.hitlMode}</Text>
          </Box>
          <Box>
            <Text dimColor>Branch: </Text>
            <Text>quest/{createdQuest.id}</Text>
            <Text dimColor>  |  Base: </Text>
            <Text>{createdQuest.baseBranch}</Text>
          </Box>
        </Box>
      </Box>
    );
  }

  // -----------------------------------------------------------------------
  // Render: Error phase
  // -----------------------------------------------------------------------

  if (phase === "error") {
    return (
      <Box flexDirection="column" borderStyle="round" borderColor="red" paddingX={1} paddingY={1}>
        <Box marginBottom={1}>
          <Text bold color="red">
            ✘ Failed to create quest
          </Text>
        </Box>
        <Box>
          <Text>{creationError}</Text>
        </Box>
        <Box marginTop={1}>
          <Text dimColor>Press Esc to return</Text>
        </Box>
      </Box>
    );
  }

  // -----------------------------------------------------------------------
  // Render: Editing phase (steps)
  // -----------------------------------------------------------------------

  // Build status line showing collected values so far
  const statusParts: string[] = [];
  if (questId && stepIndex > 0) statusParts.push(`ID: ${questId}`);
  if (questTitle && stepIndex > 1) statusParts.push(`Title: ${questTitle}`);
  if (stepIndex > 3) statusParts.push(`Priority: ${questPriority}`);
  if (stepIndex > 4) statusParts.push(`Difficulty: ${questDifficulty}`);
  const statusText = statusParts.join(" | ");

  // Compute initial index for select inputs based on prefill
  const priorityInitialIndex = Math.max(
    0,
    (VALID_PRIORITIES as readonly string[]).indexOf(questPriority)
  );
  const difficultyInitialIndex = Math.max(
    0,
    (VALID_DIFFICULTIES as readonly string[]).indexOf(questDifficulty)
  );
  const hitlInitialIndex = Math.max(
    0,
    (VALID_HITL_MODES as readonly string[]).indexOf(questHitl)
  );

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="magenta" paddingX={1} paddingY={1}>
      {/* Header: New Quest */}
      <Box marginBottom={1}>
        <Text bold color="magenta">
          New Quest
        </Text>
      </Box>

      {/* Step header */}
      <Box flexDirection="column" marginBottom={1}>
        {currentStep === "id" && (
          <>
            <Text bold>{stepLabel} — Quest ID</Text>
            <Text dimColor>Kebab-case identifier (e.g. auth-overhaul, search-api)</Text>
            <Text dimColor>Esc to cancel • Ctrl+S to submit</Text>
          </>
        )}
        {currentStep === "title" && (
          <>
            <Text bold>{stepLabel} — Title</Text>
            <Text dimColor>Human-readable name for the quest</Text>
            <Text dimColor>Esc to go back • Ctrl+S to submit</Text>
          </>
        )}
        {currentStep === "goal" && (
          <>
            <Text bold>{stepLabel} — Goal</Text>
            <Text dimColor>What should this quest achieve?</Text>
            <Text dimColor>Esc to go back • Ctrl+S to submit</Text>
          </>
        )}
        {currentStep === "priority" && (
          <>
            <Text bold>{stepLabel} — Priority</Text>
            <Text dimColor>Select with Enter, Esc to go back</Text>
          </>
        )}
        {currentStep === "difficulty" && (
          <>
            <Text bold>{stepLabel} — Difficulty</Text>
            <Text dimColor>Select with Enter, Esc to go back</Text>
          </>
        )}
        {currentStep === "hitl" && (
          <>
            <Text bold>{stepLabel} — HITL Mode</Text>
            <Text dimColor>Human-in-the-loop mode for agents. Select with Enter, Esc to go back</Text>
          </>
        )}
      </Box>

      {/* Input area */}
      <Box flexDirection="column" marginBottom={1}>
        {currentStep === "id" && (
          <Box borderStyle="single" borderColor="cyan" paddingX={1}>
            <TextInput
              value={questId}
              onChange={setQuestId}
              onSubmit={handleTextSubmit}
              placeholder="quest-id"
              focus={true}
            />
          </Box>
        )}

        {currentStep === "title" && (
          <Box borderStyle="single" borderColor="cyan" paddingX={1}>
            <TextInput
              value={questTitle}
              onChange={setQuestTitle}
              onSubmit={handleTextSubmit}
              placeholder="Quest Title"
              focus={true}
            />
          </Box>
        )}

        {currentStep === "goal" && (
          <Box borderStyle="single" borderColor="cyan" paddingX={1}>
            <TextInput
              value={questGoal}
              onChange={setQuestGoal}
              onSubmit={handleTextSubmit}
              placeholder="Describe the quest goal..."
              multiline={true}
              focus={true}
            />
          </Box>
        )}

        {currentStep === "priority" && (
          <SelectInput
            items={buildPriorityItems()}
            onSelect={handlePrioritySelect}
            onCancel={goBack}
            initialIndex={priorityInitialIndex}
            focus={true}
          />
        )}

        {currentStep === "difficulty" && (
          <SelectInput
            items={buildDifficultyItems()}
            onSelect={handleDifficultySelect}
            onCancel={goBack}
            initialIndex={difficultyInitialIndex}
            focus={true}
          />
        )}

        {currentStep === "hitl" && (
          <SelectInput
            items={buildHitlItems()}
            onSelect={handleHitlSelect}
            onCancel={goBack}
            initialIndex={hitlInitialIndex}
            focus={true}
          />
        )}
      </Box>

      {/* Error message */}
      {error && (
        <Box marginBottom={1}>
          <Text color="red">{error}</Text>
        </Box>
      )}

      {/* Status line */}
      {statusText && (
        <Box>
          <Text dimColor>{statusText}</Text>
        </Box>
      )}
    </Box>
  );
}
