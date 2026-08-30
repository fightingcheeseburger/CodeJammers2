import type { AppConfig } from "../config.js";
import type { JsonStore } from "../store.js";
import type { Document, User } from "../types.js";
import { hashPassword, newId } from "./crypto.js";
import { DEFAULT_HUMAN_SCOPES } from "./scopes.js";

/**
 * Controlled fixtures.
 *
 * Two operators who own nothing of each other's, plus one admin who can
 * read the platform audit log and nothing else. Every reviewer can
 * reproduce the cross-user denial with these accounts and no setup.
 */
const OPERATOR_SCOPES = [...DEFAULT_HUMAN_SCOPES];

function makeUser(
  username: string,
  displayName: string,
  password: string,
  role: User["role"],
  scopes: string[],
): User {
  const { hash, salt } = hashPassword(password);
  return {
    id: "user-" + username,
    username,
    displayName,
    role,
    passwordHash: hash,
    passwordSalt: salt,
    scopes,
    disabledAt: null,
    createdAt: new Date().toISOString(),
  };
}

function makeDocument(
  id: string,
  ownerId: string,
  title: string,
  body: string,
  classification: Document["classification"],
): Document {
  return {
    id,
    ownerId,
    title,
    body,
    classification,
    updatedAt: new Date().toISOString(),
    updatedBy: null,
  };
}

export async function seedIdentityFixtures(
  store: JsonStore,
  config: AppConfig,
): Promise<void> {
  await store.mutate((database) => {
    if (database.users.length === 0) {
      database.users.push(
        makeUser("alice", "Alice (User A)", config.seedPasswords.alice, "operator", [
          ...OPERATOR_SCOPES,
        ]),
        makeUser("bob", "Bob (User B)", config.seedPasswords.bob, "operator", [
          ...OPERATOR_SCOPES,
        ]),
        // The admin can audit the platform but owns no documents and can
        // drive nobody else's Agents. Reading the log is not a master key.
        makeUser("admin", "Platform Admin", config.seedPasswords.admin, "admin", [
          "agents:read",
          "audit:read",
        ]),
      );
    }

    if (database.documents.length === 0) {
      database.documents.push(
        makeDocument(
          "doc-a1",
          "user-alice",
          "Alice - Q3 launch plan",
          "Internal launch checklist owned by Alice.",
          "internal",
        ),
        makeDocument(
          "doc-a2",
          "user-alice",
          "Alice - vendor shortlist",
          "Draft vendor comparison owned by Alice.",
          "internal",
        ),
        makeDocument(
          "doc-b1",
          "user-bob",
          "Bob - compensation review",
          "CONFIDENTIAL: Bob's private compensation notes. No Agent belonging to another user may read this.",
          "confidential",
        ),
        makeDocument(
          "doc-b2",
          "user-bob",
          "Bob - incident retro",
          "Bob's private incident retrospective.",
          "confidential",
        ),
      );
    }

    /**
     * Adopt any Agent migrated from a v1 database. Orphans go to the
     * first operator and the adoption is written to the audit log so the
     * change of ownership is never invisible.
     */
    const fallbackOwner = database.users.find((user) => user.role === "operator");
    if (!fallbackOwner) return;
    for (const agent of database.agents) {
      if (agent.ownerId) continue;
      agent.ownerId = fallbackOwner.id;
      const principalId = newId();
      agent.principalId = principalId;
      database.principals.push({
        id: principalId,
        agentId: agent.id,
        ownerId: fallbackOwner.id,
        name: "agent/" + agent.id.slice(0, 8),
        generation: 1,
        revokedAt: null,
        createdAt: new Date().toISOString(),
        rotatedAt: null,
      });
      database.audit.push({
        id: newId(),
        at: new Date().toISOString(),
        runId: null,
        actorUserId: fallbackOwner.id,
        agentPrincipalId: principalId,
        agentId: agent.id,
        principalKind: "human",
        action: "agent.adopt",
        resourceType: "agent",
        resourceId: agent.id,
        decision: "allow",
        reason: "migrated_from_v1",
        detail:
          "Agent had no owner in the v1 database and was adopted by " +
          fallbackOwner.username,
        scopes: [],
        grantId: null,
        tokenFingerprint: null,
      });
    }
  });
}
