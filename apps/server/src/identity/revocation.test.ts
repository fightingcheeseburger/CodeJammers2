import { afterEach, describe, expect, it } from "vitest";
import { bearer, HoldingRunner, makeHarness, type Harness } from "../test-harness.js";
import type { HumanActor } from "../types.js";

const open: Harness[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((item) => item.close()));
});
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

async function liveToken(
  h: Harness,
  owner: HumanActor,
  scopes: string[] = ["docs:read"],
): Promise<{ token: string; agentId: string; runId: string; grantId: string }> {
  const agent = await h.service.createAgent(owner, { name: "Revocable" });
  if (scopes.join() !== "docs:read") {
    await h.identity.createGrant(owner, { agentId: agent.id, scopes });
  }
  const { run } = await h.service.sendMessage(owner, agent.id, "task");
  const grant = h.identity.activeGrantForAgent(agent.id, owner.userId)!;
  const minted = h.identity.mintForRun({
    agentId: agent.id,
    runId: run.id,
    subjectUserId: owner.userId,
    grant,
  })!;
  await expect.poll(async () => (await h.service.getRun(owner, run.id)).status).toBe("running");
  return { token: minted.token, agentId: agent.id, runId: run.id, grantId: grant.id };
}

const read = (h: Harness, token: string, id = "doc-a1") =>
  h.app.inject({
    method: "GET",
    url: "/api/resources/documents/" + id,
    headers: bearer(token),
  });

describe("Revocation is enforced at use time, not only at issuance", () => {
  it("stops a still-valid, still-unexpired token the moment the grant is revoked", async () => {
    const h = await harness();
    const alice = h.actor("alice");
    const { token, grantId } = await liveToken(h, alice);

    expect((await read(h, token)).statusCode).toBe(200);

    await h.identity.revokeGrant(alice, grantId, "demo revocation");

    const denied = await read(h, token);
    expect(denied.statusCode).toBe(403);
    expect(denied.json().reason).toBe("grant_revoked");
  });

  it("invalidates every outstanding grant when the Agent principal is rotated", async () => {
    const h = await harness();
    const alice = h.actor("alice");
    const { token, agentId } = await liveToken(h, alice);
    expect((await read(h, token)).statusCode).toBe(200);

    await h.identity.rotatePrincipal(agentId);

    const denied = await read(h, token);
    expect(denied.statusCode).toBe(403);
    expect(denied.json().reason).toBe("principal_rotated");
  });

  it("kills the credential when the Agent principal is revoked", async () => {
    const h = await harness();
    const { token, agentId } = await liveToken(h, h.actor("alice"));
    await h.identity.revokePrincipal(agentId);
    expect((await read(h, token)).json().reason).toBe("principal_revoked");
  });

  it("kills the credential when the owner stops the Agent", async () => {
    const h = await harness();
    const alice = h.actor("alice");
    const { token, agentId } = await liveToken(h, alice);
    await h.store.mutate((database) => {
      const agent = database.agents.find((item) => item.id === agentId);
      if (agent) agent.status = "stopped";
    });
    expect((await read(h, token)).json().reason).toBe("agent_stopped");
  });

  it("kills the credential when the Run it was minted for ends", async () => {
    const h = await harness();
    const { token, runId } = await liveToken(h, h.actor("alice"));
    expect((await read(h, token)).statusCode).toBe(200);
    await h.store.mutate((database) => {
      const run = database.runs.find((item) => item.id === runId);
      if (run) run.status = "completed";
    });
    const denied = await read(h, token);
    expect(denied.json().reason).toBe("run_not_active");
  });

  it("neuters every Agent acting for a human the moment that human is disabled", async () => {
    const h = await harness();
    const alice = h.actor("alice");
    const { token } = await liveToken(h, alice);
    await h.store.mutate((database) => {
      const user = database.users.find((item) => item.id === alice.userId);
      if (user) user.disabledAt = new Date().toISOString();
    });
    expect((await read(h, token)).json().reason).toBe("subject_disabled");
  });

  it("narrows the Agent in step with its delegator when a scope is withdrawn", async () => {
    const h = await harness();
    const alice = h.actor("alice");
    const { token } = await liveToken(h, alice, ["docs:read", "docs:write"]);
    expect((await read(h, token)).statusCode).toBe(200);
    await h.store.mutate((database) => {
      const user = database.users.find((item) => item.id === alice.userId);
      if (user) user.scopes = user.scopes.filter((scope) => scope !== "docs:read");
    });
    expect((await read(h, token)).json().reason).toBe("scope_exceeds_delegator");
  });
});
