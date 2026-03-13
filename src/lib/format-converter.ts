/**
 * format-converter.ts — Convert agency-agents definition format to woco agent
 * template format.
 *
 * The agency-agents registry (github.com/msitarzewski/agency-agents) uses a
 * different markdown structure than woco's generalist-agent.md template:
 *
 *   Agency-agents frontmatter:
 *     name, description, color, emoji, vibe
 *
 *   Woco frontmatter:
 *     description (long-form with examples), mode (primary)
 *
 * This module detects the agency-agents format and converts it to a form
 * compatible with the patchImportedAgent() pipeline in templates.ts. The
 * converted output preserves the specialized agent's personality and domain
 * expertise while conforming to woco's expected structure.
 *
 * Usage:
 *   Called automatically by patchImportedAgent() when the raw agent content
 *   is detected as agency-agents format. No manual invocation needed.
 */

import YAML from "yaml";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Parsed representation of an agency-agents frontmatter.
 * Fields match the schema used in msitarzewski/agency-agents.
 */
export interface AgencyAgentFrontmatter {
  /** Human-readable agent name, e.g. "Frontend Developer" */
  name: string;
  /** Short description of the agent's expertise */
  description: string;
  /** Terminal color identifier, e.g. "cyan" */
  color?: string;
  /** Emoji representing the agent, e.g. "🖥️" */
  emoji?: string;
  /** Short personality tagline, e.g. "Builds responsive, accessible web apps..." */
  vibe?: string;
}

/**
 * Parsed sections from an agency-agents markdown body.
 * All fields are optional — not every agent has every section.
 */
export interface AgencyAgentSections {
  /** The agent personality intro paragraph(s) */
  identity?: string;
  /** Core mission / primary responsibilities */
  coreMission?: string;
  /** Critical rules the agent must follow */
  criticalRules?: string;
  /** Technical deliverables (code examples, templates) */
  deliverables?: string;
  /** Workflow process steps */
  workflow?: string;
  /** Communication style guidelines */
  communicationStyle?: string;
  /** Success metrics */
  successMetrics?: string;
  /** Advanced capabilities */
  advancedCapabilities?: string;
  /** Any remaining body content not matched to known sections */
  remaining?: string;
}

/**
 * Full parsed agency-agents definition.
 */
export interface ParsedAgencyAgent {
  frontmatter: AgencyAgentFrontmatter;
  sections: AgencyAgentSections;
  /** Raw body content (everything after frontmatter) */
  rawBody: string;
}

// ---------------------------------------------------------------------------
// Format Detection
// ---------------------------------------------------------------------------

/**
 * Detect whether raw markdown content is in agency-agents format.
 *
 * Heuristics:
 *   1. Has YAML frontmatter with `name` field (woco uses `mode`, not `name`)
 *   2. Frontmatter contains `color` or `emoji` or `vibe` (agency-agents specific)
 *   3. Does NOT have `mode` in frontmatter (woco-specific)
 *
 * @param rawMd — raw markdown content to check
 * @returns true if the content appears to be in agency-agents format
 */
