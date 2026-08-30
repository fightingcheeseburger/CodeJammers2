import { randomUUID } from "node:crypto";
import type { AppConfig } from "./config.js";
import { isArkConfigured } from "./config.js";
import { HttpError, RunCancelledError } from "./errors.js";
import type { IdentityService } from "./identity/identity-service.js";
import { JsonStore } from "./store.js";
import type {
  Agent,
  AgentRun,
  AgentRunner,
  CreateAgentInput,
  HumanActor,
  Message,
  UpdateAgentInput,
} from "./types.js";
import { WorkspaceManager } from "./workspace.js";

const now = () => new Date().toISOString();

/**
 * AgentService with an owner on every call.
 *
 * Every public method now takes the human actor performing it. There is no
 * "just fetch the agent" path any more: `getAgent` is the authorized read
 * and `requireAgent` is the only way to reach an Agent record, so a new
 * route cannot accidentally skip the check.
 */
export class AgentService {
  private readonly activeExecutions = new Map<string, Promise<void>>();
  private readonly cancellationRequests = new Set<string>();

  constructor(
    private readonly config: AppConfig,
    private readonly store: JsonStore,
    private readonly workspaces: WorkspaceManager,
    private readonly runner: AgentRunner,
    private readonly identity: IdentityService,
  ) {}

  async initialize(): Promise<void> {
    await this.store.initialize();
    await this.workspaces.initialize();
    await this.store.mutate((database) => {
      for (const run of database.runs) {
        if (run.status === "queued" || run.status === "running") {
          run.status = "cancelled";
          run.error = "Server restarted while this run was active";
          run.completedAt = now();
        }
      }
      for (const agent of database.agents) {
        if (agent.status === "busy") {
          agent.status = "ready";
          agent.updatedAt = now();
        }
      }
      // Any approval still pending across a restart is dead: the Run that
      // would have consumed it is gone.
      for (const approval of database.approvals) {
        if (approval.status === "pending") approval.status = "expired";
      }
    });
  }

