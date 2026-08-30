import type { AppConfig } from "../config.js";
import { HttpError } from "../errors.js";
import type { JsonStore } from "../store.js";
import type {
  Actor,
  AgentActor,
  AgentPrincipal,
  AgentRun,
  ApprovalRequest,
  DelegationGrant,
  HumanActor,
  Session,
  User,
} from "../types.js";
import {
  mintActionToken,
  verifyActionToken,
  RESOURCE_API_AUDIENCE,
  type ActionTokenClaims,
  type VerifyFailure,
} from "./action-token.js";
import { AuditLog } from "./audit.js";
import {
  fingerprint,
  newId,
  newSecret,
  paramsHash as hashParams,
  sha256,
  verifyPassword,
} from "./crypto.js";
import { decide, type PolicyContext, type PolicyDecision, type PolicyRequest } from "./policy.js";
import { isDelegatable, isSubsetOf, normalizeScopes } from "./scopes.js";

const now = () => new Date().toISOString();
const plus = (milliseconds: number) => new Date(Date.now() + milliseconds).toISOString();

export type AgentAuthFailure =
  | VerifyFailure
  | "missing_credential"
  | "unknown_grant"
  | "unknown_principal";

export interface AgentAuthResult {
  ok: boolean;
  actor?: AgentActor;
  reason?: AgentAuthFailure;
  fingerprint: string | null;
}

/**
 * IdentityService
 * ===============
 *
 * Owns the identity plane: humans, their sessions, Agent principals, the
 * delegation grants between them, action tokens, approvals, and the
 * authorization entry point every other component calls.
 *
 * Nothing else in the platform is allowed to make an access decision.
 * Routes and services ask this object and act on the answer.
 */
export class IdentityService {
  readonly audit: AuditLog;

  constructor(
    private readonly config: AppConfig,
    private readonly store: JsonStore,
  ) {
    this.audit = new AuditLog(store);
  }

  /* ---------------------------------------------------------------- *
   * Humans and sessions
   * ---------------------------------------------------------------- */

  listUsers(): Array<Pick<User, "id" | "username" | "displayName" | "role" | "scopes">> {
    return this.store.snapshot().users.map((user) => ({
      id: user.id,
      username: user.username,
      displayName: user.displayName,
      role: user.role,
      scopes: user.scopes,
    }));
  }

  getUser(id: string): User | null {
    return this.store.snapshot().users.find((user) => user.id === id) ?? null;
  }

  async login(username: string, password: string): Promise<{ token: string; user: User }> {
    const user = this.store
      .snapshot()
      .users.find((item) => item.username.toLowerCase() === username.trim().toLowerCase());

    // Always run the KDF so a missing user and a wrong password cost the
    // same wall-clock time.
    const reference = user ?? {
      passwordHash: sha256("absent"),
      passwordSalt: "absent",
    };
    const valid =
      verifyPassword(password, reference.passwordHash, reference.passwordSalt) &&
      user !== undefined &&
      !user.disabledAt;

    if (!user || !valid) {
      await this.audit.recordAnonymousDenial({
        action: "session.create",
        resourceType: "session",
        resourceId: null,
        reason: user ? "bad_password" : "unknown_user",
        detail: "Failed sign-in for " + username.slice(0, 40),
        tokenFingerprint: null,
      });
      throw new HttpError(401, "Invalid username or password");
    }

    const secret = newSecret(32);
    const session: Session = {
      id: newId(),
      userId: user.id,
      tokenHash: sha256(secret),
      createdAt: now(),
      expiresAt: plus(this.config.sessionTtlMs),
      revokedAt: null,
      lastSeenAt: now(),
    };
    await this.store.mutate((database) => database.sessions.push(session));
    await this.audit.record({
      runId: null,
      actorUserId: user.id,
      agentPrincipalId: null,
      agentId: null,
      principalKind: "human",
      action: "session.create",
      resourceType: "session",
      resourceId: session.id,
      decision: "allow",
      reason: "password_accepted",
      detail: "Signed in as " + user.username,
      scopes: user.scopes,
      grantId: null,
      tokenFingerprint: fingerprint(secret),
    });
    // The raw secret is returned once and never stored.
    return { token: session.id + "." + secret, user };
  }

