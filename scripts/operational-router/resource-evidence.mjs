/**
 * ResourceEvidence input contract + strict parser + identity firewall.
 *
 * `ResourceEvidence` is the structured resource-evidence object the Operational
 * Router ingests. Today it is produced by a fixture / injected object; later it
 * will be the stdout of `orca resource status --json` without the adapter
 * changing. Shape (approved, task-frozen):
 *
 *   {
 *     queried_at: ISO string,            // when the Router READ evidence
 *     providers: {
 *       <providerId>: {
 *         available:        boolean,
 *         status:          "ok" | "degraded" | "error" | "unavailable" | ...,
 *         source_updated_at: ISO string, // when provider data was last updated
 *         data_age_ms:      number,
 *         rate_limited:     boolean,
 *         retry_at:         ISO string | null,
 *         windows: [
 *           {
 *             scope:   "session" | "weekly" | "fableWeekly" | "monthly" | "bucket" | ...,
 *             role:    "BURST" | "BUDGET" | "UNKNOWN",
 *             window_minutes: number,
 *             remaining_ratio: number 0..1 | null,
 *             remaining_ratio_granularity: number | null,
 *             reset_at: ISO string | null,
 *             reset_at_source: "unknown" | "absolute" | "RELATIVE_PROVIDER_DURATION" | ...
 *           }
 *         ]
 *       }
 *     }
 *   }
 *
 * This module NEVER retains identity: email, accountId, providerAccountId,
 * workspaceLabel, credentials, tokens, or raw provider payloads. Unknown keys
 * are dropped by allow-list copy; in `strict` mode a denied key is a hard
 * rejection. Denied values are never logged.
 *
 * Pure: no I/O. `JSON.parse` only, in try/catch.
 */

export const RESOURCE_EVIDENCE_CONTRACT_VERSION = "1.0.0";

// Windows are identified by (provider, scope, role, window_minutes) - never by
// array position. The adapter must not depend on array order.
export const WINDOW_IDENTITY_FIELDS = Object.freeze(["scope", "role", "window_minutes"]);

const KNOWN_PROVIDER_FIELDS = Object.freeze([
  "available",
  "status",
  "source_updated_at",
  "data_age_ms",
  "rate_limited",
  "retry_at",
  "windows",
]);

const KNOWN_WINDOW_FIELDS = Object.freeze([
  "scope",
  "role",
  "window_minutes",
  "remaining_ratio",
  "remaining_ratio_granularity",
  "reset_at",
  "reset_at_source",
]);

// Never copied onto normalized evidence. Presence triggers rejection in strict
// mode; otherwise silently dropped (never logged).
const IDENTITY_DENYLIST = Object.freeze([
  "email",
  "account",
  "account_id",
  "accountid",
  "accountId",
  "provideraccountid",
  "providerAccountId",
  "provider_account_id",
  "workspace",
  "workspacelabel",
  "workspaceLabel",
  "workspace_label",
  "user",
  "username",
  "user_name",
  "credential",
  "credentials",
  "token",
  "tokens",
  "access_token",
  "refresh_token",
  "api_key",
  "apikey",
  "apiKey",
  "authorization",
  "cookie",
  "raw",
  "raw_output",
  "raw_payload",
  "payload",
  "transcript",
]);

const WINDOW_ROLES = Object.freeze(["BURST", "BUDGET", "UNKNOWN"]);

export class ResourceEvidenceError extends Error {
  constructor(code, message) {
    super(message ?? code);
    this.name = "ResourceEvidenceError";
    this.code = code; // MALFORMED_JSON | SCHEMA_INVALID | IDENTITY_FIELD_PRESENT
  }
}

