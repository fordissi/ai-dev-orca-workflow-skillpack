/**
 * Shared pure resource-routing implementation.
 *
 * This is the single source of truth for the Skillpack's resource-aware
 * routing math: window roles, freshness / reset-generation validity,
 * BUDGET conservation, BURST depletion, stranded capacity, PACE trajectory,
 * Router capacity reserve, resource-acquisition precedence and candidate
 * selection. RESOURCE_AWARE_ROUTING.md / MODEL_ROUTING_POLICY.md remain the
 * normative owners; this module only makes them executable.
 *
 * It is imported by BOTH:
 *   - scripts/validate-policy-pack.mjs  (the conformance checker)
 *   - scripts/operational-router/*      (the live Operational Router adapter)
 *
 * Extraction is refactor-only: every function here is byte-equivalent to the
 * implementation that previously lived inline in the conformance checker.
 * Pure: no I/O, no environment access, no provider contact, no dispatch.
 */

const RESOURCE_STATES = ["GREEN", "YELLOW", "RED", "UNKNOWN"];

// A snapshot's authority is inherited from its source; the snapshot itself is
// only an overlay/cache. Trust levels live in RESOURCE_AWARE_ROUTING.md.
// PROVIDER_NATIVE_PROBE is fresh observational evidence read directly from a
// provider's own read-only CLI (/status, /usage) when Orca exposes no
// structured quota fields.
const RESOURCE_SOURCES = ["ORCA_RUNTIME", "PROVIDER_NATIVE_PROBE", "USER_STATEMENT", "UNKNOWN"];

// Outcomes of a single provider-native resource probe. Resource-acquisition
// outcomes only: they never disable a model, mark it unqualified, mutate the
// registry, or count as an implementation failure.
const PROBE_OUTCOMES = [
  "PROBE_OK",
  "PROBE_AUTH_REQUIRED",
  "PROBE_CLI_MISSING",
  "PROBE_SESSION_UNAVAILABLE",
  "PROBE_PERMISSION_BLOCKED",
  "PROBE_PARSE_FAILED",
  "PROBE_DATA_UNAVAILABLE",
  "PROBE_TIMEOUT",
  "PROBE_IDENTITY_UNCERTAIN",
];

// Capability stage: a backward-compatible band ABOVE capability_tier. Ordered,
// but not a ladder you can climb past - the gate is "meet the required stage,
// and a flagship (STAGE_3) candidate is admitted only when the required stage
// IS STAGE_3". MODEL_ROUTING_POLICY.md owns the semantics; MODEL_REGISTRY.yaml
// owns which tier maps to which stage.
const STAGE_ORDER = ["STAGE_1_DEFAULT", "STAGE_2_ADVANCED", "STAGE_3_FLAGSHIP"];