  async logout(sessionId: string): Promise<void> {
    await this.store.mutate((database) => {
      const session = database.sessions.find((item) => item.id === sessionId);
      if (session) session.revokedAt = now();
    });
  }

  /** Resolve a control-plane bearer value into a human actor. */
  resolveHumanActor(bearer: string): HumanActor | null {
    const separator = bearer.indexOf(".");
    if (separator <= 0) return null;
    const sessionId = bearer.slice(0, separator);
    const secret = bearer.slice(separator + 1);
    const database = this.store.snapshot();
    const session = database.sessions.find((item) => item.id === sessionId);
    if (!session || session.revokedAt) return null;
    if (new Date(session.expiresAt).getTime() <= Date.now()) return null;
    if (session.tokenHash !== sha256(secret)) return null;
    const user = database.users.find((item) => item.id === session.userId);
    if (!user || user.disabledAt) return null;
    return {
      kind: "human",
      userId: user.id,
      username: user.username,
      role: user.role,
      scopes: user.scopes,
      sessionId: session.id,
    };
  }

  /* ---------------------------------------------------------------- *
   * Agent principals
   * ---------------------------------------------------------------- */

  async createPrincipal(agentId: string, ownerId: string): Promise<AgentPrincipal> {
    const principal: AgentPrincipal = {
      id: newId(),
      agentId,
      ownerId,
      name: "agent/" + agentId.slice(0, 8),
      generation: 1,
      revokedAt: null,
      createdAt: now(),
      rotatedAt: null,
    };
    await this.store.mutate((database) => database.principals.push(principal));
    return principal;
  }

  getPrincipal(id: string): AgentPrincipal | null {
    return this.store.snapshot().principals.find((item) => item.id === id) ?? null;
  }

  getPrincipalForAgent(agentId: string): AgentPrincipal | null {
    return this.store.snapshot().principals.find((item) => item.agentId === agentId) ?? null;
  }

  /**
   * Rotation bumps the generation. Every grant is bound to the generation
   * it was issued under, so rotation invalidates all outstanding authority
   * for this Agent in one atomic step - without deleting the grant
   * records, which stay readable as history.
   */
  async rotatePrincipal(agentId: string): Promise<AgentPrincipal> {
    return this.store.mutate((database) => {
      const principal = database.principals.find((item) => item.agentId === agentId);
      if (!principal) throw new HttpError(404, "Agent principal not found");
      principal.generation += 1;
      principal.rotatedAt = now();
      principal.revokedAt = null;
      return structuredClone(principal);
    });
  }

  async revokePrincipal(agentId: string): Promise<void> {
    await this.store.mutate((database) => {
      const principal = database.principals.find((item) => item.agentId === agentId);
      if (principal) principal.revokedAt = now();
    });
  }

  /* ---------------------------------------------------------------- *
   * Delegation grants
   * ---------------------------------------------------------------- */

