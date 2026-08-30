import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { AppConfig } from "./config.js";
import { HttpError } from "./errors.js";
import type { AgentService } from "./agent-service.js";
import type { IdentityService } from "./identity/identity-service.js";
import type { ResourceService } from "./resource-service.js";
import { RESOURCE_SCOPES } from "./identity/scopes.js";
import { fingerprint } from "./identity/crypto.js";
import type { AgentActor, HumanActor } from "./types.js";

const agentIdParams = z.object({ id: z.string().uuid() });
const runIdParams = z.object({ id: z.string().uuid() });
const opaqueIdParams = z.object({ id: z.string().min(1).max(80) });
const documentIdParams = z.object({ id: z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/) });
const createAgentBody = z.object({
  name: z.string().trim().min(1).max(80),
  description: z.string().max(500).optional(),
  instructions: z.string().max(10_000).optional(),
});
const updateAgentBody = createAgentBody
  .partial()
  .refine((value) => Object.keys(value).length > 0, "At least one field is required");
const messageBody = z.object({ content: z.string().trim().min(1).max(50_000) });
const loginBody = z.object({
  username: z.string().trim().min(1).max(64),
  password: z.string().min(1).max(256),
});
const grantBody = z.object({
  agentId: z.string().uuid(),
  scopes: z.array(z.enum(RESOURCE_SCOPES)).min(1).max(RESOURCE_SCOPES.length),
  ttlMinutes: z.coerce.number().int().min(1).max(10_080).optional(),
});
const revokeBody = z.object({ reason: z.string().trim().max(200).default("Revoked by owner") });
const approvalDecisionBody = z.object({ approved: z.boolean() });
const documentWriteBody = z.object({ body: z.string().max(20_000) });

declare module "fastify" {
  interface FastifyRequest {
    /** Set by the control-plane auth hook. */
    human?: HumanActor;
    /** Set by the resource-server auth hook. */
    agentActor?: AgentActor;
  }
}

function bearerOf(request: FastifyRequest): string {
  const header = request.headers.authorization ?? "";
  return header.startsWith("Bearer ") ? header.slice(7).trim() : "";
}

