/**
 * ink/onboarding/index.ts — Barrel re-exports for the Ink onboarding wizard.
 */

// Pure utilities
export {
  type RawInputs,
  type InputStep,
  INPUT_STEPS,
  SECTION_NAMES,
  parseObjectives,
  parseTechStack,
  parseConventions,
  parseRules,
  parseRulesRich,
  structureRawInputs,
  serializeSectionForEdit,
  parseSectionEdit,
  formatSectionForDisplay,
  summarizeSection,
} from "./onboarding-utils";

// Components
export { StepWizard, type StepWizardProps } from "./step-wizard";
export { SectionPicker, type SectionPickerProps } from "./section-picker";
export { FieldEditor, type FieldEditorProps } from "./field-editor";
export { ProfileReview, type ProfileReviewProps } from "./profile-review";
export {
  OnboardingWizard,
  type OnboardingWizardProps,
} from "./onboarding-wizard";
