/**
 * End-to-end identity and authorization smoke test.
 *
 * Unlike the vitest suites, which drive the app in-process, this script
 * talks to a real HTTP server over the network exactly as a browser and a
 * Runtime container would. Run it with scripts/identity-smoke.sh.
 */
import { readFileSync } from "node:fs";

const BASE = process.env.SMOKE_BASE_URL ?? "http://127.0.0.1:3111";
const TOKEN_FILE = process.env.LAUNCHPAD_SMOKE_TOKEN_FILE ?? "/tmp/launchpad-smoke-token";

const call = async (path, options = {}) => {
  const response = await fetch(BASE + path, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers ?? {}) },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  let body = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  return { status: response.status, body };
};
const auth = (token) => ({ Authorization: "Bearer " + token });

let failures = 0;
const check = (label, ok, extra = "") => {
  if (!ok) failures += 1;
  console.log((ok ? "  PASS  " : "  FAIL  ") + label + (extra ? "  -> " + extra : ""));
};
const section = (title) => console.log("\n" + title);

section("1. Human authentication replaces the shared bearer token");
const alice = await call("/api/auth/login", {
  method: "POST",
  body: { username: "alice", password: process.env.LAUNCHPAD_SEED_PASSWORD_ALICE ?? "alice-demo-password" },
});
const bob = await call("/api/auth/login", {
  method: "POST",
  body: { username: "bob", password: process.env.LAUNCHPAD_SEED_PASSWORD_BOB ?? "bob-demo-password" },
});
check("Alice and Bob sign in", alice.status === 200 && bob.status === 200, alice.status + "/" + bob.status);
const A = alice.body.token;
const B = bob.body.token;
check(
  "a wrong password is refused",
  (await call("/api/auth/login", { method: "POST", body: { username: "alice", password: "wrong" } })).status === 401,
);
check("an unauthenticated control-plane call is refused", (await call("/api/agents")).status === 401);

section("2. Every Agent gets its own principal and a least-privilege grant");
const created = await call("/api/agents", { method: "POST", headers: auth(A), body: { name: "Researcher" } });
check("Alice creates an Agent", created.status === 201, String(created.status));
const agentId = created.body.agent.id;
const identity = await call("/api/agents/" + agentId + "/identity", { headers: auth(A) });
check("the Agent has its own principal", Boolean(identity.body.principal?.id));
check(
  "the default delegation is read-only",
  JSON.stringify(identity.body.grants[0].scopes) === '["docs:read"]',
  JSON.stringify(identity.body.grants?.[0]?.scopes),
);

section("3. Ownership isolation between User A and User B");
check("Bob sees none of Alice's Agents", (await call("/api/agents", { headers: auth(B) })).body.agents.length === 0);
const bobProbe = await call("/api/agents/" + agentId, { headers: auth(B) });
check("Bob gets 404, not 403, so existence is not disclosed", bobProbe.status === 404, String(bobProbe.status));

section("4. A Run mints a scoped, short-lived credential for the Runtime");
const run = await call("/api/agents/" + agentId + "/messages", {
  method: "POST",
  headers: auth(A),
  body: { content: "list the documents you can reach" },
});
check("the Run is accepted", run.status === 202, String(run.status));
check(
  "the response reports what was delegated",
  run.body.delegation.granted === true && run.body.delegation.scopes.includes("docs:read"),
);
await new Promise((resolve) => setTimeout(resolve, 1500));
const token = readFileSync(TOKEN_FILE, "utf8").trim();
check("the Runtime received an action token", token.length > 0);

section("5. The delegated Agent reaches its owner's data and nothing else");
check("it reads Alice's document", (await call("/api/resources/documents/doc-a1", { headers: auth(token) })).status === 200);
const crossUser = await call("/api/resources/documents/doc-b1", { headers: auth(token) });
check(
  "it is DENIED Bob's document, and Bob's content never leaves the server",
  crossUser.status === 404 && !JSON.stringify(crossUser.body).includes("CONFIDENTIAL"),
  crossUser.status + " " + JSON.stringify(crossUser.body),
);
const write = await call("/api/resources/documents/doc-a1", {
  method: "PUT",
  headers: auth(token),
  body: { body: "overwritten by the agent" },
});
check("a write is refused because docs:write was never delegated", write.body?.reason === "scope_not_in_token", JSON.stringify(write.body));

section("6. The two planes do not share credentials");
check("a human session token is refused at the resource API", (await call("/api/resources/documents", { headers: auth(A) })).status === 401);
check("an action token is refused at the control plane", (await call("/api/agents", { headers: auth(token) })).status === 401);

section("7. Revocation takes effect immediately, mid-Run");
const revoke = await call("/api/grants/" + run.body.run.grantId + "/revoke", {
  method: "POST",
  headers: auth(A),
  body: { reason: "smoke test" },
});
check("Alice revokes the grant", revoke.status === 200, String(revoke.status));
const afterRevoke = await call("/api/resources/documents/doc-a1", { headers: auth(token) });
check(
  "the same signed, unexpired token stops working",
  afterRevoke.status === 403 && afterRevoke.body.reason === "grant_revoked",
  JSON.stringify(afterRevoke.body),
);

section("8. The authorization trail is complete, attributed and redacted");
const audit = await call("/api/audit?limit=200&agentId=" + agentId, { headers: auth(A) });
const denial = audit.body.events.find((event) => event.reason === "cross_user_denied");
check(
  "the cross-user denial names the human, the Agent principal and the target",
  Boolean(denial) && denial.actorUserId === "user-alice" && Boolean(denial.agentPrincipalId) && denial.resourceId === "doc-b1",
);
check("no raw credential appears in the trail", !JSON.stringify(audit.body).includes(token.slice(20, 60)));
check(
  "Bob cannot read Alice's authorization trail",
  (await call("/api/audit?limit=200", { headers: auth(B) })).body.events.every((event) => event.actorUserId === "user-bob"),
);
check("a non-admin cannot read the platform-wide trail", (await call("/api/audit?scope=platform", { headers: auth(A) })).status === 403);

console.log("\n" + (failures === 0 ? "ALL IDENTITY SMOKE CHECKS PASSED" : failures + " CHECK(S) FAILED"));
process.exit(failures === 0 ? 0 : 1);
