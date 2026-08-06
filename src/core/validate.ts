import { z } from "zod";

/**
 * Schemas for the config files ccpanel touches (§12.2).
 *
 * Two rules govern everything here, and both exist to protect keys we've
 * never heard of:
 *
 * 1. Every object is `z.looseObject` — Zod 4's plain `z.object()` STRIPS
 *    unknown keys. Verified against zod 4.4.3: a loose parent with a strict
 *    child still drops the child's unknown keys, so "loose at the top" is not
 *    enough. Every level must be loose.
 * 2. Validation returns issues ONLY, never a parsed object. Callers cannot
 *    serialize Zod's output even by accident, so a mistake in a schema can
 *    never delete a user's settings. The object written to disk is always the
 *    one the caller mutated.
 */

/** The four documented states of a skill override (§5.3). Not a boolean. */
export const SKILL_OVERRIDE_STATES = ["on", "name-only", "user-invocable-only", "off"] as const;
export type SkillOverrideState = (typeof SKILL_OVERRIDE_STATES)[number];

const hookEntrySchema = z.looseObject({
  type: z.string().optional(),
  command: z.string().optional(),
  timeout: z.number().optional(),
});

const hookMatcherSchema = z.looseObject({
  matcher: z.string().optional(),
  hooks: z.array(hookEntrySchema).optional(),
});

const permissionsSchema = z.looseObject({
  allow: z.array(z.string()).optional(),
  deny: z.array(z.string()).optional(),
  ask: z.array(z.string()).optional(),
  additionalDirectories: z.array(z.string()).optional(),
});

export const settingsSchema = z.looseObject({
  permissions: permissionsSchema.optional(),
  hooks: z.record(z.string(), z.array(hookMatcherSchema)).optional(),
  disabledMcpjsonServers: z.array(z.string()).optional(),
  enabledMcpjsonServers: z.array(z.string()).optional(),
  enabledPlugins: z.array(z.string()).optional(),
  skillOverrides: z.record(z.string(), z.enum(SKILL_OVERRIDE_STATES)).optional(),
  disableAllHooks: z.boolean().optional(),
  disableBundledSkills: z.boolean().optional(),
  disableClaudeAiConnectors: z.boolean().optional(),
  autoCompactEnabled: z.boolean().optional(),
  autoCompactWindow: z.number().optional(),
  claudeMdExcludes: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  model: z.string().optional(),
});

const mcpServerSchema = z.looseObject({
  type: z.string().optional(),
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  url: z.string().optional(),
  headers: z.record(z.string(), z.string()).optional(),
  timeout: z.number().optional(),
});

export const mcpJsonSchema = z.looseObject({
  mcpServers: z.record(z.string(), mcpServerSchema).optional(),
});

export interface ValidationIssue {
  path: string;
  message: string;
}

export interface ValidationResult {
  ok: boolean;
  issues: ValidationIssue[];
}

/**
 * Checks a value against a schema and reports problems. Deliberately returns
 * no data — see the file header.
 */
function check(schema: z.ZodType, value: unknown): ValidationResult {
  const result = schema.safeParse(value);
  if (result.success) return { ok: true, issues: [] };
  return {
    ok: false,
    issues: result.error.issues.map((issue) => ({
      path: issue.path.join(".") || "(root)",
      message: issue.message,
    })),
  };
}

export function validateSettings(value: unknown): ValidationResult {
  return check(settingsSchema, value);
}

export function validateMcpJson(value: unknown): ValidationResult {
  return check(mcpJsonSchema, value);
}

/** Picks the right schema for a config file based on its name. */
export function validateByFilename(filePath: string, value: unknown): ValidationResult {
  if (filePath.endsWith(".mcp.json")) return validateMcpJson(value);
  if (filePath.endsWith("settings.json") || filePath.endsWith("settings.local.json")) {
    return validateSettings(value);
  }
  // Unknown config file: parsing succeeded, and we model nothing about it.
  return { ok: true, issues: [] };
}
