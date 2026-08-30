import { afterEach, describe, expect, it } from "vitest";
import { bearer, HoldingRunner, makeHarness, type Harness } from "../test-harness.js";

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

async function writerAgent(h: Harness) {
  const alice = h.actor("alice");
  const agent = await h.service.createAgent(alice, { name: "Writer" });
  await h.identity.createGrant(alice, {
    agentId: agent.id,
    scopes: ["docs:read", "docs:write"],
  });
  const { run } = await h.service.sendMessage(alice, agent.id, "update the plan");
  const grant = h.identity.activeGrantForAgent(agent.id, alice.userId)!;
  const minted = h.identity.mintForRun({
    agentId: agent.id,
    runId: run.id,
    subjectUserId: alice.userId,
    grant,
  })!;
  await expect.poll(async () => (await h.service.getRun(alice, run.id)).status).toBe("running");
  return { alice, agent, run, token: minted.token };
}

const put = (h: Harness, token: string, id: string, body: string) =>
  h.app.inject({
    method: "PUT",
    url: "/api/resources/documents/" + id,
    headers: bearer(token),
    payload: { body },
  });

describe("Human approval gate for high-risk scopes", () => {
  it("parks a write until the owner decides, then lets it through once", async () => {
    const h = await harness();
    const { token } = await writerAgent(h);

    const parked = await put(h, token, "doc-a1", "approved content");
    expect(parked.statusCode).toBe(202);
    expect(parked.json().reason).toBe("approval_required");
    const approvalId = parked.json().approvalId as string;
    expect(h.store.snapshot().documents.find((d) => d.id === "doc-a1")?.body).not.toContain(
      "approved content",
    );

    // The Agent can poll, but only for its own Run's approval.
    const polled = await h.app.inject({
      method: "GET",
      url: "/api/resources/approvals/" + approvalId,
      headers: bearer(token),
    });
    expect(polled.json().approval.status).toBe("pending");

    const decided = await h.app.inject({
      method: "POST",
      url: "/api/approvals/" + approvalId,
      headers: bearer(h.tokens.alice),
      payload: { approved: true },
    });
    expect(decided.statusCode).toBe(200);

    const allowed = await put(h, token, "doc-a1", "approved content");
    expect(allowed.statusCode).toBe(200);
    expect(h.store.snapshot().documents.find((d) => d.id === "doc-a1")?.body).toBe(
      "approved content",
    );

    // The approval is single use: the same write cannot be replayed.
    const replay = await put(h, token, "doc-a1", "approved content");
    expect(replay.statusCode).toBe(202);
    expect(replay.json().approvalId).not.toBe(approvalId);
  });

  it("binds the approval to the exact parameters that were approved", async () => {
    const h = await harness();
    const { token } = await writerAgent(h);
    const parked = await put(h, token, "doc-a1", "the body Alice reviewed");
    const approvalId = parked.json().approvalId as string;
    await h.app.inject({
      method: "POST",
      url: "/api/approvals/" + approvalId,
      headers: bearer(h.tokens.alice),
      payload: { approved: true },
    });

    // Same document, different payload: a fresh approval is demanded
    // rather than the approved one being reused.
    const swapped = await put(h, token, "doc-a1", "something Alice never saw");
    expect(swapped.statusCode).toBe(202);
    expect(swapped.json().approvalId).not.toBe(approvalId);
    expect(h.store.snapshot().documents.find((d) => d.id === "doc-a1")?.body).not.toContain(
      "never saw",
    );
  });

  it("blocks the write when the owner refuses", async () => {
    const h = await harness();
    const { token } = await writerAgent(h);
    const parked = await put(h, token, "doc-a2", "unwanted edit");
    const approvalId = parked.json().approvalId as string;
    await h.app.inject({
      method: "POST",
      url: "/api/approvals/" + approvalId,
      headers: bearer(h.tokens.alice),
      payload: { approved: false },
    });

    const denied = await put(h, token, "doc-a2", "unwanted edit");
    expect(denied.statusCode).toBe(403);
    expect(denied.json().reason).toBe("approval_denied");
    expect(h.store.snapshot().documents.find((d) => d.id === "doc-a2")?.body).not.toContain(
      "unwanted edit",
    );
  });

  it("never asks another user to approve, and never lets them", async () => {
    const h = await harness();
    const { token } = await writerAgent(h);
    const parked = await put(h, token, "doc-a1", "content");
    const approvalId = parked.json().approvalId as string;

    expect(h.identity.listApprovals(h.actor("bob").userId)).toHaveLength(0);
    const attempt = await h.app.inject({
      method: "POST",
      url: "/api/approvals/" + approvalId,
      headers: bearer(h.tokens.bob),
      payload: { approved: true },
    });
    expect(attempt.statusCode).toBe(404);
  });

  it("still refuses an approved write against another user's document", async () => {
    const h = await harness();
    const { token } = await writerAgent(h);
    // doc-b1 belongs to Bob. Ownership is checked before the approval gate
    // is ever reached, so no approval is even created.
    const response = await put(h, token, "doc-b1", "cross-tenant write");
    expect(response.statusCode).toBe(404);
    expect(h.identity.listApprovals(h.actor("alice").userId)).toHaveLength(0);
    expect(h.store.snapshot().documents.find((d) => d.id === "doc-b1")?.body).toContain(
      "CONFIDENTIAL",
    );
  });
});
