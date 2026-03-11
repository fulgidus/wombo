/**
 * validate.ts — Input validation / hardening for agent-ready CLI.
 *
 * All user/agent-supplied inputs pass through these validators at the CLI
 * boundary. This prevents hallucinated inputs from corrupting state.
 *
 * Rules:
 *   - Feature IDs: kebab-case only, no path traversals, no query params
 *   - Branch names: no control chars, no "..", no spaces
 *   - Free-text (titles, descriptions): no control chars except \n \t
 *   - Effort strings: ISO 8601 duration pattern only
 */

// ---------------------------------------------------------------------------
// Patterns
// ---------------------------------------------------------------------------

/** Valid feature/subtask ID: lowercase alphanumeric + hyphens, 1-128 chars */
const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,127}$/;

/** Control characters below space, excluding \t (0x09) and \n (0x0a) */
const CONTROL_CHARS = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/;

/** Path traversal sequences */
const PATH_TRAVERSAL = /\.\.\//;

/** Embedded query params or fragments */
const QUERY_FRAGMENT = /[?#]/;

/** Percent-encoded sequences (indicates double-encoding risk) */
const PERCENT_ENCODED = /%[0-9a-fA-F]{2}/;

/** ISO 8601 duration: P[nY][nM][nD][T[nH][nM][nS]] */
const DURATION_PATTERN = /^P(?:\d+Y)?(?:\d+M)?(?:\d+D)?(?:T(?:\d+H)?(?:\d+M)?(?:\d+S)?)?$/;

// ---------------------------------------------------------------------------
// Result type
// ---------------------------------------------------------------------------

export interface ValidationResult {
  valid: boolean;
  error?: string;
}

function ok(): ValidationResult {
  return { valid: true };
}

function fail(error: string): ValidationResult {
  return { valid: false, error };
}

// ---------------------------------------------------------------------------
// Validators
// ---------------------------------------------------------------------------

/**
 * Validate a feature or subtask ID.
 * Must be kebab-case, no traversals, no query params, no encoded chars.
 */
export function validateId(value: string, label: string = "ID"): ValidationResult {
  if (!value || value.length === 0) {
    return fail(`${label} must not be empty.`);
  }

  if (CONTROL_CHARS.test(value)) {
    return fail(`${label} contains control characters.`);
  }

  if (PATH_TRAVERSAL.test(value)) {
    return fail(`${label} contains path traversal sequence "../".`);
  }

  if (QUERY_FRAGMENT.test(value)) {
    return fail(`${label} contains query/fragment characters (? or #).`);
  }

  if (PERCENT_ENCODED.test(value)) {
    return fail(`${label} contains percent-encoded characters — possible double-encoding.`);
  }

  if (!ID_PATTERN.test(value)) {
    return fail(
      `${label} "${value}" is invalid. IDs must be kebab-case ` +
      `(lowercase letters, digits, hyphens), 1–128 characters, starting with a letter or digit.`
    );
  }

  return ok();
}

/**
 * Validate free-text input (titles, descriptions, notes).
 * Rejects control chars except \t and \n.
 */
export function validateText(value: string, label: string = "text"): ValidationResult {
  if (CONTROL_CHARS.test(value)) {
    return fail(`${label} contains control characters (non-printable bytes).`);
  }
  return ok();
}

/**
 * Validate a branch name.
 * No control chars, no "..", no spaces, no ~, ^, :, \, ?, *, [
 */
export function validateBranchName(value: string, label: string = "branch name"): ValidationResult {
  if (!value || value.length === 0) {
    return fail(`${label} must not be empty.`);
  }

  if (CONTROL_CHARS.test(value)) {
    return fail(`${label} contains control characters.`);
  }

  if (/\.\./.test(value)) {
    return fail(`${label} contains ".." which is not allowed in git branch names.`);
  }

  if (/[ ~^:\\?*\[]/.test(value)) {
    return fail(`${label} contains characters not allowed in git branch names.`);
  }

  return ok();
}

/**
 * Validate an ISO 8601 duration string.
 */
export function validateDuration(value: string, label: string = "effort"): ValidationResult {
  if (!value || value.length === 0) {
    return fail(`${label} must not be empty.`);
  }

  if (!DURATION_PATTERN.test(value)) {
    return fail(
      `${label} "${value}" is not a valid ISO 8601 duration. ` +
      `Expected format: P[nY][nM][nD][T[nH][nM][nS]] (e.g., "PT2H", "P1D", "P1DT4H30M").`
    );
  }

  return ok();
}

/**
 * Validate a status value against the allowed set.
 */
export function validateEnum(
  value: string,
  allowed: readonly string[],
  label: string = "value"
): ValidationResult {
  if (!allowed.includes(value)) {
    return fail(`${label} "${value}" is not valid. Allowed values: ${allowed.join(", ")}`);
  }
  return ok();
}

// ---------------------------------------------------------------------------
// Convenience: validate and exit on failure
// ---------------------------------------------------------------------------

/**
 * Run a validation and exit with error message if invalid.
 * For use at the CLI boundary.
 */
export function assertValid(result: ValidationResult): void {
  if (!result.valid) {
    console.error(`Validation error: ${result.error}`);
    process.exit(1);
  }
}
