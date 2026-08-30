# One-page architecture: identity and authorization middleware

Everything inside the dashed boxes is new. The Starter Kit components are
unchanged except where a call now passes through the Policy Decision Point.

```mermaid
flowchart TB
  subgraph browser["Browser — untrusted"]
    UI["React UI<br/>holds a SESSION token only"]
  end

  subgraph control["Control plane — trusted"]
    HOOK["Fastify auth hook<br/>session tokens only"]
    AS["AgentService<br/>every method takes an actor"]
    BROKER["Delegation Broker<br/>mints one Action Token per Run"]
  end

  subgraph idp["Identity & Policy plane — NEW"]
    IDS["IdentityService<br/>users · sessions · principals<br/>grants · approvals"]
    PDP{{"Policy Decision Point<br/>deny by default<br/>13-step chain"}}
    AUD[("Audit log<br/>append-only · redacted")]
  end

  subgraph runtime["Agent Runtime — untrusted code, real authority"]
    RUN["Codex CLI in a container<br/>env: LAUNCHPAD_ACTION_TOKEN"]
  end

  subgraph data["Data plane — trusted"]
    RHOOK["Resource auth hook<br/>ACTION tokens only<br/>aud=launchpad-resource-api"]
    RS["ResourceService"]
    DOCS[("Protected documents<br/>alice: doc-a1, doc-a2<br/>bob: doc-b1, doc-b2")]
  end

  UI -->|"Bearer session"| HOOK
  HOOK --> AS
  AS -->|"authorize(actor, action, resource)"| PDP
  AS --> BROKER
  BROKER -->|"grant + principal"| IDS
  BROKER -->|"token in env, never in argv"| RUN
  RUN -->|"Bearer action token"| RHOOK
  RHOOK --> RS
  RS -->|"authorize(agent actor, action, resource)"| PDP
  PDP -.->|"live state"| IDS
  PDP -->|"every decision"| AUD
  RS --> DOCS
  UI -->|"revoke · rotate · approve"| HOOK
  AUD -.->|"read, scoped to the owner"| UI

  classDef new fill:#fff6e0,stroke:#d9a441,stroke-width:2px,stroke-dasharray:5 4
  classDef boundary fill:#eef4ff,stroke:#5b7cc0
  class IDS,PDP,AUD,RHOOK,RS,DOCS,BROKER new
  class HOOK,AS boundary
```

## The two trust boundaries that matter

```mermaid
flowchart LR
  H["Human<br/>alice"] -->|"password → session token<br/>aud: control-plane"| CP["Control plane<br/>/api/*"]
  CP -->|"token exchange<br/>RFC 8693 sub + act"| T["Action Token<br/>aud: resource-api<br/>TTL 5 min · bound to one Run"]
  T --> RT["Agent Runtime"]
  RT -->|"Bearer action token"| DP["Data plane<br/>/api/resources/*"]

  CP -.->|"REFUSED"| DP
  RT -.->|"REFUSED"| CP

  classDef refused stroke:#c04040,stroke-dasharray:4 4
  linkStyle 4,5 stroke:#c04040,stroke-width:2px,stroke-dasharray:4 4
```

Neither plane accepts the other's credential. The control plane holds
nothing it could forward downstream, so token passthrough — the confused
deputy the MCP authorization spec warns about — is not a bug we avoid, it
is a shape the system cannot express.

## The decision, end to end

```mermaid
sequenceDiagram
  participant A as Alice (browser)
  participant CP as Control plane
  participant ID as Identity & Policy
  participant RT as Agent Runtime
  participant RS as Resource server

  A->>CP: POST /agents/:id/messages
  CP->>ID: authorize(alice, agent.run, agent)
  ID-->>CP: allow (owner_action)
  CP->>ID: mint action token for this Run
  ID-->>CP: sub=alice, act=agent/3f2a, scope=[docs:read], exp=+5m
  CP->>RT: spawn turn, token in process env only
  Note over CP,A: 202 + delegation summary shown in the UI

  RT->>RS: GET /resources/documents/doc-a1
  RS->>ID: authorize(agent actor, document.read, doc-a1)
  ID-->>RS: allow (delegated_action)
  RS-->>RT: 200 Alice's document

  RT->>RS: GET /resources/documents/doc-b1
  RS->>ID: authorize(agent actor, document.read, doc-b1)
  ID-->>RS: DENY (cross_user_denied)
  RS-->>RT: 404, body never read
  ID->>ID: audit: alice → agent/3f2a → doc-b1 → deny

  A->>CP: POST /grants/:id/revoke
  RT->>RS: GET /resources/documents/doc-a1
  RS->>ID: authorize(...)
  ID-->>RS: DENY (grant_revoked)
  RS-->>RT: 403 — same signed, unexpired token, now inert
```
