import type {
  Actor,
  Agent,
  AgentPrincipal,
  AgentRun,
  ApprovalRequest,
  DelegationGrant,
  User,
} from "../types.js";
import { HIGH_RISK_SCOPES } from "./scopes.js";

/**
 * Policy Decision Point
 * =====================
 *
 * A pure function. It receives an actor, a requested action, the target
 * resource, and a snapshot of the live state it needs. It returns an
 * explicit effect plus a machine-readable reason code.
 *
 * Two properties matter more than the rule list itself:
 *
 *  1. Deny by default. An action with no rule is denied, not allowed.
 *  2. It is stateless and side-effect free, so it is trivially testable
 *     and the same decision can be replayed from an audit record.
 */

export type PolicyEffect = "allow" | "deny" | "pending";

export interface Obligation {
  type: "require_approval";
  scope: string;
}

export interface PolicyDecision {
  effect: PolicyEffect;
  /** Stable machine-readable code. Assert on this in tests, not on prose. */
  reason: string;
  detail: string;
  requiredScope: string | null;
  obligations: Obligation[];
}

export interface PolicyRequest {
  actor: Actor;
  action: string;
  resourceType: "agent" | "document" | "grant" | "principal" | "audit" | "approval";
  resourceId: string | null;
  /** Owner of the target resource, when the resource exists. */
  resourceOwnerId: string | null;
  /** sha256 of the normalized parameters, for approval binding. */
  paramsHash?: string | null;
}

export interface PolicyContext {
  subjectUser: User | null;
  agent: Agent | null;
  principal: AgentPrincipal | null;
  grant: DelegationGrant | null;
  run: AgentRun | null;
  approval: ApprovalRequest | null;
  now: Date;
}

interface ActionSpec {
  scope: string;
  /** Actions an Agent principal is allowed to attempt at all. */
  delegatable: boolean;
  /** Ownership of the target resource must match the subject. */
  ownershipChecked: boolean;
}

const ACTIONS: Record<string, ActionSpec> = {
  "agent.read": { scope: "agents:read", delegatable: false, ownershipChecked: true },
  "agent.create": { scope: "agents:write", delegatable: false, ownershipChecked: false },
  "agent.update": { scope: "agents:write", delegatable: false, ownershipChecked: true },
  "agent.delete": { scope: "agents:write", delegatable: false, ownershipChecked: true },
  "agent.start": { scope: "agents:write", delegatable: false, ownershipChecked: true },
  "agent.stop": { scope: "agents:write", delegatable: false, ownershipChecked: true },
  "agent.run": { scope: "agents:run", delegatable: false, ownershipChecked: true },
  "grant.read": { scope: "grants:manage", delegatable: false, ownershipChecked: true },
  "grant.create": { scope: "grants:manage", delegatable: false, ownershipChecked: true },
  "grant.revoke": { scope: "grants:manage", delegatable: false, ownershipChecked: true },
  "principal.rotate": { scope: "agents:write", delegatable: false, ownershipChecked: true },
  "approval.read": { scope: "agents:read", delegatable: false, ownershipChecked: true },
  "approval.decide": { scope: "agents:run", delegatable: false, ownershipChecked: true },
  "audit.read": { scope: "audit:read", delegatable: false, ownershipChecked: false },
  "document.list": { scope: "docs:read", delegatable: true, ownershipChecked: false },
  "document.read": { scope: "docs:read", delegatable: true, ownershipChecked: true },
  "document.write": { scope: "docs:write", delegatable: true, ownershipChecked: true },
  "document.delete": { scope: "docs:delete", delegatable: true, ownershipChecked: true },
};

const deny = (reason: string, detail: string, scope: string | null = null): PolicyDecision => ({
  effect: "deny",
  reason,
  detail,
  requiredScope: scope,
  obligations: [],
});

const allow = (reason: string, detail: string, scope: string | null): PolicyDecision => ({
  effect: "allow",
  reason,
  detail,
  requiredScope: scope,
  obligations: [],
});

function expired(timestamp: string, now: Date): boolean {
  return new Date(timestamp).getTime() <= now.getTime();
}

