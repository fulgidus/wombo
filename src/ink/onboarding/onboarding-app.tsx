/**
 * onboarding-app.tsx — Top-level onboarding orchestrator Ink component.
 *
 * Manages the full onboarding flow including async operations (brownfield
 * scout, LLM synthesis) and confirm dialogs. This component is the
 * boundary between the pure UI components and the side-effectful operations.
 *
 * **Create mode** flow:
 *   1. StepWizard → collect raw inputs
 *   2. structureRawInputs → build profile
 *   3. If brownfield → ProgressView (scout) → update profile
 *   4. ConfirmDialog → "Enhance with AI?"
 *   5. If yes → ProgressView (LLM synthesis) → update profile
 *   6. ProfileReview → section-by-section approval
 *   7. Save profile
 *   8. ProgressView (success) → brief display
 *   9. ConfirmDialog → "Run genesis planner?"
 *   10. Call onDone with final profile + genesis flag
 *
 * **Edit mode** flow:
 *   1. SectionPicker → select section or resynthesize
 *   2. FieldEditor → edit section → save → loop
 *   3. On resynthesize → ProgressView (LLM) → save → loop
 *   4. On back → call onDone
 *
 * Unlike OnboardingWizard, this component orchestrates the full flow
 * directly using the sub-components (StepWizard, ProfileReview,
 * SectionPicker, FieldEditor) rather than delegating to OnboardingWizard,
 * because async operations (scout, LLM) need to occur between phases.
 */

import React, { useState, useCallback, useEffect } from "react";
import { Box, Text } from "ink";
import type {
  ProfileSection,
  ProjectProfile,
} from "../../lib/project-store";
import type { WomboConfig } from "../../config";
import { structureRawInputs, type RawInputs } from "./onboarding-utils";
import { StepWizard } from "./step-wizard";
import { ProfileReview } from "./profile-review";
import { SectionPicker } from "./section-picker";
import { FieldEditor } from "./field-editor";
import { ConfirmDialog } from "./confirm-dialog";
import { ProgressView, type ProgressResult } from "./progress-view";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Overall flow phases for create mode.
 * These track the top-level state machine:
 *   collecting → scouting → confirm-llm → synthesizing → reviewing → saving → confirm-genesis → done
 */
type CreateFlowPhase =
  | "collecting"       // StepWizard: collecting raw inputs
  | "scouting"         // ProgressView: running brownfield scout
  | "confirm-llm"     // ConfirmDialog: "Enhance with AI?"
  | "synthesizing"     // ProgressView: running LLM synthesis
  | "reviewing"        // ProfileReview: section-by-section approval
  | "saving"           // ProgressView: saving + success message
  | "confirm-genesis"  // ConfirmDialog: "Run genesis planner?"
  | "done";            // Flow complete

/**
 * Edit-mode phases.
 */
type EditFlowPhase =
  | "picking"          // SectionPicker: select section to edit
  | "editing"          // FieldEditor: editing a section
  | "synthesizing"     // ProgressView: LLM resynthesize
  | "done";

export interface OnboardingAppProps {
  /** Which mode to run in. */
  mode: "create" | "edit";
  /** Project root path (for scout and save operations). */
  projectRoot: string;
  /** Existing profile for edit mode. */
  existingProfile?: ProjectProfile;
  /** Wombo config (for LLM agent resolution). */
  config?: WomboConfig;
  /**
   * Called when the onboarding flow completes.
   * @param profile — The final profile (null if cancelled).
   * @param genesisRequested — Whether the user wants to run genesis.
   */
  onDone: (profile: ProjectProfile | null, genesisRequested?: boolean) => void;
  /**
   * Optional: override brownfield scout for testing.
   * Should return the scout summary string (or "" on failure).
   */
  scoutFn?: (projectRoot: string) => Promise<string>;
  /**
   * Optional: override LLM synthesis for testing.
   * Should return the enhanced profile.
   */
  synthesisFn?: (
    profile: ProjectProfile,
    config: WomboConfig,
    projectRoot: string,
    onProgress: (msg: string) => void,
  ) => Promise<ProjectProfile>;
  /**
   * Optional: override save for testing.
   */
  saveFn?: (projectRoot: string, profile: ProjectProfile) => void;
}

// ---------------------------------------------------------------------------
// OnboardingApp
// ---------------------------------------------------------------------------

/**
 * OnboardingApp — full onboarding orchestrator with async operations.
 *
 * This is the component that should be rendered by the Ink app to run
 * the complete onboarding flow. It manages the state machine, handles
 * async operations, and calls onDone when finished.
 */
