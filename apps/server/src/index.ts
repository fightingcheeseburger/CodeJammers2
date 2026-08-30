import path from "node:path";
import { AgentService } from "./agent-service.js";
import { createApp } from "./app.js";
import { loadConfig, writeCodexConfig } from "./config.js";
import { IdentityService } from "./identity/identity-service.js";
import { seedIdentityFixtures } from "./identity/seed.js";
import { ResourceService } from "./resource-service.js";
import { createRunner } from "./runner-factory.js";
import { JsonStore } from "./store.js";
import { WorkspaceManager } from "./workspace.js";

const config = loadConfig();
await writeCodexConfig(config);

const store = new JsonStore(path.join(config.dataDirectory, "launchpad.json"));
const workspaces = new WorkspaceManager(config.workspaceRoot);
const runner = createRunner(config);
const identity = new IdentityService(config, store);
const service = new AgentService(config, store, workspaces, runner, identity);
const resources = new ResourceService(store, identity);

await service.initialize();
await seedIdentityFixtures(store, config);

const app = await createApp(config, service, identity, resources);

/**
 * Action Tokens are signed with a per-boot random secret unless
 * LAUNCHPAD_TOKEN_SECRET is pinned. A restart therefore invalidates every
 * outstanding credential, which is the safe default for a POC. Say so
 * once at startup rather than letting it surprise somebody mid-demo.
 */
if (!config.tokenSecretPinned) {
  app.log.info(
    "Action token signing key is ephemeral for this process. Set LAUNCHPAD_TOKEN_SECRET to survive restarts.",
  );
}

// Approvals do not expire on their own in a JSON store; sweep them.
const approvalSweep = setInterval(() => {
  void identity.expireStaleApprovals().catch(() => undefined);
}, 30_000);
approvalSweep.unref();

const shutdown = async (signal: string) => {
  app.log.info({ signal }, "Shutting down");
  clearInterval(approvalSweep);
  await app.close();
  process.exit(0);
};

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

await app.listen({ host: config.host, port: config.port });
