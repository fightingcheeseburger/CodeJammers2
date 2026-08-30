import { useCallback, useEffect, useState } from "react";
import { api } from "../api";
import type { ApprovalRequest } from "../types";

/**
 * High-risk actions stop here. The card shows the exact action, the exact
 * target and a preview of the exact payload; the decision is bound to that
 * payload's hash server-side, so approving this cannot approve anything
 * else.
 */
export function ApprovalInbox({ onError }: { onError: (message: string) => void }) {
  const [approvals, setApprovals] = useState<ApprovalRequest[]>([]);
  const [busy, setBusy] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setApprovals((await api.approvals()).approvals);
    } catch (reason) {
      onError(reason instanceof Error ? reason.message : String(reason));
    }
  }, [onError]);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 1_500);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const pending = approvals.filter((item) => item.status === "pending");
  const recent = approvals.filter((item) => item.status !== "pending").slice(0, 4);

  const decide = async (id: string, approved: boolean) => {
    setBusy(id);
    try {
      await api.decideApproval(id, approved);
      await refresh();
    } catch (reason) {
      onError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(null);
    }
  };

  if (pending.length === 0 && recent.length === 0) return null;

  return (
    <section className="approval-inbox">
      <span className="eyebrow">Waiting for you</span>
      {pending.map((approval) => (
        <article className="approval-card" key={approval.id}>
          <div>
            <strong>
              {approval.action} on <code>{approval.resourceId}</code>
            </strong>
            <p className="approval-preview">{approval.paramsPreview}</p>
            <span className="approval-meta">
              run {approval.runId.slice(0, 8)} · expires{" "}
              {new Date(approval.expiresAt).toLocaleTimeString()}
            </span>
          </div>
          <div className="approval-actions">
            <button
              className="button button-primary"
              disabled={busy === approval.id}
              onClick={() => void decide(approval.id, true)}
            >
              Approve
            </button>
            <button
              className="button button-danger"
              disabled={busy === approval.id}
              onClick={() => void decide(approval.id, false)}
            >
              Deny
            </button>
          </div>
        </article>
      ))}
      {recent.length > 0 && (
        <div className="approval-history">
          {recent.map((approval) => (
            <span key={approval.id} className={"tag tag-" + approval.status}>
              {approval.status} · {approval.resourceId}
            </span>
          ))}
        </div>
      )}
    </section>
  );
}
