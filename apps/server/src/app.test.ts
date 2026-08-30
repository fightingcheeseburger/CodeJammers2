import { afterEach, describe, expect, it } from "vitest";
import { bearer, makeHarness, type Harness } from "./test-harness.js";

const open: Harness[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((harness) => harness.close()));
});
async function harness(): Promise<Harness> {
  const created = await makeHarness();
  open.push(created);
  return created;
}

describe("HTTP boundary", () => {
  it("rejects unauthenticated control-plane calls and accepts a session", async () => {
    const { app, tokens } = await harness();
    expect((await app.inject({ method: "GET", url: "/api/agents" })).statusCode).toBe(401);
    const allowed = await app.inject({
      method: "GET",
      url: "/api/agents",
      headers: bearer(tokens.alice),
    });
    expect(allowed.statusCode).toBe(200);
  });

  it("issues a session only for correct credentials", async () => {
    const { app, config } = await harness();
    const bad = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: "alice", password: "not-the-password" },
    });
    expect(bad.statusCode).toBe(401);

    const good = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: "alice", password: config.seedPasswords.alice },
    });
    expect(good.statusCode).toBe(200);
    expect(good.json().user.username).toBe("alice");
    // The session bearer is returned once and is not a stored credential.
    expect(typeof good.json().token).toBe("string");
  });

  it("never stores a usable session credential on disk", async () => {
    const { app, store, config } = await harness();
    const response = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: "bob", password: config.seedPasswords.bob },
    });
    const token = response.json().token as string;
    const serialized = JSON.stringify(store.snapshot());
    const secret = token.slice(token.indexOf(".") + 1);
    expect(serialized).not.toContain(secret);
  });

  it("invalidates a session after logout", async () => {
    const { app, tokens } = await harness();
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/auth/logout",
          headers: bearer(tokens.alice),
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (await app.inject({ method: "GET", url: "/api/agents", headers: bearer(tokens.alice) }))
        .statusCode,
    ).toBe(401);
  });

  it("preserves Fastify client error status codes", async () => {
    const { app, tokens } = await harness();
    const malformed = await app.inject({
      method: "POST",
      url: "/api/agents",
      headers: { ...bearer(tokens.alice), "content-type": "application/json" },
      payload: "{not-json",
    });
    expect(malformed.statusCode).toBe(400);

    const oversized = await app.inject({
      method: "POST",
      url: "/api/agents",
      headers: { ...bearer(tokens.alice), "content-type": "application/json" },
      payload: JSON.stringify({ name: "x".repeat(1_100_000) }),
    });
    expect(oversized.statusCode).toBe(413);
  });
});

describe("Audience separation between the two planes", () => {
  it("refuses a human session token at the resource API", async () => {
    const { app, tokens } = await harness();
    const response = await app.inject({
      method: "GET",
      url: "/api/resources/documents",
      headers: bearer(tokens.alice),
    });
    expect(response.statusCode).toBe(401);
    expect(response.json().reason).toBe("malformed");
  });

  it("refuses an action token at the control plane", async () => {
    const { app, service, identity, actor, tokens } = await harness();
    const alice = actor("alice");
    const agent = await service.createAgent(alice, { name: "Two planes" });
    const { run } = await service.sendMessage(alice, agent.id, "hello");
    const grant = identity.activeGrantForAgent(agent.id, alice.userId);
    expect(grant).not.toBeNull();
    const minted = identity.mintForRun({
      agentId: agent.id,
      runId: run.id,
      subjectUserId: alice.userId,
      grant: grant!,
    });
    expect(minted).not.toBeNull();

    const response = await app.inject({
      method: "GET",
      url: "/api/agents",
      headers: bearer(minted!.token),
    });
    // The control plane resolves session tokens only, so an action token
    // is simply not a credential here.
    expect(response.statusCode).toBe(401);
    expect(tokens.alice).not.toBe(minted!.token);
  });
});
