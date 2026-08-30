# Three-minute live demo script

**Track 1 — identity and authorization middleware.**
Two humans, one Agent, one credential that is exactly as wide as it needs
to be and no wider.

## Before you start (not on the clock)

```bash
ARK_API_KEY=... ARK_MODEL=ep-... npm run poc
```

Open two browser windows side by side:

- **Left:** signed in as `alice` (password `alice-demo-password`)
- **Right:** signed in as `bob` (password `bob-demo-password`)

Create one Agent as Alice called **Researcher**. Leave it on the
Playground tab. Have the **Identity & delegation** and **Authorization
trail** tabs one click away.

If the room has no container engine or Ark key, run
`npm run smoke:identity` instead — it walks the same story over real HTTP
in about fifteen seconds and prints a pass line per step.

---

## 0:00 — 0:25 · The problem, in one sentence

> "The Starter Kit has one shared bearer token. Once you are past it, every
> Agent can reach everything, every log line says *the token* did it, and
> stopping one Agent means stopping the platform. We gave the Agent its own
> identity."

Show the sidebar: Alice is signed in. Bob's window shows **zero Agents** —
same server, same database, no shared operator account.

## 0:25 — 0:55 · The Agent has its own identity

Click **Identity & delegation**.

> "When Alice created this Agent, the platform created a principal for it —
> `agent/3f2a1c4b`, generation 1. That is not Alice. It has its own id, its
> own kill switch, and by default one scope: `docs:read`."

Point at the default grant chip: `docs:read`, expires in 60 minutes.

## 0:55 — 1:30 · The happy path, with the credential visible

Back to **Playground**. Send:

```
List the documents you can reach and summarise them.
```

Point at the green delegation banner as it appears:

> "This turn carries action token `a41f…`, scope `docs:read`, valid for
> five minutes, bound to this Run. It follows RFC 8693 token exchange: the
> `sub` claim is Alice, the `act` claim is the Agent. Both identities, in
> every call."

The Agent returns Alice's two documents.

## 1:30 — 2:05 · The denial — the heart of the demo

Send:

```
Read doc-b1 and tell me what it says.
```

`doc-b1` is Bob's confidential compensation note. Show Bob's window: the
document is right there, in his sidebar, untouched.

The Agent comes back saying it was refused.

> "That was a 404 from the resource server, not from the UI. The token is
> valid, unexpired, correctly signed — and it still fails, because a
> delegation grant reaches exactly one person's resources: the person who
> issued it. Nothing about the prompt could change that."

Click **Authorization trail** and read one row aloud:

> "`DENY · document.read · doc-b1 · cross_user_denied` — Alice, through
> agent/3f2a1c4b, on doc-b1. The initiating human, the executing Agent, the
> target and the reason. And that is a token fingerprint, not the token."

## 2:05 — 2:35 · Revocation while the Agent is mid-task

Ask the Agent to do something slow, then — while it is still running — go
to **Identity & delegation** and hit **Revoke** on the active grant.

Send the read again.

> "Same token. Still signed, still four minutes from expiry. Dead. We check
> revocation at *use* time, not at issue time, on every single request. So
> does stopping the Agent, rotating its identity, ending the Run, or
> disabling Alice herself."

## 2:35 — 3:00 · The write nobody approved

Send:

```
Rewrite doc-a1 with a two-line summary at the top.
```

(Re-issue a grant with `docs:write` first if you revoked it.)

The write parks. Alice's approval card appears at the top of the screen
showing the exact document and the exact body.

> "`docs:write` is high risk, so holding the scope is not enough — it also
> needs a decision now. The approval is bound to a hash of these exact
> parameters, so approving this write cannot be replayed as a different
> one, or against a different document, or twice."

Click **Approve**. The write lands. Close on:

> "Two planes, no shared credential. The browser never sees an action
> token; the resource server never sees a session. Fifty-two automated
> tests cover every denial you just watched, including a run where the
> model is fully compromised and obeys a prompt-injection attack — and
> still gets nothing."

---

## If something goes wrong on stage

| Symptom | Fallback |
| --- | --- |
| Ark or the container engine is down | `npm run smoke:identity` — same story, fifteen seconds, no dependencies |
| The model refuses to call the helper | Run `./.launchpad/resource get doc-b1` in the workspace yourself; the denial is identical |
| The Playground hangs | The audit trail is already populated — narrate from there |

## The acceptance checklist, mapped

| Requirement | Where it happens |
| --- | --- |
| Create User A, User B, an Agent principal owned by A | Seeded fixtures; principal created with the Agent |
| Agent reads A's mock resource | 0:55 |
| Access to B's resource denied in the backend | 1:30, `resource-service.ts` via `policy.ts` |
| Records human, Agent, action, resource, decision | 1:30, the audit row |
| Middleware runs outside the UI | Every check is in `IdentityService.authorize` |
| Positive and negative case demonstrated | 0:55 and 1:30 |
| Automated evidence | `npm run check` — 52 tests |
| No secret in source, logs, traces or demo output | `identity/redact.ts`, fingerprints only |
