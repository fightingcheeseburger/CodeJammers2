import type { JsonStore } from "../store.js";
import type { Actor, AuditDecision, AuditEvent, PrincipalKind } from "../types.js";
import { newId } from "./crypto.js";
import { redactPreview } from "./redact.js";
import type { PolicyDecision, PolicyRequest } from "./policy.js";

/**
 * Append-only authorization log.
 *
 * Every decision the policy engine makes is recorded, allow and deny
 * alike. Recording only denials tells you what was blocked; recording
 * both tells you what an Agent actually did with the authority you gave
 * it, which is the question an operator asks after an incident.
 */
export class AuditLog {
  constructor(
    private readonly store: JsonStore,
    private readonly maxEvents = 5_000,
  ) {}

  async record(event: Omit<AuditEvent, "id" | "at">): Promise<AuditEvent> {
    const entry: AuditEvent = {
      ...event,
      detail: redactPreview(event.detail),
      id: newId(),
      at: new Date().toISOString(),
    };
    await this.store.mutate((database) => {
      database.audit.push(entry);
      // Bounded retention keeps the JSON store honest in a POC.
      if (database.audit.length > this.maxEvents) {
        database.audit.splice(0, database.audit.length - this.maxEvents);
      }
    });
    return entry;
  }

  /** Convenience wrapper: turn a policy decision into an audit record. */
  async recordDecision(
    request: PolicyRequest,
    decision: PolicyDecision,
    extra: { runId?: string | null; grantId?: string | null } = {},
  ): Promise<AuditEvent> {
    const actor = request.actor;
    const decisionValue: AuditDecision =
      decision.effect === "allow" ? "allow" : decision.effect === "pending" ? "pending" : "deny";
    return this.record({
      runId: extra.runId ?? (actor.kind === "agent" ? actor.runId : null),
      actorUserId: actor.kind === "human" ? actor.userId : actor.subjectUserId,
      agentPrincipalId: actor.kind === "agent" ? actor.agentPrincipalId : null,
      agentId: actor.kind === "agent" ? actor.agentId : null,
      principalKind: actor.kind as PrincipalKind,
      action: request.action,
      resourceType: request.resourceType,
      resourceId: request.resourceId,
      decision: decisionValue,
      reason: decision.reason,
      detail: decision.detail,
      scopes: decision.requiredScope ? [decision.requiredScope] : [],
      grantId: extra.grantId ?? (actor.kind === "agent" ? actor.grantId : null),
      tokenFingerprint: actor.kind === "agent" ? actor.tokenFingerprint : null,
    });
  }

  /** Anonymous denials (no valid credential at all) still get logged. */
  async recordAnonymousDenial(input: {
    action: string;
    resourceType: string;
    resourceId: string | null;
    reason: string;
    detail: string;
    tokenFingerprint: string | null;
  }): Promise<AuditEvent> {
    return this.record({
      runId: null,
      actorUserId: null,
      agentPrincipalId: null,
      agentId: null,
      principalKind: "anonymous",
      action: input.action,
      resourceType: input.resourceType,
      resourceId: input.resourceId,
      decision: "deny",
      reason: input.reason,
      detail: input.detail,
      scopes: [],
      grantId: null,
      tokenFingerprint: input.tokenFingerprint,
    });
  }

  list(filter: { userId?: string; runId?: string; agentId?: string; limit?: number } = {}): AuditEvent[] {
    const limit = Math.min(filter.limit ?? 200, 1_000);
    return this.store
      .snapshot()
      .audit.filter((event) => {
        if (filter.userId && event.actorUserId !== filter.userId) return false;
        if (filter.runId && event.runId !== filter.runId) return false;
        if (filter.agentId && event.agentId !== filter.agentId) return false;
        return true;
      })
      .sort((left, right) => right.at.localeCompare(left.at))
      .slice(0, limit);
  }

  /** Helper used by tests and the demo script. */
  static summarize(event: AuditEvent): string {
    return [
      event.decision.toUpperCase(),
      event.action,
      event.resourceId ?? "-",
      "(" + event.reason + ")",
    ].join(" ");
  }
}

export type { Actor };
