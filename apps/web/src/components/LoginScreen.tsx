import { useState } from "react";

const DEMO_ACCOUNTS = [
  { username: "alice", label: "Alice — User A", hint: "owns doc-a1, doc-a2" },
  { username: "bob", label: "Bob — User B", hint: "owns doc-b1, doc-b2" },
  { username: "admin", label: "Platform Admin", hint: "reads the platform audit log" },
];

export function LoginScreen({
  onSubmit,
  busy,
  error,
}: {
  onSubmit: (username: string, password: string) => void;
  busy: boolean;
  error: string | null;
}) {
  const [username, setUsername] = useState("alice");
  const [password, setPassword] = useState("");

  return (
    <main className="auth-screen">
      <form
        className="auth-card"
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit(username, password);
        }}
      >
        <div className="brand-mark">A</div>
        <span className="eyebrow">Agent Launchpad</span>
        <h1>Sign in</h1>
        <p>
          Every Agent belongs to the human who created it. Sign in as that human — the
          platform has no shared operator credential.
        </p>
        {error && (
          <div className="error-banner" role="alert">
            {error}
          </div>
        )}
        <div className="account-picker">
          {DEMO_ACCOUNTS.map((account) => (
            <button
              type="button"
              key={account.username}
              className={"account-chip " + (username === account.username ? "selected" : "")}
              onClick={() => setUsername(account.username)}
            >
              <strong>{account.label}</strong>
              <span>{account.hint}</span>
            </button>
          ))}
        </div>
        <label>
          Username
          <input
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            autoComplete="username"
            required
          />
        </label>
        <label>
          Password
          <input
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoComplete="current-password"
            required
            autoFocus
          />
        </label>
        <button className="button button-primary" disabled={busy || !password}>
          {busy ? "Signing in…" : "Sign in"}
        </button>
        <p className="auth-footnote">
          Demo passwords are set by <code>LAUNCHPAD_SEED_PASSWORD_*</code> and default to
          <code> alice-demo-password</code> / <code>bob-demo-password</code> /
          <code> admin-demo-password</code>.
        </p>
      </form>
    </main>
  );
}
