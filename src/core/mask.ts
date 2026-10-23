/**
 * Secret masking (§12.4).
 *
 * Masking happens before a value reaches a render or a log.
 * The rule deliberately errs toward over-masking: showing dots where a real
 * secret wasn't needed is a cosmetic problem, leaking one is not.
 */

export const MASK = "••••••••";

/** Keys whose values are treated as secret regardless of what they look like. */
const SECRET_KEY_PATTERN = /(key|token|secret|pass|pwd|bearer|credential|auth)/i;

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
  /^(?:AKIA|ASIA)[0-9A-Z]{16}$/, // AWS access key id (long-term / temporary)
  /^npm_[A-Za-z0-9]{36}$/, // npm access token
  /^AIza[0-9A-Za-z_-]{35}$/, // Google API key
  /^(?:sk|rk)_(?:live|test)_[A-Za-z0-9]+$/, // Stripe secret / restricted key
  /^glpat-[A-Za-z0-9_-]+$/, // GitLab personal access token
  /^[A-Za-z0-9+/_-]{40,}={0,2}$/, // 40+ chars of base64-ish entropy
];

/**
 * A command-line flag whose next value is a secret: `--api-key abc`,
 * `--token abc`, `-password abc`. Used for argv arrays, where the flag and its
 * value are separate items and the value on its own looks like nothing.
 */
const SECRET_FLAG_PATTERN =
  /^--?[A-Za-z0-9_-]*?(api[-_]?key|token|secret|password|passwd|credential|auth)s?$/i;

export function isSecretFlag(arg: string): boolean {
  return SECRET_FLAG_PATTERN.test(arg);
}

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

/**
 * Masks a single value for display. A string that isn't a secret as a whole
 * still has any secret parts masked — a URL's password or `?token=`.
 */
export function maskValue(value: unknown, key?: string): unknown {
  if (isSecret(value, key)) return MASK;
  return typeof value === "string" ? maskText(value) : value;
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

  if (typeof input === "string") return looksLikeSecret(input) ? MASK : maskText(input);
  if (input === null || typeof input !== "object") return input;

  // In an argv array the secret is the item *after* its flag:
  // ["--api-key", "abc123"] must not show abc123.
  if (Array.isArray(input)) {
    return input.map((item, i) => {
      const previous = input[i - 1];
      if (typeof previous === "string" && isSecretFlag(previous)) return MASK;
      return maskDeep(item);
    });
  }

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
    /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
    /\bnpm_[A-Za-z0-9]{36}\b/g,
    /\bAIza[0-9A-Za-z_-]{35}/g,
    /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{8,}/g,
    /\bglpat-[A-Za-z0-9_-]{8,}/g,
  ];
  for (const re of inlinePatterns) out = out.replace(re, MASK);

  // An HTTP auth header's credential: "Authorization: Bearer abc".
  // Backslashes and quotes end the value, so masking text that is itself
  // JSON (the undo log) can't unbalance an escaped quote.
  out = out.replace(/\b(Bearer)\s+[^\s"'\\]+/gi, `$1 ${MASK}`);

  // A variable named like a secret, set inline: DB_PASSWORD=hunter2 npm start.
  out = out.replace(
    /\b([A-Za-z0-9_]*(?:PASS|PWD|SECRET|TOKEN|KEY)[A-Za-z0-9_]*=)("[^"\\]*"|'[^'\\]*'|[^\s"'&\\]+)/gi,
    (_m, name: string) => `${name}${MASK}`,
  );

  // A URL's userinfo: keep the user name, hide the password. With no
  // password, a long "user" is usually the token itself (https://TOKEN@host),
  // while a short one is a real name (ssh://git@host) and stays.
  out = out.replace(
    /\b([a-z][a-z0-9+.-]*:\/\/)([^\s/@:]+)(?::([^\s/@]*))?@/gi,
    (match, scheme: string, user: string, password: string | undefined) => {
      if (password !== undefined) return `${scheme}${user}:${MASK}@`;
      return user.length >= 20 || looksLikeSecret(user) ? `${scheme}${MASK}@` : match;
    },
  );

  // Query or fragment parameters named like a secret: ?token=…, &api_key=….
  out = out.replace(
    /([?&#;][^=&\s#?]*?(?:key|token|secret|password|passwd|pwd|auth|signature|sig|credential)[^=&\s#]*=)[^&\s#"']+/gi,
    `$1${MASK}`,
  );

  // A secret flag and its value in a command line: --token abc, --api-key=abc.
  out = out.replace(
    /(^|\s)(--?[A-Za-z0-9_-]*?(?:api[-_]?key|token|secret|password|passwd|credential|auth)s?)(=|\s+)("[^"]*"|'[^']*'|[^\s"']+)/gi,
    (_m, lead: string, flag: string, sep: string) => `${lead}${flag}${sep}${MASK}`,
  );
  return out;
}
