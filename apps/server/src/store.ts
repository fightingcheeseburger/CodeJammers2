import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Database } from "./types.js";

const emptyDatabase = (): Database => ({
  version: 2,
  users: [],
  sessions: [],
  principals: [],
  grants: [],
  approvals: [],
  audit: [],
  documents: [],
  agents: [],
  messages: [],
  runs: [],
});

/**
 * Forward migration from the Starter Kit's version 1 shape.
 *
 * A v1 database has Agents with no owner. Rather than guess, every
 * orphaned Agent is parked with `ownerId: ""` and the seeder adopts them
 * into the first operator account, recording the adoption in the audit
 * log. Nothing is silently granted to anybody.
 */
function migrate(parsed: Record<string, unknown>): Database {
  const version = parsed.version;
  if (version !== 1 && version !== 2) {
    throw new Error("Unsupported database format (version " + String(version) + ")");
  }
  const base = emptyDatabase();
  const legacyAgents = Array.isArray(parsed.agents) ? parsed.agents : [];
  return {
    ...base,
    users: (parsed.users as Database["users"]) ?? [],
    sessions: (parsed.sessions as Database["sessions"]) ?? [],
    principals: (parsed.principals as Database["principals"]) ?? [],
    grants: (parsed.grants as Database["grants"]) ?? [],
    approvals: (parsed.approvals as Database["approvals"]) ?? [],
    audit: (parsed.audit as Database["audit"]) ?? [],
    documents: (parsed.documents as Database["documents"]) ?? [],
    messages: (parsed.messages as Database["messages"]) ?? [],
    agents: legacyAgents.map((agent) => {
      const record = agent as Partial<Database["agents"][number]>;
      return {
        ...(record as Database["agents"][number]),
        ownerId: record.ownerId ?? "",
        principalId: record.principalId ?? "",
      };
    }),
    runs: (Array.isArray(parsed.runs) ? parsed.runs : []).map((run) => {
      const record = run as Partial<Database["runs"][number]>;
      return {
        ...(record as Database["runs"][number]),
        initiatedBy: record.initiatedBy ?? null,
        grantId: record.grantId ?? null,
        actionTokenId: record.actionTokenId ?? null,
      };
    }),
    version: 2,
  };
}

export class JsonStore {
  private data: Database = emptyDatabase();
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  async initialize(): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      if (!Array.isArray(parsed.agents)) {
        throw new Error("Unsupported database format");
      }
      this.data = migrate(parsed);
      await this.persist();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
      await this.persist();
    }
  }

  snapshot(): Database {
    return structuredClone(this.data);
  }

  async mutate<T>(mutation: (database: Database) => T | Promise<T>): Promise<T> {
    let result!: T;
    const operation = this.queue.then(async () => {
      const next = structuredClone(this.data);
      result = await mutation(next);
      await this.persist(next);
      this.data = next;
    });
    this.queue = operation.catch(() => undefined);
    await operation;
    return result;
  }

  private async persist(data: Database = this.data): Promise<void> {
    const temporaryPath = this.filePath + ".tmp";
    await writeFile(temporaryPath, JSON.stringify(data, null, 2) + "\n", {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporaryPath, this.filePath);
  }
}
