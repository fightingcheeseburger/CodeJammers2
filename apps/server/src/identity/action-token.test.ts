import { describe, expect, it } from "vitest";
import {
  mintActionToken,
  verifyActionToken,
  CONTROL_PLANE_AUDIENCE,
  RESOURCE_API_AUDIENCE,
} from "./action-token.js";

const SECRET = "unit-test-secret-value-0123456789";
const base = {
  subjectUserId: "user-alice",
  agentPrincipalId: "principal-1",
  agentId: "agent-1",
  generation: 1,
  grantId: "grant-1",
  runId: "run-1",
  scopes: ["docs:read"],
  ttlSeconds: 300,
};

describe("Action token", () => {
  it("round-trips and carries RFC 8693 delegation claims", () => {
    const { token, claims } = mintActionToken(SECRET, base);
    expect(claims.sub).toBe("user-alice");
    expect(claims.act.sub).toBe("principal-1");
    expect(claims.aud).toBe(RESOURCE_API_AUDIENCE);

    const verified = verifyActionToken(SECRET, token, RESOURCE_API_AUDIENCE);
    expect(verified.ok).toBe(true);
    if (verified.ok) {
      expect(verified.claims.sub).toBe("user-alice");
      expect(verified.claims.act.agent_id).toBe("agent-1");
      expect(verified.claims.run_id).toBe("run-1");
    }
  });

  it("rejects a token signed with a different key", () => {
    const { token } = mintActionToken("another-secret-value-0123456789", base);
    const verified = verifyActionToken(SECRET, token, RESOURCE_API_AUDIENCE);
    expect(verified).toMatchObject({ ok: false, reason: "bad_signature" });
  });

  it("rejects a tampered payload even when the shape is valid", () => {
    const { token } = mintActionToken(SECRET, base);
    const [header, payload, signature] = token.split(".") as [string, string, string];
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    // Escalate the scope set and try to reuse the original signature.
    claims.scope = ["docs:read", "docs:write", "docs:delete"];
    const forged =
      header + "." + Buffer.from(JSON.stringify(claims)).toString("base64url") + "." + signature;
    expect(verifyActionToken(SECRET, forged, RESOURCE_API_AUDIENCE)).toMatchObject({
      ok: false,
      reason: "bad_signature",
    });
  });

  it("cannot be downgraded to an unsigned token", () => {
    const { token } = mintActionToken(SECRET, base);
    const payload = token.split(".")[1] as string;
    const noneHeader = Buffer.from(JSON.stringify({ alg: "none", typ: "LPAT" })).toString(
      "base64url",
    );
    expect(
      verifyActionToken(SECRET, noneHeader + "." + payload + ".", RESOURCE_API_AUDIENCE),
    ).toMatchObject({ ok: false, reason: "malformed" });
  });

  it("is bound to one audience", () => {
    const { token } = mintActionToken(SECRET, base);
    expect(verifyActionToken(SECRET, token, CONTROL_PLANE_AUDIENCE)).toMatchObject({
      ok: false,
      reason: "wrong_audience",
    });
  });

  it("expires", () => {
    const { token } = mintActionToken(SECRET, { ...base, ttlSeconds: 30 });
    const later = new Date(Date.now() + 31_000);
    expect(verifyActionToken(SECRET, token, RESOURCE_API_AUDIENCE, later)).toMatchObject({
      ok: false,
      reason: "expired",
    });
  });

  it("rejects structurally broken input without throwing", () => {
    for (const candidate of ["", "a.b", "...", "not-a-token", "a.b.c.d"]) {
      expect(verifyActionToken(SECRET, candidate, RESOURCE_API_AUDIENCE).ok).toBe(false);
    }
  });
});
