import { afterEach, describe, expect, it } from "vitest";
import { bearer, HoldingRunner, makeHarness, type Harness } from "../test-harness.js";
import type { AgentRun, HumanActor } from "../types.js";

const open: Harness[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((item) => item.close()));
});

/** Holds every Run open so action tokens stay live for the assertions. */
let holder: HoldingRunner;
async function harness(): Promise<Harness> {
  holder = new HoldingRunner();
  const created = await makeHarness(holder);
  open.push({ ...created, close: async () => {
    holder.finish();
    await created.close();
  } });
  return created;
}

/**
 * Put an Agent into a state where it holds a live action token: create it,
 * widen its grant if asked, start a Run, and mint the credential the
 * Runtime would have carried.
 */
async function delegatedAgent(
  h: Harness,
  owner: HumanActor,
  scopes: string[] = ["docs:read"],
): Promise<{ agentId: string; token: string; run: AgentRun; grantId: string }> {
  const agent = await h.service.createAgent(owner, { name: "Delegate " + scopes.join("+") });
  if (scopes.join() !== "docs:read") {
    await h.identity.createGrant(owner, { agentId: agent.id, scopes });
  }
  const { run } = await h.service.sendMessage(owner, agent.id, "do the task");
  const grant = h.identity.activeGrantForAgent(agent.id, owner.userId);
  if (!grant) throw new Error("expected an active grant");
  const minted = h.identity.mintForRun({
    agentId: agent.id,
    runId: run.id,
    subjectUserId: owner.userId,
    grant,
  });
  if (!minted) throw new Error("expected a minted token");
  // The HoldingRunner keeps the Run in "running" for the whole test, which
  // is exactly the window in which the credential is meant to work.
  await expect.poll(async () => (await h.service.getRun(owner, run.id)).status).toBe("running");
  return { agentId: agent.id, token: minted.token, run, grantId: grant.id };
}

describe("Ownership isolation between User A and User B", () => {
  it("hides another user's Agents from the list", async () => {
    const h = await harness();
    await h.service.createAgent(h.actor("alice"), { name: "Alice Agent" });
    expect(h.service.listAgents(h.actor("bob"))).toHaveLength(0);
    expect(h.service.listAgents(h.actor("alice"))).toHaveLength(1);
  });

  it("refuses control-plane access to another user's Agent without confirming it exists", async () => {
    const h = await harness();
    const agent = await h.service.createAgent(h.actor("alice"), { name: "Alice Agent" });
    for (const [method, url] of [
      ["GET", "/api/agents/" + agent.id],
      ["POST", "/api/agents/" + agent.id + "/stop"],
      ["GET", "/api/agents/" + agent.id + "/messages"],
      ["DELETE", "/api/agents/" + agent.id],
    ] as const) {
      const response = await h.app.inject({ method, url, headers: bearer(h.tokens.bob) });
      expect(response.statusCode, method + " " + url).toBe(404);
    }
    // The audit log keeps the real reason even though the API said 404.
    const reasons = h.identity.audit.list({ userId: h.actor("bob").userId }).map((e) => e.reason);
    expect(reasons).toContain("not_owner");
  });

  it("refuses to let another user drive an Agent they do not own", async () => {
    const h = await harness();
    const agent = await h.service.createAgent(h.actor("alice"), { name: "Alice Agent" });
    await expect(h.service.sendMessage(h.actor("bob"), agent.id, "hi")).rejects.toMatchObject({
      statusCode: 404,
    });
  });
});

describe("The delegated Agent reaches its owner's data and nothing else", () => {
  it("allows a read of the owner's document", async () => {
    const h = await harness();
    const { token } = await delegatedAgent(h, h.actor("alice"));
    const response = await h.app.inject({
      method: "GET",
      url: "/api/resources/documents/doc-a1",
      headers: bearer(token),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().document.ownerId).toBe("user-alice");
  });

  it("denies a read of another user's document in the backend", async () => {
    const h = await harness();
    const { token, run } = await delegatedAgent(h, h.actor("alice"));
    const response = await h.app.inject({
      method: "GET",
      url: "/api/resources/documents/doc-b1",
      headers: bearer(token),
    });
    expect(response.statusCode).toBe(404);
    // Bob's confidential body never reaches the Agent.
    expect(response.body).not.toContain("compensation");

    const event = h.identity.audit
      .list({ runId: run.id })
      .find((item) => item.action === "document.read" && item.resourceId === "doc-b1");
    expect(event).toBeDefined();
    expect(event?.decision).toBe("deny");
    expect(event?.reason).toBe("cross_user_denied");
    expect(event?.actorUserId).toBe("user-alice");
    expect(event?.agentPrincipalId).toBeTruthy();
  });

  it("does not disclose other users' documents in a listing", async () => {
    const h = await harness();
    const { token } = await delegatedAgent(h, h.actor("alice"));
    const response = await h.app.inject({
      method: "GET",
      url: "/api/resources/documents",
      headers: bearer(token),
    });
    expect(response.statusCode).toBe(200);
    const ids = response.json().documents.map((d: { id: string }) => d.id);
    expect(ids).toEqual(["doc-a1", "doc-a2"]);
  });
});

describe("Scope is enforced separately from ownership", () => {
  it("denies a write when only docs:read was delegated", async () => {
    const h = await harness();
    const { token } = await delegatedAgent(h, h.actor("alice"), ["docs:read"]);
    const response = await h.app.inject({
      method: "PUT",
      url: "/api/resources/documents/doc-a1",
      headers: bearer(token),
      payload: { body: "rewritten by the agent" },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().reason).toBe("scope_not_in_token");

    const document = h.store.snapshot().documents.find((d) => d.id === "doc-a1");
    expect(document?.body).not.toContain("rewritten");
  });

  it("refuses to delegate a control-plane scope at all", async () => {
    const h = await harness();
    const alice = h.actor("alice");
    const agent = await h.service.createAgent(alice, { name: "Escalator" });
    const response = await h.app.inject({
      method: "POST",
      url: "/api/grants",
      headers: bearer(h.tokens.alice),
      payload: { agentId: agent.id, scopes: ["agents:write"] },
    });
    // Rejected by the route schema before it ever reaches the service, and
    // by the service if the schema is ever loosened.
    expect(response.statusCode).toBe(400);
    await expect(
      h.identity.createGrant(alice, { agentId: agent.id, scopes: ["agents:write"] }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("refuses to delegate a scope the human does not hold", async () => {
    const h = await harness();
    const alice = h.actor("alice");
    const agent = await h.service.createAgent(alice, { name: "Over-reach" });
    await h.store.mutate((database) => {
      const user = database.users.find((item) => item.id === alice.userId);
      if (user) user.scopes = user.scopes.filter((scope) => scope !== "docs:write");
    });
    await expect(
      h.identity.createGrant(alice, { agentId: agent.id, scopes: ["docs:write"] }),
    ).rejects.toMatchObject({ statusCode: 403 });
  });
});
