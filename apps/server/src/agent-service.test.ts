import { afterEach, describe, expect, it } from "vitest";
import { FakeRunner, makeHarness, type Harness } from "./test-harness.js";
import type { AgentRunner, RunnerResult } from "./types.js";

const open: Harness[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((harness) => harness.close()));
});

async function harnessWith(runner?: AgentRunner): Promise<Harness> {
  const harness = await makeHarness(runner ?? new FakeRunner());
  open.push(harness);
  return harness;
}

describe("Agent lifecycle", () => {
  it("creates, updates, stops, starts and deletes an Agent", async () => {
    const { service, actor } = await harnessWith();
    const alice = actor("alice");
    const agent = await service.createAgent(alice, { name: "Builder" });
    expect(service.listAgents(alice)).toHaveLength(1);
    expect(
      (await service.updateAgent(alice, agent.id, { description: "Builds apps" })).description,
    ).toBe("Builds apps");
    expect((await service.stopAgent(alice, agent.id)).status).toBe("stopped");
    expect((await service.startAgent(alice, agent.id)).status).toBe("ready");
    await service.deleteAgent(alice, agent.id);
    expect(service.listAgents(alice)).toHaveLength(0);
  });

  it("persists a playground conversation", async () => {
    const { service, actor } = await harnessWith();
    const alice = actor("alice");
    const agent = await service.createAgent(alice, { name: "Coder" });
    const { run } = await service.sendMessage(alice, agent.id, "write hello world");
    await expect.poll(async () => (await service.getRun(alice, run.id)).status).toBe("completed");
    const messages = await service.getMessages(alice, agent.id);
    expect(messages.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(messages[1]?.content).toContain("write hello world");
    expect((await service.getAgent(alice, agent.id)).codexThreadId).toBe("fake-thread");
  });

  it("atomically accepts only one concurrent run per Agent", async () => {
    let finish!: (result: RunnerResult) => void;
    const pending = new Promise<RunnerResult>((resolve) => {
      finish = resolve;
    });
    const { service, actor } = await harnessWith({
      run: () => pending,
      cancel: async () => false,
      isAvailable: async () => true,
    });
    const alice = actor("alice");
    const agent = await service.createAgent(alice, { name: "Concurrent" });
    const attempts = await Promise.allSettled([
      service.sendMessage(alice, agent.id, "first"),
      service.sendMessage(alice, agent.id, "second"),
    ]);

    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
    expect(attempts.find((attempt) => attempt.status === "rejected")).toMatchObject({
      reason: { statusCode: 409 },
    });
    expect(await service.getMessages(alice, agent.id)).toHaveLength(1);

    finish({ output: "done", threadId: "thread", usage: null });
    const accepted = attempts.find((attempt) => attempt.status === "fulfilled");
    if (accepted?.status === "fulfilled") {
      await expect
        .poll(async () => (await service.getRun(alice, accepted.value.run.id)).status)
        .toBe("completed");
    }
  });

  it("does not let start reset a busy Agent and admit a second run", async () => {
    let finish!: (result: RunnerResult) => void;
    const pending = new Promise<RunnerResult>((resolve) => {
      finish = resolve;
    });
    const { service, actor } = await harnessWith({
      run: () => pending,
      cancel: async () => false,
      isAvailable: async () => true,
    });
    const alice = actor("alice");
    const agent = await service.createAgent(alice, { name: "Busy" });
    const { run } = await service.sendMessage(alice, agent.id, "first");

    await expect(service.startAgent(alice, agent.id)).rejects.toMatchObject({ statusCode: 409 });
    await expect(service.sendMessage(alice, agent.id, "second")).rejects.toMatchObject({
      statusCode: 409,
    });

    finish({ output: "done", threadId: "thread", usage: null });
    await expect.poll(async () => (await service.getRun(alice, run.id)).status).toBe("completed");
  });
});
