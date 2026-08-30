export type AgentStatus = "ready" | "busy" | "stopped" | "error";
export type RunStatus = "queued" | "running" | "completed" | "failed" | "cancelled";
export type MessageRole = "user" | "assistant";

/* ------------------------------------------------------------------ *
 * Identity plane
 * ------------------------------------------------------------------ */

/**
 * Every authenticated caller in the platform is a Principal. Two kinds
 * exist and they are deliberately NOT interchangeable:
 *
 *  - "human"  : a person operating the control plane through the browser.
 *  - "agent"  : an Agent principal that acts *on behalf of* a human but
 *               carries its own identifier, its own lifecycle, and its own
 *               revocation switch.
 *
 * The Starter Kit had a single shared bearer token, which is neither.
 */
export type PrincipalKind = "human" | "agent";

export type UserRole = "operator" | "admin";

export interface User {
  id: string;
  username: string;
  displayName: string;
  role: UserRole;
  /** scrypt(password, salt) - never the password itself. */
  passwordHash: string;
  passwordSalt: string;
  /** The maximum scope set this human may ever hold or delegate. */
  scopes: string[];
  disabledAt: string | null;
  createdAt: string;
}

export interface Session {
  id: string;
  userId: string;
  /** sha256 of the bearer value. The usable credential never touches disk. */
  tokenHash: string;
  createdAt: string;
  expiresAt: string;
  revokedAt: string | null;
  lastSeenAt: string;
}

/**
 * The Agent's own identity. Created with the Agent, rotatable and
 * revocable independently of the human who owns it.
 */
export interface AgentPrincipal {
  id: string;
  agentId: string;
  /** The human who owns this Agent principal. */
  ownerId: string;
  /** Stable name used in audit records, e.g. "agent/3f2a...". */
  name: string;
  /** Bumped on rotation; old delegation grants become unusable. */
  generation: number;
  revokedAt: string | null;
  createdAt: string;
  rotatedAt: string | null;
}

/**
 * A scoped, time-bound, revocable statement that a human lets an Agent
 * principal act for them against a bounded set of resources.
 *
 * Invariants enforced at creation time:
 *  - scopes must be a subset of the delegating human's own scopes
 *  - resourceOwnerId must equal subjectUserId (you cannot delegate access
 *    to somebody else's data)
 */
export interface DelegationGrant {
  id: string;
  agentPrincipalId: string;
  /** Bound to the principal generation at issuance. Rotation invalidates. */
  principalGeneration: number;
  /** The human on whose behalf the Agent will act (the "sub"). */
  subjectUserId: string;
  /** Whose resources this grant reaches. Always === subjectUserId. */
  resourceOwnerId: string;
  scopes: string[];
  createdBy: string;
  createdAt: string;
  expiresAt: string;
  revokedAt: string | null;
  revokedBy: string | null;
  revokedReason: string | null;
}

export type ApprovalStatus = "pending" | "approved" | "denied" | "expired";

/**
 * A human-in-the-loop gate for a high-risk action. The approval is bound
 * to the exact action, resource and normalized parameters, so approving
 * "write doc-a1" can never be replayed as "write doc-a2".
 */
export interface ApprovalRequest {
  id: string;
  runId: string;
  agentPrincipalId: string;
  subjectUserId: string;
  action: string;
  resourceId: string;
  /** sha256 of the canonicalized parameters. Binds approval to payload. */
  paramsHash: string;
  paramsPreview: string;
  status: ApprovalStatus;
  createdAt: string;
  expiresAt: string;
  decidedAt: string | null;
  decidedBy: string | null;
  /** Set once the approved action has actually been performed. */
  consumedAt: string | null;
}

export type AuditDecision = "allow" | "deny" | "pending";

/**
 * One append-only record per authorization decision. Contains the five
 * things an operator needs: who asked, what acted, what was requested,
 * what was decided, and why.
 */
