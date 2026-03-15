/**
 * onboarding-wizard.tsx — Main onboarding orchestrator Ink component.
 *
 * Top-level component that orchestrates the full onboarding flow.
 * Supports two modes:
 *
 * **Create mode** (no existing profile):
 *   1. StepWizard — collect raw inputs (type, name, desc, vision, etc.)
 *   2. Structure inputs into a ProjectProfile via structureRawInputs
 *   3. Optionally run brownfield scout (async, handled by caller)
 *   4. Optionally run LLM synthesis (async, handled by caller)
 *   5. ProfileReview — section-by-section approval
 *   6. Call onComplete with the approved profile
 *
 * **Edit mode** (existing profile):
 *   1. SectionPicker — select a section to edit or resynthesize
 *   2. FieldEditor — edit the selected section
 *   3. Return to SectionPicker after edit
 *   4. Call onComplete when user exits (Esc from SectionPicker)
 *
 * Async operations (scout, LLM synthesis) are delegated to the caller
 * via callback props. This keeps the component pure and testable.
 */

import React, { useState, useCallback } from "react";
import { Box, Text } from "ink";
import type {
  ProfileSection,
  ProjectProfile,
} from "../../lib/project-store";
import { structureRawInputs, type RawInputs } from "./onboarding-utils";
import { StepWizard } from "./step-wizard";
import { SectionPicker } from "./section-picker";
import { FieldEditor } from "./field-editor";
import { ProfileReview } from "./profile-review";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Phases of the create-mode flow. */
type CreatePhase =
  | "collecting"    // StepWizard
  | "reviewing"     // ProfileReview
  | "complete";     // Done

/** Phases of the edit-mode flow. */
type EditPhase =
  | "picking"       // SectionPicker
  | "editing";      // FieldEditor

export interface OnboardingWizardProps {
  /** Which mode to run in. */
  mode: "create" | "edit";
  /** Existing profile for edit mode. Required when mode is "edit". */
  existingProfile?: ProjectProfile;
  /**
   * Called when the onboarding flow completes with the final profile.
   * In create mode: after ProfileReview approval.
   * In edit mode: when user exits SectionPicker (Esc/back).
   */
  onComplete: (profile: ProjectProfile) => void;
  /** Called when the user cancels the flow entirely. */
  onCancel: () => void;
  /**
   * Optional callback for brownfield scout.
   * Called after structureRawInputs if the profile type is "brownfield".
   * The caller should run the scout and return the updated profile.
   */
  onScoutRequest?: (profile: ProjectProfile) => void;
  /**
   * Optional callback for LLM synthesis request.
   * Called when the user selects "Re-run LLM synthesis" in edit mode.
   */
  onResynthesizeRequest?: (profile: ProjectProfile) => void;
}

// ---------------------------------------------------------------------------
// OnboardingWizard
// ---------------------------------------------------------------------------

/**
 * OnboardingWizard — main orchestrator for the onboarding flow.
 *
 * Manages state transitions between sub-components (StepWizard,
 * ProfileReview, SectionPicker, FieldEditor) depending on the mode.
 */
export function OnboardingWizard({
  mode,
  existingProfile,
  onComplete,
  onCancel,
  onScoutRequest,
  onResynthesizeRequest,
}: OnboardingWizardProps): React.ReactElement {
  // -------------------------------------------------------------------------
  // Create mode state
  // -------------------------------------------------------------------------
  const [createPhase, setCreatePhase] = useState<CreatePhase>("collecting");
  const [draftProfile, setDraftProfile] = useState<ProjectProfile | null>(null);

  // -------------------------------------------------------------------------
  // Edit mode state
  // -------------------------------------------------------------------------
  const [editPhase, setEditPhase] = useState<EditPhase>("picking");
  const [editingSection, setEditingSection] = useState<ProfileSection | null>(
    null,
  );
  const [editProfile, setEditProfile] = useState<ProjectProfile | null>(
    existingProfile ? JSON.parse(JSON.stringify(existingProfile)) : null,
  );

  // =========================================================================
  // Create mode handlers
  // =========================================================================

  const handleStepWizardComplete = useCallback(
    (inputs: RawInputs) => {
      const profile = structureRawInputs(inputs);

      // If brownfield, notify caller for scout
      if (profile.type === "brownfield" && onScoutRequest) {
        onScoutRequest(profile);
      }

      setDraftProfile(profile);
      setCreatePhase("reviewing");
    },
    [onScoutRequest],
  );

  const handleStepWizardCancel = useCallback(() => {
    onCancel();
  }, [onCancel]);

  const handleReviewApprove = useCallback(
    (approvedProfile: ProjectProfile) => {
      setCreatePhase("complete");
      onComplete(approvedProfile);
    },
    [onComplete],
  );

  const handleReviewCancel = useCallback(() => {
    onCancel();
  }, [onCancel]);

  // =========================================================================
  // Edit mode handlers
  // =========================================================================

  const handleSectionSelect = useCallback((section: ProfileSection) => {
    setEditingSection(section);
    setEditPhase("editing");
  }, []);

  const handleResynthesize = useCallback(() => {
    if (editProfile && onResynthesizeRequest) {
      onResynthesizeRequest(editProfile);
    }
  }, [editProfile, onResynthesizeRequest]);

  const handleEditBack = useCallback(() => {
    if (editProfile) {
      onComplete(editProfile);
    } else {
      onCancel();
    }
  }, [editProfile, onComplete, onCancel]);

  const handleFieldSave = useCallback(
    (updatedProfile: ProjectProfile) => {
      setEditProfile(updatedProfile);
      setEditingSection(null);
      setEditPhase("picking");
    },
    [],
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
            onComplete={handleStepWizardComplete}
            onCancel={handleStepWizardCancel}
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

      case "complete":
        return (
          <Box padding={1}>
            <Text color="green" bold>
              ✔ Profile approved!
            </Text>
          </Box>
        );
    }
  }

  // Edit mode
  if (mode === "edit" && editProfile) {
    switch (editPhase) {
      case "picking":
        return (
          <SectionPicker
            profile={editProfile}
            onSelect={handleSectionSelect}
            onResynthesize={handleResynthesize}
            onBack={handleEditBack}
          />
        );

      case "editing":
        if (!editingSection) {
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
    }
  }

  // Fallback — shouldn't happen
  return (
    <Box padding={1}>
      <Text color="red">
        Error: invalid state (mode={mode}, profile={editProfile ? "yes" : "no"})
      </Text>
    </Box>
  );
}
