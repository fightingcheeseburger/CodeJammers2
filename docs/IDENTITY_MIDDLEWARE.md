# Identity and Authorization Middleware

**Track 1 — Agent Launchpad. Selected direction: identity and authorization.**

The Starter Kit ships a working Agent platform with, in its own words, "no
user identity or authorization system". It has one shared bearer token that
gates the whole API, and once past it, every Agent can reach everything.
This document describes the middleware we added, why each boundary sits
where it does, and what it does not solve.

---

## 1. The problem, stated precisely

An Agent is not a feature of a user account. It is a **separate actor** that
runs unattended, for minutes at a time, driven by a language model that
reads untrusted input — files, tool output, web pages — and decides what to
do next.

Three things follow, and none of them are solved by a login screen:

1. **An Agent must not reuse a human's credential.** If it does, then every
   log line says the human did it, revoking the Agent means revoking the
   human, and the Agent's reach is exactly the human's reach — which is
   always wider than the task needs.
2. **Its authority must be checked where the work happens, not where the
   work is requested.** The model decides which tools to call. A check in
   the UI, or even in the chat route, is a check the model never passes
   through.
3. **Authority must be withdrawable while the Agent is mid-task.** A Run is
   long; an incident is short. "The credential expires in an hour" is not
   an answer to "stop it now".

The single sentence version: *the platform needs a way to say what an
Agent may do on whose behalf, enforce it at the point of use, and take it
back instantly.*

---

## 2. What we built

Five components, each with one job.

| Component | File | Job |
| --- | --- | --- |
| Identity plane | `identity/identity-service.ts` | Humans, sessions, Agent principals, delegation grants, approvals. The only thing that answers "may this happen?" |
| Policy engine | `identity/policy.ts` | A pure function from (actor, action, resource, live state) to an explicit decision plus a machine-readable reason. Deny by default. |
| Action tokens | `identity/action-token.ts` | The credential an Agent actually carries: HMAC-signed, audience-bound, minutes-long, minted once per Run. |
| Resource server | `resource-service.ts` | A mock downstream system that trusts nothing and re-derives authority on every request. The place that actually says no. |
| Audit log | `identity/audit.ts` | Append-only record of every decision, allow and deny, redacted before storage. |

### 2.1 Two kinds of principal

```
human:  alice          — signs in with a password, holds a session
agent:  agent/3f2a1c4b — created with the Agent, owned by a human,
                         has its own id, generation and kill switch
```

An Agent principal is created at the same moment as the Agent and is
recorded on the Agent (`agent.principalId`). It is never the human. Audit
records carry both, so every action reads as *"Alice, through
agent/3f2a1c4b, tried to read doc-b1"*.

### 2.2 Delegation grants

A grant is a human's statement that an Agent principal may act for them,
within limits:

```ts
{
  agentPrincipalId, principalGeneration,   // who acts, at which generation
  subjectUserId, resourceOwnerId,          // for whom, over whose data
  scopes: ["docs:read"],                   // how much
  expiresAt, revokedAt                     // for how long, until withdrawn
}
```

Three invariants are enforced when a grant is issued, and they are why a
grant can never become an escalation path:

1. **Only data-plane scopes are delegatable.** `agents:write`,
   `grants:manage` and `audit:read` are refused outright. An Agent
   therefore cannot create Agents, edit its own instructions, or widen its
   own grant, even in principle.
2. **`scopes ⊆ delegator's own scopes`.** You cannot hand over authority
   you do not hold.
3. **`resourceOwnerId === subjectUserId`.** A grant reaches exactly one
   user's resources: the delegator's. This is the rule that produces the
   cross-user denial.

New Agents are created with `["docs:read"]` and nothing more. Anything
wider is a deliberate act by the owner.

### 2.3 Action tokens

At the start of every Run, the human's authority is **exchanged** for a
narrow credential. The claim set follows RFC 8693 (OAuth 2.0 Token
Exchange) delegation semantics:

```jsonc
{
  "jti": "…",                     // token id, recorded in the audit trail
  "sub": "user-alice",            // the human on whose behalf
  "act": {                        // RFC 8693 actor claim
    "sub": "principal-…",         // the Agent principal doing it
    "agent_id": "…",
    "generation": 1
  },
  "aud": "launchpad-resource-api",// RFC 8707-style resource indicator
  "grant_id": "…",
  "run_id": "…",                  // the token lives and dies with this Run
  "scope": ["docs:read"],
  "iat": …, "nbf": …, "exp": …    // 5 minutes by default
}
```