  /** Only ever returns Agents the actor owns. */
  listAgents(actor: HumanActor): Agent[] {
    return this.store
      .snapshot()
      .agents.filter((agent) => agent.ownerId === actor.userId)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  private rawAgent(id: string): Agent | null {
    return this.store.snapshot().agents.find((item) => item.id === id) ?? null;
  }

  /**
   * The single authorized read. `action` lets one helper cover read,
   * update, delete, start, stop and run without duplicating the check.
   */
  async requireAgent(actor: HumanActor, id: string, action: string): Promise<Agent> {
    const agent = this.rawAgent(id);
    await this.identity.require({
      actor,
      action,
      resourceType: "agent",
      resourceId: id,
      resourceOwnerId: agent?.ownerId ?? null,
    });
    if (!agent) throw new HttpError(404, "Agent not found");
    return agent;
  }

  async getAgent(actor: HumanActor, id: string): Promise<Agent> {
    return this.requireAgent(actor, id, "agent.read");
  }

  async createAgent(actor: HumanActor, input: CreateAgentInput): Promise<Agent> {
    await this.identity.require({
      actor,
      action: "agent.create",
      resourceType: "agent",
      resourceId: null,
      resourceOwnerId: null,
    });
    const timestamp = now();
    const id = randomUUID();
    // The Agent's identity is created with the Agent, not borrowed from
    // the human who made it.
    const principal = await this.identity.createPrincipal(id, actor.userId);
    const agent: Agent = {
      id,
      ownerId: actor.userId,
      principalId: principal.id,
      name: input.name.trim(),
      description: input.description?.trim() ?? "",
      instructions: input.instructions?.trim() ?? "",
      status: "ready",
      workspacePath: this.workspaces.workspacePath(id),
      codexThreadId: null,
      lastError: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    await this.workspaces.create(agent);
    await this.store.mutate((database) => database.agents.push(agent));

    // Least privilege by default: a new Agent gets read-only delegation.
    // Anything more is an explicit decision the owner makes later.
    await this.identity.createGrant(actor, { agentId: id, scopes: ["docs:read"] });
    return agent;
  }

  async updateAgent(actor: HumanActor, id: string, input: UpdateAgentInput): Promise<Agent> {
    const current = await this.requireAgent(actor, id, "agent.update");
    if (current.status === "busy") {
      throw new HttpError(409, "Stop the active run before editing this Agent");
    }
    const updated = await this.store.mutate((database) => {
      const agent = database.agents.find((item) => item.id === id);
      if (!agent) throw new HttpError(404, "Agent not found");
      if (agent.status === "busy") {
        throw new HttpError(409, "Stop the active run before editing this Agent");
      }
      if (input.name !== undefined) agent.name = input.name.trim();
      if (input.description !== undefined) agent.description = input.description.trim();
      if (input.instructions !== undefined) agent.instructions = input.instructions.trim();
      agent.lastError = null;
      agent.updatedAt = now();
      return structuredClone(agent);
    });
    await this.workspaces.writeInstructions(updated);
    return updated;
  }

  async deleteAgent(actor: HumanActor, id: string): Promise<{ archivedWorkspace: string }> {
    const agent = await this.requireAgent(actor, id, "agent.delete");
    await this.cancelExecution(id);
    const archivedWorkspace = await this.workspaces.archive(agent);
    // Deleting an Agent revokes its identity and every outstanding grant.
    // The grant records survive as history; their authority does not.
    await this.identity.revokePrincipal(id);
    await this.store.mutate((database) => {
      const revokedAt = now();
      const principal = database.principals.find((item) => item.agentId === id);
      for (const grant of database.grants) {
        if (principal && grant.agentPrincipalId === principal.id && !grant.revokedAt) {
          grant.revokedAt = revokedAt;
          grant.revokedBy = actor.userId;
          grant.revokedReason = "Agent deleted";
        }
      }
      database.agents = database.agents.filter((item) => item.id !== id);
      database.messages = database.messages.filter((item) => item.agentId !== id);
      database.runs = database.runs.filter((item) => item.agentId !== id);
    });
    return { archivedWorkspace };
  }

  async startAgent(actor: HumanActor, id: string): Promise<Agent> {
    await this.requireAgent(actor, id, "agent.start");
    return this.setStatus(id, "ready");
  }

  async stopAgent(actor: HumanActor, id: string): Promise<Agent> {
    await this.requireAgent(actor, id, "agent.stop");
    await this.cancelExecution(id);
    return this.setStatus(id, "stopped");
  }

  async getMessages(actor: HumanActor, agentId: string): Promise<Message[]> {
    await this.requireAgent(actor, agentId, "agent.read");
    return this.store
      .snapshot()
      .messages.filter((message) => message.agentId === agentId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  async getRun(actor: HumanActor, runId: string): Promise<AgentRun> {
    const run = this.store.snapshot().runs.find((item) => item.id === runId);
    const agent = run ? this.rawAgent(run.agentId) : null;
    await this.identity.require({
      actor,
      action: "agent.read",
      resourceType: "agent",
      resourceId: run?.agentId ?? null,
      resourceOwnerId: agent?.ownerId ?? null,
    });
    if (!run) throw new HttpError(404, "Run not found");
    return run;
  }

  async getRuns(actor: HumanActor, agentId: string): Promise<AgentRun[]> {
    await this.requireAgent(actor, agentId, "agent.read");
    return this.store
      .snapshot()
      .runs.filter((run) => run.agentId === agentId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  /**
   * Start a Run.
   *
   * This is the delegation moment: the human's authority is exchanged for
   * a narrow, short-lived Action Token bound to this Run. The token is
   * minted here, handed to the Runtime for one turn, and never persisted -
   * only its id is recorded, so the audit trail can name the credential
   * without being able to replay it.
   */
  async sendMessage(
    actor: HumanActor,
    agentId: string,
    prompt: string,
  ): Promise<{ run: AgentRun; message: Message; delegation: DelegationSummary }> {
    const agent = await this.requireAgent(actor, agentId, "agent.run");
    if (!isArkConfigured(this.config)) {
      throw new HttpError(
        503,
        "Ark is not configured. Set ARK_API_KEY and ARK_MODEL, then restart.",
      );
    }
    if (agent.status === "stopped") {
      throw new HttpError(409, "Start the Agent before sending a message");
    }

    const timestamp = now();
    const runId = randomUUID();
    const grant = this.identity.activeGrantForAgent(agentId, actor.userId);
    const minted = grant
      ? this.identity.mintForRun({ agentId, runId, subjectUserId: actor.userId, grant })
      : null;

    const run: AgentRun = {
      id: runId,
      agentId,
      status: "queued",
      prompt,
      output: null,
      error: null,
      usage: null,
      startedAt: null,
      completedAt: null,
      createdAt: timestamp,
      initiatedBy: actor.userId,
      grantId: grant?.id ?? null,
      actionTokenId: minted?.claims.jti ?? null,
    };
    const message: Message = {
      id: randomUUID(),
      agentId,
      runId,
      role: "user",
      content: prompt,
      createdAt: timestamp,
    };

    const agentAtStart = await this.store.mutate((database) => {
      const storedAgent = database.agents.find((item) => item.id === agentId);
      if (!storedAgent) throw new HttpError(404, "Agent not found");
      if (storedAgent.status === "stopped") {
        throw new HttpError(409, "Start the Agent before sending a message");
      }
      if (storedAgent.status === "busy") {
        throw new HttpError(409, "This Agent is already running");
      }
      database.runs.push(run);
      database.messages.push(message);
      const snapshot = structuredClone(storedAgent);
      storedAgent.status = "busy";
      storedAgent.lastError = null;
      storedAgent.updatedAt = timestamp;
      return snapshot;
    });

    await this.identity.audit.record({
      runId,
      actorUserId: actor.userId,
      agentPrincipalId: agent.principalId,
      agentId,
      principalKind: "human",
      action: "run.start",
      resourceType: "agent",
      resourceId: agentId,
      decision: "allow",
      reason: minted ? "action_token_minted" : "run_without_delegation",
      detail: minted
        ? "Minted action token " +
          minted.claims.jti +
          " with scopes [" +
          minted.claims.scope.join(", ") +
          "] valid until " +
          new Date(minted.claims.exp * 1000).toISOString()
        : "No active delegation grant: this Run carries no data-plane authority",
      scopes: minted?.claims.scope ?? [],
      grantId: grant?.id ?? null,
      tokenFingerprint: null,
    });

    const credentials: Record<string, string> = minted
      ? {
          LAUNCHPAD_ACTION_TOKEN: minted.token,
          LAUNCHPAD_RESOURCE_API: this.resourceApiUrl(),
          LAUNCHPAD_RUN_ID: runId,
        }
      : { LAUNCHPAD_RESOURCE_API: this.resourceApiUrl() };

    const execution = this.executeRun(agentAtStart, run, credentials);
    this.activeExecutions.set(agentId, execution);
    void execution
      .finally(() => {
        if (this.activeExecutions.get(agentId) === execution) {
          this.activeExecutions.delete(agentId);
        }
      })
      .catch(() => undefined);

    return {
      run,
      message,
      delegation: {
        granted: minted !== null,
        grantId: grant?.id ?? null,
        scopes: minted?.claims.scope ?? [],
        tokenId: minted?.claims.jti ?? null,
        expiresAt: minted ? new Date(minted.claims.exp * 1000).toISOString() : null,
      },
    };
  }

  private resourceApiUrl(): string {
    const host =
      this.config.runtimeProvider === "container" ? this.config.runtimeApiHost : "127.0.0.1";
    return "http://" + host + ":" + this.config.port + "/api/resources";
  }

  async systemInfo(): Promise<Record<string, unknown>> {
    return {
      arkConfigured: isArkConfigured(this.config),
      arkBaseUrl: this.config.arkBaseUrl,
      arkModel: this.config.arkModel || null,
      codexAvailable: await this.runner.isAvailable(),
      codexSandboxMode: this.config.codexSandboxMode,
      runtimeProvider: this.config.runtimeProvider,
      containerEngine:
        this.config.runtimeProvider === "container" ? this.config.containerEngine : null,
      runtime:
        this.config.runtimeProvider === "container"
          ? "Codex CLI in " + this.config.containerEngine + " Runtime"
          : "Codex CLI in application container",
      identity: {
        enabled: true,
        actionTokenTtlSeconds: this.config.actionTokenTtlSeconds,
        grantDefaultTtlMinutes: this.config.grantDefaultTtlMinutes,
        approvalTtlSeconds: this.config.approvalTtlSeconds,
        tokenSecretPinned: this.config.tokenSecretPinned,
        resourceApiForRuntime: this.resourceApiUrl(),
        runtimeMayNotReachHost: this.config.runtimeMayNotReachHost,
        usingDefaultPasswords: this.config.usingDefaultPasswords,
      },
    };
  }

  private async executeRun(
    agentAtStart: Agent,
    run: AgentRun,
    credentials: Record<string, string>,
  ): Promise<void> {
    await this.store.mutate((database) => {
      const storedRun = database.runs.find((item) => item.id === run.id);
      if (storedRun) {
        storedRun.status = "running";
        storedRun.startedAt = now();
      }
    });
    try {
      if (this.cancellationRequests.has(agentAtStart.id)) {
        throw new RunCancelledError();
      }
      const result = await this.runner.run({
        agentId: agentAtStart.id,
        workspacePath: agentAtStart.workspacePath,
        prompt: run.prompt,
        threadId: agentAtStart.codexThreadId,
        credentials,
      });
      const completedAt = now();
      await this.store.mutate((database) => {
        const storedRun = database.runs.find((item) => item.id === run.id);
        const agent = database.agents.find((item) => item.id === agentAtStart.id);
        if (!storedRun || !agent) return;
        storedRun.status = "completed";
        storedRun.output = result.output;
        storedRun.usage = result.usage;
        storedRun.completedAt = completedAt;
        database.messages.push({
          id: randomUUID(),
          agentId: agent.id,
          runId: run.id,
          role: "assistant",
          content: result.output,
          createdAt: completedAt,
        });
        agent.status = "ready";
        agent.codexThreadId = result.threadId;
        agent.lastError = null;
        agent.updatedAt = completedAt;
      });
    } catch (error) {
      const completedAt = now();
      const cancelled = error instanceof RunCancelledError;
      const message = error instanceof Error ? error.message : String(error);
      await this.store.mutate((database) => {
        const storedRun = database.runs.find((item) => item.id === run.id);
        const agent = database.agents.find((item) => item.id === agentAtStart.id);
        if (storedRun) {
          storedRun.status = cancelled ? "cancelled" : "failed";
          storedRun.error = message;
          storedRun.completedAt = completedAt;
        }
        if (agent) {
          if (agent.status !== "stopped") {
            agent.status = cancelled ? "ready" : "error";
          }
          agent.lastError = cancelled ? null : message;
          agent.updatedAt = completedAt;
        }
      });
    } finally {
      // The credential dies with the Run. Any pending approval that was
      // never decided is closed so it cannot be answered after the fact.
      await this.closeRunCredential(run.id);
    }
  }

  /**
   * Post-run cleanup. The Action Token is already unusable because the
   * policy engine refuses tokens whose Run is not active, but pending
   * approvals are expired explicitly so the owner's inbox stays truthful.
   */
  private async closeRunCredential(runId: string): Promise<void> {
    await this.store.mutate((database) => {
      for (const approval of database.approvals) {
        if (approval.runId === runId && approval.status === "pending") {
          approval.status = "expired";
        }
      }
    });
  }

  private async setStatus(id: string, status: Agent["status"]): Promise<Agent> {
    return this.store.mutate((database) => {
      const agent = database.agents.find((item) => item.id === id);
      if (!agent) throw new HttpError(404, "Agent not found");
      if (status === "ready" && agent.status === "busy") {
        throw new HttpError(409, "Stop the active run before starting this Agent");
      }
      agent.status = status;
      if (status === "ready") agent.lastError = null;
      agent.updatedAt = now();
      return structuredClone(agent);
    });
  }

  private async cancelExecution(agentId: string): Promise<void> {
    this.cancellationRequests.add(agentId);
    try {
      await this.runner.cancel(agentId);
      const execution = this.activeExecutions.get(agentId);
      if (execution) await execution;
    } finally {
      this.cancellationRequests.delete(agentId);
    }
  }
}

export interface DelegationSummary {
  granted: boolean;
  grantId: string | null;
  scopes: string[];
  tokenId: string | null;
  expiresAt: string | null;
}
