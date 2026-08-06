/**
 * Secret masking (§12.4).
 *
 * Masking happens before a value reaches a render, a log, or the clipboard.
 * The rule deliberately errs toward over-masking: showing dots where a real
 * secret wasn't needed is a cosmetic problem, leaking one is not.
 */

export const MASK = "••••••••";

/** Keys whose values are treated as secret regardless of what they look like. */
const SECRET_KEY_PATTERN = /(key|token|secret|password|credential|auth)/i;

/** Recognisable credential shapes, checked when the key name gives nothing away. */
const CREDENTIAL_VALUE_PATTERNS: RegExp[] = [
  /^sk-[A-Za-z0-9._-]+$/, // OpenAI/Anthropic-style secret keys, incl. sk-ant-…
  /^ghp_[A-Za-z0-9]+$/, // GitHub personal access token (classic)
  /^gho_[A-Za-z0-9]+$/, // GitHub OAuth token
  /^ghs_[A-Za-z0-9]+$/, // GitHub server-to-server token
  /^ghr_[A-Za-z0-9]+$/, // GitHub refresh token
  /^github_pat_[A-Za-z0-9_]+$/, // GitHub fine-grained PAT
  /^xox[abposr]-[A-Za-z0-9-]+$/, // Slack tokens
  /^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$/, // JWT
  /^[A-Za-z0-9+/_-]{40,}={0,2}$/, // 40+ chars of base64-ish entropy
];

export function isSecretKey(key: string): boolean {
  return SECRET_KEY_PATTERN.test(key);
}

export function looksLikeSecret(value: string): boolean {
  const v = value.trim();
  if (v.length === 0) return false;
  return CREDENTIAL_VALUE_PATTERNS.some((re) => re.test(v));
}

/**
 * True when this key/value pair should be masked. `key` is optional so the
 * same check works for bare values (array members, CLI args).
 */
export function isSecret(value: unknown, key?: string): boolean {
  if (key !== undefined && isSecretKey(key)) return true;
  if (typeof value === "string" && looksLikeSecret(value)) return true;
  return false;
}

/** Masks a single value for display. Non-secrets are returned unchanged. */
export function maskValue(value: unknown, key?: string): unknown {
  return isSecret(value, key) ? MASK : value;
}

/**
 * Deep-masks a structure for display or logging. Object keys are preserved —
 * only values are replaced, so the shape of a config stays readable.
 *
 * A secret-looking key masks its entire subtree: `"auth": { "token": "x" }`
 * must not leak `x` just because the inner key was reached separately.
 */
export function maskDeep(input: unknown, key?: string): unknown {
  if (key !== undefined && isSecretKey(key)) return MASK;

  if (typeof input === "string") return looksLikeSecret(input) ? MASK : input;
  if (input === null || typeof input !== "object") return input;

  if (Array.isArray(input)) return input.map((item) => maskDeep(item));

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    out[k] = maskDeep(v, k);
  }
  return out;
}

/**
 * Masks credential-shaped substrings inside free text — parse errors, command
 * strings, and stack traces that may quote a config line verbatim.
 */
export function maskText(text: string): string {
  let out = text;
  const inlinePatterns: RegExp[] = [
    /\bsk-[A-Za-z0-9._-]{8,}/g,
    /\bghp_[A-Za-z0-9]{8,}/g,
    /\bgho_[A-Za-z0-9]{8,}/g,
    /\bghs_[A-Za-z0-9]{8,}/g,
    /\bghr_[A-Za-z0-9]{8,}/g,
    /\bgithub_pat_[A-Za-z0-9_]{8,}/g,
    /\bxox[abposr]-[A-Za-z0-9-]{8,}/g,
    /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g,
  ];
  for (const re of inlinePatterns) out = out.replace(re, MASK);
  return out;
}