export function isAgencyAgentFormat(rawMd: string): boolean {
  const trimmed = rawMd.trimStart();
  if (!trimmed.startsWith("---")) return false;

  const endIdx = trimmed.indexOf("---", 3);
  if (endIdx === -1) return false;

  const fmBlock = trimmed.slice(3, endIdx);

  try {
    const parsed = YAML.parse(fmBlock);
    if (!parsed || typeof parsed !== "object") return false;

    // Agency-agents format has `name` in frontmatter; woco has `mode`
    const hasName = typeof parsed.name === "string" && parsed.name.length > 0;
    const hasMode = "mode" in parsed;

    // If it already has `mode`, it's likely already in woco format (or patched)
    if (hasMode) return false;

    // Agency-agents specific fields
    const hasAgencyFields =
      "color" in parsed || "emoji" in parsed || "vibe" in parsed;

    return hasName || hasAgencyFields;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/**
 * Parse raw agency-agents markdown into structured form.
 *
 * @param rawMd — raw markdown content in agency-agents format
 * @returns parsed representation, or null if parsing fails
 */
export function parseAgencyAgent(rawMd: string): ParsedAgencyAgent | null {
  const trimmed = rawMd.trimStart();
  if (!trimmed.startsWith("---")) return null;

  const endIdx = trimmed.indexOf("---", 3);
  if (endIdx === -1) return null;

  const fmBlock = trimmed.slice(3, endIdx);
  // Body starts after the closing --- and any trailing newline
  const afterFm = trimmed.slice(endIdx + 3);
  const rawBody = afterFm.startsWith("\n") ? afterFm.slice(1) : afterFm;

  let parsed: Record<string, unknown>;
  try {
    parsed = YAML.parse(fmBlock);
    if (!parsed || typeof parsed !== "object") return null;
  } catch {
    return null;
  }

  const frontmatter: AgencyAgentFrontmatter = {
    name: String(parsed.name ?? "Specialized Agent"),
    description: String(parsed.description ?? ""),
    color: parsed.color != null ? String(parsed.color) : undefined,
    emoji: parsed.emoji != null ? String(parsed.emoji) : undefined,
    vibe: parsed.vibe != null ? String(parsed.vibe) : undefined,
  };

  const sections = extractSections(rawBody);

  return { frontmatter, sections, rawBody };
}

/**
 * Extract known sections from the agency-agents body.
 *
 * Agency-agents use h2 (##) headers with emoji prefixes to delimit sections.
 * We extract the ones we care about for mapping, and collect the rest.
 */
function extractSections(body: string): AgencyAgentSections {
  const sections: AgencyAgentSections = {};

  // Split body into sections by h2 headers (## ...)
  // Keep h1 headers attached to identity section
  const h2Pattern = /^## .+$/gm;
  const h2Matches: Array<{ heading: string; startIdx: number }> = [];

  let match: RegExpExecArray | null;
  while ((match = h2Pattern.exec(body)) !== null) {
    h2Matches.push({ heading: match[0], startIdx: match.index });
  }

  // Everything before first h2 is identity/intro
  if (h2Matches.length > 0) {
    const identityContent = body.slice(0, h2Matches[0].startIdx).trim();
    if (identityContent) {
      sections.identity = identityContent;
    }
  } else {
    // No h2 headers — everything is identity
    sections.identity = body.trim();
    return sections;
  }

  // Process each h2 section
  const remainingParts: string[] = [];

  for (let i = 0; i < h2Matches.length; i++) {
    const { heading, startIdx } = h2Matches[i];
    const endIdx = i + 1 < h2Matches.length ? h2Matches[i + 1].startIdx : body.length;
    const sectionContent = body.slice(startIdx, endIdx).trim();
    const headingLower = heading.toLowerCase();

    if (matchesSection(headingLower, ["identity", "memory"])) {
      sections.identity = joinContent(sections.identity, sectionContent);
    } else if (matchesSection(headingLower, ["core mission", "mission", "responsibilities"])) {
      sections.coreMission = joinContent(sections.coreMission, sectionContent);
    } else if (matchesSection(headingLower, ["critical rules", "rules you must follow", "constraints"])) {
      sections.criticalRules = joinContent(sections.criticalRules, sectionContent);
    } else if (matchesSection(headingLower, ["deliverable", "technical deliverable"])) {
      sections.deliverables = joinContent(sections.deliverables, sectionContent);
    } else if (matchesSection(headingLower, ["workflow", "process"])) {
      sections.workflow = joinContent(sections.workflow, sectionContent);
    } else if (matchesSection(headingLower, ["communication style", "communication"])) {
      sections.communicationStyle = joinContent(sections.communicationStyle, sectionContent);
    } else if (matchesSection(headingLower, ["success metrics", "metrics"])) {
      sections.successMetrics = joinContent(sections.successMetrics, sectionContent);
    } else if (matchesSection(headingLower, ["advanced capabilities", "capabilities"])) {
      sections.advancedCapabilities = joinContent(sections.advancedCapabilities, sectionContent);
    } else {
      remainingParts.push(sectionContent);
    }
  }

  if (remainingParts.length > 0) {
    sections.remaining = remainingParts.join("\n\n");
  }

  return sections;
}

/**
 * Check if a heading matches any of the given keyword patterns.
 */
function matchesSection(headingLower: string, keywords: string[]): boolean {
  return keywords.some((kw) => headingLower.includes(kw));
}

/**
 * Join existing content with new content, separated by double newline.
 */
function joinContent(existing: string | undefined, newContent: string): string {
  if (!existing) return newContent;
  return existing + "\n\n" + newContent;
}

// ---------------------------------------------------------------------------
// Conversion
// ---------------------------------------------------------------------------

/**
 * Convert an agency-agents definition to woco-compatible agent markdown.
 *
 * The output follows the structure expected by patchImportedAgent() in
 * templates.ts:
 *   - YAML frontmatter with `description` and `mode: primary`
 *   - Markdown body with the agent's specialized content
 *
 * The conversion:
 *   1. Transforms frontmatter: name/description/vibe → description, adds mode
 *   2. Restructures body: preserves specialized content, strips emoji headers,
 *      reflows into a clean structure
 *   3. Preserves all domain expertise and personality
 *
 * The patching pipeline (wc-patch.body.start/end, portless/TDD injection,
 * placeholder substitution) runs AFTER this conversion, adding wombo-combo
 * operational context around the converted content.
 *
 * @param agent — parsed agency-agents definition
 * @returns markdown string in woco-compatible format
 */
export function convertAgencyToWoco(agent: ParsedAgencyAgent): string {
  // --- Build woco-style description ---
  const descParts: string[] = [];
  descParts.push(agent.frontmatter.description);
  if (agent.frontmatter.vibe) {
    descParts.push(agent.frontmatter.vibe);
  }
  const wocoDescription = descParts.join(" ").trim();

  // --- Build frontmatter ---
  const fmObj: Record<string, string> = {
    description: wocoDescription,
    mode: "primary",
  };
  const fmYaml = YAML.stringify(fmObj, { lineWidth: 0 }).trimEnd();

  // --- Build body ---
  const bodyParts: string[] = [];

  // Agent role preamble — preserve the identity/personality
  const agentName = agent.frontmatter.name;
  bodyParts.push(
    `You are **${agentName}**, a specialized agent with domain expertise.`
  );

  // Identity section
  if (agent.sections.identity) {
    bodyParts.push("");
    bodyParts.push(cleanEmojiHeaders(agent.sections.identity));
  }

  // Core mission
  if (agent.sections.coreMission) {
    bodyParts.push("");
    bodyParts.push(cleanEmojiHeaders(agent.sections.coreMission));
  }

  // Critical rules
  if (agent.sections.criticalRules) {
    bodyParts.push("");
    bodyParts.push(cleanEmojiHeaders(agent.sections.criticalRules));
  }

  // Workflow
  if (agent.sections.workflow) {
    bodyParts.push("");
    bodyParts.push(cleanEmojiHeaders(agent.sections.workflow));
  }

  // Deliverables
  if (agent.sections.deliverables) {
    bodyParts.push("");
    bodyParts.push(cleanEmojiHeaders(agent.sections.deliverables));
  }

  // Communication style
  if (agent.sections.communicationStyle) {
    bodyParts.push("");
    bodyParts.push(cleanEmojiHeaders(agent.sections.communicationStyle));
  }

  // Advanced capabilities
  if (agent.sections.advancedCapabilities) {
    bodyParts.push("");
    bodyParts.push(cleanEmojiHeaders(agent.sections.advancedCapabilities));
  }

  // Success metrics
  if (agent.sections.successMetrics) {
    bodyParts.push("");
    bodyParts.push(cleanEmojiHeaders(agent.sections.successMetrics));
  }

  // Remaining sections
  if (agent.sections.remaining) {
    bodyParts.push("");
    bodyParts.push(cleanEmojiHeaders(agent.sections.remaining));
  }

  const body = bodyParts.join("\n") + "\n";

  return `---\n${fmYaml}\n---\n${body}`;
}

/**
 * Clean emoji prefixes from markdown headers.
 *
 * Agency-agents use emoji-prefixed headers like:
 *   ## 🧠 Your Identity & Memory
 *   ## 🎯 Your Core Mission
 *
 * These are cleaned to plain headers:
 *   ## Your Identity & Memory
 *   ## Your Core Mission
 *
 * This avoids confusing the LLM with decorative emoji in operational headers.
 */
function cleanEmojiHeaders(content: string): string {
  // Match h1-h4 headers with emoji prefixes
  // Emoji pattern: unicode emoji chars followed by optional space
  return content.replace(
    /^(#{1,4})\s+[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE00}-\u{FE0F}\u{200D}\u{20E3}\u{E0020}-\u{E007F}]+\s*/gmu,
    "$1 "
  );
}

// ---------------------------------------------------------------------------
// Convenience: Detect + Convert
// ---------------------------------------------------------------------------

/**
 * If the raw markdown is in agency-agents format, convert it to woco format.
 * Otherwise return it unchanged.
 *
 * This is the primary entry point used by patchImportedAgent() to ensure
 * all imported agent definitions are in a compatible format before patching.
 *
 * @param rawMd — raw markdown content (may be agency-agents or woco format)
 * @returns markdown in woco-compatible format
 */
export function normalizeAgentFormat(rawMd: string): string {
  if (!isAgencyAgentFormat(rawMd)) {
    return rawMd;
  }

  const parsed = parseAgencyAgent(rawMd);
  if (!parsed) {
    // Parsing failed — return as-is and let patchImportedAgent handle it
    return rawMd;
  }

  return convertAgencyToWoco(parsed);
}
