import { describe, expect, it } from "vitest";
import { redact, redactDeep, redactPreview } from "./redact.js";
import { mintActionToken } from "./action-token.js";
import { fingerprint } from "./crypto.js";

describe("Redaction", () => {
  it("removes a real action token from free text", () => {
    const { token } = mintActionToken("redaction-test-secret-0123456789", {
      subjectUserId: "user-alice",
      agentPrincipalId: "principal-1",
      agentId: "agent-1",
      generation: 1,
      grantId: "grant-1",
      runId: "run-1",
      scopes: ["docs:read"],
      ttlSeconds: 60,
    });
    const leaked = "the agent printed LAUNCHPAD_ACTION_TOKEN=" + token + " into its answer";
    const cleaned = redact(leaked);
    expect(cleaned).not.toContain(token);
    expect(cleaned).toContain("redacted");
  });

  it("removes Ark-style keys and bearer headers", () => {
    expect(redact("ARK_API_KEY=sk-abcdef0123456789xyz")).not.toContain("abcdef0123456789");
    expect(redact("Authorization: Bearer abcdefghijklmnop")).not.toContain("abcdefghijklmnop");
  });

  it("redacts secret-looking object keys whatever their value", () => {
    const cleaned = redactDeep({ nested: { apiKey: "short", note: "keep me" } }) as {
      nested: { apiKey: string; note: string };
    };
    expect(cleaned.nested.apiKey).toBe("[redacted]");
    expect(cleaned.nested.note).toBe("keep me");
  });

  it("clamps previews", () => {
    const prose = "the agent rewrote the launch plan section by section. ".repeat(20);
    expect(redactPreview(prose, 50)).toHaveLength(50);
  });

  it("treats a long opaque blob as a secret even without a label", () => {
    const blob = "Zm9vYmFy".repeat(8);
    expect(redact("value " + blob)).not.toContain(blob);
  });

  it("produces a fingerprint that is not reversible to the credential", () => {
    const print = fingerprint("a-very-secret-value");
    expect(print).toMatch(/^sha256:[0-9a-f]{12}$/);
    expect(print).not.toContain("secret");
  });
});
