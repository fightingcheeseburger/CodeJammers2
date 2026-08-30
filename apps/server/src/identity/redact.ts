/**
 * Redaction
 * =========
 *
 * Everything written to the audit log or returned to a browser passes
 * through here first. The audit trail is the one place an operator is
 * guaranteed to look, which makes it the one place a leaked secret is
 * guaranteed to be found.
 */

const PATTERNS: Array<{ label: string; pattern: RegExp }> = [
  // Our own action tokens: header.payload.signature in base64url.
  { label: "[redacted:action-token]", pattern: /\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g },
  // Volcengine Ark / OpenAI style keys.
  { label: "[redacted:api-key]", pattern: /\b(?:sk|ak)-[A-Za-z0-9_-]{12,}\b/gi },
  // Anything that looks like an assignment to a secret-ish name.
  {
    label: "$1=[redacted]",
    pattern:
      /\b(ARK_API_KEY|APP_AUTH_TOKEN|LAUNCHPAD_ACTION_TOKEN|LAUNCHPAD_SESSION_SECRET|LAUNCHPAD_TOKEN_SECRET|AWS_SECRET_ACCESS_KEY|password|passwd|secret|token|api[_-]?key)\s*[=:]\s*["']?[^\s"',;]{6,}/gi,
  },
  { label: "[redacted:bearer]", pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{10,}/gi },
  // UUID-shaped values are fine; long opaque base64url blobs are not.
  { label: "[redacted:opaque-secret]", pattern: /\b[A-Za-z0-9_-]{43,}\b/g },
];

export function redact(value: string): string {
  let output = value;
  for (const { label, pattern } of PATTERNS) {
    output = output.replace(pattern, label);
  }
  return output;
}

/** Redact and clamp, for fields that end up on screen. */
export function redactPreview(value: string, maxLength = 240): string {
  const cleaned = redact(value).replace(/\s+/g, " ").trim();
  return cleaned.length > maxLength ? cleaned.slice(0, maxLength - 1) + "…" : cleaned;
}

export function redactDeep<T>(value: T): T {
  if (typeof value === "string") return redact(value) as unknown as T;
  if (Array.isArray(value)) return value.map((item) => redactDeep(item)) as unknown as T;
  if (value && typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      output[key] = /secret|token|password|api[_-]?key/i.test(key)
        ? "[redacted]"
        : redactDeep(item);
    }
    return output as unknown as T;
  }
  return value;
}
