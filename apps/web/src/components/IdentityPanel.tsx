import { useCallback, useEffect, useState } from "react";
import { api } from "../api";
import { RESOURCE_SCOPES, type Agent, type AgentPrincipal, type DelegationGrant } from "../types";

function relative(iso: string): string {
  const delta = new Date(iso).getTime() - Date.now();
  const minutes = Math.round(delta / 60_000);
  if (minutes <= 0) return "expired";
  if (minutes < 60) return "in " + minutes + " min";
  return "in " + Math.round(minutes / 60) + " h";
}

function grantState(grant: DelegationGrant): { label: string; tone: string } {
  if (grant.revokedAt) return { label: "revoked", tone: "revoked" };
  if (new Date(grant.expiresAt).getTime() <= Date.now()) return { label: "expired", tone: "expired" };
  return { label: "active", tone: "active" };
}

/**
 * The owner's view of what their Agent may do. Everything shown here is a
 * projection of server-side state: hiding a row would not remove any
 * authority, and revoking a row removes it immediately.
 */
export function IdentityPanel({
  agent,
  onError,
}: {
  agent: Agent;
  onError: (message: string) => void;
}) {
  const [principal, setPrincipal] = useState<AgentPrincipal | null>(null);
  const [grants, setGrants] = useState<DelegationGrant[]>([]);
  const [scopes, setScopes] = useState<string[]>(["docs:read"]);
  const [ttl, setTtl] = useState(60);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const result = await api.identity(agent.id);
      setPrincipal(result.principal);
      setGrants(result.grants);
    } catch (reason) {
      onError(reason instanceof Error ? reason.message : String(reason));
    }
  }, [agent.id, onError]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const act = async (work: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await work();
      await refresh();
    } catch (reason) {
      onError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const activeGrant = grants.find((grant) => grantState(grant).tone === "active");

  return (
    <section className="identity-panel">
      <div className="panel-heading">
        <div>
          <span className="eyebrow">Identity and delegation</span>
          <h2>What this Agent may do, and for whom</h2>
        </div>
        <button
          className="button button-ghost"
          disabled={busy}
          onClick={() =>
            act(async () => {
              await api.rotatePrincipal(agent.id);
            })
          }
          title="Bump the principal generation. Every outstanding grant becomes unusable."
        >
          Rotate identity
        </button>
      </div>

      <div className="principal-card">
        <div>
          <span className="eyebrow">Agent principal</span>
          <strong>{principal?.name ?? "—"}</strong>
          <code>{principal?.id ?? "—"}</code>
        </div>
        <div className="principal-meta">
          <span>
            generation <strong>{principal?.generation ?? "—"}</strong>
          </span>
          <span className={principal?.revokedAt ? "tag tag-revoked" : "tag tag-active"}>
            {principal?.revokedAt ? "revoked" : "active"}
          </span>
        </div>
      </div>

      <p className="panel-note">
        This principal is <em>not</em> the human who owns it. It has its own id, its own
        generation, and its own kill switch. Runs carry a token minted for this principal
        that expires in minutes and dies with the Run.
      </p>

      <div className="grant-issue">
        <span className="eyebrow">Issue a delegation</span>
        <div className="scope-row">
          {RESOURCE_SCOPES.map((scope) => (
            <label key={scope} className="scope-chip">
              <input
                type="checkbox"
                checked={scopes.includes(scope)}
                onChange={(event) =>
                  setScopes((current) =>
                    event.target.checked
                      ? [...current, scope]
                      : current.filter((item) => item !== scope),
                  )
                }
              />
              <code>{scope}</code>
            </label>
          ))}
          <label className="ttl-field">
            minutes
            <input
              type="number"
              min={1}
              max={1440}
              value={ttl}
              onChange={(event) => setTtl(Number(event.target.value))}
            />
          </label>
          <button
            className="button button-primary"
            disabled={busy || scopes.length === 0}
            onClick={() =>
              act(() => api.createGrant({ agentId: agent.id, scopes, ttlMinutes: ttl }))
            }
          >
            Delegate
          </button>
        </div>
        <p className="panel-note">
          Control-plane scopes such as <code>agents:write</code> are not offered here and are
          refused by the backend if requested directly. An Agent can never be delegated the
          authority to create Agents or widen its own grants.
        </p>
      </div>

      <div className="grant-list">
        {grants.length === 0 && <div className="empty-row">No delegations issued yet.</div>}
        {grants.map((grant) => {
          const state = grantState(grant);
          return (
            <div className={"grant-row grant-" + state.tone} key={grant.id}>
              <div className="grant-scopes">
                {grant.scopes.map((scope) => (
                  <code key={scope}>{scope}</code>
                ))}
              </div>
              <div className="grant-meta">
                <span className={"tag tag-" + state.tone}>{state.label}</span>
                <span>
                  gen {grant.principalGeneration} · expires {relative(grant.expiresAt)}
                </span>
                {grant.revokedReason && <span className="grant-reason">{grant.revokedReason}</span>}
              </div>
              <button
                className="button button-danger"
                disabled={busy || state.tone !== "active"}
                onClick={() => act(() => api.revokeGrant(grant.id, "Revoked from the console"))}
              >
                Revoke
              </button>
            </div>
          );
        })}
      </div>

      {!activeGrant && (
        <div className="warn-row">
          No active delegation. This Agent can still run and edit its own workspace, but it
          carries no authority over protected resources at all.
        </div>
      )}
    </section>
  );
}