  listGrants(userId: string): DelegationGrant[] {
    return this.store
      .snapshot()
      .grants.filter((grant) => grant.subjectUserId === userId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  listGrantsForAgent(agentId: string): DelegationGrant[] {
    const principal = this.getPrincipalForAgent(agentId);
    if (!principal) return [];
    return this.store
      .snapshot()
      .grants.filter((grant) => grant.agentPrincipalId === principal.id)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  getGrant(id: string): DelegationGrant | null {
    return this.store.snapshot().grants.find((item) => item.id === id) ?? null;
  }

  /**
   * Issue a delegation. Three invariants are enforced here and they are
   * the reason a grant can never be an escalation path:
   *
   *   1. Only data-plane scopes may be delegated at all.
   *   2. The requested scopes must be a subset of the delegator's own.
   *   3. The grant reaches the delegator's resources and nobody else's.
   */
  async createGrant(
    actor: HumanActor,
    input: { agentId: string; scopes: string[]; ttlMinutes?: number },
  ): Promise<DelegationGrant> {
    const principal = this.getPrincipalForAgent(input.agentId);
    if (!principal) throw new HttpError(404, "Agent principal not found");
    if (principal.ownerId !== actor.userId) {
      throw new HttpError(404, "Agent not found");
    }
    const scopes = normalizeScopes(input.scopes);
    if (scopes.length === 0) throw new HttpError(400, "At least one scope is required");

    const notDelegatable = scopes.filter((scope) => !isDelegatable(scope));
    if (notDelegatable.length > 0) {
      await this.audit.record({
        runId: null,
        actorUserId: actor.userId,
        agentPrincipalId: principal.id,
        agentId: input.agentId,
        principalKind: "human",
        action: "grant.create",
        resourceType: "grant",
        resourceId: null,
        decision: "deny",
        reason: "scope_not_delegatable",
        detail: "Refused to delegate control-plane scopes: " + notDelegatable.join(", "),
        scopes,
        grantId: null,
        tokenFingerprint: null,
      });
      throw new HttpError(
        400,
        "These scopes may never be delegated to an Agent: " + notDelegatable.join(", "),
      );
    }

    const user = this.getUser(actor.userId);
    if (!user) throw new HttpError(401, "Unknown user");
    if (!isSubsetOf(scopes, user.scopes)) {
      await this.audit.record({
        runId: null,
        actorUserId: actor.userId,
        agentPrincipalId: principal.id,
        agentId: input.agentId,
        principalKind: "human",
        action: "grant.create",
        resourceType: "grant",
        resourceId: null,
        decision: "deny",
        reason: "scope_exceeds_delegator",
        detail: "Cannot delegate authority the delegator does not hold",
        scopes,
        grantId: null,
        tokenFingerprint: null,
      });
      throw new HttpError(403, "You cannot delegate a scope you do not hold");
    }

    const ttlMinutes = Math.min(
      Math.max(input.ttlMinutes ?? this.config.grantDefaultTtlMinutes, 1),
      this.config.grantMaxTtlMinutes,
    );
    const grant: DelegationGrant = {
      id: newId(),
      agentPrincipalId: principal.id,
      principalGeneration: principal.generation,
      subjectUserId: actor.userId,
      resourceOwnerId: actor.userId,
      scopes,
      createdBy: actor.userId,
      createdAt: now(),
      expiresAt: plus(ttlMinutes * 60_000),
      revokedAt: null,
      revokedBy: null,
      revokedReason: null,
    };
    await this.store.mutate((database) => database.grants.push(grant));
    await this.audit.record({
      runId: null,
      actorUserId: actor.userId,
      agentPrincipalId: principal.id,
      agentId: input.agentId,
      principalKind: "human",
      action: "grant.create",
      resourceType: "grant",
      resourceId: grant.id,
      decision: "allow",
      reason: "grant_issued",
      detail:
        "Delegated [" + scopes.join(", ") + "] for " + ttlMinutes + " minutes, expiring " + grant.expiresAt,
      scopes,
      grantId: grant.id,
      tokenFingerprint: null,
    });
    return grant;
  }

  async revokeGrant(actor: HumanActor, grantId: string, reason: string): Promise<DelegationGrant> {
    const existing = this.getGrant(grantId);
    if (!existing || existing.subjectUserId !== actor.userId) {
      throw new HttpError(404, "Grant not found");
    }
    const updated = await this.store.mutate((database) => {
      const grant = database.grants.find((item) => item.id === grantId);
      if (!grant) throw new HttpError(404, "Grant not found");
      if (!grant.revokedAt) {
        grant.revokedAt = now();
        grant.revokedBy = actor.userId;
        grant.revokedReason = reason.slice(0, 200);
      }
      return structuredClone(grant);
    });
    await this.audit.record({
      runId: null,
      actorUserId: actor.userId,
      agentPrincipalId: updated.agentPrincipalId,
      agentId: null,
      principalKind: "human",
      action: "grant.revoke",
      resourceType: "grant",
      resourceId: grantId,
      decision: "allow",
      reason: "grant_revoked",
      detail: "Revoked by " + actor.username + ": " + reason.slice(0, 120),
      scopes: updated.scopes,
      grantId,
      tokenFingerprint: null,
    });
    return updated;
  }

  /** The newest grant that is currently usable for this Agent. */
  activeGrantForAgent(agentId: string, subjectUserId: string): DelegationGrant | null {
    const principal = this.getPrincipalForAgent(agentId);
    if (!principal || principal.revokedAt) return null;
    const timestamp = Date.now();
    const matches = this.store
      .snapshot()
      .grants.filter(
        (grant) =>
          grant.agentPrincipalId === principal.id &&
          grant.subjectUserId === subjectUserId &&
          grant.principalGeneration === principal.generation &&
          !grant.revokedAt &&
          new Date(grant.expiresAt).getTime() > timestamp,
      );
    /**
     * The store only ever appends grants (see JsonStore.mutate and
     * createGrant), so array order IS chronological order. Picking the
     * last match is therefore always the most recently issued grant.
     *
     * This deliberately does NOT sort by `createdAt`. Two grants can be
     * issued within the same millisecond - e.g. the default read-only
     * grant createAgent issues, followed immediately by a wider grant the
     * owner requests - and Array.sort is stable, so a comparator that
     * treats equal timestamps as a tie leaves the OLDER, narrower grant in
     * position [0]. On fast hardware that collision is common, not
     * theoretical: it is exactly what made a freshly issued docs:write
     * grant lose to the original docs:read grant here.
     */
    return matches.at(-1) ?? null;
  }

  /* ---------------------------------------------------------------- *
   * Action tokens
   * ---------------------------------------------------------------- */

  /**
   * Mint the credential the Agent Runtime will carry for one Run.
   *
   * Lifetime is the shorter of the configured TTL, the remaining life of
   * the grant, and the Run timeout. A credential that outlives its
   * purpose is a credential waiting to be stolen.
   */
  mintForRun(input: {
    agentId: string;
    runId: string;
    subjectUserId: string;
    grant: DelegationGrant;
  }): { token: string; claims: ActionTokenClaims } | null {
    const principal = this.getPrincipalForAgent(input.agentId);
    if (!principal || principal.revokedAt) return null;

    const grantRemainingSeconds = Math.floor(
      (new Date(input.grant.expiresAt).getTime() - Date.now()) / 1000,
    );
    const ttlSeconds = Math.max(
      30,
      Math.min(
        this.config.actionTokenTtlSeconds,
        grantRemainingSeconds,
        Math.ceil(this.config.codexTimeoutMs / 1000),
      ),
    );
    return mintActionToken(this.config.tokenSecret, {
      subjectUserId: input.subjectUserId,
      agentPrincipalId: principal.id,
      agentId: input.agentId,
      generation: principal.generation,
      grantId: input.grant.id,
      runId: input.runId,
      scopes: input.grant.scopes,
      audience: RESOURCE_API_AUDIENCE,
      ttlSeconds,
    });
  }

  /**
   * Resolve a resource-server bearer value into an Agent actor. This only
   * proves the credential is authentic, unexpired and addressed to this
   * audience. Authority is decided afterwards by `authorize`.
   */
  resolveAgentActor(bearer: string): AgentAuthResult {
    if (!bearer) return { ok: false, reason: "missing_credential", fingerprint: null };
    const print = fingerprint(bearer);
    const verified = verifyActionToken(this.config.tokenSecret, bearer, RESOURCE_API_AUDIENCE);
    if (!verified.ok) return { ok: false, reason: verified.reason, fingerprint: print };
    const claims = verified.claims;
    const principal = this.getPrincipal(claims.act.sub);
    if (!principal) return { ok: false, reason: "unknown_principal", fingerprint: print };
    const grant = this.getGrant(claims.grant_id);
    if (!grant) return { ok: false, reason: "unknown_grant", fingerprint: print };
    return {
      ok: true,
      fingerprint: print,
      actor: {
        kind: "agent",
        subjectUserId: claims.sub,
        agentPrincipalId: claims.act.sub,
        agentId: claims.act.agent_id,
        grantId: claims.grant_id,
        scopes: claims.scope,
        runId: claims.run_id,
        tokenId: claims.jti,
        tokenFingerprint: print,
      },
    };
  }

  /* ---------------------------------------------------------------- *
   * Approvals
   * ---------------------------------------------------------------- */

  listApprovals(userId: string): ApprovalRequest[] {
    return this.store
      .snapshot()
      .approvals.filter((item) => item.subjectUserId === userId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  getApproval(id: string): ApprovalRequest | null {
    return this.store.snapshot().approvals.find((item) => item.id === id) ?? null;
  }

  findApproval(input: {
    runId: string;
    action: string;
    resourceId: string;
    paramsHash: string;
  }): ApprovalRequest | null {
    // Same reasoning as activeGrantForAgent: the store only appends, so
    // array order is already chronological. Walking from the end finds
    // the most recent match without comparing millisecond-resolution
    // timestamps, which can tie.
    const candidates = this.store
      .snapshot()
      .approvals.filter(
        (item) =>
          item.runId === input.runId &&
          item.action === input.action &&
          item.resourceId === input.resourceId &&
          item.paramsHash === input.paramsHash,
      );
    /**
     * A consumed approval is not an approval any more. Ignoring it here
     * means an identical repeat of an approved action asks the human
     * again rather than riding on the earlier decision: approval is
     * per-action, not per-shape.
     */
    for (let index = candidates.length - 1; index >= 0; index -= 1) {
      const candidate = candidates[index];
      if (candidate && !candidate.consumedAt) return candidate;
    }
    return null;
  }

  async requestApproval(input: {
    actor: AgentActor;
    action: string;
    resourceId: string;
    params: unknown;
    preview: string;
  }): Promise<ApprovalRequest> {
    const approval: ApprovalRequest = {
      id: newId(),
      runId: input.actor.runId,
      agentPrincipalId: input.actor.agentPrincipalId,
      subjectUserId: input.actor.subjectUserId,
      action: input.action,
      resourceId: input.resourceId,
      paramsHash: hashParams(input.params),
      paramsPreview: input.preview,
      status: "pending",
      createdAt: now(),
      expiresAt: plus(this.config.approvalTtlSeconds * 1_000),
      decidedAt: null,
      decidedBy: null,
      consumedAt: null,
    };
    await this.store.mutate((database) => database.approvals.push(approval));
    return approval;
  }

  async decideApproval(
    actor: HumanActor,
    approvalId: string,
    approved: boolean,
  ): Promise<ApprovalRequest> {
    const existing = this.getApproval(approvalId);
    if (!existing || existing.subjectUserId !== actor.userId) {
      throw new HttpError(404, "Approval request not found");
    }
    const updated = await this.store.mutate((database) => {
      const approval = database.approvals.find((item) => item.id === approvalId);
      if (!approval) throw new HttpError(404, "Approval request not found");
      if (approval.status !== "pending") {
        throw new HttpError(409, "This approval was already decided");
      }
      if (new Date(approval.expiresAt).getTime() <= Date.now()) {
        approval.status = "expired";
        throw new HttpError(409, "This approval request expired");
      }
      approval.status = approved ? "approved" : "denied";
      approval.decidedAt = now();
      approval.decidedBy = actor.userId;
      return structuredClone(approval);
    });
    await this.audit.record({
      runId: updated.runId,
      actorUserId: actor.userId,
      agentPrincipalId: updated.agentPrincipalId,
      agentId: null,
      principalKind: "human",
      action: "approval.decide",
      resourceType: "approval",
      resourceId: approvalId,
      decision: approved ? "allow" : "deny",
      reason: approved ? "approval_granted" : "approval_refused",
      detail:
        actor.username +
        " " +
        (approved ? "approved" : "denied") +
        " " +
        updated.action +
        " on " +
        updated.resourceId,
      scopes: [],
      grantId: null,
      tokenFingerprint: null,
    });
    return updated;
  }

  async consumeApproval(approvalId: string): Promise<void> {
    await this.store.mutate((database) => {
      const approval = database.approvals.find((item) => item.id === approvalId);
      if (approval && !approval.consumedAt) approval.consumedAt = now();
    });
  }

  async expireStaleApprovals(): Promise<void> {
    const timestamp = Date.now();
    await this.store.mutate((database) => {
      for (const approval of database.approvals) {
        if (approval.status === "pending" && new Date(approval.expiresAt).getTime() <= timestamp) {
          approval.status = "expired";
        }
      }
    });
  }

  /* ---------------------------------------------------------------- *
   * The single authorization entry point
   * ---------------------------------------------------------------- */

  /**
   * Build the live context, ask the policy engine, write the audit record,
   * return the decision. Callers never see a decision that was not logged.
   */
  async authorize(
    request: PolicyRequest,
    options: { paramsHash?: string | null; approvalId?: string | null } = {},
  ): Promise<PolicyDecision> {
    const database = this.store.snapshot();
    const actor = request.actor;
    const subjectId = actor.kind === "human" ? actor.userId : actor.subjectUserId;

    let run: AgentRun | null = null;
    let principal: AgentPrincipal | null = null;
    let grant: DelegationGrant | null = null;
    let approval: ApprovalRequest | null = null;
    let agentId: string | null = null;

    if (actor.kind === "agent") {
      agentId = actor.agentId;
      principal = database.principals.find((item) => item.id === actor.agentPrincipalId) ?? null;
      grant = database.grants.find((item) => item.id === actor.grantId) ?? null;
      run = database.runs.find((item) => item.id === actor.runId) ?? null;
      if (options.approvalId) {
        approval = database.approvals.find((item) => item.id === options.approvalId) ?? null;
      } else if (options.paramsHash && request.resourceId) {
        approval = this.findApproval({
          runId: actor.runId,
          action: request.action,
          resourceId: request.resourceId,
          paramsHash: options.paramsHash,
        });
      }
    } else if (request.resourceType === "agent" && request.resourceId) {
      agentId = request.resourceId;
    }

    const context: PolicyContext = {
      subjectUser: database.users.find((item) => item.id === subjectId) ?? null,
      agent: agentId ? (database.agents.find((item) => item.id === agentId) ?? null) : null,
      principal,
      grant,
      run,
      approval,
      now: new Date(),
    };

    const decision = decide(
      options.paramsHash === undefined
        ? request
        : { ...request, paramsHash: options.paramsHash },
      context,
    );
    await this.audit.recordDecision(request, decision);
    return decision;
  }

  /** Throwing variant for control-plane routes. */
  async require(request: PolicyRequest): Promise<PolicyDecision> {
    const decision = await this.authorize(request);
    if (decision.effect !== "allow") {
      // Ownership failures are reported as 404 so the API does not confirm
      // that another user's resource exists. The audit log keeps the real
      // reason for the operator.
      const hidden = decision.reason === "not_owner" || decision.reason === "cross_user_denied";
      throw new HttpError(hidden ? 404 : 403, hidden ? "Not found" : decision.detail);
    }
    return decision;
  }
}

export type { Actor, PolicyDecision };
