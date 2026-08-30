import { HttpError } from "./errors.js";
import type { IdentityService } from "./identity/identity-service.js";
import { paramsHash as hashParams } from "./identity/crypto.js";
import { redactPreview } from "./identity/redact.js";
import type { PolicyDecision } from "./identity/policy.js";
import type { JsonStore } from "./store.js";
import type { Actor, AgentActor, ApprovalRequest, Document } from "./types.js";

export interface ResourceOutcome<T> {
  status: number;
  body: T | { error: string; reason: string; approvalId?: string; pollUrl?: string };
}

/**
 * Mock protected resource server
 * ==============================
 *
 * A deliberately small document store that behaves like a real downstream
 * system: it does not trust the caller, it re-derives authority from the
 * presented credential on every single request, and it never sees a human
 * session token.
 *
 * This is the enforcement point that makes the middleware real. The UI can
 * hide User B's documents all it likes; this service is what actually says
 * no.
 */
export class ResourceService {
  constructor(
    private readonly store: JsonStore,
    private readonly identity: IdentityService,
  ) {}

  private find(id: string): Document | null {
    return this.store.snapshot().documents.find((item) => item.id === id) ?? null;
  }

  /** Documents a human owns. Used by the browser, never by an Agent. */
  listForHuman(userId: string): Document[] {
    return this.store
      .snapshot()
      .documents.filter((item) => item.ownerId === userId)
      .sort((left, right) => left.id.localeCompare(right.id));
  }

  /**
   * List. Returns only what the caller's authority reaches, so the
   * response itself never discloses that other users' documents exist.
   */
  async list(actor: Actor): Promise<ResourceOutcome<{ documents: Document[] }>> {
    const decision = await this.identity.authorize({
      actor,
      action: "document.list",
      resourceType: "document",
      resourceId: null,
      resourceOwnerId: null,
    });
    if (decision.effect !== "allow") {
      return this.refuse(decision);
    }
    const scopeOwner =
      actor.kind === "human"
        ? actor.userId
        : (this.identity.getGrant(actor.grantId)?.resourceOwnerId ?? " ");
    return {
      status: 200,
      body: {
        documents: this.store
          .snapshot()
          .documents.filter((item) => item.ownerId === scopeOwner)
          .sort((left, right) => left.id.localeCompare(right.id)),
      },
    };
  }

  async read(actor: Actor, documentId: string): Promise<ResourceOutcome<{ document: Document }>> {
    const document = this.find(documentId);
    const decision = await this.identity.authorize({
      actor,
      action: "document.read",
      resourceType: "document",
      resourceId: documentId,
      resourceOwnerId: document?.ownerId ?? null,
    });
    if (decision.effect !== "allow") {
      return this.refuse(decision);
    }
    if (!document) {
      return { status: 404, body: { error: "Document not found", reason: "not_found" } };
    }
    return { status: 200, body: { document } };
  }

  /**
   * Write. A high-risk scope, so the policy engine returns "pending" the
   * first time and the call is parked behind a human decision that is
   * bound to this exact document and this exact body.
   */
  async write(
    actor: Actor,
    documentId: string,
    body: string,
  ): Promise<ResourceOutcome<{ document: Document } | { approval: ApprovalRequest }>> {
    const document = this.find(documentId);
    const params = { documentId, body };
    const parameterHash = hashParams(params);

    const decision = await this.identity.authorize(
      {
        actor,
        action: "document.write",
        resourceType: "document",
        resourceId: documentId,
        resourceOwnerId: document?.ownerId ?? null,
      },
      { paramsHash: parameterHash },
    );

    if (decision.effect === "pending") {
      if (actor.kind !== "agent") {
        return this.refuse(decision);
      }
      const existing = this.identity.findApproval({
        runId: actor.runId,
        action: "document.write",
        resourceId: documentId,
        paramsHash: parameterHash,
      });
      const approval =
        existing && existing.status === "pending"
          ? existing
          : await this.identity.requestApproval({
              actor,
              action: "document.write",
              resourceId: documentId,
              params,
              preview: redactPreview(body, 160),
            });
      return {
        status: 202,
        body: {
          error: "Approval required before this write can proceed",
          reason: decision.reason,
          approvalId: approval.id,
          pollUrl: "/api/resources/approvals/" + approval.id,
        },
      };
    }

    if (decision.effect !== "allow") {
      return this.refuse(decision);
    }
    if (!document) {
      return { status: 404, body: { error: "Document not found", reason: "not_found" } };
    }

    const actorLabel =
      actor.kind === "human"
        ? actor.userId
        : actor.agentPrincipalId + " for " + actor.subjectUserId;
    const updated = await this.store.mutate((database) => {
      const target = database.documents.find((item) => item.id === documentId);
      if (!target) throw new HttpError(404, "Document not found");
      target.body = body;
      target.updatedAt = new Date().toISOString();
      target.updatedBy = actorLabel;
      return structuredClone(target);
    });

    // Burn the approval so an approved write cannot be replayed.
    if (actor.kind === "agent") {
      const approval = this.identity.findApproval({
        runId: actor.runId,
        action: "document.write",
        resourceId: documentId,
        paramsHash: parameterHash,
      });
      if (approval && approval.status === "approved" && !approval.consumedAt) {
        await this.identity.consumeApproval(approval.id);
      }
    }

    return { status: 200, body: { document: updated } };
  }

  /** Agents poll this while a write is parked behind a human decision. */
  approvalStatus(actor: AgentActor, approvalId: string): ResourceOutcome<{ approval: unknown }> {
    const approval = this.identity.getApproval(approvalId);
    if (
      !approval ||
      approval.runId !== actor.runId ||
      approval.subjectUserId !== actor.subjectUserId
    ) {
      return { status: 404, body: { error: "Approval request not found", reason: "not_found" } };
    }
    return {
      status: 200,
      body: {
        approval: {
          id: approval.id,
          status: approval.status,
          action: approval.action,
          resourceId: approval.resourceId,
          expiresAt: approval.expiresAt,
          decidedAt: approval.decidedAt,
        },
      },
    };
  }

  /**
   * Denials are deliberately uniform: the same status and the same shape
   * whether the target does not exist or the caller simply may not reach
   * it. The machine-readable reason goes to the audit log, not to the
   * caller, so a compromised Agent cannot map another user's namespace by
   * probing for different error messages.
   */
  private refuse(decision: PolicyDecision): ResourceOutcome<never> {
    const status = decision.reason === "cross_user_denied" ? 404 : 403;
    return {
      status,
      body: {
        error:
          status === 404
            ? "Document not found"
            : "The presented credential does not authorize this action",
        reason: status === 404 ? "not_found" : decision.reason,
      },
    };
  }
}
