/**
 * Scope vocabulary
 * ================
 *
 * Scopes are per-operation, never per-service. "docs:read" and
 * "docs:write" are separate capabilities so that a read-only Agent stays
 * read-only even if its prompt is poisoned.
 */

export const CONTROL_PLANE_SCOPES = [
  "agents:read",
  "agents:write",
  "agents:run",
  "grants:manage",
  "audit:read",
] as const;

export const RESOURCE_SCOPES = ["docs:read", "docs:write", "docs:delete"] as const;

export const ALL_SCOPES: readonly string[] = [
  ...CONTROL_PLANE_SCOPES,
  ...RESOURCE_SCOPES,
];

/**
 * Only data-plane scopes may be delegated to an Agent principal. Control
 * plane authority stays with humans: an Agent can never be granted
 * "agents:write" and therefore can never create another Agent, edit its
 * own instructions, or mint itself a wider grant. This single rule closes
 * the most obvious privilege-escalation path in an Agent platform.
 */
export const DELEGATABLE_SCOPES: readonly string[] = [...RESOURCE_SCOPES];

/**
 * Scopes whose use requires an explicit human decision at the moment of
 * use, not merely at delegation time. Reads are cheap and reversible;
 * writes and deletes are not.
 */
export const HIGH_RISK_SCOPES: readonly string[] = ["docs:write", "docs:delete"];

export const DEFAULT_HUMAN_SCOPES: readonly string[] = [
  "agents:read",
  "agents:write",
  "agents:run",
  "grants:manage",
  "docs:read",
  "docs:write",
  "docs:delete",
];

export function isKnownScope(scope: string): boolean {
  return ALL_SCOPES.includes(scope);
}

export function isDelegatable(scope: string): boolean {
  return DELEGATABLE_SCOPES.includes(scope);
}

export function isHighRisk(scope: string): boolean {
  return HIGH_RISK_SCOPES.includes(scope);
}

/** True when every scope in `requested` also appears in `held`. */
export function isSubsetOf(requested: readonly string[], held: readonly string[]): boolean {
  return requested.every((scope) => held.includes(scope));
}

export function normalizeScopes(scopes: readonly string[]): string[] {
  return [...new Set(scopes.map((scope) => scope.trim()).filter(Boolean))].sort();
}

/** The scope a given resource operation demands. */
export function scopeForDocumentAction(action: "read" | "write" | "delete"): string {
  return "docs:" + action;
}
