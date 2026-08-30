import { createHmac } from "node:crypto";
import { newId, safeEqual } from "./crypto.js";

/**
 * Action Token
 * ============
 *
 * A compact, HMAC-signed bearer credential minted once per Run and handed
 * to the Agent Runtime. Its shape follows RFC 8693 (OAuth 2.0 Token
 * Exchange) delegation semantics:
 *
 *   sub  - the HUMAN on whose behalf the action is taken
 *   act  - the ACTOR actually performing it (the Agent principal)
 *   aud  - the audience this token is bound to (RFC 8707 resource
 *          indicator style). A control-plane session token can never be
 *          replayed at the resource server and vice versa.
 *
 * Encoding is JWT-shaped (header.payload.signature, base64url) but the
 * implementation is deliberately dependency-free and only ever accepts
 * HS256 - "alg" is not read from the header, so alg-confusion and the
 * "alg":"none" downgrade are structurally impossible.
 */

export const CONTROL_PLANE_AUDIENCE = "launchpad-control-plane";
export const RESOURCE_API_AUDIENCE = "launchpad-resource-api";

export interface ActionTokenClaims {
  /** Token id, used for correlation and single-run binding. */
  jti: string;
  /** The delegating human. */
  sub: string;
  /** RFC 8693 actor claim: who is really making the call. */
  act: {
    sub: string;
    agent_id: string;
    generation: number;
  };
  aud: string;
  /** The delegation grant that authorized minting. */
  grant_id: string;
  /** The Run this token lives and dies with. */
  run_id: string;
  scope: string[];
  iat: number;
  nbf: number;
  exp: number;
}

export type VerifyFailure =
  | "malformed"
  | "bad_signature"
  | "wrong_audience"
  | "not_yet_valid"
  | "expired";

export type VerifyResult =
  | { ok: true; claims: ActionTokenClaims }
  | { ok: false; reason: VerifyFailure };

const HEADER = base64url(JSON.stringify({ alg: "HS256", typ: "LPAT" }));

function base64url(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function sign(secret: string, payload: string): string {
  return createHmac("sha256", secret)
    .update(HEADER + "." + payload)
    .digest("base64url");
}

export interface MintInput {
  subjectUserId: string;
  agentPrincipalId: string;
  agentId: string;
  generation: number;
  grantId: string;
  runId: string;
  scopes: string[];
  audience?: string;
  ttlSeconds: number;
  now?: Date;
}

export function mintActionToken(
  secret: string,
  input: MintInput,
): { token: string; claims: ActionTokenClaims } {
  const issuedAt = Math.floor((input.now?.getTime() ?? Date.now()) / 1000);
  const claims: ActionTokenClaims = {
    jti: newId(),
    sub: input.subjectUserId,
    act: {
      sub: input.agentPrincipalId,
      agent_id: input.agentId,
      generation: input.generation,
    },
    aud: input.audience ?? RESOURCE_API_AUDIENCE,
    grant_id: input.grantId,
    run_id: input.runId,
    // Sorted so the same scope set always serializes identically.
    scope: [...new Set(input.scopes)].sort(),
    iat: issuedAt,
    nbf: issuedAt,
    exp: issuedAt + input.ttlSeconds,
  };
  const payload = base64url(JSON.stringify(claims));
  return { token: HEADER + "." + payload + "." + sign(secret, payload), claims };
}

/**
 * Stateless verification only: signature, audience and validity window.
 * Everything stateful - is the grant still alive, is the principal still
 * this generation, is the Run still running, does the scope cover this
 * action, does the caller own the resource - is decided by the policy
 * engine against live state. A valid signature is necessary, never
 * sufficient.
 */
export function verifyActionToken(
  secret: string,
  token: string,
  expectedAudience: string,
  now: Date = new Date(),
): VerifyResult {
  const parts = token.split(".");
  if (parts.length !== 3) return { ok: false, reason: "malformed" };
  const [header, payload, signature] = parts as [string, string, string];
  if (header !== HEADER) return { ok: false, reason: "malformed" };
  if (!safeEqual(signature, sign(secret, payload))) {
    return { ok: false, reason: "bad_signature" };
  }

  let claims: ActionTokenClaims;
  try {
    claims = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8"),
    ) as ActionTokenClaims;
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (
    typeof claims?.sub !== "string" ||
    typeof claims?.jti !== "string" ||
    typeof claims?.grant_id !== "string" ||
    typeof claims?.run_id !== "string" ||
    typeof claims?.act?.sub !== "string" ||
    typeof claims?.act?.generation !== "number" ||
    !Array.isArray(claims?.scope) ||
    typeof claims?.exp !== "number" ||
    typeof claims?.nbf !== "number"
  ) {
    return { ok: false, reason: "malformed" };
  }

  if (claims.aud !== expectedAudience) {
    return { ok: false, reason: "wrong_audience" };
  }
  const seconds = Math.floor(now.getTime() / 1000);
  // 30s of leeway for clock skew between the app and the Runtime container.
  if (seconds + 30 < claims.nbf) return { ok: false, reason: "not_yet_valid" };
  if (seconds > claims.exp) return { ok: false, reason: "expired" };

  return { ok: true, claims };
}
