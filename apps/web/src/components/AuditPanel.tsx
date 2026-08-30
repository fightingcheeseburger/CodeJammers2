import { useCallback, useEffect, useState } from "react";
import { api } from "../api";
import type { AuditEvent } from "../types";

function time(iso: string): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(iso));
}

/**
 * The evidence view. One row per authorization decision, allow and deny
 * alike, with the initiating human, the executing Agent principal, the
 * action, the target and the machine-readable reason.
 */
export function AuditPanel({
  agentId,
  onError,
}: {
  agentId: string;
  onError: (message: string) => void;
}) {
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [onlyDenials, setOnlyDenials] = useState(false);
  const [live, setLive] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const result = await api.audit({ agentId, limit: 120 });
      setEvents(result.events);
    } catch (reason) {
      onError(reason instanceof Error ? reason.message : String(reason));
    }
  }, [agentId, onError]);

  useEffect(() => {
    void refresh();
    if (!live) return;
    const timer = window.setInterval(() => void refresh(), 2_000);
    return () => window.clearInterval(timer);
  }, [refresh, live]);

  const shown = onlyDenials ? events.filter((event) => event.decision !== "allow") : events;

  return (
    <section className="audit-panel">
      <div className="panel-heading">
        <div>
          <span className="eyebrow">Authorization trail</span>
          <h2>Every decision, with its reason</h2>
        </div>
        <div className="audit-controls">
          <label>
            <input
              type="checkbox"
              checked={onlyDenials}
              onChange={(event) => setOnlyDenials(event.target.checked)}
            />
            denials only
          </label>
          <label>
            <input
              type="checkbox"
              checked={live}
              onChange={(event) => setLive(event.target.checked)}
            />
            live
          </label>
          <button className="button button-ghost" onClick={() => void refresh()}>
            Refresh
          </button>
        </div>
      </div>

      <div className="audit-list">
        {shown.length === 0 && <div className="empty-row">No decisions recorded yet.</div>}
        {shown.map((event) => (
          <article className={"audit-row audit-" + event.decision} key={event.id}>
            <div className="audit-line">
              <span className={"tag tag-" + event.decision}>{event.decision}</span>
              <code className="audit-action">{event.action}</code>
              <code className="audit-reason">{event.reason}</code>
              <span className="audit-time">{time(event.at)}</span>
            </div>
            <div className="audit-chain">
              <span title="Initiating human">{event.actorUserId ?? "anonymous"}</span>
              <span className="arrow">→</span>
              <span title="Executing principal">
                {event.principalKind === "agent"
                  ? "agent " + (event.agentPrincipalId ?? "").slice(0, 8)
                  : event.principalKind}
              </span>
              <span className="arrow">→</span>
              <span title="Target resource">
                {event.resourceType}
                {event.resourceId ? " " + event.resourceId : ""}
              </span>
            </div>
            <p className="audit-detail">{event.detail}</p>
            <div className="audit-ids">
              {event.scopes.length > 0 && <code>{event.scopes.join(" ")}</code>}
              {event.grantId && <code title="Grant">grant {event.grantId.slice(0, 8)}</code>}
              {event.runId && <code title="Run">run {event.runId.slice(0, 8)}</code>}
              {event.tokenFingerprint && (
                <code title="Token fingerprint — not the token">{event.tokenFingerprint}</code>
              )}
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}