Implementation notes that matter:

- **HS256 only, and `alg` is never read from the header.** The header is a
  compile-time constant that must match byte for byte, so algorithm
  confusion and the `"alg":"none"` downgrade are structurally impossible
  rather than defended against.
- **TTL is the minimum** of the configured lifetime, the grant's remaining
  life, and the Run timeout.
- **The token is never persisted.** Only its `jti` is stored on the Run and
  a `sha256:` fingerprint prefix in audit records. The trail can name the
  credential; it cannot replay it.
- **The token never appears in argv.** The container runner passes
  `--env LAUNCHPAD_ACTION_TOKEN` (name only); the value travels in the
  engine's own process environment, so it is absent from `ps`,
  `docker inspect`, and shell history.
- **The browser never sees one.** There is no API that returns an action
  token to a human client.

### 2.4 The enforcement point

Every resource call re-derives authority from live state. A valid
signature is necessary and never sufficient. The chain, in order, with the
reason code each step emits:

| # | Check | Reason code on failure |
| --- | --- | --- |
| 0 | The action has a policy rule at all | `unknown_action` |
| 1 | The delegating human exists and is enabled | `subject_disabled` |
| 2 | The human still holds the required scope | `scope_exceeds_delegator` |
| 3 | The action is delegatable to an Agent at all | `action_not_delegatable` |
| 4 | The principal exists and is not revoked | `principal_revoked` |
| 5 | The grant's generation matches the principal's | `principal_rotated` |
| 6 | The grant is not revoked | `grant_revoked` |
| 7 | The grant has not expired | `grant_expired` |
| 8 | The Run is still active | `run_not_active` |
| 9 | The Agent has not been stopped | `agent_stopped` |
| 10 | The token carries the scope | `scope_not_in_token` |
| 11 | The grant carries the scope | `scope_not_granted` |
| 12 | The resource belongs to the grant's owner | **`cross_user_denied`** |
| 13 | High-risk scopes have a matching human approval | `approval_required` |

Steps 4–9 are the reason revocation is **immediate**. They are evaluated
against current state on every single request, not at token issuance, so a
perfectly valid, unexpired, correctly signed token stops working the
instant its grant is revoked, its principal is rotated, its Run ends, or
its human is disabled.

Step 2 is worth its own sentence: because the human's own scope set is the
ceiling on every check, narrowing or disabling a person instantly narrows
every Agent acting for them — no grant sweep required.

### 2.5 Audience separation

The application exposes two planes that share a process and share no
credentials:

- `/api/*` — **control plane.** Accepts human session tokens only.
- `/api/resources/*` — **data plane.** Accepts action tokens whose `aud`
  is `launchpad-resource-api`, and nothing else.

A session token presented at the resource API is not a credential there. An
action token presented at the control plane is not a credential there. This
is audience binding in the RFC 8707 sense, and it makes **token passthrough
structurally impossible**: the control plane has nothing it could forward,
because the only credential the resource server accepts is one minted for a
specific Run. That closes the confused-deputy path the MCP authorization
spec singles out.

### 2.6 Human approval for high-risk actions

`docs:write` and `docs:delete` are marked high-risk. Holding the scope is
not enough; the action also needs a decision at the moment of use.

The first attempt returns `202` with an approval id. The approval record
stores `sha256(canonical(params))`, and the policy engine compares that
hash on the retry. So:

- Approving *"write this body to doc-a1"* cannot be replayed as *"write a
  different body to doc-a1"* — the hash differs.
- It cannot be replayed as *"write to doc-a2"* — the resource binding
  differs.
- It cannot be used twice — the approval is consumed on success, and a
  consumed approval is not an approval; an identical repeat asks again.
- It cannot be answered by anyone but the owner, and it dies with the Run.

Ownership is checked *before* the approval gate, so a cross-user write is
refused outright and never reaches a human's inbox. Nobody is ever asked to
approve something they could not have authorized anyway.

### 2.7 What the Agent sees

The Runtime receives two environment variables for the turn:
`LAUNCHPAD_ACTION_TOKEN` and `LAUNCHPAD_RESOURCE_API`. The workspace gets
a small helper, `.launchpad/resource`, which reads the token from the
environment — so the credential is never written to disk, never committed,
and vanishes when the turn ends.

`AGENTS.md` tells the Agent how to interpret each status code and, crucially,
that a `404` is final: *"Do not attempt to work around this. Report it and
stop."* That instruction is a courtesy, not a control. The controls are in
the backend, which is the entire point.

---

