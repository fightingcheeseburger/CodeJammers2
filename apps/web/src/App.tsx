import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError, restoreSessionToken, setSessionToken } from "./api";
import { ApprovalInbox } from "./components/ApprovalInbox";
import { AuditPanel } from "./components/AuditPanel";
import { IdentityPanel } from "./components/IdentityPanel";
import { LoginScreen } from "./components/LoginScreen";
import type {
  Agent,
  AgentRun,
  DelegationSummary,
  Message,
  ProtectedDocument,
  SessionUser,
  SystemInfo,
} from "./types";

const starterPrompts = [
  "List the documents you can reach and summarise them.",
  "Read doc-b1 and tell me what it says.",
  "Rewrite doc-a1 with a two-line summary at the top.",
];

const emptyForm = {
  name: "",
  description: "",
  instructions:
    "Help me build and test software in this workspace. Keep changes small and explain the result.",
};

type Tab = "playground" | "identity" | "audit";

function formatTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" }).format(
    new Date(value),
  );
}

function StatusPill({ status }: { status: Agent["status"] }) {
  return (
    <span className={"status status-" + status}>
      <span className="status-dot" />
      {status}
    </span>
  );
}

function Spinner() {
  return <span className="spinner" aria-label="Loading" />;
}

export default function App() {
  const [session, setSession] = useState<SessionUser | null>(null);
  const [booting, setBooting] = useState(true);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [system, setSystem] = useState<SystemInfo | null>(null);
  const [documents, setDocuments] = useState<ProtectedDocument[]>([]);
  const [tab, setTab] = useState<Tab>("playground");
  const [showCreate, setShowCreate] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const [prompt, setPrompt] = useState("");
  const [activeRun, setActiveRun] = useState<AgentRun | null>(null);
  const [delegation, setDelegation] = useState<DelegationSummary | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const messageEnd = useRef<HTMLDivElement>(null);
  const selectedIdRef = useRef<string | null>(null);
  const mountedRef = useRef(true);
  const pollingRunIds = useRef(new Set<string>());
  selectedIdRef.current = selectedId;

  const reportError = useCallback((message: string) => setError(message), []);

  const selected = useMemo(
    () => agents.find((agent) => agent.id === selectedId) ?? null,
    [agents, selectedId],
  );

  const refreshAgents = useCallback(async () => {
    const { agents: next } = await api.listAgents();
    setAgents(next);
    setSelectedId((current) =>
      current && next.some((agent) => agent.id === current) ? current : (next[0]?.id ?? null),
    );
  }, []);

  const refreshMessages = useCallback(async (agentId: string) => {
    const result = await api.messages(agentId);
    if (mountedRef.current && selectedIdRef.current === agentId) setMessages(result.messages);
  }, []);

  const bootstrap = useCallback(async () => {
    const [, systemInfo, mine] = await Promise.all([
      refreshAgents(),
      api.system(),
      api.myDocuments(),
    ]);
    setSystem(systemInfo);
    setDocuments(mine.documents);
  }, [refreshAgents]);

  useEffect(() => {
    mountedRef.current = true;
    const stored = restoreSessionToken();
    if (!stored) {
      setBooting(false);
      return () => {
        mountedRef.current = false;
      };
    }
    void api
      .me()
      .then(async ({ user }) => {
        if (!mountedRef.current) return;
        setSession(user);
        await bootstrap();
      })
      .catch(() => setSessionToken(""))
      .finally(() => mountedRef.current && setBooting(false));
    return () => {
      mountedRef.current = false;
    };
  }, [bootstrap]);

  useEffect(() => {
    setActiveRun(null);
    setDelegation(null);
    setShowSettings(false);
    setTab("playground");
    if (!selectedId) {
      setMessages([]);
      return;
    }
    void Promise.all([refreshMessages(selectedId), api.runs(selectedId)])
      .then(([, result]) => {
        if (selectedIdRef.current !== selectedId) return;
        const latest = result.runs[0] ?? null;
        setActiveRun(latest);
        if (latest && ["queued", "running"].includes(latest.status)) {
          void pollRun(latest.id, selectedId).catch((reason) =>
            setError(reason instanceof Error ? reason.message : String(reason)),
          );
        }
      })
      .catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)));
  }, [refreshMessages, selectedId]);

  useEffect(() => {
    if (selected) {
      setForm({
        name: selected.name,
        description: selected.description,
        instructions: selected.instructions,
      });
    }
  }, [selected]);

  useEffect(() => {
    messageEnd.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, activeRun]);

  const signIn = async (username: string, password: string) => {
    setBusy(true);
    setError(null);
    try {
      const result = await api.login(username, password);
      setSessionToken(result.token);
      const me = await api.me();
      setSession(me.user);
      await bootstrap();
    } catch (reason) {
      if (reason instanceof ApiError && reason.status === 401) {
        setError("Invalid username or password.");
      } else {
        setError(reason instanceof Error ? reason.message : String(reason));
      }
    } finally {
      setBusy(false);
    }
  };

  const signOut = async () => {
    try {
      await api.logout();
    } catch {
      /* the session is being discarded regardless */
    }
    setSessionToken("");
    setSession(null);
    setAgents([]);
    setSelectedId(null);
    setMessages([]);
    setDocuments([]);
  };

  const createAgent = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { agent } = await api.createAgent(form);
      await refreshAgents();
      setSelectedId(agent.id);
      setShowCreate(false);
      setForm(emptyForm);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const saveAgent = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!selected) return;
    setBusy(true);
    setError(null);
    try {
      await api.updateAgent(selected.id, form);
      await refreshAgents();
      setShowSettings(false);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const toggleAgent = async () => {
    if (!selected) return;
    setBusy(true);
    setError(null);
    try {
      if (selected.status === "stopped") await api.startAgent(selected.id);
      else await api.stopAgent(selected.id);
      await refreshAgents();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const deleteAgent = async () => {
    if (!selected) return;
    if (!window.confirm("Delete " + selected.name + "? Its workspace will be archived and its identity revoked.")) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.deleteAgent(selected.id);
      await refreshAgents();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const pollRun = async (runId: string, agentId: string) => {
    if (pollingRunIds.current.has(runId)) return;
    pollingRunIds.current.add(runId);
    try {
      while (mountedRef.current) {
        await new Promise((resolve) => window.setTimeout(resolve, 900));
        if (!mountedRef.current) return;
        const result = await api.run(runId);
        if (selectedIdRef.current === agentId) setActiveRun(result.run);
        if (!["queued", "running"].includes(result.run.status)) {
          await Promise.all([
            refreshMessages(agentId),
            refreshAgents(),
            api.myDocuments().then((result) => setDocuments(result.documents)),
          ]);
          return;
        }
      }
    } finally {
      pollingRunIds.current.delete(runId);
    }
  };

  const sendMessage = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!selected || !prompt.trim()) return;
    const content = prompt.trim();
    setPrompt("");
    setError(null);
    try {
      const result = await api.sendMessage(selected.id, content);
      if (selectedIdRef.current === selected.id) {
        setMessages((current) => [...current, result.message]);
        setActiveRun(result.run);
        setDelegation(result.delegation);
      }
      setAgents((current) =>
        current.map((agent) => (agent.id === selected.id ? { ...agent, status: "busy" } : agent)),
      );
      await pollRun(result.run.id, selected.id);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      setActiveRun(null);
      await refreshAgents();
    }
  };

  if (booting) {
    return (
      <main className="auth-screen">
        <section className="auth-card" aria-live="polite">
          <div className="brand-mark">A</div>
          <span className="eyebrow">Agent Launchpad</span>
          <h1>Connecting to the control plane</h1>
          <Spinner />
        </section>
      </main>
    );
  }

  if (!session) {
    return <LoginScreen onSubmit={(u, p) => void signIn(u, p)} busy={busy} error={error} />;
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">A</div>
          <div>
            <strong>Agent Launchpad</strong>
            <span>
              {system?.runtimeProvider === "container"
                ? "Local container · Codex CLI"
                : "ECS / Docker · Codex CLI"}
            </span>
          </div>
        </div>

        <div className="session-card">
          <div>
            <span className="eyebrow">Signed in</span>
            <strong>{session.username}</strong>
            <span className="session-role">{session.role}</span>
          </div>
          <button className="button button-ghost" onClick={() => void signOut()}>
            Sign out
          </button>
        </div>

        <button
          className="button button-primary create-button"
          onClick={() => {
            setForm(emptyForm);
            setShowCreate(true);
          }}
        >
          <span>＋</span> Create Agent
        </button>

        <div className="sidebar-label">
          <span>Your Agents</span>
          <span>{agents.length}</span>
        </div>
        <nav className="agent-list">
          {agents.map((agent) => (
            <button
              className={"agent-card " + (agent.id === selectedId ? "selected" : "")}
              key={agent.id}
              onClick={() => setSelectedId(agent.id)}
            >
              <div className="agent-avatar">{agent.name.slice(0, 1).toUpperCase()}</div>
              <div className="agent-card-copy">
                <strong>{agent.name}</strong>
                <span>{agent.description || "Coding Agent"}</span>
              </div>
              <span className={"mini-dot mini-" + agent.status} />
            </button>
          ))}
          {agents.length === 0 && (
            <div className="empty-sidebar">
              <span>◇</span>
              Create your first coding Agent.
            </div>
          )}
        </nav>

        <div className="documents-card">
          <span className="eyebrow">Your protected documents</span>
          {documents.map((document) => (
            <div className="document-row" key={document.id}>
              <code>{document.id}</code>
              <span>{document.title}</span>
              {document.updatedBy && <em>last written by {document.updatedBy.slice(0, 12)}…</em>}
            </div>
          ))}
          {documents.length === 0 && <span className="empty-row">None.</span>}
        </div>

        <div className="runtime-card">
          <span className="eyebrow">Runtime</span>
          <strong>{system?.runtime ?? "Checking…"}</strong>
          <span>
            {system?.arkModel ?? "Ark model not configured"}
            {system?.containerEngine ? " · " + system.containerEngine : ""}
          </span>
          {system?.identity && (
            <span>
              action token TTL {system.identity.actionTokenTtlSeconds}s
              {system.identity.tokenSecretPinned ? "" : " · ephemeral signing key"}
            </span>
          )}
        </div>
      </aside>

      <main className="main">
        {!system?.arkConfigured || !system?.codexAvailable ? (
          <div className="config-banner">
            <span>!</span>
            <div>
              <strong>Runtime configuration needed</strong>
              <p>
                {!system?.arkConfigured
                  ? "Set ARK_API_KEY and ARK_MODEL in .env before using the Playground."
                  : system.runtimeProvider === "container"
                    ? "The local container engine or Agent Runtime image is unavailable. Rerun npm run poc."
                    : "Codex CLI was not found. Use the Docker image or install @openai/codex."}
              </p>
            </div>
          </div>
        ) : null}

        {error && (
          <div className="error-banner" role="alert">
            <span>{error}</span>
            <button onClick={() => setError(null)}>×</button>
          </div>
        )}

        {system?.identity?.runtimeMayNotReachHost && (
          <div className="config-banner">
            <span>!</span>
            <div>
              <strong>The Agent Runtime may not be able to reach the resource API</strong>
              <p>
                Runs execute in containers, but the platform is bound to loopback. Docker
                Desktop usually bridges this; Colima, Podman and Linux do not. If a
                delegated call fails to connect, restart with <code>HOST=0.0.0.0</code> —
                the control plane now requires a real session — or use{" "}
                <code>RUNTIME_PROVIDER=local-process</code>. The Runtime is being told to
                call <code>{system.identity.resourceApiForRuntime}</code>.
              </p>
            </div>
          </div>
        )}

        <ApprovalInbox onError={reportError} />

        {selected ? (
          <>
            <header className="agent-header">
              <div>
                <div className="header-title-row">
                  <h1>{selected.name}</h1>
                  <StatusPill status={selected.status} />
                </div>
                <p>{selected.description || "A Codex coding Agent in an isolated workspace."}</p>
              </div>
              <div className="header-actions">
                <button
                  className="button button-ghost"
                  onClick={() => setShowSettings((value) => !value)}
                  disabled={busy || selected.status === "busy"}
                >
                  Settings
                </button>
                <button className="button button-ghost" onClick={toggleAgent} disabled={busy}>
                  {selected.status === "stopped" ? "Start" : "Stop"}
                </button>
                <button
                  className="button button-danger"
                  onClick={deleteAgent}
                  disabled={busy || selected.status === "busy"}
                >
                  Delete
                </button>
              </div>
            </header>

            <nav className="tab-bar">
              {(["playground", "identity", "audit"] as Tab[]).map((item) => (
                <button
                  key={item}
                  className={"tab " + (tab === item ? "selected" : "")}
                  onClick={() => setTab(item)}
                >
                  {item === "playground"
                    ? "Playground"
                    : item === "identity"
                      ? "Identity & delegation"
                      : "Authorization trail"}
                </button>
              ))}
            </nav>

            {showSettings && (
              <form className="settings-panel" onSubmit={saveAgent}>
                <div className="settings-title">
                  <div>
                    <span className="eyebrow">Agent configuration</span>
                    <h2>Instructions and identity</h2>
                  </div>
                  <button type="button" onClick={() => setShowSettings(false)}>
                    ×
                  </button>
                </div>
                <div className="form-grid">
                  <label>
                    Name
                    <input
                      value={form.name}
                      onChange={(event) => setForm({ ...form, name: event.target.value })}
                      required
                      maxLength={80}
                    />
                  </label>
                  <label>
                    Description
                    <input
                      value={form.description}
                      onChange={(event) => setForm({ ...form, description: event.target.value })}
                      maxLength={500}
                    />
                  </label>
                </div>
                <label>
                  System instructions
                  <textarea
                    value={form.instructions}
                    onChange={(event) => setForm({ ...form, instructions: event.target.value })}
                    rows={5}
                    maxLength={10_000}
                  />
                </label>
                <div className="panel-footer">
                  <code>{selected.workspacePath}</code>
                  <button className="button button-primary" disabled={busy}>
                    {busy ? <Spinner /> : "Save changes"}
                  </button>
                </div>
              </form>
            )}

            {tab === "identity" && <IdentityPanel agent={selected} onError={reportError} />}
            {tab === "audit" && <AuditPanel agentId={selected.id} onError={reportError} />}

            {tab === "playground" && (
              <section className="playground">
                <div className="playground-topbar">
                  <div>
                    <span className="eyebrow">Playground</span>
                    <h2>Build something with your Agent</h2>
                  </div>
                  <div className="session-info">
                    <span className="pulse" />
                    {selected.codexThreadId ? "Session connected" : "New session"}
                  </div>
                </div>

                {delegation && (
                  <div className={"delegation-banner " + (delegation.granted ? "ok" : "warn")}>
                    {delegation.granted ? (
                      <span>
                        This turn carries action token{" "}
                        <code>{delegation.tokenId?.slice(0, 8)}</code> with{" "}
                        {delegation.scopes.map((scope) => (
                          <code key={scope}>{scope}</code>
                        ))}{" "}
                        until {delegation.expiresAt && formatTime(delegation.expiresAt)}. It is
                        bound to this Run and revocable at any moment.
                      </span>
                    ) : (
                      <span>
                        This turn carries no delegated authority. The Agent can work in its
                        workspace but cannot reach any protected resource.
                      </span>
                    )}
                  </div>
                )}

                <div className="messages">
                  {messages.length === 0 && !activeRun ? (
                    <div className="welcome">
                      <div className="welcome-orbit">
                        <div>⌁</div>
                      </div>
                      <h3>What should {selected.name} build?</h3>
                      <p>
                        The Agent can inspect files, write code, run commands, and reach the
                        protected resources you have delegated to it — and nothing else.
                      </p>
                      <div className="prompt-grid">
                        {starterPrompts.map((item) => (
                          <button key={item} onClick={() => setPrompt(item)}>
                            <span>↗</span>
                            {item}
                          </button>
                        ))}
                      </div>
                    </div>
                  ) : (
                    messages.map((message) => (
                      <article className={"message message-" + message.role} key={message.id}>
                        <div className="message-meta">
                          <strong>{message.role === "user" ? "You" : selected.name}</strong>
                          <span>{formatTime(message.createdAt)}</span>
                        </div>
                        <div className="message-body">{message.content}</div>
                      </article>
                    ))
                  )}
                  {activeRun && ["queued", "running"].includes(activeRun.status) && (
                    <article className="message message-assistant thinking">
                      <div className="message-meta">
                        <strong>{selected.name}</strong>
                        <span>working in the Agent workspace</span>
                      </div>
                      <div className="thinking-row">
                        <Spinner />
                        Codex is reading, editing, or running commands…
                      </div>
                    </article>
                  )}
                  {activeRun?.status === "failed" && (
                    <article className="run-error">
                      <strong>Run failed</strong>
                      <span>{activeRun.error}</span>
                    </article>
                  )}
                  <div ref={messageEnd} />
                </div>

                <form className="composer" onSubmit={sendMessage}>
                  <textarea
                    value={prompt}
                    onChange={(event) => setPrompt(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" && !event.shiftKey) {
                        event.preventDefault();
                        event.currentTarget.form?.requestSubmit();
                      }
                    }}
                    placeholder={
                      selected.status === "stopped"
                        ? "Start this Agent to continue…"
                        : "Describe what you want the Agent to do…"
                    }
                    disabled={
                      selected.status === "stopped" ||
                      selected.status === "busy" ||
                      (activeRun != null && ["queued", "running"].includes(activeRun.status))
                    }
                    rows={3}
                  />
                  <div className="composer-footer">
                    <span>
                      Enter to send · Shift + Enter for newline ·{" "}
                      {system?.codexSandboxMode ?? "checking sandbox"}
                    </span>
                    <button
                      className="send-button"
                      disabled={
                        !prompt.trim() ||
                        selected.status === "stopped" ||
                        selected.status === "busy" ||
                        (activeRun != null && ["queued", "running"].includes(activeRun.status))
                      }
                      aria-label="Send message"
                    >
                      ↑
                    </button>
                  </div>
                </form>
              </section>
            )}
          </>
        ) : (
          <div className="no-agent">
            <div className="no-agent-art">A</div>
            <span className="eyebrow">Agent Launchpad</span>
            <h1>Your runtime is ready for an Agent.</h1>
            <p>Create a workspace, give Codex a job, and continue the conversation here.</p>
            <button
              className="button button-primary"
              onClick={() => {
                setForm(emptyForm);
                setShowCreate(true);
              }}
            >
              Create your first Agent
            </button>
          </div>
        )}
      </main>

      {showCreate && (
        <div className="modal-backdrop" onMouseDown={() => setShowCreate(false)}>
          <form
            className="modal"
            onSubmit={createAgent}
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="modal-heading">
              <div>
                <span className="eyebrow">New workspace</span>
                <h2>Create an Agent</h2>
                <p>
                  The Agent gets a persistent folder, a resumable Codex session, its own
                  principal, and a read-only delegation you can widen later.
                </p>
              </div>
              <button type="button" onClick={() => setShowCreate(false)}>
                ×
              </button>
            </div>
            <label>
              Name
              <input
                autoFocus
                placeholder="Frontend Builder"
                value={form.name}
                onChange={(event) => setForm({ ...form, name: event.target.value })}
                required
                maxLength={80}
              />
            </label>
            <label>
              Description
              <input
                placeholder="Builds polished React prototypes"
                value={form.description}
                onChange={(event) => setForm({ ...form, description: event.target.value })}
                maxLength={500}
              />
            </label>
            <label>
              Instructions
              <textarea
                value={form.instructions}
                onChange={(event) => setForm({ ...form, instructions: event.target.value })}
                rows={6}
                maxLength={10_000}
              />
            </label>
            <div className="modal-footer">
              <button
                type="button"
                className="button button-ghost"
                onClick={() => setShowCreate(false)}
              >
                Cancel
              </button>
              <button className="button button-primary" disabled={busy}>
                {busy ? <Spinner /> : "Create Agent"}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