export function OnboardingApp({
  mode,
  projectRoot,
  existingProfile,
  config,
  onDone,
  scoutFn,
  synthesisFn,
  saveFn,
}: OnboardingAppProps): React.ReactElement {
  // =========================================================================
  // Shared progress state
  // =========================================================================
  const [progressTitle, setProgressTitle] = useState("");
  const [progressSubtitle, setProgressSubtitle] = useState<string | undefined>();
  const [progressStatus, setProgressStatus] = useState("");
  const [progressResult, setProgressResult] = useState<ProgressResult | undefined>();

  // =========================================================================
  // Create mode state
  // =========================================================================
  const [createPhase, setCreatePhase] = useState<CreateFlowPhase>("collecting");
  const [draftProfile, setDraftProfile] = useState<ProjectProfile | null>(null);

  // =========================================================================
  // Edit mode state
  // =========================================================================
  const [editPhase, setEditPhase] = useState<EditFlowPhase>("picking");
  const [editProfile, setEditProfile] = useState<ProjectProfile | null>(
    existingProfile ? JSON.parse(JSON.stringify(existingProfile)) : null,
  );
  const [editingSection, setEditingSection] = useState<ProfileSection | null>(null);

  // =========================================================================
  // Create mode: Step 1 — StepWizard
  // =========================================================================

  const handleInputsComplete = useCallback(
    (inputs: RawInputs) => {
      const profile = structureRawInputs(inputs);
      setDraftProfile(profile);

      // If brownfield and scout function available, run scout
      if (profile.type === "brownfield" && scoutFn) {
        setCreatePhase("scouting");
        setProgressTitle("Codebase Scout");
        setProgressSubtitle(projectRoot);
        setProgressStatus("Scanning codebase structure...");
        setProgressResult(undefined);

        scoutFn(projectRoot).then((summary) => {
          const updatedProfile = { ...profile };
          if (summary) {
            updatedProfile.codebase_summary = summary;
            const lineCount = summary.split("\n").length;
            setProgressResult({
              type: "success",
              message: `Scout complete — ${lineCount} lines of structure.`,
            });
          } else {
            setProgressResult({
              type: "info",
              message: "Scout found no codebase structure.",
            });
          }
          setDraftProfile(updatedProfile);

          // Auto-advance after brief display
          setTimeout(() => {
            setCreatePhase("confirm-llm");
          }, 1500);
        });
        return;
      }

      // No scout needed — go to LLM confirm
      setCreatePhase("confirm-llm");
    },
    [projectRoot, scoutFn],
  );

  const handleInputsCancel = useCallback(() => {
    onDone(null);
  }, [onDone]);

  // =========================================================================
  // Create mode: Step 2 — LLM confirm + synthesis
  // =========================================================================

  const handleLlmConfirm = useCallback(() => {
    if (!draftProfile || !synthesisFn || !config) {
      // No synthesis function — skip to review
      setCreatePhase("reviewing");
      return;
    }

    setCreatePhase("synthesizing");
    setProgressTitle("LLM Synthesis");
    setProgressSubtitle(draftProfile.name || projectRoot);
    setProgressStatus("Enhancing profile with AI...");
    setProgressResult(undefined);

    synthesisFn(draftProfile, config, projectRoot, (msg) => {
      setProgressStatus(msg);
    }).then((enhanced) => {
      setDraftProfile(enhanced);
      setProgressResult({
        type: "success",
        message: "LLM synthesis complete.",
      });

      setTimeout(() => {
        setCreatePhase("reviewing");
      }, 1500);
    });
  }, [draftProfile, synthesisFn, config, projectRoot]);

  const handleLlmDecline = useCallback(() => {
    // Skip LLM — go to review
    setCreatePhase("reviewing");
  }, []);

  // =========================================================================
  // Create mode: Step 3 — ProfileReview
  // =========================================================================

  const handleReviewApprove = useCallback(
    (approvedProfile: ProjectProfile) => {
      setDraftProfile(approvedProfile);

      // Save the profile
      if (saveFn) {
        saveFn(projectRoot, approvedProfile);
      }

      // Show success
      setCreatePhase("saving");
      setProgressTitle("Onboarding Complete");
      setProgressSubtitle(undefined);
      setProgressStatus("");
      setProgressResult({
        type: "success",
        message: `Project profile saved for "${approvedProfile.name || "(unnamed)"}"`,
      });
    },
    [saveFn, projectRoot],
  );

  // Auto-advance from saving to genesis confirm
  useEffect(() => {
    if (mode === "create" && createPhase === "saving" && progressResult) {
      const timer = setTimeout(() => {
        setCreatePhase("confirm-genesis");
      }, 1500);
      return () => clearTimeout(timer);
    }
  }, [mode, createPhase, progressResult]);

  const handleReviewCancel = useCallback(() => {
    onDone(null);
  }, [onDone]);

  // =========================================================================
  // Create mode: Step 4 — Genesis confirm
  // =========================================================================

  const handleGenesisConfirm = useCallback(() => {
    onDone(draftProfile, true);
  }, [draftProfile, onDone]);

  const handleGenesisDecline = useCallback(() => {
    onDone(draftProfile, false);
  }, [draftProfile, onDone]);

  // =========================================================================
  // Edit mode handlers
  // =========================================================================

  const handleSectionSelect = useCallback((section: ProfileSection) => {
    setEditingSection(section);
    setEditPhase("editing");
  }, []);

  const handleEditResynthesize = useCallback(() => {
    if (!editProfile || !synthesisFn || !config) return;

    setEditPhase("synthesizing");
    setProgressTitle("LLM Synthesis");
    setProgressSubtitle(editProfile.name || projectRoot);
    setProgressStatus("Enhancing profile with AI...");
    setProgressResult(undefined);

    synthesisFn(editProfile, config, projectRoot, (msg) => {
      setProgressStatus(msg);
    }).then((enhanced) => {
      setEditProfile(enhanced);

      if (saveFn) {
        saveFn(projectRoot, enhanced);
      }

      setProgressResult({
        type: "success",
        message: "LLM synthesis complete.",
      });

      setTimeout(() => {
        setEditPhase("picking");
      }, 1500);
    });
  }, [editProfile, synthesisFn, config, projectRoot, saveFn]);

  const handleEditBack = useCallback(() => {
    onDone(editProfile);
  }, [editProfile, onDone]);

  const handleFieldSave = useCallback(
    (updatedProfile: ProjectProfile) => {
      setEditProfile(updatedProfile);

      if (saveFn) {
        saveFn(projectRoot, updatedProfile);
      }

      setEditingSection(null);
      setEditPhase("picking");
    },
    [saveFn, projectRoot],
  );

  const handleFieldDiscard = useCallback(() => {
    setEditingSection(null);
    setEditPhase("picking");
  }, []);

  // =========================================================================
  // Render
  // =========================================================================

  if (mode === "create") {
    switch (createPhase) {
      case "collecting":
        return (
          <StepWizard
            onComplete={handleInputsComplete}
            onCancel={handleInputsCancel}
          />
        );

      case "scouting":
      case "synthesizing":
      case "saving":
        return (
          <ProgressView
            title={progressTitle}
            subtitle={progressSubtitle}
            status={progressStatus}
            result={progressResult}
          />
        );

      case "confirm-llm":
        return (
          <ConfirmDialog
            title="LLM Synthesis"
            message="Enhance profile with AI?"
            onConfirm={handleLlmConfirm}
            onCancel={handleLlmDecline}
          />
        );

      case "reviewing":
        if (!draftProfile) {
          return (
            <Box padding={1}>
              <Text color="red">Error: no draft profile available.</Text>
            </Box>
          );
        }
        return (
          <ProfileReview
            profile={draftProfile}
            onApprove={handleReviewApprove}
            onCancel={handleReviewCancel}
          />
        );

      case "confirm-genesis":
        return (
          <ConfirmDialog
            title="Genesis Planner"
            message="Run genesis planner to create initial quests?"
            onConfirm={handleGenesisConfirm}
            onCancel={handleGenesisDecline}
          />
        );

      case "done":
        return (
          <Box padding={1}>
            <Text color="green" bold>
              ✔ Onboarding complete!
            </Text>
          </Box>
        );
    }
  }

  // Edit mode
  if (mode === "edit") {
    switch (editPhase) {
      case "picking":
        if (!editProfile) {
          return (
            <Box padding={1}>
              <Text color="red">Error: no profile for editing.</Text>
            </Box>
          );
        }
        return (
          <SectionPicker
            profile={editProfile}
            onSelect={handleSectionSelect}
            onResynthesize={handleEditResynthesize}
            onBack={handleEditBack}
          />
        );

      case "editing":
        if (!editProfile || !editingSection) {
          return (
            <Box padding={1}>
              <Text color="red">Error: no section selected for editing.</Text>
            </Box>
          );
        }
        return (
          <FieldEditor
            profile={editProfile}
            section={editingSection}
            onSave={handleFieldSave}
            onDiscard={handleFieldDiscard}
          />
        );

      case "synthesizing":
        return (
          <ProgressView
            title={progressTitle}
            subtitle={progressSubtitle}
            status={progressStatus}
            result={progressResult}
          />
        );

      case "done":
        return (
          <Box padding={1}>
            <Text color="green" bold>
              ✔ Profile updated!
            </Text>
          </Box>
        );
    }
  }

  // Fallback
  return (
    <Box padding={1}>
      <Text color="red">
        Error: invalid state (mode={mode})
      </Text>
    </Box>
  );
}