## 3. Threat model

| Threat | Control | Evidence |
| --- | --- | --- |
| Cross-user data access | Grant reaches exactly one owner's resources; checked at the resource server | `identity/authorization.test.ts`, `identity-smoke.sh` §5 |
| Prompt injection widening authority | The model can decide anything; the token still carries only `docs:read` for one owner | `identity/prompt-injection.test.ts` |
| Confused deputy / token passthrough | Two audiences, no shared credential, nothing to forward | `app.test.ts` "Audience separation" |
| Credential theft from the workspace | Token in env only, never on disk or in argv; redacted from logs and audit | `identity/redact.test.ts`, `app.test.ts` |
| Token forgery or tampering | HMAC-SHA256, constant-time compare, fixed header, no `alg` negotiation | `identity/action-token.test.ts` |
| Stale authority after an incident | Revocation, rotation, stop and disable all checked at use time | `identity/revocation.test.ts` |
| Privilege escalation by the Agent | Control-plane scopes are not delegatable and control-plane actions are closed to Agent principals | `identity/authorization.test.ts` |
| Unreviewed destructive writes | Approval gate bound to action, resource and parameter hash | `identity/approval.test.ts` |
| Namespace probing via error messages | Uniform `404` for both "absent" and "not yours"; the real reason goes to the audit log | `identity/authorization.test.ts` |
| Session credential theft from the store | Only `sha256(secret)` is persisted | `app.test.ts` |

### Residual risks, stated honestly

- **The Ark API key is still passed into the Runtime container**, inherited
  from the Starter Kit. A model that ignores its instructions can read it.
  Fixing this properly means proxying model calls through the control plane
  so the Runtime never holds a provider credential — a clean next step, and
  out of scope for three days.
- **Passwords are scrypt-hashed but seeded from environment defaults.**
  This is a demo identity provider, not an IdP. The seam is
  `IdentityService.login`; swapping in OIDC changes that method and nothing
  else.
- **The JSON store is single-process.** Audit records are append-only by
  convention, not by storage guarantee.
- **Ordinary containers are not a hardened multi-tenant boundary.** We
  narrowed *authority*, not the sandbox. Two Agents owned by different
  users still share a kernel.
- **Codex network egress is now enabled** (`network_access = true` in the
  generated `config.toml`) so the Agent can reach the resource API. Egress
  is not allowlisted to that host; a determined Agent can still make
  arbitrary outbound requests. The mitigation we have is that it carries no
  credential worth stealing except its own five-minute, single-owner token.

---

## 4. Where each decision lives

| Layer | Owns | Files |
| --- | --- | --- |
| Experience | Login, ownership-scoped views, grant issue/revoke, approvals, audit timeline | `apps/web/src/components/*` |
| Control plane | Session resolution, per-action authorization, Run orchestration | `app.ts`, `agent-service.ts` |
| Identity & policy | Principals, grants, tokens, approvals, decisions, audit | `identity/*` |
| Runtime | Request-scoped credential injection, no argv exposure | `codex-runner.ts`, `container-codex-runner.ts` |
| Data | Ownership-aware resource server, mock protected documents | `resource-service.ts`, `store.ts` |

The `AgentRunner` interface gained one optional field, `credentials`. That
is the whole extension to the Runtime contract: a request-scoped map handed
to the Runtime for one turn. Any future runner — a microVM, a remote
sandbox, a different CLI — satisfies it the same way.

---

## 5. Extension points we left open

- **Swap the IdP.** `IdentityService.login` and `resolveHumanActor` are the
  only two places that know what a session is.
- **Swap the policy engine.** `decide()` is a pure function with a typed
  request and a typed decision. Replacing it with OPA or OpenFGA means
  reimplementing one function; every call site stays.
- **Add a resource type.** Add rows to the `ACTIONS` table in `policy.ts`
  and a service that calls `identity.authorize`. Ownership, scope,
  revocation, approval and audit come for free.
- **Add relationship-based authorization.** `resourceOwnerId` is currently
  a single owner. A ReBAC lookup (`is alice a viewer of doc-b1?`) drops in
  at exactly that point.

---

## 6. Reproducing the evidence

```bash
npm run check           # typecheck + 52 tests + production build
npm run smoke:identity  # end-to-end over real HTTP, no Docker or Ark key
```

The smoke script builds the platform, starts it with a stub Runtime that
records the credential it was handed, and then walks the full story:
sign-in, principal creation, cross-user denial, scope denial, audience
separation, mid-Run revocation, and the audit trail.
