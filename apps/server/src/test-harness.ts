import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { AgentService } from "./agent-service.js";
import { createApp } from "./app.js";
import { loadConfig, type AppConfig } from "./config.js";
import { IdentityService } from "./identity/identity-service.js";
import { seedIdentityFixtures } from "./identity/seed.js";
import { ResourceService } from "./resource-service.js";
import { JsonStore } from "./store.js";
import type { AgentRunner, HumanActor, RunnerRequest, RunnerResult } from "./types.js";
import { WorkspaceManager } from "./workspace.js";

/**
 * A complete platform in a temporary directory: real store, real identity
 * plane, real routes, fake model Runtime. Tests exercise the same code
 * path a browser does, so a check that passes here is a check that runs in
 * production.
 */
export interface Harness {
  app: FastifyInstance;
  service: AgentService;
  identity: IdentityService;
  resources: ResourceService;
  store: JsonStore;
  config: AppConfig;
  /** Session bearer values for the seeded users. */
  tokens: { alice: string; bob: string; admin: string };
  actor(username: "alice" | "bob" | "admin"): HumanActor;
  close(): Promise<void>;
}

/**
 * A Runtime that never finishes until told to. Tests that need a LIVE
 * action token use this, because a credential is only valid while its Run
 * is active - which is the point of binding it to the Run in the first
 * place.
 */
export class HoldingRunner implements AgentRunner {
  public lastRequest: RunnerRequest | null = null;
  private release!: (result: RunnerResult) => void;
  private readonly pending = new Promise<RunnerResult>((resolve) => {
    this.release = resolve;
  });

  async run(request: RunnerRequest): Promise<RunnerResult> {
    this.lastRequest = request;
    return this.pending;
  }
  finish(): void {
    this.release({ output: "done", threadId: "fake-thread", usage: null });
  }
  async cancel(): Promise<boolean> {
    return false;
  }
  async isAvailable(): Promise<boolean> {
    return true;
  }
}

export class FakeRunner implements AgentRunner {
  public lastRequest: RunnerRequest | null = null;
  constructor(private readonly onRun?: (request: RunnerRequest) => Promise<void> | void) {}

  async run(request: RunnerRequest): Promise<RunnerResult> {
    this.lastRequest = request;
    await this.onRun?.(request);
    return {
      output: "Completed: " + request.prompt,
      threadId: request.threadId ?? "fake-thread",
      usage: { inputTokens: 12, outputTokens: 5 },
    };
  }
  async cancel(): Promise<boolean> {
    return false;
  }
  async isAvailable(): Promise<boolean> {
    return true;
  }
}

export async function makeHarness(
  runner: AgentRunner = new FakeRunner(),
  overrides: Record<string, string> = {},
): Promise<Harness> {
  const root = await mkdtemp(path.join(tmpdir(), "launchpad-identity-test-"));
  const config = loadConfig({
    NODE_ENV: "test",
    APP_DATA_DIR: path.join(root, "data"),
    AGENT_WORKSPACE_ROOT: path.join(root, "workspaces"),
    CODEX_HOME: path.join(root, "codex"),
    ARK_API_KEY: "test-key",
    ARK_MODEL: "ep-test",
    // Pinned so tests can forge and tamper deterministically.
    LAUNCHPAD_TOKEN_SECRET: "test-token-secret-value-0123456789",
    ...overrides,
  });
  const store = new JsonStore(path.join(root, "data", "db.json"));
  const workspaces = new WorkspaceManager(path.join(root, "workspaces"));
  const identity = new IdentityService(config, store);
  const service = new AgentService(config, store, workspaces, runner, identity);
  const resources = new ResourceService(store, identity);
  await service.initialize();
  await seedIdentityFixtures(store, config);
  const app = await createApp(config, service, identity, resources);

  const login = async (username: string, password: string): Promise<string> => {
    const { token } = await identity.login(username, password);
    return token;
  };
  const tokens = {
    alice: await login("alice", config.seedPasswords.alice),
    bob: await login("bob", config.seedPasswords.bob),
    admin: await login("admin", config.seedPasswords.admin),
  };

  const actor = (username: "alice" | "bob" | "admin"): HumanActor => {
    const resolved = identity.resolveHumanActor(tokens[username]);
    if (!resolved) throw new Error("Failed to resolve seeded actor " + username);
    return resolved;
  };

  return {
    app,
    service,
    identity,
    resources,
    store,
    config,
    tokens,
    actor,
    async close() {
      await app.close();
      // A Run may still be flushing to the JSON store as the test ends.
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    },
  };
}

export const bearer = (token: string): Record<string, string> => ({
  authorization: "Bearer " + token,
});