export interface AuditEvent {
  id: string;
  at: string;
  /** Correlates every event produced by one Run. */
  runId: string | null;
  /** The initiating human (the "sub" of the delegation chain). */
  actorUserId: string | null;
  /** The executing Agent principal, when the actor was an Agent. */
  agentPrincipalId: string | null;
  agentId: string | null;
  principalKind: PrincipalKind | "anonymous";
  action: string;
  resourceType: string;
  resourceId: string | null;
  decision: AuditDecision;
  /** Machine-readable reason code, e.g. "grant_revoked". */
  reason: string;
  /** Human-readable detail, already redacted. */
  detail: string;
  scopes: string[];
  grantId: string | null;
  /** sha256 prefix of the presented token. Never the token itself. */
  tokenFingerprint: string | null;
}

/* ------------------------------------------------------------------ *
 * Protected resources (mock, but genuinely enforced)
 * ------------------------------------------------------------------ */

export interface Document {
  id: string;
  ownerId: string;
  title: string;
  body: string;
  classification: "internal" | "confidential";
  updatedAt: string;
  updatedBy: string | null;
}

/* ------------------------------------------------------------------ *
 * Existing platform entities
 * ------------------------------------------------------------------ */

export interface Agent {
  id: string;
  /** Added: every Agent now has exactly one owning human. */
  ownerId: string;
  /** Added: the Agent's own principal id. */
  principalId: string;
  name: string;
  description: string;
  instructions: string;
  status: AgentStatus;
  workspacePath: string;
  codexThreadId: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Message {
  id: string;
  agentId: string;
  runId: string;
  role: MessageRole;
  content: string;
  createdAt: string;
}

export interface RunUsage {
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
}

export interface AgentRun {
  id: string;
  agentId: string;
  status: RunStatus;
  prompt: string;
  output: string | null;
  error: string | null;
  usage: RunUsage | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  /** Added: the human who initiated this Run. */
  initiatedBy: string | null;
  /** Added: the grant whose authority this Run carried. */
  grantId: string | null;
  /** Added: jti of the action token minted for this Run. */
  actionTokenId: string | null;
}

export interface Database {
  version: 2;
  users: User[];
  sessions: Session[];
  principals: AgentPrincipal[];
  grants: DelegationGrant[];
  approvals: ApprovalRequest[];
  audit: AuditEvent[];
  documents: Document[];
  agents: Agent[];
  messages: Message[];
  runs: AgentRun[];
}

export interface CreateAgentInput {
  name: string;
  description?: string | undefined;
  instructions?: string | undefined;
}

export interface UpdateAgentInput {
  name?: string | undefined;
  description?: string | undefined;
  instructions?: string | undefined;
}

export interface RunnerResult {
  output: string;
  threadId: string | null;
  usage: RunUsage | null;
}

export interface RunnerRequest {
  agentId: string;
  workspacePath: string;
  prompt: string;
  threadId: string | null;
  /**
   * Added seam: request-scoped credentials handed to the Runtime for this
   * turn only. Never persisted, never written into the workspace.
   */
  credentials?: Record<string, string> | undefined;
}

export interface AgentRunner {
  run(request: RunnerRequest): Promise<RunnerResult>;
  cancel(agentId: string): Promise<boolean>;
  isAvailable(): Promise<boolean>;
}

/* ------------------------------------------------------------------ *
 * Authorization request/response contract
 * ------------------------------------------------------------------ */

export interface HumanActor {
  kind: "human";
  userId: string;
  username: string;
  role: UserRole;
  scopes: string[];
  sessionId: string;
}

export interface AgentActor {
  kind: "agent";
  /** The human this Agent is acting for. */
  subjectUserId: string;
  agentPrincipalId: string;
  agentId: string;
  grantId: string;
  scopes: string[];
  runId: string;
  tokenId: string;
  tokenFingerprint: string;
}

export type Actor = HumanActor | AgentActor;