export async function createApp(
  config: AppConfig,
  service: AgentService,
  identity: IdentityService,
  resources: ResourceService,
): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: config.logLevel,
      redact: ["req.headers.authorization", "req.headers.cookie"],
    },
    bodyLimit: 1_048_576,
  });

  await app.register(cors, {
    origin:
      config.nodeEnv === "development"
        ? ["http://localhost:5173", "http://127.0.0.1:5173"]
        : false,
  });

  const PUBLIC_ROUTES = new Set(["/api/health", "/api/auth", "/api/auth/login"]);

  /**
   * Two authentication boundaries, deliberately separate.
   *
   * `/api/resources/*` is the data plane. It accepts ONLY Action Tokens
   * whose audience is the resource API. A human session token presented
   * there is rejected, and an Action Token presented anywhere else is
   * rejected. That is RFC 8707-style audience binding, and it is what
   * makes token passthrough structurally impossible: the control plane
   * has no credential it could forward to the resource server, because
   * the only credential that works there is one it minted for a specific
   * Run.
   *
   * Everything else under `/api/` is the control plane and accepts only
   * human session tokens. An Agent cannot reach it at all.
   */
  app.addHook("onRequest", async (request, reply) => {
    if (!request.url.startsWith("/api/")) return;
    const path = request.url.split("?")[0] ?? request.url;
    if (PUBLIC_ROUTES.has(path)) return;

    const bearer = bearerOf(request);

    if (path.startsWith("/api/resources")) {
      const result = identity.resolveAgentActor(bearer);
      if (!result.ok || !result.actor) {
        await identity.audit.recordAnonymousDenial({
          action: "resource.request",
          resourceType: "document",
          resourceId: null,
          reason: result.reason ?? "missing_credential",
          detail: request.method + " " + path + " rejected at the resource boundary",
          tokenFingerprint: bearer ? fingerprint(bearer) : null,
        });
        return reply
          .code(401)
          .send({ error: "A valid action token is required", reason: result.reason });
      }
      request.agentActor = result.actor;
      return;
    }

    const human = identity.resolveHumanActor(bearer);
    if (!human) {
      return reply.code(401).send({ error: "Authentication required" });
    }
    request.human = human;
    return;
  });

  const requireHuman = (request: FastifyRequest): HumanActor => {
    if (!request.human) throw new HttpError(401, "Authentication required");
    return request.human;
  };
  const requireAgentActor = (request: FastifyRequest): AgentActor => {
    if (!request.agentActor) throw new HttpError(401, "A valid action token is required");
    return request.agentActor;
  };

  /* ---------------- public ---------------- */

  app.get("/api/health", async () => ({ ok: true, service: "volc-agent-launchpad" }));

  /** Kept for UI compatibility: authentication is now always required. */
  app.get("/api/auth", async () => ({ required: true, mode: "session" }));

  app.post("/api/auth/login", async (request, reply) => {
    const body = loginBody.parse(request.body);
    const { token, user } = await identity.login(body.username, body.password);
    return reply.code(200).send({
      token,
      user: {
        id: user.id,
        username: user.username,
        displayName: user.displayName,
        role: user.role,
        scopes: user.scopes,
      },
    });
  });

  /* ---------------- control plane: session ---------------- */

  app.post("/api/auth/logout", async (request) => {
    const human = requireHuman(request);
    await identity.logout(human.sessionId);
    return { ok: true };
  });

  app.get("/api/auth/me", async (request) => {
    const human = requireHuman(request);
    return { user: human };
  });

  app.get("/api/system", async () => service.systemInfo());

  /* ---------------- control plane: agents ---------------- */

  app.get("/api/agents", async (request) => ({ agents: service.listAgents(requireHuman(request)) }));

  app.post("/api/agents", async (request, reply) => {
    const body = createAgentBody.parse(request.body);
    const agent = await service.createAgent(requireHuman(request), body);
    return reply.code(201).send({ agent });
  });

  app.get("/api/agents/:id", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    return { agent: await service.getAgent(requireHuman(request), id) };
  });

  app.patch("/api/agents/:id", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    const body = updateAgentBody.parse(request.body);
    return { agent: await service.updateAgent(requireHuman(request), id, body) };
  });

  app.delete("/api/agents/:id", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    return service.deleteAgent(requireHuman(request), id);
  });

  app.post("/api/agents/:id/start", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    return { agent: await service.startAgent(requireHuman(request), id) };
  });

  app.post("/api/agents/:id/stop", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    return { agent: await service.stopAgent(requireHuman(request), id) };
  });

  app.get("/api/agents/:id/messages", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    return { messages: await service.getMessages(requireHuman(request), id) };
  });

  app.get("/api/agents/:id/runs", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    return { runs: await service.getRuns(requireHuman(request), id) };
  });

  app.post("/api/agents/:id/messages", async (request, reply) => {
    const { id } = agentIdParams.parse(request.params);
    const body = messageBody.parse(request.body);
    const result = await service.sendMessage(requireHuman(request), id, body.content);
    return reply.code(202).send(result);
  });

  app.get("/api/runs/:id", async (request) => {
    const { id } = runIdParams.parse(request.params);
    return { run: await service.getRun(requireHuman(request), id) };
  });

  /* ---------------- control plane: identity ---------------- */

  app.get("/api/agents/:id/identity", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    const human = requireHuman(request);
    await service.requireAgent(human, id, "agent.read");
    return {
      principal: identity.getPrincipalForAgent(id),
      grants: identity.listGrantsForAgent(id),
    };
  });

  app.post("/api/agents/:id/identity/rotate", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    const human = requireHuman(request);
    await service.requireAgent(human, id, "agent.update");
    const principal = await identity.rotatePrincipal(id);
    await identity.audit.record({
      runId: null,
      actorUserId: human.userId,
      agentPrincipalId: principal.id,
      agentId: id,
      principalKind: "human",
      action: "principal.rotate",
      resourceType: "principal",
      resourceId: principal.id,
      decision: "allow",
      reason: "principal_rotated",
      detail:
        "Rotated to generation " +
        principal.generation +
        "; every grant issued under an earlier generation is now unusable",
      scopes: [],
      grantId: null,
      tokenFingerprint: null,
    });
    return { principal };
  });

  app.get("/api/grants", async (request) => ({
    grants: identity.listGrants(requireHuman(request).userId),
  }));

  app.post("/api/grants", async (request, reply) => {
    const human = requireHuman(request);
    const body = grantBody.parse(request.body);
    await service.requireAgent(human, body.agentId, "agent.update");
    const grant = await identity.createGrant(human, {
      agentId: body.agentId,
      scopes: [...body.scopes],
      ...(body.ttlMinutes === undefined ? {} : { ttlMinutes: body.ttlMinutes }),
    });
    return reply.code(201).send({ grant });
  });

  app.post("/api/grants/:id/revoke", async (request) => {
    const { id } = opaqueIdParams.parse(request.params);
    const body = revokeBody.parse(request.body ?? {});
    return { grant: await identity.revokeGrant(requireHuman(request), id, body.reason) };
  });

  app.get("/api/approvals", async (request) => ({
    approvals: identity.listApprovals(requireHuman(request).userId),
  }));

  app.post("/api/approvals/:id", async (request) => {
    const { id } = opaqueIdParams.parse(request.params);
    const body = approvalDecisionBody.parse(request.body);
    return { approval: await identity.decideApproval(requireHuman(request), id, body.approved) };
  });

  app.get("/api/audit", async (request) => {
    const human = requireHuman(request);
    const query = z
      .object({
        runId: z.string().optional(),
        agentId: z.string().optional(),
        limit: z.coerce.number().int().min(1).max(500).optional(),
        scope: z.enum(["mine", "platform"]).default("mine"),
      })
      .parse(request.query);

    if (query.scope === "platform") {
      // Platform-wide audit is an admin capability, checked by policy.
      await identity.require({
        actor: human,
        action: "audit.read",
        resourceType: "audit",
        resourceId: null,
        resourceOwnerId: null,
      });
      return {
        events: identity.audit.list({
          ...(query.runId ? { runId: query.runId } : {}),
          ...(query.agentId ? { agentId: query.agentId } : {}),
          ...(query.limit ? { limit: query.limit } : {}),
        }),
      };
    }

    return {
      events: identity.audit.list({
        userId: human.userId,
        ...(query.runId ? { runId: query.runId } : {}),
        ...(query.agentId ? { agentId: query.agentId } : {}),
        ...(query.limit ? { limit: query.limit } : {}),
      }),
    };
  });

  /** The human's own view of their documents. Session-authenticated. */
  app.get("/api/my/documents", async (request) => ({
    documents: resources.listForHuman(requireHuman(request).userId),
  }));

  /* ---------------- data plane: resource server ---------------- */

  const send = async <T>(
    reply: FastifyReply,
    outcome: { status: number; body: T },
  ): Promise<FastifyReply> => reply.code(outcome.status).send(outcome.body);

  app.get("/api/resources/documents", async (request, reply) =>
    send(reply, await resources.list(requireAgentActor(request))),
  );

  app.get("/api/resources/documents/:id", async (request, reply) => {
    const { id } = documentIdParams.parse(request.params);
    return send(reply, await resources.read(requireAgentActor(request), id));
  });

  app.put("/api/resources/documents/:id", async (request, reply) => {
    const { id } = documentIdParams.parse(request.params);
    const body = documentWriteBody.parse(request.body);
    return send(reply, await resources.write(requireAgentActor(request), id, body.body));
  });

  app.get("/api/resources/approvals/:id", async (request, reply) => {
    const { id } = opaqueIdParams.parse(request.params);
    return send(reply, resources.approvalStatus(requireAgentActor(request), id));
  });

  /* ---------------- static + errors ---------------- */

  if (config.nodeEnv === "production") {
    const webRoot = fileURLToPath(new URL("../../web/dist", import.meta.url));
    await app.register(fastifyStatic, { root: webRoot, prefix: "/" });
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith("/api/")) {
        return reply.code(404).send({ error: "API route not found" });
      }
      return reply.sendFile("index.html");
    });
  }

  app.setErrorHandler((error, request, reply) => {
    const appError = error instanceof Error ? error : new Error(String(error));
    const validationError = error instanceof z.ZodError;
    const frameworkStatus =
      typeof (error as { statusCode?: unknown }).statusCode === "number"
        ? (error as { statusCode: number }).statusCode
        : null;
    const statusCode =
      error instanceof HttpError
        ? error.statusCode
        : validationError
          ? 400
          : frameworkStatus && frameworkStatus >= 400 && frameworkStatus <= 599
            ? frameworkStatus
            : 500;
    if (statusCode >= 500) request.log.error(appError);
    return reply.code(statusCode).send({
      error: appError.message,
      ...(validationError ? { details: error.issues } : {}),
    });
  });

  return app;
}
