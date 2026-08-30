export type AgentStatus = "ready" | "busy" | "stopped" | "error";
export type RunStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

export interface SessionUser {
  userId: string;
  username: string;
  role: "operator" | "admin";
  scopes: string[];
}

export interface Agent {
  id: string;
  ownerId: string;
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

export interface AgentPrincipal {
  id: string;
  agentId: string;
  ownerId: string;
  name: string;
  generation: number;
  revokedAt: string | null;
  createdAt: string;
  rotatedAt: string | null;
}

export interface DelegationGrant {
  id: string;
  agentPrincipalId: string;
  principalGeneration: number;
  subjectUserId: string;
  resourceOwnerId: string;
  scopes: string[];
  createdAt: string;
  expiresAt: string;
  revokedAt: string | null;
  revokedReason: string | null;
}

export interface ApprovalRequest {
  id: string;
  runId: string;
  agentPrincipalId: string;
  subjectUserId: string;
  action: string;
  resourceId: string;
  paramsPreview: string;
  status: "pending" | "approved" | "denied" | "expired";
  createdAt: string;
  expiresAt: string;
  decidedAt: string | null;
}

export interface AuditEvent {
  id: string;
  at: string;
  runId: string | null;
  actorUserId: string | null;
  agentPrincipalId: string | null;
  agentId: string | null;
  principalKind: "human" | "agent" | "anonymous";
  action: string;
  resourceType: string;
  resourceId: string | null;
  decision: "allow" | "deny" | "pending";
  reason: string;
  detail: string;
  scopes: string[];
  grantId: string | null;
  tokenFingerprint: string | null;
}

export interface ProtectedDocument {
  id: string;
  ownerId: string;
  title: string;
  body: string;
  classification: "internal" | "confidential";
  updatedAt: string;
  updatedBy: string | null;
}

export interface Message {
  id: string;
  agentId: string;
  runId: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
}

export interface AgentRun {
  id: string;
  agentId: string;
  status: RunStatus;
  prompt: string;
  output: string | null;
  error: string | null;
  usage: {
    inputTokens?: number;
    cachedInputTokens?: number;
    outputTokens?: number;
  } | null;
  createdAt: string;
  initiatedBy: string | null;
  grantId: string | null;
  actionTokenId: string | null;
}

export interface DelegationSummary {
  granted: boolean;
  grantId: string | null;
  scopes: string[];
  tokenId: string | null;
  expiresAt: string | null;
}

export interface SystemInfo {
  arkConfigured: boolean;
  arkBaseUrl: string;
  arkModel: string | null;
  codexAvailable: boolean;
  codexSandboxMode: string;
  runtimeProvider: "local-process" | "container";
  containerEngine: string | null;
  runtime: string;
  identity?: {
    enabled: boolean;
    actionTokenTtlSeconds: number;
    grantDefaultTtlMinutes: number;
    approvalTtlSeconds: number;
    tokenSecretPinned: boolean;
  };
}

export const RESOURCE_SCOPES = ["docs:read", "docs:write", "docs:delete"] as const;