function stageIndex(stage) {
  return STAGE_ORDER.indexOf(stage);
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Capability tiers are the only comparable ladder. Roles and slots are
 * orthogonal tags and must never be ranked against each other.
 */
function tierIndex(tierOrder, tier) {
  return tierOrder.indexOf(tier);
}

/**
 * A snapshot entry may only confer a confident state if it declares where it
 * came from.
 *
 * Absence of an entry is UNKNOWN: no reading at all is missing data, which is
 * neither punished nor rewarded. An entry that is present but malformed is a
 * different thing - it is a claim the snapshot cannot back up - so it fails
 * closed as CONFIG_INVALID and can never win selection. Trust levels are owned
 * by RESOURCE_AWARE_ROUTING.md.
 */
function resourceEntryTrust(entry) {
  if (entry === undefined) return null;

  if (!("source" in entry)) {
    return "resource entry declares no source";
  }

  if (!RESOURCE_SOURCES.includes(entry.source)) {
    return `resource entry has unknown source ${JSON.stringify(entry.source)}`;
  }

  if (entry.source === "UNKNOWN" && entry.state !== "UNKNOWN") {
    return `resource entry claims state ${JSON.stringify(entry.state)} with source UNKNOWN`;
  }

  return null;
}

function resolveResourceEntry(resourceStates, resourceStateKey) {
  if (!isPlainObject(resourceStates) || !isNonEmptyString(resourceStateKey)) {
    return undefined;
  }

  let cursor = resourceStates;
  for (const segment of resourceStateKey.split(".")) {
    if (!isPlainObject(cursor)) return undefined;
    cursor = Object.hasOwn(cursor, segment) ? cursor[segment] : cursor?.pools?.[segment];
  }

  return isPlainObject(cursor) ? cursor : undefined;
}

/* ------------------------------------------------------------------------ *
 * Hierarchical resource windows
 *
 * Quota opportunity cost is a routing signal, not capability authority, and
 * short-window opportunity must not override long-horizon scarcity.
 * RESOURCE_AWARE_ROUTING.md owns these roles and thresholds; this section only
 * makes them executable. Nothing here can change which candidates are
 * eligible - it only reorders candidates that already passed every check.
 *
 * A quota window has a role, not a name:
 *   BURST  - a short rolling window. Its capacity is use-it-or-lose-it, so it
 *            supplies the utilization signal (stranded capacity).
 *   BUDGET - a long-horizon cap. Its capacity is what runs out for the rest of
 *            the week or month, so it supplies the scarcity signal
 *            (conservation pressure) and outranks the burst signal.
 * ------------------------------------------------------------------------ */

const WINDOW_ROLES = ["BURST", "BUDGET"];
const RESET_PROXIMITY_VALUES = ["NEAR", "MEDIUM", "FAR", "UNKNOWN"];
const STRANDED_RISK_VALUES = ["HIGH", "MEDIUM", "LOW", "UNKNOWN"];
const CONSERVATION_VALUES = ["CRITICAL", "HIGH", "MEDIUM", "LOW", "NONE", "UNKNOWN"];
const CONFIDENCE_VALUES = ["HIGH", "MEDIUM", "LOW", "UNKNOWN"];

// BURST depletion: the defensive mirror of stranded capacity. A short window
// that is nearly spent AND does not refill soon strands *work*, not capacity.
// It never reaches CRITICAL - a 5h window is not a long-horizon existential
// risk the way a weekly BUDGET is. Demotion only, NEW_WORK only, ROUTER-exempt.
const BURST_DEPLETION_VALUES = ["HIGH", "MEDIUM", "LOW", "NONE", "UNKNOWN"];

// Long-horizon PACE / trajectory pressure. Evidence-gated: it is UNKNOWN (and
// therefore routing-neutral) unless multiple same-generation observations
// establish a burn velocity. `pace_reason` is a label, not a state.
const PACE_PRESSURE_VALUES = ["CRITICAL", "HIGH", "ELEVATED", "LOW", "NONE", "UNKNOWN"];
const PACE_CONFIDENCE_VALUES = ["HIGH", "MEDIUM", "UNKNOWN"];
const PACE_REASONS = ["WEEKLY_OVERBURN", "PROJECTED_EARLY_EXHAUSTION"];

// The composed defensive rank a candidate falls into once BUDGET conservation,
// BURST depletion and PACE pressure are folded together. Worse rank = later in
// the band. BUDGET absolute scarcity always outranks softer pressure.
const RESOURCE_PRESSURE_RANKS = ["CLEAR", "SOFT_PRESSURED", "BUDGET_SCARCE"];

// PACE evidence contract. Versioned here and operator-overridable via the
// `paceConfig` option - NOT silent policy truth. RESOURCE_AWARE_ROUTING.md's
// "Long-horizon pace / trajectory" section is the owner.
const PACE_EVIDENCE = Object.freeze({
  min_observations: 3, // fewer than this -> UNKNOWN
  min_total_span_ms: 30 * 60 * 1000, // the series must cover at least 30 min
  reset_at_tolerance_ms: 60 * 60 * 1000, // same generation if reset_at agrees within 1h
  upward_jump_ratio: 0.05, // remaining rising more than 5 points -> generation change
});

// A reading can never be more confident than the source it came from.
const SOURCE_TRUST = {
  ORCA_RUNTIME: "HIGH",
  // Directly observed from the provider's own CLI with a verified account /
  // pool identity and a successful parse. Same trust ceiling as ORCA_RUNTIME;
  // an unverified identity lowers it via remaining_confidence
  // (PROBE_IDENTITY_UNCERTAIN never yields a usable entry).
  PROVIDER_NATIVE_PROBE: "HIGH",
  USER_STATEMENT: "MEDIUM",
  UNKNOWN: "UNKNOWN",
};

// Legacy v0.3 snapshots named their windows instead of typing them. The names
// keep working and mean what they always meant; an explicit `role` wins, so a
// provider whose short window really is its budget can say so.
const LEGACY_WINDOW_ROLES = [
  ["short_window", "BURST"],
  ["weekly_window", "BUDGET"],
];

const RESET_NEAR_MS = 6 * 60 * 60 * 1000;
const RESET_MEDIUM_MS = 48 * 60 * 60 * 1000;

// A short window's sense of "near" is not a weekly window's. Burst depletion
// reads reset proximity on tighter thresholds: a 5h window refilling in half
// an hour self-heals before most new work would finish.
const BURST_RESET_NEAR_MS = 30 * 60 * 1000;
const BURST_RESET_MEDIUM_MS = 3 * 60 * 60 * 1000;

const REMAINING_HIGH = 0.5;
const REMAINING_MODERATE = 0.2;

const BUDGET_AMPLE = 0.5;
const BUDGET_COMFORTABLE = 0.25;
const BUDGET_LOW = 0.1;

// BURST depletion bands: at or below BURST_SCARCE is acute, below BURST_TIGHT
// is mild. Mirrors BUDGET_LOW / BUDGET_COMFORTABLE for the short horizon.
const BURST_SCARCE = 0.1;
const BURST_TIGHT = 0.25;

// The freshness rule already stated in RESOURCE_AWARE_ROUTING.md. A decayed
// remaining ratio is worse than no ratio, because it looks authoritative.
const SNAPSHOT_FRESH_MS = 5 * 60 * 1000;

function rankIn(values, value) {
  const index = values.indexOf(value);
  return index === -1 ? 0 : values.length - index;
}

const confidenceRank = (value) => rankIn(CONFIDENCE_VALUES, value);
const riskRank = (value) => rankIn(STRANDED_RISK_VALUES, value);
const proximityRank = (value) => rankIn(RESET_PROXIMITY_VALUES, value);

// UNKNOWN ranks below every stated pressure, so "take the most restrictive"
// never lets a missing reading outrank one somebody actually took.
const conservationRank = (value) => rankIn(CONSERVATION_VALUES, value) - 1;
const burstDepletionRank = (value) => rankIn(BURST_DEPLETION_VALUES, value) - 1;
const pacePressureRank = (value) => rankIn(PACE_PRESSURE_VALUES, value) - 1;

function toMillis(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : Number.NaN;
  if (isNonEmptyString(value)) return Date.parse(value);
  if (value instanceof Date) return value.getTime();
  return Number.NaN;
}

/**
 * Parses a provider-native RELATIVE refresh duration such as "160h 46m",
 * "3h", "45m" into milliseconds. Conservative: hours+minutes, hours only or
 * minutes only, all non-negative integers; anything else -> null (the caller
 * then keeps reset_at UNKNOWN). It never invents a duration.
 *
 * Antigravity `agy /usage` prints these on a consumed window
 * ("... Refreshes in 160h 46m"); see references/RESOURCE_PROBES.md.
 */
export function parseRelativeDuration(text) {
  if (!isNonEmptyString(text)) return null;
  const cleaned = text.trim();
  const full = /^(\d+)\s*h\s*(\d+)\s*m$/i.exec(cleaned);
  if (full) {
    const h = Number(full[1]);
    const m = Number(full[2]);
    if (m >= 60) return null;
    return (h * 60 + m) * 60 * 1000;
  }
  const hoursOnly = /^(\d+)\s*h$/i.exec(cleaned);
  if (hoursOnly) return Number(hoursOnly[1]) * 60 * 60 * 1000;
  const minutesOnly = /^(\d+)\s*m$/i.exec(cleaned);
  if (minutesOnly) return Number(minutesOnly[1]) * 60 * 1000;
  return null;
}

/**
 * Normalizes a relative refresh duration against the probe's checked_at into
 * an absolute ISO reset_at. Provenance stays RELATIVE_PROVIDER_DURATION at the
 * call site - this does not claim the provider emitted an absolute timestamp.
 * Unparseable duration or checked_at -> null (reset_at UNKNOWN).
 */
export function relativeResetAt(checkedAt, durationText) {
  const base = toMillis(checkedAt);
  const deltaMs = parseRelativeDuration(durationText);
  if (!Number.isFinite(base) || deltaMs === null) return null;
  return new Date(base + deltaMs).toISOString();
}

/**
 * Every window on an entry, in a single shape, whatever schema it was written
 * in. A window whose role cannot be established is dropped rather than
 * guessed: an unclassified window is not evidence about either horizon.
 */
export function resourceWindows(entry) {
  if (!isPlainObject(entry)) return [];

  const windows = [];
  const push = (key, role, window) => {
    if (!WINDOW_ROLES.includes(role)) return;
    windows.push({
      key,
      role,
      remaining_ratio: window.remaining_ratio,
      reset_at: window.reset_at,
      // Optional nominal horizon of the window, in minutes. Present on
      // evidence-sourced entries; absent on legacy / hand-written snapshots.
      // Used only by the Weekly Balance signal as the balancing horizon - it
      // is NOT a claim that generations are fixed periods.
      window_minutes:
        typeof window.window_minutes === "number" && Number.isFinite(window.window_minutes)
          ? window.window_minutes
          : null,
    });
  };

  if (Array.isArray(entry.windows)) {
    for (const [index, window] of entry.windows.entries()) {
      if (!isPlainObject(window)) continue;
      push(isNonEmptyString(window.key) ? window.key : `windows[${index}]`, window.role, window);
    }
  }

  for (const [key, defaultRole] of LEGACY_WINDOW_ROLES) {
    const window = entry[key];
    if (!isPlainObject(window)) continue;
    push(key, WINDOW_ROLES.includes(window.role) ? window.role : defaultRole, window);
  }

  return windows;
}

/**
 * How close a window is to refilling.
 *
 * A reset time already in the past describes a window that no longer exists,
 * so it reads UNKNOWN rather than NEAR: the honest answer is that this
 * snapshot no longer says anything about the current window.
 */
export function resetProximity(resetAt, now) {
  const at = toMillis(resetAt);
  const evaluatedAt = toMillis(now);
  if (!Number.isFinite(at) || !Number.isFinite(evaluatedAt)) return "UNKNOWN";

  const remainingMs = at - evaluatedAt;
  if (remainingMs <= 0) return "UNKNOWN";
  if (remainingMs <= RESET_NEAR_MS) return "NEAR";
  if (remainingMs <= RESET_MEDIUM_MS) return "MEDIUM";
  return "FAR";
}

/**
 * How much of a BURST window's capacity would be lost to its reset.
 *
 * Stranding needs both halves: a lot left AND little time to spend it. Plenty
 * of capacity with a distant reset is not stranded, and an almost-spent window
 * strands nothing however soon it refills.
 */
export function strandedCapacityRisk(remainingRatio, proximity) {
  if (typeof remainingRatio !== "number" || !Number.isFinite(remainingRatio)) return "UNKNOWN";
  if (remainingRatio < 0 || remainingRatio > 1) return "UNKNOWN";
  if (!RESET_PROXIMITY_VALUES.includes(proximity) || proximity === "UNKNOWN") return "UNKNOWN";

  if (remainingRatio >= REMAINING_HIGH) {
    if (proximity === "NEAR") return "HIGH";
    return proximity === "MEDIUM" ? "MEDIUM" : "LOW";
  }

  if (remainingRatio >= REMAINING_MODERATE) {
    return proximity === "NEAR" ? "MEDIUM" : "LOW";
  }

  return "LOW";
}

/**
 * How hard a BUDGET window argues for conserving this provider.
 *
 * Proximity reduces pressure here, the opposite of its effect on a burst
 * window. Ten percent of a weekly cap left with five days to run is a real
 * constraint on everything scheduled this week; the same ten percent an hour
 * before the cap refills constrains almost nothing, because the scarcity
 * resolves itself inside the horizon of the work being routed.
 */
export function conservationPressure(remainingRatio, proximity) {
  if (typeof remainingRatio !== "number" || !Number.isFinite(remainingRatio)) return "UNKNOWN";
  if (remainingRatio < 0 || remainingRatio > 1) return "UNKNOWN";
  if (!RESET_PROXIMITY_VALUES.includes(proximity) || proximity === "UNKNOWN") return "UNKNOWN";

  if (remainingRatio >= BUDGET_AMPLE) return proximity === "FAR" ? "LOW" : "NONE";
  if (remainingRatio >= BUDGET_COMFORTABLE) return proximity === "FAR" ? "MEDIUM" : "LOW";
  if (remainingRatio >= BUDGET_LOW) {
    if (proximity === "NEAR") return "LOW";
    return proximity === "MEDIUM" ? "MEDIUM" : "HIGH";
  }
  if (proximity === "NEAR") return "MEDIUM";
  return proximity === "MEDIUM" ? "HIGH" : "CRITICAL";
}

/**
 * How much unused long-horizon BUDGET is at risk of expiring at reset.
 *
 * The offensive mirror of conservation_pressure, and the exact opposite shape:
 * "a lot left AND little time to spend it" is what makes a weekly/monthly cap
 * worth using before it refills. An almost-spent budget has almost nothing to
 * strand, so it never rises above LOW - there is no strong preference for
 * burning the last few percent. RESOURCE_AWARE_ROUTING.md owns this matrix.
 */
export function budgetExpiryOpportunity(remainingRatio, proximity) {
  if (typeof remainingRatio !== "number" || !Number.isFinite(remainingRatio)) return "UNKNOWN";
  if (remainingRatio < 0 || remainingRatio > 1) return "UNKNOWN";
  if (!RESET_PROXIMITY_VALUES.includes(proximity) || proximity === "UNKNOWN") return "UNKNOWN";

  if (remainingRatio >= BUDGET_AMPLE) {
    if (proximity === "NEAR") return "HIGH";
    return proximity === "MEDIUM" ? "MEDIUM" : "LOW";
  }
  if (remainingRatio >= BUDGET_COMFORTABLE) {
    return proximity === "NEAR" ? "MEDIUM" : "LOW";
  }
  // Below BUDGET_COMFORTABLE (0.25) there is too little left to strand: LOW
  // whatever the proximity, so scarcity - not expiry - drives the decision.
  return "LOW";
}

/**
 * How close a BURST window is to refilling, on thresholds tuned to a short
 * window rather than a weekly cap: NEAR is "self-heals almost immediately"
 * (<= 30 min), FAR is "stuck without this capacity for a while" (> 3h).
 * A reset already in the past is UNKNOWN, exactly like `resetProximity`.
 */
export function burstResetProximity(resetAt, now) {
  const at = toMillis(resetAt);
  const evaluatedAt = toMillis(now);
  if (!Number.isFinite(at) || !Number.isFinite(evaluatedAt)) return "UNKNOWN";

  const remainingMs = at - evaluatedAt;
  if (remainingMs <= 0) return "UNKNOWN";
  if (remainingMs <= BURST_RESET_NEAR_MS) return "NEAR";
  if (remainingMs <= BURST_RESET_MEDIUM_MS) return "MEDIUM";
  return "FAR";
}

/**
 * How hard a BURST window argues for conserving this provider for NEW work.
 *
 * The defensive mirror of stranded capacity: it needs both halves the other
 * way round - little left AND a reset that is not imminent. Proximity reduces
 * it, like BUDGET conservation and unlike stranded capacity: a nearly empty
 * five-hour window that refills in 20 minutes strands almost nothing, because
 * it heals inside the horizon of the work being routed. It never reaches
 * CRITICAL; a short window is not a long-horizon existential risk.
 * RESOURCE_AWARE_ROUTING.md owns this matrix.
 */
export function burstDepletionPressure(remainingRatio, proximity) {
  if (typeof remainingRatio !== "number" || !Number.isFinite(remainingRatio)) return "UNKNOWN";
  if (remainingRatio < 0 || remainingRatio > 1) return "UNKNOWN";
  if (!RESET_PROXIMITY_VALUES.includes(proximity) || proximity === "UNKNOWN") return "UNKNOWN";

  // Ample short-window capacity: nothing to conserve.
  if (remainingRatio >= REMAINING_HIGH) return "NONE";

  if (remainingRatio >= BURST_TIGHT) {
    return proximity === "FAR" ? "LOW" : "NONE";
  }
  if (remainingRatio >= BURST_SCARCE) {
    if (proximity === "NEAR") return "NONE";
    return proximity === "MEDIUM" ? "LOW" : "MEDIUM";
  }
  // Below BURST_SCARCE (0.1): acute unless it refills almost immediately.
  if (proximity === "NEAR") return "LOW";
  return proximity === "MEDIUM" ? "MEDIUM" : "HIGH";
}

/**
 * The part of a reading that is common to both signals: whether the entry can
 * carry any weight at all.
 *
 * Returns null when it cannot - an untrusted or malformed entry, an UNKNOWN
 * state, a snapshot too old for its ratios to still be true, or a confidence
 * below MEDIUM. Every one of those yields UNKNOWN on both signals, which is
 * neutral: it neither promotes nor demotes.
 */
/**
 * Whether any of an entry's quota windows has reached or passed its reset.
 *
 * `checked_at` recency does not rescue a window across its reset boundary: a
 * window whose reset_at is <= now describes the previous quota generation and
 * MUST NOT be reused. A refresh is required before the next autonomous
 * selection. RESOURCE_AWARE_ROUTING.md's Freshness section is the owner.
 */
export function resetExpired(entry, now) {
  const evaluatedAt = toMillis(now);
  if (!Number.isFinite(evaluatedAt)) return false;
  return resourceWindows(entry).some((window) => {
    const at = toMillis(window.reset_at);
    return Number.isFinite(at) && at <= evaluatedAt;
  });
}

/**
 * Whether a resource entry needs refreshing before it can drive an autonomous
 * routing decision: a stale reading past its reset boundary, or one an
 * event-driven trigger has explicitly invalidated (`invalidated: true`, set by
 * the operational router after a rate-limit / quota-exhausted / dispatch
 * failure / newer-user-fact event). Not a permanent provider failure.
 */
export function refreshRequired(entry, now) {
  if (!isPlainObject(entry)) return false;
  return entry.invalidated === true || resetExpired(entry, now);
}

/**
 * Whether a resource entry is a fresh, trustworthy reading usable right now:
 * a declared valid source, no trust-invariant violation, not reset-expired or
 * event-invalidated, and a checked_at inside the freshness TTL.
 */
function entryUsableNow(entry, now) {
  if (!isPlainObject(entry)) return false;
  if (resourceEntryTrust(entry) !== null) return false;
  if (refreshRequired(entry, now)) return false;
  const evaluatedAt = toMillis(now);
  const checkedAt = toMillis(entry.checked_at);
  return Number.isFinite(checkedAt) && Number.isFinite(evaluatedAt) && evaluatedAt - checkedAt <= SNAPSHOT_FRESH_MS;
}

/**
 * Resource-acquisition precedence for one resource_state_key whose snapshot
 * needs refreshing. RESOURCE_AWARE_ROUTING.md's "Resource acquisition" section
 * is the owner; this makes the precedence executable.
 *
 *   1. structured trusted runtime data (ORCA_RUNTIME)
 *   2. a successful provider-native read-only probe (PROVIDER_NATIVE_PROBE)
 *   3. fresh user-provided facts (USER_STATEMENT)
 *   4. UNKNOWN
 *
 * A provider-native probe is usable only with probe_status PROBE_OK and a
 * fresh, trustworthy entry; any other probe outcome (auth required, CLI
 * missing, parse failed, identity uncertain, ...) falls through without
 * disabling anything. UNKNOWN is neutral, never a block.
 */
export function resolveResourceAcquisition(tiers, options = {}) {
  const { now = Date.now() } = options;
  const t = isPlainObject(tiers) ? tiers : {};
  const probe = isPlainObject(t.probe) ? t.probe : null;
  const probeStatus = probe !== null && PROBE_OUTCOMES.includes(probe.probe_status) ? probe.probe_status : null;

  // Tier 0: the current snapshot is still fresh and valid (any trusted source,
  // including a prior PROVIDER_NATIVE_PROBE) - reuse it, no acquisition needed.
  if (entryUsableNow(t.current, now)) {
    return { acquisition_source: t.current.source, probe_status: probeStatus, fallback_used: false, entry: t.current };
  }

  // Tier 1: fresh structured runtime data (ORCA_RUNTIME).
  if (entryUsableNow(t.structured, now)) {
    return { acquisition_source: "ORCA_RUNTIME", probe_status: probeStatus, fallback_used: false, entry: t.structured };
  }

  // Tier 2: a successful provider-native probe. Only PROBE_OK yields a usable
  // reading; every other outcome falls through.
  if (probe !== null && probe.probe_status === "PROBE_OK" && entryUsableNow(probe.entry, now)) {
    return {
      acquisition_source: "PROVIDER_NATIVE_PROBE",
      probe_status: "PROBE_OK",
      fallback_used: isPlainObject(t.structured),
      entry: probe.entry,
    };
  }

  // Tier 3: fresh user-provided facts.
  if (entryUsableNow(t.user_statement, now)) {
    return { acquisition_source: "USER_STATEMENT", probe_status: probeStatus, fallback_used: true, entry: t.user_statement };
  }

  // Tier 4: UNKNOWN - neutral, never a block.
  return {
    acquisition_source: "UNKNOWN",
    probe_status: probeStatus,
    fallback_used: true,
    entry: { state: "UNKNOWN", source: "UNKNOWN", checked_at: null, available: null },
  };
}

// Two facts a quota check must never collapse into one status.
// `provider_resource_state` is how much quota the provider itself reports;
// `orca_integration_state` is only whether Orca can currently see / launch the
// provider integration (`orca account list` and friends).
export const PROVIDER_RESOURCE_STATES = ["AVAILABLE", "PRESSURED", "EXHAUSTED", "UNKNOWN"];
export const ORCA_INTEGRATION_STATES = ["AVAILABLE", "UNAVAILABLE", "DEGRADED", "UNKNOWN"];

// Maps a normalized provider reading to a coarse resource band. A stale,
// low-confidence or unreadable entry is UNKNOWN - never EXHAUSTED, so a failed
// probe cannot be mistaken for an empty quota.
function classifyProviderResourceState(entry, now) {
  const readable = isPlainObject(entry) ? readableEntry(entry, now) : null;
  if (readable === null || !readable.usable) return "UNKNOWN";
  if (entry.available === false || readable.state === "RED") return "EXHAUSTED";
  if (readable.state === "YELLOW") return "PRESSURED";

  const ratios = resourceWindows(entry)
    .map((w) => w.remaining_ratio)
    .filter((r) => typeof r === "number" && Number.isFinite(r) && r >= 0 && r <= 1);
  if (ratios.length > 0) {
    const min = Math.min(...ratios);
    if (min <= 0.05) return "EXHAUSTED";
    if (min <= 0.2) return "PRESSURED";
    return "AVAILABLE";
  }
  return readable.state === "GREEN" ? "AVAILABLE" : "UNKNOWN";
}

// The reset_at from the authoritative provider reading (BUDGET window first).
// This is what wins over any reset hint carried on an Orca aggregate view.
function firstProviderReset(entry) {
  const windows = resourceWindows(entry);
  const budgetWindow = windows.find((w) => w.role === "BUDGET" && w.reset_at != null);
  if (budgetWindow) return budgetWindow.reset_at;
  const anyWindow = windows.find((w) => w.reset_at != null);
  return anyWindow ? anyWindow.reset_at : null;
}

/**
 * Separates provider quota evidence from Orca integration visibility so the
 * Router cannot read an `orca account list` "unavailable" as a spent quota.
 * RESOURCE_AWARE_ROUTING.md's "Provider-native quota probe precedence" section
 * is the owner; this makes the two-axis rule executable.
 *
 * `provider_resource_state` is set ONLY by a successful provider-native probe,
 * an equivalent authoritative adapter, or fresh USER_STATEMENT facts. Orca
 * aggregate / account visibility never sets it - not up, not down. A successful
 * provider-native probe is therefore never overridden by Orca aggregate state
 * (`aggregate_overrode_probe` is structurally always false), and an Orca
 * "unavailable" never turns an UNKNOWN provider reading into EXHAUSTED.
 *
 * `quota_available` and `dispatch_runtime_available` stay distinct: quota
 * sufficiency does not prove dispatchability, which still needs a separate
 * runtime check plus registry / stage / reserve / disjointness / identity.
 *
 * Pure evidence resolution: it returns no stage, model, provider, reasoning
 * effort or registry field, and recommends nothing.
 */
export function separateQuotaEvidence(inputs = {}, options = {}) {
  const { now = Date.now() } = options;
  const i = isPlainObject(inputs) ? inputs : {};

  const probe = isPlainObject(i.provider_probe) ? i.provider_probe : null;
  const adapter = isPlainObject(i.provider_adapter) ? i.provider_adapter : null;
  const userStatement = isPlainObject(i.user_statement) ? i.user_statement : null;

  const usableProbe = probe !== null && probe.probe_status === "PROBE_OK" && entryUsableNow(probe.entry, now);
  const usableAdapter =
    adapter !== null && adapter.status === "ADAPTER_OK" && entryUsableNow(adapter.entry, now);
  const userEntry = userStatement !== null ? userStatement.entry ?? userStatement : null;
  const usableUser = userEntry !== null && entryUsableNow(userEntry, now);

  let providerEntry = null;
  let evidenceSource = "UNKNOWN";
  if (usableProbe) {
    providerEntry = probe.entry;
    evidenceSource = "PROVIDER_NATIVE_PROBE";
  } else if (usableAdapter) {
    providerEntry = adapter.entry;
    evidenceSource = "PROVIDER_ADAPTER";
  } else if (usableUser) {
    providerEntry = userEntry;
    evidenceSource = "USER_STATEMENT";
  }

  const providerOffered = probe !== null || adapter !== null || userStatement !== null;
  const staleEvidenceSeen = providerOffered && providerEntry === null;

  const providerState = providerEntry !== null ? classifyProviderResourceState(providerEntry, now) : "UNKNOWN";
  const providerReset = providerEntry !== null ? firstProviderReset(providerEntry) : null;

  const orca = isPlainObject(i.orca_integration) ? i.orca_integration : null;
  const orcaState =
    orca !== null && ORCA_INTEGRATION_STATES.includes(orca.visibility) ? orca.visibility : "UNKNOWN";

  const quotaAvailable =
    providerState === "AVAILABLE" ? "YES" : providerState === "EXHAUSTED" ? "NO" : "UNKNOWN";

  const dispatchRuntime = isPlainObject(i.dispatch_runtime) ? i.dispatch_runtime : null;
  const dispatchRuntimeAvailable =
    dispatchRuntime !== null && ["YES", "NO", "UNKNOWN"].includes(dispatchRuntime.available)
      ? dispatchRuntime.available
      : "UNKNOWN";

  return {
    provider_resource_state: providerState,
    orca_integration_state: orcaState,
    resource_evidence_source: evidenceSource,
    quota_available: quotaAvailable,
    dispatch_runtime_available: dispatchRuntimeAvailable,
    provider_reset_at: providerReset,
    // Orca aggregate state has no path to change provider_resource_state.
    aggregate_overrode_probe: false,
    // A successful probe is not implied by Orca availability; weak corroboration only.
    orca_fallback_usable: providerState === "UNKNOWN" && orcaState === "AVAILABLE",
    // Explicit human quota question, or no usable provider reading yet.
    provider_native_probe_required: i.human_quota_query === true || !usableProbe,
    // Stale / unknown provider evidence must be refreshed before a new dispatch.
    refresh_before_dispatch: staleEvidenceSeen || providerState === "UNKNOWN",
  };
}

function readableEntry(entry, now) {
  if (!isPlainObject(entry)) return null;
  if (resourceEntryTrust(entry) !== null) return null;

  const state = RESOURCE_STATES.includes(entry.state) ? entry.state : "UNKNOWN";

  // An UNKNOWN state cannot carry a confident opportunity or scarcity reading.
  // This is what keeps YELLOW and UNKNOWN from acquiring a precedence.
  if (state === "UNKNOWN") return null;

  const sourceTrust = SOURCE_TRUST[entry.source] ?? "UNKNOWN";
  const declared = CONFIDENCE_VALUES.includes(entry.remaining_confidence) ? entry.remaining_confidence : null;
  // A declared confidence may lower the source's trust but never raise it.
  const confidence =
    declared === null || confidenceRank(declared) > confidenceRank(sourceTrust) ? sourceTrust : declared;

  const evaluatedAt = toMillis(now);
  const checkedAt = toMillis(entry.checked_at);
  const ttlStale = !Number.isFinite(checkedAt) || !Number.isFinite(evaluatedAt) || evaluatedAt - checkedAt > SNAPSHOT_FRESH_MS;

  // freshness = time freshness AND window-generation validity. A reset-expired
  // or event-invalidated entry is stale however recent its checked_at is.
  const needsRefresh = refreshRequired(entry, now);

  if (ttlStale || needsRefresh) {
    return { state, confidence, stale: true, refresh_required: ttlStale || needsRefresh, reset_expired: resetExpired(entry, now), usable: false };
  }
  if (confidenceRank(confidence) < confidenceRank("MEDIUM")) {
    return { state, confidence, stale: false, refresh_required: false, reset_expired: false, usable: false };
  }

  return { state, confidence, stale: false, refresh_required: false, reset_expired: false, usable: true };
}

const UNKNOWN_BASE = Object.freeze({ state: "UNKNOWN", confidence: "UNKNOWN", stale: false });

/**
 * Resolves the BURST half of an entry: the utilization signal.
 *
 * The returned view carries labels only - never a ratio, a reset timestamp or
 * any other raw quota value - so it can be written into routing evidence
 * without putting account data into an artifact.
 */
export function resolveStrandedCapacity(entry, options = {}) {
  const { now = Date.now() } = options;
  const readable = readableEntry(entry, now);

  if (readable === null) {
    return { ...UNKNOWN_BASE, reset_proximity: "UNKNOWN", stranded_capacity_risk: "UNKNOWN" };
  }

  const base = {
    state: readable.state,
    confidence: readable.confidence,
    stale: readable.stale,
    reset_proximity: "UNKNOWN",
    stranded_capacity_risk: "UNKNOWN",
  };
  if (!readable.usable) return base;

  // A provider is as stranded as its most stranded burst window: a five-hour
  // window about to refill strands capacity even when another one is quiet.
  let best = { proximity: "UNKNOWN", risk: "UNKNOWN" };

  for (const window of resourceWindows(entry)) {
    if (window.role !== "BURST") continue;

    const proximity = resetProximity(window.reset_at, now);
    const risk = strandedCapacityRisk(window.remaining_ratio, proximity);

    if (
      riskRank(risk) > riskRank(best.risk) ||
      (riskRank(risk) === riskRank(best.risk) && proximityRank(proximity) > proximityRank(best.proximity))
    ) {
      best = { proximity, risk };
    }
  }

  return { ...base, reset_proximity: best.proximity, stranded_capacity_risk: best.risk };
}

/**
 * Resolves the BUDGET half of an entry: the scarcity signal.
 *
 * With several long-horizon caps the most restrictive one wins, because any of
 * them can be the cap that actually runs out first. A weekly allowance that is
 * fine says nothing about a monthly one that is nearly spent.
 */
export function resolveConservationPressure(entry, options = {}) {
  const { now = Date.now() } = options;
  const readable = readableEntry(entry, now);

  if (readable === null) {
    return {
      ...UNKNOWN_BASE,
      budget_reset_proximity: "UNKNOWN",
      conservation_pressure: "UNKNOWN",
      budget_expiry_opportunity: "UNKNOWN",
    };
  }

  const base = {
    state: readable.state,
    confidence: readable.confidence,
    stale: readable.stale,
    budget_reset_proximity: "UNKNOWN",
    conservation_pressure: "UNKNOWN",
    budget_expiry_opportunity: "UNKNOWN",
  };
  if (!readable.usable) return base;

  // conservation takes the most restrictive BUDGET window (any cap can be the
  // one that runs out first); expiry takes the best one (any near-reset cap
  // with room left is capacity about to be wasted).
  let tightest = { proximity: "UNKNOWN", pressure: "UNKNOWN" };
  let bestExpiry = "UNKNOWN";

  for (const window of resourceWindows(entry)) {
    if (window.role !== "BUDGET") continue;

    const proximity = resetProximity(window.reset_at, now);
    const pressure = conservationPressure(window.remaining_ratio, proximity);
    if (conservationRank(pressure) > conservationRank(tightest.pressure)) {
      tightest = { proximity, pressure };
    }

    const expiry = budgetExpiryOpportunity(window.remaining_ratio, proximity);
    if (riskRank(expiry) > riskRank(bestExpiry)) bestExpiry = expiry;
  }

  return {
    ...base,
    budget_reset_proximity: tightest.proximity,
    conservation_pressure: tightest.pressure,
    budget_expiry_opportunity: bestExpiry,
  };
}

/**
 * Resolves the BURST defensive half of an entry: `burst_depletion_pressure`.
 *
 * The scarcity mirror of `resolveStrandedCapacity` - it takes the MOST
 * pressured short window, because any nearly-empty burst window that will not
 * refill soon is a reason to send new work elsewhere. Labels only, no ratios,
 * so it can go straight into routing evidence. UNKNOWN is neutral.
 */
export function resolveBurstDepletion(entry, options = {}) {
  const { now = Date.now() } = options;
  const readable = readableEntry(entry, now);

  if (readable === null) {
    return { ...UNKNOWN_BASE, burst_reset_proximity: "UNKNOWN", burst_depletion_pressure: "UNKNOWN" };
  }

  const base = {
    state: readable.state,
    confidence: readable.confidence,
    stale: readable.stale,
    burst_reset_proximity: "UNKNOWN",
    burst_depletion_pressure: "UNKNOWN",
  };
  if (!readable.usable) return base;

  let worst = { proximity: "UNKNOWN", pressure: "UNKNOWN" };
  for (const window of resourceWindows(entry)) {
    if (window.role !== "BURST") continue;

    const proximity = burstResetProximity(window.reset_at, now);
    const pressure = burstDepletionPressure(window.remaining_ratio, proximity);
    if (burstDepletionRank(pressure) > burstDepletionRank(worst.pressure)) {
      worst = { proximity, pressure };
    }
  }

  return { ...base, burst_reset_proximity: worst.proximity, burst_depletion_pressure: worst.pressure };
}

/* ------------------------------------------------------------------------ *
 * Weekly Balance
 *
 * The PRIMARY long-horizon subscription-balancing signal: consume a weekly
 * (BUDGET) allowance evenly over the cycle by comparing how much is LEFT with
 * how much TIME is left before it resets.
 *
 *   time_remaining_ratio = clamp((reset_at - now) / (window_minutes * 60000), 0, 1)
 *   budget_surplus       = remaining_ratio - time_remaining_ratio
 *
 *   surplus > 0  -> consuming slower than time passes -> unused-capacity opportunity
 *   surplus < 0  -> consuming faster than time passes -> conservation pressure
 *
 * `window_minutes` is used ONLY as the nominal balancing horizon. This does NOT
 * infer `generation_start = reset_at - window`, does NOT assert weekly cycles
 * are fixed periods, and creates NO generation metadata - PACE still owns
 * generation continuity. A single trustworthy current snapshot is enough.
 *
 * RESOURCE_AWARE_ROUTING.md's "Weekly Balance" section owns the semantics;
 * thresholds live in `WEEKLY_BALANCE` and are operator-overridable via
 * `options.weeklyBalanceConfig`. Not self-tuned.
 * ------------------------------------------------------------------------ */

// worst -> best; UNKNOWN is deliberately absent (it ranks as NORMAL for
// comparison and never carries a numeric surplus, so it neither promotes nor
// is promoted over).
const WEEKLY_BALANCE_STATES = [
  "CRITICAL_RESERVE",
  "RESERVE",
  "STRONG_CONSERVE",
  "CONSERVE",
  "NORMAL",
  "PREFER",
  "BOOST",
];

export const WEEKLY_BALANCE = Object.freeze({
  boost_surplus: 0.2,
  prefer_surplus: 0.05,
  conserve_surplus: -0.05,
  strong_conserve_surplus: -0.2,
  reserve_remaining: 0.15,
  critical_reserve_remaining: 0.05,
  hysteresis: 0.1,
  expiry_prefer_hours: 24,
  expiry_prefer_surplus: 0.1,
  expiry_boost_hours: 12,
  expiry_boost_remaining: 0.2,
});

const INERT_WEEKLY_BALANCE = Object.freeze({
  state: "UNKNOWN",
  reason: null,
  reset_proximity: "UNKNOWN",
  actual_remaining_ratio: null,
  time_remaining_ratio: null,
  budget_surplus: null,
});

function weeklyBalanceRank(state) {
  const i = WEEKLY_BALANCE_STATES.indexOf(state);
  return i === -1 ? WEEKLY_BALANCE_STATES.indexOf("NORMAL") : i;
}

function clamp(value, lo, hi) {
  return Math.max(lo, Math.min(hi, value));
}

function weeklySurplusBand(surplus, config) {
  if (surplus >= config.boost_surplus) return "BOOST";
  if (surplus >= config.prefer_surplus) return "PREFER";
  if (surplus > config.conserve_surplus) return "NORMAL";
  if (surplus > config.strong_conserve_surplus) return "CONSERVE";
  return "STRONG_CONSERVE";
}

// Absolute remaining quota still matters: never aggressively consume a provider
// just because reset is close if what is left is already critically low.
function weeklyReserveFloor(remaining, config) {
  if (typeof remaining !== "number" || !Number.isFinite(remaining)) return null;
  if (remaining < config.critical_reserve_remaining) return "CRITICAL_RESERVE";
  if (remaining < config.reserve_remaining) return "RESERVE";
  return null;
}

/**
 * Resolves the Weekly Balance of a resource entry from its BUDGET window(s).
 * With several BUDGET caps the most conservative (lowest surplus) wins, and the
 * reserve floor reads the lowest remaining_ratio - any one cap can be the one
 * that runs out first. Returns labels plus the derived ratios; only the `state`
 * label is written into routing evidence (numbers stay out of artifacts, as
 * elsewhere in this module). Missing / untrustworthy evidence -> UNKNOWN
 * (neutral), never estimated.
 */
export function resolveWeeklyBalance(entry, options = {}) {
  const { now = Date.now(), weeklyBalanceConfig = WEEKLY_BALANCE } = options;
  const config = isPlainObject(weeklyBalanceConfig) ? { ...WEEKLY_BALANCE, ...weeklyBalanceConfig } : WEEKLY_BALANCE;

  const readable = readableEntry(entry, now);
  if (readable === null || !readable.usable) return { ...INERT_WEEKLY_BALANCE };

  const nowMs = toMillis(now);
  if (!Number.isFinite(nowMs)) return { ...INERT_WEEKLY_BALANCE };

  let worst = null; // { surplus, timeRatio, remaining, resetMs }
  let minRemaining = null;

  for (const window of resourceWindows(entry)) {
    if (window.role !== "BUDGET") continue;
    const remaining = window.remaining_ratio;
    if (typeof remaining !== "number" || !Number.isFinite(remaining) || remaining < 0 || remaining > 1) continue;
    minRemaining = minRemaining === null ? remaining : Math.min(minRemaining, remaining);

    const resetMs = toMillis(window.reset_at);
    const wm = window.window_minutes;
    if (!Number.isFinite(resetMs) || typeof wm !== "number" || !Number.isFinite(wm) || wm <= 0) continue;

    const timeRatio = clamp((resetMs - nowMs) / (wm * 60 * 1000), 0, 1);
    const surplus = remaining - timeRatio;
    if (worst === null || surplus < worst.surplus) worst = { surplus, timeRatio, remaining, resetMs };
  }

  // No BUDGET window carried the full evidence (remaining_ratio + reset_at +
  // window_minutes). Weekly Balance needs all three, so it is UNKNOWN and
  // neutral - the existing conservation_pressure behaviour is untouched.
  // `minRemaining` (lowest ratio across every BUDGET window) still feeds the
  // reserve floor and the expiry-boost gate on the full path below.
  if (worst === null) return { ...INERT_WEEKLY_BALANCE };

  let state = weeklySurplusBand(worst.surplus, config);
  let reason = "SURPLUS";

  // Expiry corrections: near reset, unused quota is worth spending.
  const hoursToReset = (worst.resetMs - nowMs) / 3_600_000;
  if (
    hoursToReset <= config.expiry_prefer_hours &&
    worst.surplus >= config.expiry_prefer_surplus &&
    weeklyBalanceRank(state) < weeklyBalanceRank("PREFER")
  ) {
    state = "PREFER";
    reason = "EXPIRY_PREFER";
  }
  if (
    hoursToReset <= config.expiry_boost_hours &&
    minRemaining >= config.expiry_boost_remaining &&
    weeklyBalanceRank(state) < weeklyBalanceRank("BOOST")
  ) {
    state = "BOOST";
    reason = "EXPIRY_BOOST";
  }

  // Reserve floor overrides the positive/boost side.
  const floor = weeklyReserveFloor(minRemaining, config);
  if (floor !== null && weeklyBalanceRank(floor) < weeklyBalanceRank(state)) {
    state = floor;
    reason = "RESERVE_FLOOR";
  }

  return {
    state,
    reason,
    reset_proximity: resetProximity(worst.resetMs, nowMs),
    actual_remaining_ratio: worst.remaining,
    time_remaining_ratio: worst.timeRatio,
    budget_surplus: worst.surplus,
  };
}

const INERT_PACE = Object.freeze({ pace_pressure: "UNKNOWN", pace_confidence: "UNKNOWN", pace_reason: null });

/**
 * Resolves long-horizon PACE / trajectory pressure from a SERIES of quota
 * observations, never from a single snapshot.
 *
 * `input` is either a bare resource entry (the live single-snapshot path -
 * always UNKNOWN) or `{ observations: [{ checked_at, remaining_ratio, reset_at,
 * reset_at_source?, remaining_confidence?, generation_id? }, ...] }`.
 *
 * It answers one question: at the observed burn rate, would this pool exhaust
 * its long-horizon capacity materially before its reset? It does NOT assume a
 * fixed seven-day window and never derives `window_start = reset_at - 7d`.
 * Any sign of a quota-generation change (upward jump in remaining, reset_at
 * discontinuity, crossed reset boundary, confidence drop, too few / too
 * sparse observations) collapses the result to UNKNOWN, which is
 * routing-neutral. RESOURCE_AWARE_ROUTING.md's "Long-horizon pace /
 * trajectory" section owns the evidence contract; thresholds live in
 * `PACE_EVIDENCE` and are overridable via `options.paceConfig`.
 */
export function resolvePace(input, options = {}) {
  const { now = Date.now(), paceConfig = PACE_EVIDENCE } = options;
  const config = isPlainObject(paceConfig) ? { ...PACE_EVIDENCE, ...paceConfig } : PACE_EVIDENCE;
  const nowMs = toMillis(now);
  if (!Number.isFinite(nowMs)) return { ...INERT_PACE };

  const rawObs = isPlainObject(input) && Array.isArray(input.observations) ? input.observations : null;
  if (rawObs === null) return { ...INERT_PACE };

  const points = rawObs
    .filter(
      (o) =>
        isPlainObject(o) &&
        typeof o.remaining_ratio === "number" &&
        Number.isFinite(o.remaining_ratio) &&
        o.remaining_ratio >= 0 &&
        o.remaining_ratio <= 1 &&
        Number.isFinite(toMillis(o.checked_at)),
    )
    .map((o) => ({
      t: toMillis(o.checked_at),
      remaining: o.remaining_ratio,
      resetAt: toMillis(o.reset_at),
      resetSource: isNonEmptyString(o.reset_at_source) ? o.reset_at_source : null,
      confidence: CONFIDENCE_VALUES.includes(o.remaining_confidence) ? o.remaining_confidence : null,
      hasGenerationId: isNonEmptyString(o.generation_id),
    }))
    .sort((a, b) => a.t - b.t);

  if (points.length < config.min_observations) return { ...INERT_PACE };

  // Any reading below MEDIUM confidence taints the series.
  if (points.some((p) => p.confidence !== null && confidenceRank(p.confidence) < confidenceRank("MEDIUM"))) {
    return { ...INERT_PACE };
  }

  // Generation continuity across every adjacent pair.
  for (let k = 1; k < points.length; k += 1) {
    const prev = points[k - 1];
    const cur = points[k];

    // Remaining rising materially -> a new generation, not negative burn.
    if (cur.remaining - prev.remaining > config.upward_jump_ratio) return { ...INERT_PACE };

    // A window whose reset has already passed describes the previous generation.
    if (Number.isFinite(cur.resetAt) && cur.resetAt <= cur.t) return { ...INERT_PACE };

    if (Number.isFinite(prev.resetAt) && Number.isFinite(cur.resetAt)) {
      const relative =
        prev.resetSource === "RELATIVE_PROVIDER_DURATION" || cur.resetSource === "RELATIVE_PROVIDER_DURATION";
      if (relative) {
        // A relative countdown drifts each probe; the IMPLIED remaining
        // duration should shrink roughly in step with elapsed time.
        const impliedPrev = prev.resetAt - prev.t;
        const impliedCur = cur.resetAt - cur.t;
        if (Math.abs(impliedCur - impliedPrev) > config.reset_at_tolerance_ms) return { ...INERT_PACE };
      } else if (Math.abs(cur.resetAt - prev.resetAt) > config.reset_at_tolerance_ms) {
        return { ...INERT_PACE };
      }
    }
  }

  const first = points[0];
  const last = points[points.length - 1];

  const spanMs = last.t - first.t;
  if (spanMs < config.min_total_span_ms) return { ...INERT_PACE };

  const consumed = first.remaining - last.remaining;
  if (consumed <= 0) return { ...INERT_PACE }; // flat or refilled: nothing to project

  const resetAt = Number.isFinite(last.resetAt) ? last.resetAt : Number.NaN;
  if (!Number.isFinite(resetAt) || resetAt <= nowMs) return { ...INERT_PACE };

  const velocity = consumed / spanMs; // ratio consumed per ms
  const projectedRunwayMs = last.remaining / velocity; // ms to zero at this rate
  const timeToReset = resetAt - nowMs;
  const ratio = projectedRunwayMs / timeToReset; // < 1 => exhausts before reset

  let pressure;
  if (ratio >= 1.0) pressure = "NONE";
  else if (ratio >= 0.75) pressure = "LOW";
  else if (ratio >= 0.5) pressure = "ELEVATED";
  else if (ratio >= 0.33) pressure = "HIGH";
  else pressure = "CRITICAL";

  // MEDIUM from consistent observations; HIGH only with explicit provider
  // generation metadata on every reading (not reachable from any current CLI).
  const confidence = points.every((p) => p.hasGenerationId) ? "HIGH" : "MEDIUM";
  const reason = pressure === "HIGH" || pressure === "CRITICAL" ? "WEEKLY_OVERBURN" : null;

  return { pace_pressure: pressure, pace_confidence: confidence, pace_reason: reason };
}

// A candidate carrying a `pace_observations` series gets a real trajectory
// reading; a bare entry (the live path) is always UNKNOWN.
function resolvePaceForEntry(entry, now) {
  const input = isPlainObject(entry) && Array.isArray(entry.pace_observations)
    ? { observations: entry.pace_observations }
    : entry;
  return resolvePace(input, { now });
}

// PACE only participates when it is actually known AND acutely pressured.
// ELEVATED / LOW / NONE / UNKNOWN are all routing-neutral.
function paceIsDemoting(pace) {
  return (
    isPlainObject(pace) &&
    pace.pace_confidence !== "UNKNOWN" &&
    (pace.pace_pressure === "HIGH" || pace.pace_pressure === "CRITICAL")
  );
}

// The composed defensive rank. BUDGET absolute scarcity always outranks softer
// pressure; BURST depletion, confident acute PACE and an acute Weekly Balance
// deficit (STRONG_CONSERVE or a reserve floor) share the middle rank. Weekly
// Balance is the primary long-horizon signal but it never reaches
// BUDGET_SCARCE - absolute scarcity stays conservation-owned.
function resourcePressureClass({ conservation, burstDepletion, pace, weeklyBalance }) {
  if (CONSERVE_PRESSURES.has(conservation?.conservation_pressure)) return "BUDGET_SCARCE";
  const weeklySoft =
    weeklyBalance?.state === "STRONG_CONSERVE" ||
    weeklyBalance?.state === "RESERVE" ||
    weeklyBalance?.state === "CRITICAL_RESERVE";
  const soft = burstDepletion?.burst_depletion_pressure === "HIGH" || paceIsDemoting(pace) || weeklySoft;
  return soft ? "SOFT_PRESSURED" : "CLEAR";
}

const resourcePressureRankIndex = (cls) => {
  const i = RESOURCE_PRESSURE_RANKS.indexOf(cls);
  return i === -1 ? 0 : i;
};

// Router capacity reserve bands, most severe first. Unlike conservation
// pressure, these read remaining_ratio alone - proximity does not modulate
// them: control-plane capacity is protected by how much of it is left, not by
// how soon the window happens to refill. Router reserve is deliberately a
// separate signal from conservation_pressure even though both read BUDGET
// windows: conservation reorders candidates that already qualify, while
// reserve excludes a candidate from qualifying at all, and only for the one
// resource pool that hosts the active Router.
const ROUTER_RESERVE_BANDS = ["ROUTER_EMERGENCY_RESERVE", "ROUTER_CRITICAL_RESERVE", "ROUTER_RESERVE", "NORMAL", "UNKNOWN"];
const routerReserveRank = (value) => rankIn(ROUTER_RESERVE_BANDS, value) - 1;

const ROUTER_RESERVE_THRESHOLD = 0.15;
const ROUTER_CRITICAL_RESERVE_THRESHOLD = 0.10;
const ROUTER_EMERGENCY_RESERVE_THRESHOLD = 0.05;

function routerReserveBandFor(remainingRatio) {
  if (typeof remainingRatio !== "number" || !Number.isFinite(remainingRatio) || remainingRatio < 0 || remainingRatio > 1) {
    return "UNKNOWN";
  }
  if (remainingRatio <= ROUTER_EMERGENCY_RESERVE_THRESHOLD) return "ROUTER_EMERGENCY_RESERVE";
  if (remainingRatio <= ROUTER_CRITICAL_RESERVE_THRESHOLD) return "ROUTER_CRITICAL_RESERVE";
  if (remainingRatio <= ROUTER_RESERVE_THRESHOLD) return "ROUTER_RESERVE";
  return "NORMAL";
}

/**
 * Resolves the router-capacity-reserve band for one resource pool: how much
 * of its long-horizon BUDGET remains, read on its own flat thresholds rather
 * than crossed with reset proximity. A short BURST window never contributes -
 * a five-hour window nearly exhausted says nothing about whether the Router's
 * weekly capacity is at risk.
 *
 * Multiple BUDGET windows take the most restrictive band, for the same reason
 * conservation_pressure does: any one of them can be the cap that actually
 * runs out first. UNKNOWN (no usable BUDGET reading) is neither NORMAL nor a
 * reserve band - it triggers nothing, exactly like every other UNKNOWN signal
 * in this file.
 */
export function resolveRouterReserve(entry, options = {}) {
  const { now = Date.now() } = options;
  const readable = readableEntry(entry, now);

  if (readable === null) return { ...UNKNOWN_BASE, router_reserve_band: "UNKNOWN" };

  const base = { state: readable.state, confidence: readable.confidence, stale: readable.stale, router_reserve_band: "UNKNOWN" };
  if (!readable.usable) return base;

  let tightest = "UNKNOWN";
  for (const window of resourceWindows(entry)) {
    if (window.role !== "BUDGET") continue;
    const band = routerReserveBandFor(window.remaining_ratio);
    if (routerReserveRank(band) > routerReserveRank(tightest)) tightest = band;
  }

  return { ...base, router_reserve_band: tightest };
}

// A provider argues for conservation only once its long-horizon budget is
// genuinely tight. Everything softer is neutral, so a merely-measured provider
// is never worse off than an unmeasured one.
const CONSERVE_PRESSURES = new Set(["HIGH", "CRITICAL"]);

// Burst opportunity is spendable only against a budget somebody has read and
// found healthy. UNKNOWN is deliberately not in this set: not checking must
// not buy a promotion, just as it must not buy a penalty.
const SUSTAINABLE_PRESSURES = new Set(["NONE", "LOW"]);

/**
 * Selects one candidate from a slot's ordered candidates.
 *
 * The resource overlay only reorders candidates that already meet the slot's
 * `minimum_tier`; it can never move work down to a weaker candidate. YELLOW and
 * UNKNOWN are treated neutrally so a missing reading is neither punished nor
 * rewarded, and registry order breaks the tie.
 *
 * Below all of that sit two resource signals, in this order: long-horizon
 * conservation, then short-horizon opportunity. Scarcity first, utilization
 * second - a burst window about to refill must never talk a provider into
 * spending a budget that is nearly gone.
 *
 * Both reorder only inside the group that shares the resource state of the
 * candidate registry order would already have chosen, so neither can move work
 * across the GREEN / YELLOW / UNKNOWN / RED bands, and neither can put a
 * YELLOW ahead of an UNKNOWN or the reverse.
 */
export function selectCandidate(slot, resourceStates, tierOrder, options = {}) {
  const {
    allowExperimental = false,
    taskRisk = "unknown",
    excludeProvider = null,
    excludeModelFamily = null,
    allowRed = false,
    preferStrandedCapacity = true,
    now = Date.now(),
    requiredStage = isNonEmptyString(slot?.stage) ? slot.stage : null,
    rolePreference = [],
    pinnedCandidate = null,
    activeRouterResourceKey = null,
    isRouterSlot = false,
    weeklyBalanceConfig = WEEKLY_BALANCE,
    // Exact model capability, keyed "provider/model" -> MODEL_UNKNOWN |
    // MODEL_UNAVAILABLE (scripts/lib/model-dispatch.mjs). Excludes only that
    // one model; the provider's resource entry is never touched, so another
    // model on the same provider stays eligible.
    modelCapability = null,
    // Provider auth state, keyed provider -> AUTH_* (model-dispatch.mjs).
    // Anything but AUTH_OK / AUTH_UNKNOWN excludes that provider's candidates
    // for this selection only; resource state is untouched.
    providerAuth = null,
  } = options;

  const wbConfig = isPlainObject(weeklyBalanceConfig)
    ? { ...WEEKLY_BALANCE, ...weeklyBalanceConfig }
    : WEEKLY_BALANCE;

  // Shared with the pinned-candidate short-circuit below: a human's explicit
  // model pin is the one thing that may still use the Router's own reserved
  // pool, because granting the override is a human decision the strategic
  // contract already recorded, not something the operational router grants
  // itself by relaxing a resource filter.
  const pinnedMatches = (providerOrLabelProvider, model) =>
    isPlainObject(pinnedCandidate) &&
    isNonEmptyString(pinnedCandidate.model) &&
    model === pinnedCandidate.model &&
    (pinnedCandidate.provider === undefined || pinnedCandidate.provider === null ||
      providerOrLabelProvider === pinnedCandidate.provider);

  // Stage gate: a candidate must meet the required stage, and a flagship
  // (STAGE_3) candidate is admitted only when the required stage IS STAGE_3.
  // Only enforced when a required stage is known and the candidate declares
  // one, so legacy minimum_tier-only slots keep working unchanged.
  const requiredStageIdx = requiredStage === null ? -1 : stageIndex(requiredStage);
  const stageGate = (candidate) => {
    if (requiredStageIdx === -1 || !isNonEmptyString(candidate?.stage)) return null;
    const candIdx = stageIndex(candidate.stage);
    if (candIdx === -1 || candIdx < requiredStageIdx) {
      return `capability stage ${candidate.stage} is below the required stage ${requiredStage}`;
    }
    const flagshipIdx = stageIndex("STAGE_3_FLAGSHIP");
    if (candIdx === flagshipIdx && requiredStageIdx !== flagshipIdx) {
      return `flagship (STAGE_3) candidate is not admitted for ${requiredStage} work`;
    }
    return null;
  };

  if (!isPlainObject(slot) || !Array.isArray(slot.candidates) || slot.candidates.length === 0) {
    return { status: "BLOCKED", code: "CONFIG_INVALID", reason: "slot has no ordered candidates" };
  }

  if (!Array.isArray(tierOrder) || tierOrder.length === 0) {
    return { status: "BLOCKED", code: "CONFIG_INVALID", reason: "capability_tier_order is missing or empty" };
  }

  const minimumIndex = tierIndex(tierOrder, slot.minimum_tier);
  if (minimumIndex === -1) {
    return {
      status: "BLOCKED",
      code: "CONFIG_INVALID",
      reason: `slot minimum_tier ${JSON.stringify(slot.minimum_tier)} is not in capability_tier_order`,
    };
  }

  const rejected = [];
  const qualified = [];

  for (const candidate of slot.candidates) {
    const label = `${candidate?.provider ?? "unknown"}/${candidate?.model ?? "unknown"}`;
    const entry = resolveResourceEntry(resourceStates, candidate?.resource_state_key);

    // Every condition is evaluated, not short-circuited, so a candidate whose
    // ONLY problem is availability can be told apart from one that policy
    // would reject anyway. That distinction decides the blocked reason code.
    const failures = [];

    // The trust invariant is enforced here, on the live routing path, not only
    // when validating the example snapshot. An untrusted entry never confers a
    // confident state, so an untrusted GREEN cannot win.
    const untrusted = resourceEntryTrust(entry);
    if (untrusted !== null) {
      failures.push({ kind: "config", why: `${label}: ${untrusted}` });
    }

    // A reset-expired or event-invalidated entry needs a refresh before it can
    // drive selection. Until then its state band is UNKNOWN (neutral), not the
    // pre-reset value - crossing reset_at invalidates the reading even when
    // checked_at is recent. availability (below) is a runtime fact and is not
    // downgraded by this.
    const staleAcrossReset = refreshRequired(entry, now);
    const resourceState =
      untrusted === null && RESOURCE_STATES.includes(entry?.state) && !staleAcrossReset ? entry.state : "UNKNOWN";

    if (entry?.available === false) {
      failures.push({ kind: "unavailable", why: `${label}: provider or pool is unavailable` });
    }

    const modelState = isPlainObject(modelCapability) ? modelCapability[label] : undefined;
    if (modelState === "MODEL_UNKNOWN" || modelState === "MODEL_UNAVAILABLE") {
      failures.push({ kind: "model", why: `${label}: ${modelState} (model-level; provider unaffected)` });
    }

    const authState = isPlainObject(providerAuth) ? providerAuth[candidate?.provider] : undefined;
    if (isNonEmptyString(authState) && authState !== "AUTH_OK" && authState !== "AUTH_UNKNOWN") {
      failures.push({ kind: "auth", why: `${label}: ${authState} (human login action required; quota unaffected)` });
    }

    // Registry membership + `enabled` are human-authoritative. `enabled: false`
    // is the operator saying "do not route here" and is the only config gate.
    // A missing `enabled` field means enabled (backward compatible). `status`
    // (stable / experimental) and `evidence_status` are informational and
    // MUST NOT gate execution eligibility; `allowExperimental` is accepted for
    // backward compatibility and has no effect on an enabled candidate.
    if (candidate?.enabled === false) {
      failures.push({
        kind: "policy",
        why: `${label}: disabled in the registry (enabled: false)`,
      });
    }
    void allowExperimental;

    const stageFailure = stageGate(candidate);
    if (stageFailure !== null) {
      failures.push({ kind: "policy", why: `${label}: ${stageFailure}` });
    }

    const candidateIndex = tierIndex(tierOrder, candidate?.capability_tier);
    if (candidateIndex === -1 || candidateIndex < minimumIndex) {
      failures.push({ kind: "policy", why: `${label}: capability tier is below minimum tier ${slot.minimum_tier}` });
    }

    if (excludeProvider !== null && candidate?.provider === excludeProvider) {
      failures.push({ kind: "policy", why: `${label}: shares the implementer provider` });
    }

    if (excludeModelFamily !== null && candidate?.model_family === excludeModelFamily) {
      failures.push({ kind: "policy", why: `${label}: shares the implementer model family` });
    }

    // Router capacity reserve. The Router is control-plane capacity: it must
    // stay able to route, validate, recover and hand off work. Once the pool
    // hosting the active Router drops to or below the reserve threshold,
    // autonomous (non-pinned) dispatches to OTHER slots on that same pool are
    // excluded here - never the Router slot itself, and never a candidate the
    // human explicitly pinned for this task. This never touches
    // MODEL_REGISTRY membership or capability stage; it is a resource-routing
    // exclusion, same layer as availability, evaluated alongside the other
    // hard filters above. Semantics and thresholds are owned by
    // RESOURCE_AWARE_ROUTING.md's Router capacity reserve section.
    const routerReserve =
      !isRouterSlot &&
      isNonEmptyString(activeRouterResourceKey) &&
      candidate?.resource_state_key === activeRouterResourceKey &&
      !pinnedMatches(candidate?.provider, candidate?.model)
        ? resolveRouterReserve(entry, { now }).router_reserve_band
        : "NORMAL";

    if (routerReserve !== "NORMAL" && routerReserve !== "UNKNOWN") {
      failures.push({
        kind: "policy",
        why: `${label}: router capacity reserve (${routerReserve}) protects the pool hosting the active Router`,
      });
    }

    if (failures.length === 0) {
      // BURST depletion and PACE are NEW_WORK defensive signals: they must not
      // demote candidates for the ROUTER control-plane slot, which the Router
      // capacity reserve already protects. For that slot they are held inert.
      qualified.push({
        candidate,
        label,
        resourceState,
        stranded: resolveStrandedCapacity(entry, { now }),
        conservation: resolveConservationPressure(entry, { now }),
        burstDepletion: isRouterSlot
          ? { ...UNKNOWN_BASE, burst_reset_proximity: "UNKNOWN", burst_depletion_pressure: "UNKNOWN" }
          : resolveBurstDepletion(entry, { now }),
        pace: isRouterSlot ? { ...INERT_PACE } : resolvePaceForEntry(entry, now),
        // Weekly Balance is a NEW_WORK balancing signal: like BURST/PACE it is
        // held inert for the ROUTER slot, whose pool is protected by Router
        // capacity reserve, not by this signal.
        weeklyBalance: isRouterSlot
          ? { ...INERT_WEEKLY_BALANCE }
          : resolveWeeklyBalance(entry, { now, weeklyBalanceConfig: wbConfig }),
      });
      continue;
    }

    rejected.push({
      label,
      failures,
      // True when waiting for the provider to come back would be enough.
      onlyUnavailable: failures.every(({ kind }) => kind === "unavailable"),
    });
  }

  // Explicit human model selection is the highest routing priority. If the
  // human named a provider/model in the current instruction, the router uses
  // it - never swapped out for quota, benchmark, evidence_status or AI
  // preference. It still has to clear hard execution eligibility (enabled,
  // stage, tier, disjointness, availability, source trust); if it does not,
  // the block is honest and names that candidate's own reason.
  if (isPlainObject(pinnedCandidate) && isNonEmptyString(pinnedCandidate.model)) {
    if (!slot.candidates.some((c) => pinnedMatches(c?.provider, c?.model))) {
      return {
        status: "BLOCKED",
        code: "CONFIG_INVALID",
        reason: `pinned model ${pinnedCandidate.provider ?? "?"}/${pinnedCandidate.model} is not a candidate for this slot`,
      };
    }

    const hit = qualified.find(({ candidate }) => pinnedMatches(candidate?.provider, candidate?.model));
    if (hit !== undefined) {
      const hitEntry = resolveResourceEntry(resourceStates, hit.candidate?.resource_state_key);
      const hitReserveBand = resolveRouterReserve(hitEntry, { now }).router_reserve_band;
      // Recorded per PART, alongside model_selection_source=HUMAN_EXPLICIT_OVERRIDE
      // at the contract layer: true only when this pin actually spent reserved
      // Router capacity, never merely because a pin exists.
      const reserveOverride =
        !isRouterSlot &&
        isNonEmptyString(activeRouterResourceKey) &&
        hit.candidate?.resource_state_key === activeRouterResourceKey &&
        hitReserveBand !== "NORMAL" && hitReserveBand !== "UNKNOWN";
      return {
        status: "SELECTED",
        candidate: hit.candidate,
        resource_state: hit.resourceState,
        reset_proximity: hit.stranded.reset_proximity,
        stranded_capacity_risk: hit.stranded.stranded_capacity_risk,
        budget_reset_proximity: hit.conservation.budget_reset_proximity,
        conservation_pressure: hit.conservation.conservation_pressure,
        budget_expiry_opportunity: hit.conservation.budget_expiry_opportunity,
        // A human pin does not reorder, so no defensive signal demotes it - but
        // the labels are still reported for audit.
        burst_depletion_pressure: hit.burstDepletion.burst_depletion_pressure,
        burst_reset_proximity: hit.burstDepletion.burst_reset_proximity,
        pace_pressure: hit.pace.pace_pressure,
        pace_confidence: hit.pace.pace_confidence,
        pace_reason: hit.pace.pace_reason,
        weekly_balance: { ...hit.weeklyBalance },
        resource_pressure_rank: resourcePressureClass(hit),
        conservation_demotion: null,
        expiry_promotion: null,
        stranded_promotion: null,
        burst_depletion_demotion: null,
        pace_demotion: null,
        weekly_balance_promotion: null,
        weekly_balance_demotion: null,
        pinned: true,
        router_reserve_band: hitReserveBand,
        router_reserve_override: reserveOverride,
      };
    }

    const rej = rejected.find(({ label }) => {
      const [prov, ...rest] = label.split("/");
      return pinnedMatches(prov, rest.join("/"));
    });
    const code =
      rej === undefined
        ? "CONFIG_INVALID"
        : rej.failures.some(({ kind }) => kind === "config")
          ? "CONFIG_INVALID"
          : rej.onlyUnavailable
            ? "ROUTING_UNAVAILABLE"
            : rej.failures.every(({ kind }) => kind === "auth")
              ? "AUTH_REQUIRED"
              : rej.failures.every(({ kind }) => kind === "model")
                ? "MODEL_UNAVAILABLE"
                : "POLICY_BLOCKED";
    return {
      status: "BLOCKED",
      code,
      reason: `pinned model ${pinnedCandidate.model} is not eligible: ${
        (rej?.failures ?? []).map(({ why }) => why).join("; ") || "no qualifying entry"
      }`,
    };
  }

  // Registry order picks the head of the band. The resource signals then
  // reorder inside the head's own resource state, and only there.
  //
  // Defensive composition FIRST, utilization SECOND. All demotions are folded
  // into one 3-rank partition so the overlay stays one coherent pass rather
  // than an accreting stack of reorder passes:
  //
  //   rank 0 CLEAR         no BUDGET scarcity, no BURST depletion, no acute PACE
  //   rank 1 SOFT_PRESSURED BURST depletion HIGH, or confident acute PACE
  //   rank 2 BUDGET_SCARCE  conservation_pressure HIGH / CRITICAL
  //
  // BUDGET absolute scarcity always outranks softer pressure. Then the two
  // existing promotions run, each gated so it can never rescue a materially
  // pressured candidate. UNKNOWN sits in no set: not checking buys neither a
  // promotion nor a penalty.
  const pickFromBand = (band) => {
    const head = band[0];
    if (head === undefined) return undefined;
    if (!preferStrandedCapacity) return { pick: head, head };

    const sameState = band.filter(({ resourceState }) => resourceState === head.resourceState);

    // Model-role preference is the LAST tie-break: it reorders inside each
    // pressure rank separately (so the ranks stay dominant), and the
    // promotions still run after it (so opportunity stays dominant over
    // preference). No preference list -> registry order.
    const byPreference = (list) => {
      if (!Array.isArray(rolePreference) || rolePreference.length === 0) return list;
      const rank = (model) => {
        const i = rolePreference.indexOf(model);
        return i === -1 ? Number.POSITIVE_INFINITY : i;
      };
      return list
        .map((entry, index) => ({ entry, index }))
        .sort((a, b) => rank(a.entry.candidate?.model) - rank(b.entry.candidate?.model) || a.index - b.index)
        .map(({ entry }) => entry);
    };

    const inRank = (cls) => byPreference(sameState.filter((e) => resourcePressureClass(e) === cls));

    // Demotion expresses a preference, never a refusal: with every candidate
    // pressured the band still routes, in registry order within the worst rank.
    const ordered = [...inRank("CLEAR"), ...inRank("SOFT_PRESSURED"), ...inRank("BUDGET_SCARCE")];

    // Weekly Balance (PRIMARY long-horizon subscription-balancing signal, runs
    // before the offensive promotions). Promote the candidate whose weekly
    // balance is MATERIALLY better than the registry-order head's - "materially"
    // gated by hysteresis so a tiny surplus gap never reorders. Both the head
    // and the challenger need a numeric surplus (comparable evidence); UNKNOWN
    // stays neutral. Guarded like the other promotions so it can never rescue a
    // candidate that is itself BUDGET-scarce, BURST-depleted, acutely paced, or
    // on its own reserve floor.
    const wbHead = ordered[0];
    const weeklyBalancePromoted =
      isPlainObject(wbHead?.weeklyBalance) && Number.isFinite(wbHead.weeklyBalance.budget_surplus)
        ? ordered.find(
            (c) =>
              c !== wbHead &&
              Number.isFinite(c.weeklyBalance?.budget_surplus) &&
              weeklyBalanceRank(c.weeklyBalance.state) > weeklyBalanceRank(wbHead.weeklyBalance.state) &&
              c.weeklyBalance.budget_surplus - wbHead.weeklyBalance.budget_surplus >= wbConfig.hysteresis &&
              !CONSERVE_PRESSURES.has(c.conservation.conservation_pressure) &&
              c.burstDepletion.burst_depletion_pressure !== "HIGH" &&
              !paceIsDemoting(c.pace) &&
              c.weeklyBalance.state !== "RESERVE" &&
              c.weeklyBalance.state !== "CRITICAL_RESERVE",
          )
        : undefined;
    if (weeklyBalancePromoted !== undefined) {
      return { pick: weeklyBalancePromoted, head, movedBy: "weekly_balance" };
    }

    // BUDGET expiry opportunity (offensive). Prefer a candidate whose own
    // long-horizon budget has room left and is about to reset - but never one
    // whose own BUDGET is under HIGH/CRITICAL scarcity, or whose own PACE is
    // confidently acute. Scarcity and sustainability are defensive and win.
    const expiryPromoted = ordered.find(
      ({ conservation, pace }) =>
        conservation.budget_expiry_opportunity === "HIGH" &&
        !CONSERVE_PRESSURES.has(conservation.conservation_pressure) &&
        !paceIsDemoting(pace),
    );

    // BURST stranded-capacity opportunity - shorter-horizon secondary
    // optimisation, applied only if expiry did not already move the pick, and
    // never for a candidate whose own BURST is depleted or PACE is acute.
    const burstPromoted = ordered.find(
      ({ stranded, conservation, burstDepletion, pace }) =>
        stranded.stranded_capacity_risk === "HIGH" &&
        SUSTAINABLE_PRESSURES.has(conservation.conservation_pressure) &&
        burstDepletion.burst_depletion_pressure !== "HIGH" &&
        !paceIsDemoting(pace),
    );

    if (expiryPromoted !== undefined) return { pick: expiryPromoted, head, movedBy: "expiry" };
    if (burstPromoted !== undefined) return { pick: burstPromoted, head, movedBy: "burst" };
    return { pick: ordered[0], head, movedBy: null };
  };

  const selection =
    pickFromBand(qualified.filter(({ resourceState }) => resourceState === "GREEN")) ??
    pickFromBand(qualified.filter(({ resourceState }) => resourceState === "YELLOW" || resourceState === "UNKNOWN")) ??
    (allowRed ? pickFromBand(qualified.filter(({ resourceState }) => resourceState === "RED")) : undefined);

  if (selection !== undefined) {
    const { pick, head, movedBy } = selection;
    // Non-null only when a resource signal actually moved the choice.
    // Recording it is what keeps these layers auditable rather than invisible.
    const moved = pick !== head;
    const headClass = resourcePressureClass(head);
    const pickClass = resourcePressureClass(pick);
    // A demotion is any move where the head sat in a worse defensive rank than
    // the pick. Each contributing signal is reported separately for audit.
    const demoted = moved && resourcePressureRankIndex(headClass) > resourcePressureRankIndex(pickClass);
    const headBudgetScarce = CONSERVE_PRESSURES.has(head.conservation.conservation_pressure);

    return {
      status: "SELECTED",
      candidate: pick.candidate,
      resource_state: pick.resourceState,
      reset_proximity: pick.stranded.reset_proximity,
      stranded_capacity_risk: pick.stranded.stranded_capacity_risk,
      budget_reset_proximity: pick.conservation.budget_reset_proximity,
      conservation_pressure: pick.conservation.conservation_pressure,
      budget_expiry_opportunity: pick.conservation.budget_expiry_opportunity,
      burst_depletion_pressure: pick.burstDepletion.burst_depletion_pressure,
      burst_reset_proximity: pick.burstDepletion.burst_reset_proximity,
      pace_pressure: pick.pace.pace_pressure,
      pace_confidence: pick.pace.pace_confidence,
      pace_reason: pick.pace.pace_reason,
      weekly_balance: { ...pick.weeklyBalance },
      resource_pressure_rank: pickClass,
      conservation_demotion:
        demoted && headBudgetScarce
          ? {
              over: head.label,
              budget_reset_proximity: head.conservation.budget_reset_proximity,
              conservation_pressure: head.conservation.conservation_pressure,
            }
          : null,
      burst_depletion_demotion:
        demoted && !headBudgetScarce && head.burstDepletion.burst_depletion_pressure === "HIGH"
          ? {
              over: head.label,
              burst_reset_proximity: head.burstDepletion.burst_reset_proximity,
              burst_depletion_pressure: head.burstDepletion.burst_depletion_pressure,
            }
          : null,
      pace_demotion:
        demoted && !headBudgetScarce && paceIsDemoting(head.pace)
          ? {
              over: head.label,
              pace_pressure: head.pace.pace_pressure,
              pace_confidence: head.pace.pace_confidence,
              pace_reason: head.pace.pace_reason,
            }
          : null,
      expiry_promotion:
        moved && !demoted && movedBy === "expiry"
          ? {
              over: head.label,
              budget_reset_proximity: pick.conservation.budget_reset_proximity,
              budget_expiry_opportunity: pick.conservation.budget_expiry_opportunity,
            }
          : null,
      stranded_promotion:
        moved && !demoted && movedBy === "burst"
          ? {
              over: head.label,
              reset_proximity: pick.stranded.reset_proximity,
              stranded_capacity_risk: pick.stranded.stranded_capacity_risk,
            }
          : null,
      // A Weekly Balance move can read as a promotion (a healthier-balance peer
      // stepped ahead of the registry head) or a demotion (the registry head is
      // itself STRONG_CONSERVE / on its reserve floor and a peer went ahead).
      weekly_balance_promotion:
        moved && !demoted && movedBy === "weekly_balance"
          ? {
              over: head.label,
              weekly_balance_state: pick.weeklyBalance.state,
              budget_surplus: pick.weeklyBalance.budget_surplus,
            }
          : null,
      weekly_balance_demotion:
        demoted &&
        !headBudgetScarce &&
        head.burstDepletion.burst_depletion_pressure !== "HIGH" &&
        !paceIsDemoting(head.pace) &&
        (head.weeklyBalance?.state === "STRONG_CONSERVE" ||
          head.weeklyBalance?.state === "RESERVE" ||
          head.weeklyBalance?.state === "CRITICAL_RESERVE")
          ? {
              over: head.label,
              weekly_balance_state: head.weeklyBalance.state,
              budget_surplus: head.weeklyBalance.budget_surplus,
            }
          : null,
    };
  }

  // Qualified candidates exist but every one of them is RED, and this task did
  // not permit RED routing. Waiting for a reset fixes this; nothing else will.
  if (qualified.length > 0) {
    return {
      status: "BLOCKED",
      code: "RESOURCE_BLOCKED",
      reason: "the only qualified candidates are RED and this task does not permit RED routing",
    };
  }

  // A malformed snapshot outranks everything else: until the input is fixed no
  // other diagnosis can be trusted.
  const hasConfigFailure = rejected.some(({ failures }) => failures.some(({ kind }) => kind === "config"));

  // If some candidate would qualify once its provider is available again, this
  // is an availability problem. Otherwise policy is what stands in the way, and
  // a human has to decide - not the router.
  const code = hasConfigFailure
    ? "CONFIG_INVALID"
    : rejected.some(({ onlyUnavailable }) => onlyUnavailable)
      ? "ROUTING_UNAVAILABLE"
      : rejected.some(({ failures }) => failures.every(({ kind }) => kind === "auth"))
        ? "AUTH_REQUIRED"
        : rejected.some(({ failures }) => failures.every(({ kind }) => kind === "model"))
          ? "MODEL_UNAVAILABLE"
          : "POLICY_BLOCKED";

  return {
    status: "BLOCKED",
    code,
    reason: `no candidate qualifies: ${rejected.flatMap(({ failures }) => failures.map(({ why }) => why)).join("; ")}`,
  };
}

/**
 * Identifies the resource pool currently hosting the active Operational
 * Router, so Router capacity reserve stays generic rather than hard-coded to
 * whichever provider/model happens to be the ROUTER slot's registry head
 * today. Runs the ordinary selection algorithm against the registry's ROUTER
 * slot (with `isRouterSlot: true`, so reserve cannot apply to it - the Router
 * cannot exclude itself from its own pool) and reports the winning
 * candidate's `resource_state_key`.
 *
 * Returns null when the ROUTER slot itself is not resolvable (no registry, no
 * ROUTER slot, or no qualifying candidate) - in that case the caller has no
 * pool identity to protect, and Router capacity reserve simply does not apply
 * anywhere, exactly as it did before this mechanism existed.
 */
export function resolveActiveRouterResourcePool(registry, resourceStates, tierOrder, options = {}) {
  const routerSlot = registry?.capability_slots?.ROUTER;
  if (!isPlainObject(routerSlot)) return null;

  const result = selectCandidate(routerSlot, resourceStates, tierOrder, {
    ...options,
    isRouterSlot: true,
    activeRouterResourceKey: null,
  });
  if (result.status !== "SELECTED") return null;

  return {
    resource_state_key: result.candidate?.resource_state_key ?? null,
    provider: result.candidate?.provider ?? null,
    model: result.candidate?.model ?? null,
  };
}

// Internal helpers/constants shared with the conformance checker and the
// Operational Router adapter. The resolver functions above are already
// `export`-prefixed; this surfaces the primitives they are built on.
export {
  isPlainObject,
  isNonEmptyString,
  toMillis,
  rankIn,
  tierIndex,
  stageIndex,
  STAGE_ORDER,
  RESOURCE_STATES,
  RESOURCE_SOURCES,
  PROBE_OUTCOMES,
  WINDOW_ROLES,
  RESET_PROXIMITY_VALUES,
  STRANDED_RISK_VALUES,
  CONSERVATION_VALUES,
  CONFIDENCE_VALUES,
  BURST_DEPLETION_VALUES,
  PACE_PRESSURE_VALUES,
  PACE_CONFIDENCE_VALUES,
  PACE_REASONS,
  RESOURCE_PRESSURE_RANKS,
  PACE_EVIDENCE,
  SOURCE_TRUST,
  LEGACY_WINDOW_ROLES,
  confidenceRank,
  resourceEntryTrust,
  resolveResourceEntry,
  entryUsableNow,
  readableEntry,
  resolvePaceForEntry,
  paceIsDemoting,
  resourcePressureClass,
};
