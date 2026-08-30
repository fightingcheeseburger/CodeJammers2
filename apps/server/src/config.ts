import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

const envSchema = z.object({
  HOST: z.string().default("0.0.0.0"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  LOG_LEVEL: z.string().default("info"),
  APP_DATA_DIR: z.string().default(path.resolve(".data")),
  AGENT_WORKSPACE_ROOT: z.string().default(path.resolve("workspaces")),
  CODEX_HOME: z.string().default(path.resolve("codex-home")),
  CODEX_BIN: z.string().default("codex"),
  CODEX_SANDBOX_MODE: z
    .enum(["read-only", "workspace-write", "danger-full-access"])
    .default("workspace-write"),
  CODEX_TIMEOUT_MS: z.coerce.number().int().min(1_000).default(600_000),
  CODEX_MAX_OUTPUT_BYTES: z.coerce.number().int().min(65_536).default(2_097_152),
  RUNTIME_PROVIDER: z.enum(["local-process", "container"]).default("local-process"),
  CONTAINER_ENGINE: z.string().min(1).default("docker"),
  CONTAINER_RUNTIME_IMAGE: z.string().min(1).default("volc-agent-runtime:local"),
  CONTAINER_CPU_LIMIT: z.coerce.number().positive().default(2),
  CONTAINER_MEMORY_LIMIT: z
    .string()
    .regex(/^\d+(?:\.\d+)?[bkmg]$/i)
    .default("2g"),
  CONTAINER_PIDS_LIMIT: z.coerce.number().int().positive().default(256),
  CONTAINER_USER: z.string().optional(),
  RUNTIME_INSTANCE_ID: z
    .string()
    .trim()
    .min(1)
    .max(48)
    .regex(/^[a-zA-Z0-9_.-]+$/)
    .default("default"),
  APP_AUTH_TOKEN: z
    .string()
    .trim()
    .max(128)
    .regex(/^[A-Za-z0-9._~-]*$/, "APP_AUTH_TOKEN must use URL-safe characters")
    .optional(),
  ARK_API_KEY: z.string().optional(),
  ARK_MODEL: z.string().optional(),
  ARK_BASE_URL: z
    .string()
    .url()
    .default("https://ark.cn-beijing.volces.com/api/v3"),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),

  /* ---- Identity & authorization middleware ---------------------- */
  /** Signing key for Action Tokens. Random per boot unless pinned. */
  LAUNCHPAD_TOKEN_SECRET: z.string().min(16).optional(),
  /** Human session lifetime. */
  LAUNCHPAD_SESSION_TTL_MINUTES: z.coerce.number().int().min(1).max(1440).default(720),
  /** Action Token lifetime. Deliberately minutes, not hours. */
  LAUNCHPAD_ACTION_TOKEN_TTL_SECONDS: z.coerce.number().int().min(30).max(3600).default(300),
  LAUNCHPAD_GRANT_TTL_MINUTES: z.coerce.number().int().min(1).max(10080).default(60),
  LAUNCHPAD_GRANT_MAX_TTL_MINUTES: z.coerce.number().int().min(1).max(10080).default(1440),
  LAUNCHPAD_APPROVAL_TTL_SECONDS: z.coerce.number().int().min(30).max(3600).default(600),
  /** Seed passwords for the demo users. Never used in production. */
  LAUNCHPAD_SEED_PASSWORD_ALICE: z.string().min(6).default("alice-demo-password"),
  LAUNCHPAD_SEED_PASSWORD_BOB: z.string().min(6).default("bob-demo-password"),
  LAUNCHPAD_SEED_PASSWORD_ADMIN: z.string().min(6).default("admin-demo-password"),
  /**
   * Host the Agent Runtime uses to reach the resource API. Containers
   * cannot use 127.0.0.1, so the default is the Docker/Podman gateway
   * alias that this project also adds with --add-host.
   */
  LAUNCHPAD_RUNTIME_API_HOST: z.string().min(1).default("host.docker.internal"),
  /** Local-demo escape hatch for the default-password bind guard. */
  LAUNCHPAD_ALLOW_DEFAULT_PASSWORDS: z
    .string()
    .transform((value) => value === "true" || value === "1")
    .optional(),
});

export type AppConfig = ReturnType<typeof loadConfig>;