export function decide(
  request: PolicyRequest,
  context: PolicyContext,
): PolicyDecision {
  const spec = ACTIONS[request.action];
  // Rule 0: deny by default. Unknown verbs are not "probably fine".
  if (!spec) {
    return deny("unknown_action", "No policy rule covers " + request.action);
  }

  const subject = context.subjectUser;
  if (!subject) {
    return deny("subject_unknown", "The delegating user no longer exists", spec.scope);
  }
  if (subject.disabledAt) {
    return deny(
      "subject_disabled",
      "The user account " + subject.username + " is disabled",
      spec.scope,
    );
  }

  // Rule 1: the delegator's own ceiling. Nothing downstream may exceed it,
  // so disabling a human instantly neuters every Agent acting for them.
  if (!subject.scopes.includes(spec.scope)) {
    return deny(
      "scope_exceeds_delegator",
      "User " + subject.username + " does not hold " + spec.scope,
      spec.scope,
    );
  }

  return request.actor.kind === "human"
    ? decideForHuman(request, context, spec, subject)
    : decideForAgent(request, context, spec, subject);
}

function decideForHuman(
  request: PolicyRequest,
  context: PolicyContext,
  spec: ActionSpec,
  subject: User,
): PolicyDecision {
  const actor = request.actor;
  if (actor.kind !== "human") return deny("actor_mismatch", "Expected a human actor");

  if (!actor.scopes.includes(spec.scope)) {
    return deny(
      "scope_not_held",
      "Session for " + subject.username + " lacks " + spec.scope,
      spec.scope,
    );
  }

  // Admins may read the platform-wide audit log; nobody may read another
  // user's documents or drive another user's Agents, admin included.
  if (request.action === "audit.read" && actor.role !== "admin") {
    return deny("not_admin", "Only an admin may read the platform audit log", spec.scope);
  }

  if (spec.ownershipChecked && request.resourceOwnerId !== null) {
    if (request.resourceOwnerId !== actor.userId) {
      return deny(
        "not_owner",
        "User " +
          actor.username +
          " does not own " +
          request.resourceType +
          " " +
          (request.resourceId ?? "(unknown)"),
        spec.scope,
      );
    }
  }

  return allow("owner_action", "Human owner performing " + request.action, spec.scope);
}

