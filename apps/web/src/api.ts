import type {
  Agent,
  AgentPrincipal,
  AgentRun,
  ApprovalRequest,
  AuditEvent,
  DelegationGrant,
  DelegationSummary,
  Message,
  ProtectedDocument,
  SessionUser,
  SystemInfo,
} from "./types";

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly reason?: string,
  ) {
    super(message);
  }
}

/**
 * The browser holds a human SESSION token and nothing else. It never sees
 * an Action Token, and there is no browser call that could forward one:
 * delegated credentials are minted server-side and handed straight to the
 * Runtime.
 */
let sessionToken = "";
const STORAGE_KEY = "launchpad.session";

export function setSessionToken(token: string): void {
  sessionToken = token.trim();
  try {
    if (sessionToken) window.sessionStorage.setItem(STORAGE_KEY, sessionToken);
    else window.sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    /* storage is a convenience, never a requirement */
  }
}

export function restoreSessionToken(): string {
  try {
    sessionToken = window.sessionStorage.getItem(STORAGE_KEY) ?? "";
  } catch {
    sessionToken = "";
  }
  return sessionToken;
}

async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const headers = {
    ...(options?.body ? { "Content-Type": "application/json" } : {}),
    ...(sessionToken ? { Authorization: "Bearer " + sessionToken } : {}),
    ...options?.headers,
  };
  const response = await fetch(url, { ...options, headers });
  const data = (await response.json().catch(() => ({}))) as T & {
    error?: string;
    reason?: string;
  };
  if (!response.ok) {
    throw new ApiError(data.error ?? "Request failed", response.status, data.reason);
  }
  return data;
}

export const api = {
  auth: () => request<{ required: boolean; mode: string }>("/api/auth"),
  login: (username: string, password: string) =>
    request<{ token: string; user: { id: string; username: string; role: string; scopes: string[] } }>(
      "/api/auth/login",
      { method: "POST", body: JSON.stringify({ username, password }) },
    ),
  logout: () => request<{ ok: boolean }>("/api/auth/logout", { method: "POST" }),
  me: () => request<{ user: SessionUser }>("/api/auth/me"),
  system: () => request<SystemInfo>("/api/system"),

  listAgents: () => request<{ agents: Agent[] }>("/api/agents"),
  createAgent: (body: { name: string; description: string; instructions: string }) =>
    request<{ agent: Agent }>("/api/agents", { method: "POST", body: JSON.stringify(body) }),
  updateAgent: (id: string, body: { name: string; description: string; instructions: string }) =>
    request<{ agent: Agent }>("/api/agents/" + id, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  deleteAgent: (id: string) =>
    request<{ archivedWorkspace: string }>("/api/agents/" + id, { method: "DELETE" }),
  startAgent: (id: string) =>
    request<{ agent: Agent }>("/api/agents/" + id + "/start", { method: "POST" }),
  stopAgent: (id: string) =>
    request<{ agent: Agent }>("/api/agents/" + id + "/stop", { method: "POST" }),
  messages: (id: string) => request<{ messages: Message[] }>("/api/agents/" + id + "/messages"),
  runs: (id: string) => request<{ runs: AgentRun[] }>("/api/agents/" + id + "/runs"),
  sendMessage: (id: string, content: string) =>
    request<{ run: AgentRun; message: Message; delegation: DelegationSummary }>(
      "/api/agents/" + id + "/messages",
      { method: "POST", body: JSON.stringify({ content }) },
    ),
  run: (id: string) => request<{ run: AgentRun }>("/api/runs/" + id),

  identity: (agentId: string) =>
    request<{ principal: AgentPrincipal | null; grants: DelegationGrant[] }>(
      "/api/agents/" + agentId + "/identity",
    ),
  rotatePrincipal: (agentId: string) =>
    request<{ principal: AgentPrincipal }>("/api/agents/" + agentId + "/identity/rotate", {
      method: "POST",
    }),
  createGrant: (body: { agentId: string; scopes: string[]; ttlMinutes?: number }) =>
    request<{ grant: DelegationGrant }>("/api/grants", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  revokeGrant: (id: string, reason: string) =>
    request<{ grant: DelegationGrant }>("/api/grants/" + id + "/revoke", {
      method: "POST",
      body: JSON.stringify({ reason }),
    }),

  approvals: () => request<{ approvals: ApprovalRequest[] }>("/api/approvals"),
  decideApproval: (id: string, approved: boolean) =>
    request<{ approval: ApprovalRequest }>("/api/approvals/" + id, {
      method: "POST",
      body: JSON.stringify({ approved }),
    }),

  audit: (params: { agentId?: string; runId?: string; limit?: number } = {}) => {
    const query = new URLSearchParams();
    if (params.agentId) query.set("agentId", params.agentId);
    if (params.runId) query.set("runId", params.runId);
    query.set("limit", String(params.limit ?? 100));
    return request<{ events: AuditEvent[] }>("/api/audit?" + query.toString());
  },

  myDocuments: () => request<{ documents: ProtectedDocument[] }>("/api/my/documents"),
};