function isPlainObject(v) {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function isNonEmptyString(v) {
  return typeof v === "string" && v.trim().length > 0;
}
function isFiniteNumber(v) {
  return typeof v === "number" && Number.isFinite(v);
}

function assertNoIdentityKeys(obj, where, strict) {
  if (!isPlainObject(obj)) return;
  for (const key of Object.keys(obj)) {
    if (IDENTITY_DENYLIST.includes(key)) {
      if (strict) {
        // Message names the location and the key only - never the value.
        throw new ResourceEvidenceError(
          "IDENTITY_FIELD_PRESENT",
          `identity-bearing field ${JSON.stringify(key)} present at ${where}`,
        );
      }
      // non-strict: allow-list copy below drops it anyway; do not log.
    }
  }
}

/**
 * Normalizes one evidence window. Returns null (dropped) when the window is
 * malformed - a listed window with no usable role/scope is not evidence about
 * any horizon. Conservative: only fields that are directly present are copied;
 * nothing is inferred.
 */
function normalizeWindow(raw, where, strict) {
  if (!isPlainObject(raw)) return null;
  assertNoIdentityKeys(raw, where, strict);

  const scope = isNonEmptyString(raw.scope) ? raw.scope.trim() : null;
  const role = WINDOW_ROLES.includes(raw.role) ? raw.role : null;
  if (scope === null || role === null) return null;

  const windowMinutes = isFiniteNumber(raw.window_minutes) && raw.window_minutes > 0 ? raw.window_minutes : null;

  let remainingRatio = null;
  if (raw.remaining_ratio === null || raw.remaining_ratio === undefined) {
    remainingRatio = null;
  } else if (isFiniteNumber(raw.remaining_ratio) && raw.remaining_ratio >= 0 && raw.remaining_ratio <= 1) {
    remainingRatio = raw.remaining_ratio; // stored EXACTLY - no manufactured precision
  } else {
    remainingRatio = null; // out-of-range / non-numeric -> unknown, never clamped-guessed
  }

  const granularity =
    isFiniteNumber(raw.remaining_ratio_granularity) && raw.remaining_ratio_granularity > 0
      ? raw.remaining_ratio_granularity
      : null;

  const resetAt = isNonEmptyString(raw.reset_at) ? raw.reset_at.trim() : null;
  const resetAtSource = isNonEmptyString(raw.reset_at_source) ? raw.reset_at_source.trim() : "unknown";

  // Allow-list copy: anything not named here (identity included) never lands.
  void KNOWN_WINDOW_FIELDS;
  return {
    scope,
    role,
    window_minutes: windowMinutes,
    remaining_ratio: remainingRatio,
    remaining_ratio_granularity: granularity,
    reset_at: resetAt,
    reset_at_source: resetAtSource,
  };
}

function normalizeProvider(raw, providerId, strict) {
  if (!isPlainObject(raw)) {
    throw new ResourceEvidenceError("SCHEMA_INVALID", `provider ${JSON.stringify(providerId)} is not an object`);
  }
  assertNoIdentityKeys(raw, `providers.${providerId}`, strict);

  const rawWindows = Array.isArray(raw.windows) ? raw.windows : [];
  const windows = [];
  const dropped = [];
  rawWindows.forEach((w, i) => {
    const nw = normalizeWindow(w, `providers.${providerId}.windows[${i}]`, strict);
    if (nw === null) dropped.push(i);
    else windows.push(nw);
  });

  // Duplicate (scope, role, window_minutes) identity within one provider is a
  // schema problem: windows must be uniquely identifiable without array order.
  const seen = new Set();
  for (const w of windows) {
    const id = `${w.scope} ${w.role} ${w.window_minutes}`;
    if (seen.has(id)) {
      throw new ResourceEvidenceError(
        "SCHEMA_INVALID",
        `provider ${JSON.stringify(providerId)} has duplicate window identity (${w.scope}/${w.role}/${w.window_minutes})`,
      );
    }
    seen.add(id);
  }

  void KNOWN_PROVIDER_FIELDS;
  return {
    provider: providerId,
    available: typeof raw.available === "boolean" ? raw.available : null,
    status: isNonEmptyString(raw.status) ? raw.status.trim() : null,
    source_updated_at: isNonEmptyString(raw.source_updated_at) ? raw.source_updated_at.trim() : null,
    data_age_ms: isFiniteNumber(raw.data_age_ms) ? raw.data_age_ms : null,
    rate_limited: typeof raw.rate_limited === "boolean" ? raw.rate_limited : null,
    retry_at: isNonEmptyString(raw.retry_at) ? raw.retry_at.trim() : null,
    windows,
    dropped_window_indexes: dropped,
  };
}

/**
 * Parse + schema-check + identity-firewall a ResourceEvidence value.
 *
 * `input` may be a JSON string (parsed here) or an already-parsed object.
 * `options.strict` (default false): reject on any identity-bearing key rather
 * than dropping it.
 *
 * Throws ResourceEvidenceError with a `.code`; the message never echoes a
 * value from the payload.
 */
export function parseResourceEvidence(input, options = {}) {
  const { strict = false } = options;

  let value = input;
  if (typeof input === "string") {
    try {
      value = JSON.parse(input);
    } catch {
      throw new ResourceEvidenceError("MALFORMED_JSON", "resource evidence is not valid JSON");
    }
  }

  if (!isPlainObject(value)) {
    throw new ResourceEvidenceError("SCHEMA_INVALID", "resource evidence must be an object");
  }
  assertNoIdentityKeys(value, "<root>", strict);

  if (!isPlainObject(value.providers) || Object.keys(value.providers).length === 0) {
    throw new ResourceEvidenceError("SCHEMA_INVALID", "resource evidence must carry a non-empty providers object");
  }

  const queriedAt = isNonEmptyString(value.queried_at) ? value.queried_at.trim() : null;

  const providers = {};
  for (const [providerId, rawProvider] of Object.entries(value.providers)) {
    if (!isNonEmptyString(providerId)) {
      throw new ResourceEvidenceError("SCHEMA_INVALID", "provider id must be a non-empty string");
    }
    if (IDENTITY_DENYLIST.includes(providerId)) {
      throw new ResourceEvidenceError("SCHEMA_INVALID", `provider id ${JSON.stringify(providerId)} is not allowed`);
    }
    providers[providerId] = normalizeProvider(rawProvider, providerId, strict);
  }

  return {
    contract_version: RESOURCE_EVIDENCE_CONTRACT_VERSION,
    queried_at: queriedAt,
    providers,
  };
}

/**
 * Find one window on a normalized provider by identity, never by index.
 */
export function findWindow(normalizedProvider, { scope, role, window_minutes } = {}) {
  if (!isPlainObject(normalizedProvider) || !Array.isArray(normalizedProvider.windows)) return null;
  return (
    normalizedProvider.windows.find(
      (w) =>
        (scope === undefined || w.scope === scope) &&
        (role === undefined || w.role === role) &&
        (window_minutes === undefined || w.window_minutes === window_minutes),
    ) ?? null
  );
}