function decideForAgent(
  request: PolicyRequest,
  context: PolicyContext,
  spec: ActionSpec,
  subject: User,
): PolicyDecision {
  const actor = request.actor;
  if (actor.kind !== "agent") return deny("actor_mismatch", "Expected an Agent actor");

  // Rule 2: control-plane actions are not delegatable at all. Even a grant
  // that somehow listed "agents:write" could not be used to create or edit
  // an Agent, because the action itself is closed to Agent principals.
  if (!spec.delegatable) {
    return deny(
      "action_not_delegatable",
      "Agent principals may not perform " + request.action,
      spec.scope,
    );
  }

  const principal = context.principal;
  if (!principal) {
    return deny("principal_unknown", "The Agent principal no longer exists", spec.scope);
  }
  if (principal.revokedAt) {
    return deny("principal_revoked", "The Agent principal is revoked", spec.scope);
  }
  if (principal.ownerId !== subject.id) {
    return deny(
      "principal_owner_mismatch",
      "The Agent principal is not owned by the delegating user",
      spec.scope,
    );
  }

  const grant = context.grant;
  if (!grant) {
    return deny("grant_unknown", "No delegation grant backs this token", spec.scope);
  }
  if (grant.agentPrincipalId !== actor.agentPrincipalId) {
    return deny("grant_principal_mismatch", "Grant belongs to another principal", spec.scope);
  }
  if (grant.subjectUserId !== actor.subjectUserId) {
    return deny("grant_subject_mismatch", "Grant was issued for another user", spec.scope);
  }
  // Rule 3: rotating the principal invalidates every grant bound to the
  // previous generation, without touching the grant records themselves.
  if (grant.principalGeneration !== principal.generation) {
    return deny(
      "principal_rotated",
      "Grant was issued for generation " +
        grant.principalGeneration +
        ", principal is now generation " +
        principal.generation,
      spec.scope,
    );
  }
  // Rule 4: revocation is checked HERE, at use time, not only at mint
  // time. A signed, unexpired token stops working the moment the human
  // revokes the grant behind it.
  if (grant.revokedAt) {
    return deny(
      "grant_revoked",
      "Grant revoked at " + grant.revokedAt + (grant.revokedReason ? ": " + grant.revokedReason : ""),
      spec.scope,
    );
  }
  if (expired(grant.expiresAt, context.now)) {
    return deny("grant_expired", "Grant expired at " + grant.expiresAt, spec.scope);
  }

  // Rule 5: the token's authority is bounded by the Run it was minted for.
  // When the Run ends, the credential is dead even if it has not expired.
  const run = context.run;
  if (!run) {
    return deny("run_unknown", "The Run for this token no longer exists", spec.scope);
  }
  if (run.id !== actor.runId) {
    return deny("run_mismatch", "Token was minted for a different Run", spec.scope);
  }
  if (run.status !== "running" && run.status !== "queued") {
    return deny(
      "run_not_active",
      "Run " + run.id + " is " + run.status + "; its credential is no longer usable",
      spec.scope,
    );
  }

  const agent = context.agent;
  if (!agent) {
    return deny("agent_unknown", "The Agent no longer exists", spec.scope);
  }
  if (agent.status === "stopped") {
    return deny("agent_stopped", "The Agent has been stopped by its owner", spec.scope);
  }

  // Rule 6: three-way scope intersection. The token, the grant and the
  // delegating human must ALL still carry the scope. The subject check
  // already happened in decide().
  if (!actor.scopes.includes(spec.scope)) {
    return deny("scope_not_in_token", "Token scope does not cover " + spec.scope, spec.scope);
  }
  if (!grant.scopes.includes(spec.scope)) {
    return deny("scope_not_granted", "Grant does not cover " + spec.scope, spec.scope);
  }

  // Rule 7: the headline containment. A grant reaches exactly one user's
  // resources - the delegator's. This is what stops User A's Agent from
  // reading User B's document even with a perfectly valid token.
  if (spec.ownershipChecked && request.resourceOwnerId !== null) {
    if (request.resourceOwnerId !== grant.resourceOwnerId) {
      return deny(
        "cross_user_denied",
        "Grant reaches resources owned by " +
          grant.resourceOwnerId +
          "; target is owned by " +
          request.resourceOwnerId,
        spec.scope,
      );
    }
  }

  // Rule 8: high-risk scopes need a human decision at the moment of use.
  if (HIGH_RISK_SCOPES.includes(spec.scope)) {
    const approval = context.approval;
    if (!approval) {
      return {
        effect: "pending",
        reason: "approval_required",
        detail: spec.scope + " requires explicit approval from " + subject.username,
        requiredScope: spec.scope,
        obligations: [{ type: "require_approval", scope: spec.scope }],
      };
    }
    if (approval.status === "denied") {
      return deny("approval_denied", "The owner denied this action", spec.scope);
    }
    if (approval.status === "expired" || expired(approval.expiresAt, context.now)) {
      return deny("approval_expired", "The approval window closed", spec.scope);
    }
    if (approval.status === "pending") {
      return {
        effect: "pending",
        reason: "approval_pending",
        detail: "Waiting for " + subject.username + " to decide",
        requiredScope: spec.scope,
        obligations: [{ type: "require_approval", scope: spec.scope }],
      };
    }
    if (approval.consumedAt) {
      return deny("approval_consumed", "This approval was already used", spec.scope);
    }
    // Rule 9: the approval is bound to the exact parameters. Approving a
    // write to one document cannot be replayed against another.
    if (request.paramsHash && approval.paramsHash !== request.paramsHash) {
      return deny(
        "approval_params_mismatch",
        "The action parameters differ from what was approved",
        spec.scope,
      );
    }
    if (approval.runId !== actor.runId || approval.resourceId !== request.resourceId) {
      return deny("approval_binding_mismatch", "Approval is bound to another action", spec.scope);
    }
    return allow("approved_delegated_action", "Owner-approved " + request.action, spec.scope);
  }

  return allow(
    "delegated_action",
    "Agent " +
      actor.agentPrincipalId +
      " acting for " +
      subject.username +
      " under grant " +
      grant.id,
    spec.scope,
  );
}

export function requiredScopeFor(action: string): string | null {
  return ACTIONS[action]?.scope ?? null;
}

export function isDelegatableAction(action: string): boolean {
  return ACTIONS[action]?.delegatable ?? false;
}
