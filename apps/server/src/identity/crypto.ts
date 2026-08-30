import {
  createHash,
  randomBytes,
  randomUUID,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";

/** Constant-time comparison that tolerates different lengths. */
export function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  if (a.length !== b.length) {
    // Still burn a comparison so length is the only signal.
    timingSafeEqual(a, a);
    return false;
  }
  return timingSafeEqual(a, b);
}

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * A short, non-reversible handle for a credential, safe to store in audit
 * records and safe to print in a demo. Twelve hex characters of sha256 is
 * enough to correlate two log lines and useless for replay.
 */
export function fingerprint(value: string): string {
  return "sha256:" + sha256(value).slice(0, 12);
}

export function newSecret(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function newId(): string {
  return randomUUID();
}

export function hashPassword(
  password: string,
  salt = randomBytes(16).toString("hex"),
): { hash: string; salt: string } {
  return {
    hash: scryptSync(password, salt, 64).toString("hex"),
    salt,
  };
}

export function verifyPassword(
  password: string,
  hash: string,
  salt: string,
): boolean {
  const candidate = scryptSync(password, salt, 64).toString("hex");
  return safeEqual(candidate, hash);
}

/**
 * Canonical JSON: keys sorted, no incidental whitespace. Used to bind a
 * human approval to the exact parameters that were approved, so that
 * "approve write to doc-a1" cannot be replayed as "write to doc-b1".
 */
export function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return "[" + value.map(canonicalize).join(",") + "]";
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return (
    "{" +
    entries
      .map(([key, item]) => JSON.stringify(key) + ":" + canonicalize(item))
      .join(",") +
    "}"
  );
}

export function paramsHash(params: unknown): string {
  return sha256(canonicalize(params));
}
