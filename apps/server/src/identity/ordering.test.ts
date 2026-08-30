import { afterEach, describe, expect, it } from "vitest";
import { makeHarness, type Harness } from "../test-harness.js";

const open: Harness[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((item) => item.close()));
});
async function harness(): Promise<Harness> {
  const created = await makeHarness();
  open.push(created);
  return created;
}

/**
 * Regression test for a real bug: `createAgent` issues a default
 * `docs:read` grant, and an owner can issue a wider grant immediately
 * afterward - both can land in the same millisecond on fast hardware,
 * since `createdAt` has millisecond resolution.
 *
 * `activeGrantForAgent` and `findApproval` must resolve that tie by
 * insertion order (the store only ever appends), never by sorting on the
 * timestamp string - Array.sort is stable, and a comparator that treats
 * equal timestamps as equal leaves the OLDER, narrower record in front.
 * This test forces the collision directly rather than hoping the clock
 * cooperates, so it fails reliably if the tie-break regresses.
 */
describe("Tie-breaking when two records share a millisecond", () => {
  it("activeGrantForAgent prefers the later grant, not the sorted-equal one", async () => {
    const h = await harness();
    const alice = h.actor("alice");
    const agent = await h.service.createAgent(alice, { name: "Timing" });

    const before = h.identity.listGrantsForAgent(agent.id);
    expect(before).toHaveLength(1);
    expect(before[0]?.scopes).toEqual(["docs:read"]);
    const readOnlyGrant = before[0]!;

    // Force the collision: give the second grant the identical
    // createdAt the first one already has, exactly as fast hardware can.
    const wider = await h.identity.createGrant(alice, {
      agentId: agent.id,
      scopes: ["docs:read", "docs:write"],
    });
    await h.store.mutate((database) => {
      const grant = database.grants.find((item) => item.id === wider.id);
      if (grant) grant.createdAt = readOnlyGrant.createdAt;
    });
    expect(
      h.store.snapshot().grants.filter((g) => g.agentPrincipalId === wider.agentPrincipalId),
    ).toHaveLength(2);

    const active = h.identity.activeGrantForAgent(agent.id, alice.userId);
    expect(active?.id).toBe(wider.id);
    expect(active?.scopes).toContain("docs:write");
  });

  it("findApproval prefers the later approval among timestamp-tied candidates", async () => {
    const h = await harness();
    const alice = h.actor("alice");
    const agent = await h.service.createAgent(alice, { name: "Timing writer" });
    await h.identity.createGrant(alice, { agentId: agent.id, scopes: ["docs:read", "docs:write"] });
    const { run } = await h.service.sendMessage(alice, agent.id, "task");
    const grant = h.identity.activeGrantForAgent(agent.id, alice.userId)!;
    const minted = h.identity.mintForRun({
      agentId: agent.id,
      runId: run.id,
      subjectUserId: alice.userId,
      grant,
    })!;

    const params = { documentId: "doc-a1", body: "same shape" };
    const first = await h.identity.requestApproval({
      actor: {
        kind: "agent",
        subjectUserId: alice.userId,
        agentPrincipalId: grant.agentPrincipalId,
        agentId: agent.id,
        grantId: grant.id,
        scopes: minted.claims.scope,
        runId: run.id,
        tokenId: minted.claims.jti,
        tokenFingerprint: "sha256:test",
      },
      action: "document.write",
      resourceId: "doc-a1",
      params,
      preview: "first",
    });
    // Deny it, then create a second, identically-shaped approval request
    // with the same timestamp as the first - the collision this test
    // exists to force.
    await h.identity.decideApproval(alice, first.id, false);
    const second = await h.identity.requestApproval({
      actor: {
        kind: "agent",
        subjectUserId: alice.userId,
        agentPrincipalId: grant.agentPrincipalId,
        agentId: agent.id,
        grantId: grant.id,
        scopes: minted.claims.scope,
        runId: run.id,
        tokenId: minted.claims.jti,
        tokenFingerprint: "sha256:test",
      },
      action: "document.write",
      resourceId: "doc-a1",
      params,
      preview: "second",
    });
    await h.store.mutate((database) => {
      const approval = database.approvals.find((item) => item.id === second.id);
      if (approval) approval.createdAt = first.createdAt;
    });

    const resolved = h.identity.findApproval({
      runId: run.id,
      action: "document.write",
      resourceId: "doc-a1",
      paramsHash: first.paramsHash,
    });
    // The first request was denied; only the second is still answerable.
    // A tie-break that fell back to insertion order would return the
    // denied one and never find the live one.
    expect(resolved?.id).toBe(second.id);
    expect(resolved?.status).toBe("pending");
  });
});