export function loadConfig(environment: NodeJS.ProcessEnv = process.env) {
  const env = envSchema.parse(environment);
  const authToken = env.APP_AUTH_TOKEN?.trim() ?? "";
  const loopbackHosts = new Set(["127.0.0.1", "::1", "localhost"]);

  /**
   * The Starter Kit refused a non-loopback bind unless APP_AUTH_TOKEN was
   * long enough. That token no longer authenticates anything, so the check
   * was guarding a door that had been removed. It is replaced with the
   * live equivalent: do not expose the platform beyond loopback while the
   * seeded demo accounts still have their published passwords.
   */
  const usingDefaultPasswords =
    env.LAUNCHPAD_SEED_PASSWORD_ALICE === "alice-demo-password" ||
    env.LAUNCHPAD_SEED_PASSWORD_BOB === "bob-demo-password" ||
    env.LAUNCHPAD_SEED_PASSWORD_ADMIN === "admin-demo-password";

  if (
    env.NODE_ENV === "production" &&
    !loopbackHosts.has(env.HOST) &&
    usingDefaultPasswords &&
    !env.LAUNCHPAD_ALLOW_DEFAULT_PASSWORDS
  ) {
    throw new Error(
      "Refusing to listen on " +
        env.HOST +
        " while the demo accounts still use their default passwords. Set " +
        "LAUNCHPAD_SEED_PASSWORD_ALICE, _BOB and _ADMIN, or set " +
        "LAUNCHPAD_ALLOW_DEFAULT_PASSWORDS=true if this is a local demo on a " +
        "trusted network.",
    );
  }
  const defaultContainerUser =
    typeof process.getuid === "function" && typeof process.getgid === "function"
      ? process.getuid() + ":" + process.getgid()
      : "1000:1000";
  return {
    host: env.HOST,
    port: env.PORT,
    logLevel: env.LOG_LEVEL,
    dataDirectory: path.resolve(env.APP_DATA_DIR),
    workspaceRoot: path.resolve(env.AGENT_WORKSPACE_ROOT),
    codexHome: path.resolve(env.CODEX_HOME),
    codexBin: env.CODEX_BIN,
    codexSandboxMode: env.CODEX_SANDBOX_MODE,
    codexTimeoutMs: env.CODEX_TIMEOUT_MS,
    codexMaxOutputBytes: env.CODEX_MAX_OUTPUT_BYTES,
    runtimeProvider: env.RUNTIME_PROVIDER,
    containerEngine: env.CONTAINER_ENGINE,
    containerRuntimeImage: env.CONTAINER_RUNTIME_IMAGE,
    containerCpuLimit: env.CONTAINER_CPU_LIMIT,
    containerMemoryLimit: env.CONTAINER_MEMORY_LIMIT,
    containerPidsLimit: env.CONTAINER_PIDS_LIMIT,
    containerUser: env.CONTAINER_USER?.trim() || defaultContainerUser,
    runtimeInstanceId: env.RUNTIME_INSTANCE_ID,
    authToken,
    arkApiKey: env.ARK_API_KEY?.trim() ?? "",
    arkModel: env.ARK_MODEL?.trim() ?? "",
    arkBaseUrl: env.ARK_BASE_URL.replace(/\/+$/, ""),
    nodeEnv: env.NODE_ENV,
    /* Identity & authorization middleware */
    tokenSecret: env.LAUNCHPAD_TOKEN_SECRET ?? randomBytes(32).toString("base64url"),
    tokenSecretPinned: env.LAUNCHPAD_TOKEN_SECRET !== undefined,
    sessionTtlMs: env.LAUNCHPAD_SESSION_TTL_MINUTES * 60_000,
    actionTokenTtlSeconds: env.LAUNCHPAD_ACTION_TOKEN_TTL_SECONDS,
    grantDefaultTtlMinutes: env.LAUNCHPAD_GRANT_TTL_MINUTES,
    grantMaxTtlMinutes: env.LAUNCHPAD_GRANT_MAX_TTL_MINUTES,
    approvalTtlSeconds: env.LAUNCHPAD_APPROVAL_TTL_SECONDS,
    seedPasswords: {
      alice: env.LAUNCHPAD_SEED_PASSWORD_ALICE,
      bob: env.LAUNCHPAD_SEED_PASSWORD_BOB,
      admin: env.LAUNCHPAD_SEED_PASSWORD_ADMIN,
    },
    runtimeApiHost: env.LAUNCHPAD_RUNTIME_API_HOST,
    /**
     * True when Runs happen in a container but the platform listens on
     * loopback only. On Docker Desktop the host proxy usually bridges this
     * anyway; on Colima, Podman and Linux it does not, and the Agent's
     * calls to the resource API fail with ECONNREFUSED. Surfaced at
     * startup and in /api/system rather than left to be discovered on
     * stage.
     */
    runtimeMayNotReachHost:
      env.RUNTIME_PROVIDER === "container" && loopbackHosts.has(env.HOST),
    usingDefaultPasswords,
  };
}

export function isArkConfigured(config: AppConfig): boolean {
  return (
    config.arkApiKey.length > 0 &&
    !config.arkApiKey.startsWith("replace-") &&
    config.arkModel.length > 0 &&
    !config.arkModel.includes("replace-")
  );
}

export async function writeCodexConfig(config: AppConfig): Promise<void> {
  await mkdir(config.codexHome, { recursive: true });
  const toml = [
    "# Generated by Volc Agent Launchpad. Edit environment variables, not this file.",
    "model = " + JSON.stringify(config.arkModel || "ep-not-configured"),
    'model_provider = "volcengine_ark"',
    "",
    "[model_providers.volcengine_ark]",
    'name = "Volcengine Ark"',
    "base_url = " + JSON.stringify(config.arkBaseUrl),
    'env_key = "ARK_API_KEY"',
    'wire_api = "responses"',
    "requires_openai_auth = false",
    "",
    "# The Agent Runtime needs network egress to reach the identity-enforced",
    "# resource API. Egress is safe to enable only because every call now",
    "# carries a scoped, short-lived, revocable Action Token that the resource",
    "# server verifies against live delegation state on every request.",
    "[sandbox_workspace_write]",
    "network_access = true",
    "",
  ].join("\n");
  await writeFile(path.join(config.codexHome, "config.toml"), toml, {
    encoding: "utf8",
    mode: 0o600,
  });
}
