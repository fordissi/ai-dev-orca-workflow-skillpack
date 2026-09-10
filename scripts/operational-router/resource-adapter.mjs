/**
 * Operational Router - Resource Adapter.
 *
 *   ResourceEvidence  ->  ingestResourceEvidence()
 *                     ->  getCurrentResourceState()   (RESOURCE_STATE overlay)
 *                     +   bounded exact ephemeral observation history
 *                     ->  getPaceObservations()        (pace_observations series)
 *                     ->  shared Skillpack resolvers    (../lib/resource-routing.mjs)
 *
 * What this module OWNS: input validation (delegated to resource-evidence.mjs),
 * provider/window identification, ResourceEvidence -> RESOURCE_STATE mapping,
 * exact ephemeral observation accumulation, generation-continuity segmentation,
 * and resource-state snapshot production.
 *
 * What it does NOT own (all delegated to the shared pure library, which is the
 * semantic authority): routing thresholds, PACE scoring, BURST/BUDGET scoring,
 * candidate ranking, minimum tier, capability stage, human gates, Router
 * reserve math, reviewer disjointness.
 *
 * State ownership: exactly two things live on an instance - `#current` (the
 * last normalized RESOURCE_STATE tree) and `#series` (the bounded observation
 * store). No parallel caches. Not a singleton - the caller constructs it.
 *
 * The ephemeral store is process-lifetime, bounded, in-memory and discardable.
 * It is NEVER written to runtime/telemetry/ or any persistent store. Restart
 * behaviour is intentional: history lost -> PACE UNKNOWN -> rebuild from new
 * observations.
 */

import {
  resolvePace,
  resolveConservationPressure,
  resolveBurstDepletion,
  resolveStrandedCapacity,
  resolvePaceForEntry,
  resourcePressureClass,
  PACE_EVIDENCE,
  toMillis,
  isPlainObject,
} from "../lib/resource-routing.mjs";
import { parseResourceEvidence } from "./resource-evidence.mjs";

export const ADAPTER_CONTRACT_VERSION = "1.0.0";

/**
 * Bounded-history limits. Versioned and operator-controllable via the
 * constructor `storeLimits` option - never self-tuned from observed usage
 * (RESOURCE_AWARE_ROUTING.md / ROUTING_TELEMETRY.md: no feedback loop). The
 * generation-continuity thresholds themselves are the shared `PACE_EVIDENCE`
 * constants, so the adapter does not fork a second copy.
 */
export const OBSERVATION_STORE_LIMITS = Object.freeze({
  max_observations_per_series: 12,
  max_horizon_ms: 14 * 24 * 60 * 60 * 1000, // 14 days
  continuity_max_gap_ms: 6 * 60 * 60 * 1000, // a >6h gap between observations breaks continuity
});

/**
 * ResourceEvidence status -> RESOURCE_STATE band.
 *
 * Source: the task-frozen ResourceEvidence contract + RESOURCE_AWARE_ROUTING.md
 * "States". This is a 1:1 carry of the provider/runtime's own health enum, NOT
 * a remaining_ratio -> band derivation (which the policy forbids). `error` /
 * `unavailable` map to UNKNOWN (neutral), never a guessed RED. `degraded` maps
 * to YELLOW, which is equal-weight with UNKNOWN for ordering but keeps the
 * window signals alive. Anything unrecognised -> UNKNOWN.
 */
export const EVIDENCE_STATE_MAP = Object.freeze({
  ok: "GREEN",
  healthy: "GREEN",
  available: "GREEN",
  green: "GREEN",
  degraded: "YELLOW",
  partial: "YELLOW",
  yellow: "YELLOW",
  error: "UNKNOWN",
  unavailable: "UNKNOWN",
  unknown: "UNKNOWN",
});

const SERIES_SEP = "␟";

function seriesKey(resourceKey, scope, role) {
  return `${resourceKey}${SERIES_SEP}${scope}${SERIES_SEP}${role}`;
}

function isFiniteNum(v) {
  return typeof v === "number" && Number.isFinite(v);
}

/**
 * Places an entry into a flat resource-state tree under its resource_state_key,
 * nesting multi-segment keys (e.g. "antigravity.gemini") under `pools` so the
 * shared `resolveResourceEntry` walk finds them.
 */
function placeEntry(tree, resourceKey, entry) {
  const segs = resourceKey.split(".");
  if (segs.length === 1) {
    tree[resourceKey] = entry;
    return;
  }
  const [head, ...rest] = segs;
  if (!isPlainObject(tree[head])) tree[head] = { pools: {} };
  if (!isPlainObject(tree[head].pools)) tree[head].pools = {};
  let cursor = tree[head].pools;
  for (let i = 0; i < rest.length - 1; i += 1) {
    if (!isPlainObject(cursor[rest[i]])) cursor[rest[i]] = { pools: {} };
    if (!isPlainObject(cursor[rest[i]].pools)) cursor[rest[i]].pools = {};
    cursor = cursor[rest[i]].pools;
  }
  cursor[rest[rest.length - 1]] = entry;
}

export class OperationalResourceAdapter {
  #provider;
  #strict;
  #storeLimits;
  #paceConfig;
  #current = null; // { queried_at, tree, byKey: Map<resourceKey, entry> }
  #series = new Map(); // seriesKey -> Observation[]  (ascending checked_at)

  /**
   * @param {object} [options]
   * @param {{getResourceEvidence: Function}} [options.provider] injected producer
   * @param {boolean} [options.strict] reject identity-bearing evidence (default false: drop safely)
   * @param {object} [options.storeLimits] override OBSERVATION_STORE_LIMITS
   * @param {object} [options.paceConfig] operator override forwarded to resolvePace
   */
  constructor(options = {}) {
    this.#provider = options.provider ?? null;
    this.#strict = options.strict === true;
    this.#storeLimits = Object.freeze({ ...OBSERVATION_STORE_LIMITS, ...(options.storeLimits ?? {}) });
    this.#paceConfig = isPlainObject(options.paceConfig) ? options.paceConfig : undefined;
  }

  /** Pull one evidence object from the injected producer and ingest it. */
  async refresh(options = {}) {
    if (this.#provider === null || typeof this.#provider.getResourceEvidence !== "function") {
      throw new Error("OperationalResourceAdapter.refresh() needs a provider with getResourceEvidence()");
    }
    const evidence = await this.#provider.getResourceEvidence();
    return this.ingestResourceEvidence(evidence, options);
  }

  /**
   * Parse -> normalize -> map -> observe. Throws ResourceEvidenceError on
   * malformed / wrong-schema / identity-bearing input (task: JSON parsing
   * safety + identity firewall). Returns a compact ingest summary (labels /
   * counts only - never raw ratios or reset timestamps).
   */
  ingestResourceEvidence(evidence, options = {}) {
    const now = options.now ?? Date.now();
    const parsed = parseResourceEvidence(evidence, { strict: this.#strict });

    const tree = {};
    const byKey = new Map();
    const summary = [];

    for (const [resourceKey, prov] of Object.entries(parsed.providers)) {
      const entry = this.#toResourceStateEntry(prov, parsed.queried_at);
      const appended = this.#observe(resourceKey, prov);
      placeEntry(tree, resourceKey, entry);
      byKey.set(resourceKey, entry);
      summary.push({
        provider: prov.provider,
        resource_state_key: resourceKey,
        state: entry.state,
        available: entry.available,
        rate_limited: entry.rate_limited,
        checked_at_is_source_updated_at: true,
        burst_windows: entry.windows.filter((w) => w.role === "BURST").length,
        budget_windows: entry.windows.filter((w) => w.role === "BUDGET").length,
        unknown_role_windows: entry.unknown_role_windows.length,
        observations_appended: appended.appended,
        continuity_segmented: appended.segmented,
      });
    }

    this.#current = { queried_at: parsed.queried_at, tree, byKey };
    return { contract_version: ADAPTER_CONTRACT_VERSION, queried_at: parsed.queried_at, providers: summary };
  }

  /**
   * The current RESOURCE_STATE overlay, in the flat tree shape the shared
   * `selectCandidate` consumes. Each leaf entry carries a `pace_observations`
   * array (its primary BUDGET series, or [] when a single snapshot / no BUDGET
   * window). Returns a fresh deep copy every call - no internal array escapes.
   */
  getCurrentResourceState(options = {}) {
    if (this.#current === null) return {};
    const now = options.now ?? Date.now();
    const out = structuredClone(this.#current.tree);
    for (const [resourceKey, entry] of this.#current.byKey.entries()) {
      const clone = this.#findInTree(out, resourceKey);
      if (clone === null) continue;
      clone.pace_observations = this.getPaceObservations(resourceKey, { now });
    }
    return out;
  }

  /** The normalized entry for one resource_state_key (deep copy), or null. */
  getResourceStateEntry(resourceKey, options = {}) {
    if (this.#current === null || !this.#current.byKey.has(resourceKey)) return null;
    const entry = structuredClone(this.#current.byKey.get(resourceKey));
    entry.pace_observations = this.getPaceObservations(resourceKey, { now: options.now ?? Date.now() });
    return entry;
  }

  lastQueriedAt() {
    return this.#current?.queried_at ?? null;
  }

  /**
   * The bounded exact BUDGET observation series for one resource_state_key,
   * ready to hand to the shared PACE resolver. Deep copy - the internal store
   * is never exposed.
   *
   * With several BUDGET scopes (e.g. weekly + monthly) and no `scope` given,
   * the longest-horizon window (largest window_minutes) is chosen so the
   * result is deterministic and never mixes horizons.
   */
  getPaceObservations(resourceKey, options = {}) {
    const role = options.role ?? "BUDGET";
    const wantScope = options.scope ?? null;

    const matches = [];
    for (const [key, series] of this.#series.entries()) {
      const [rk, scope, r] = key.split(SERIES_SEP);
      if (rk !== resourceKey || r !== role) continue;
      if (wantScope !== null && scope !== wantScope) continue;
      matches.push({ scope, series });
    }
    if (matches.length === 0) return [];
    if (matches.length === 1) return matches[0].series.map(cloneObservation);

    // Multiple scopes: pick the longest-horizon one deterministically.
    matches.sort((a, b) => {
      const am = maxWindowMinutes(a.series);
      const bm = maxWindowMinutes(b.series);
      if (am !== bm) return bm - am;
      return a.scope < b.scope ? -1 : 1;
    });
    return matches[0].series.map(cloneObservation);
  }

  /**
   * Compact, non-sensitive explainability for one resource decision (labels
   * only - no ratios, no reset timestamps). Derived entirely from the shared
   * policy resolvers.
   */
  explain(resourceKey, options = {}) {
    const now = options.now ?? Date.now();
    const entry = this.getResourceStateEntry(resourceKey, { now });
    if (entry === null) {
      return { resource_state_key: resourceKey, state: "UNKNOWN", note: "no evidence ingested for this key" };
    }
    const conservation = resolveConservationPressure(entry, { now });
    const burstDepletion = resolveBurstDepletion(entry, { now });
    const stranded = resolveStrandedCapacity(entry, { now });
    const pace = this.#paceConfig
      ? resolvePace({ observations: entry.pace_observations }, { now, paceConfig: this.#paceConfig })
      : resolvePaceForEntry(entry, now);
    const rank = resourcePressureClass({ conservation, burstDepletion, pace });

    return {
      provider: entry.provider,
      resource_state_key: resourceKey,
      state: entry.state,
      available: entry.available,
      rate_limited: entry.rate_limited,
      budget: conservation.conservation_pressure,
      budget_expiry: conservation.budget_expiry_opportunity,
      burst_depletion: burstDepletion.burst_depletion_pressure,
      stranded: stranded.stranded_capacity_risk,
      pace: pace.pace_pressure,
      pace_confidence: pace.pace_confidence,
      pace_reason: pace.pace_reason,
      resource_pressure_rank: rank,
      budget_observations: entry.pace_observations.length,
    };
  }

  // --- internals -----------------------------------------------------------

  #toResourceStateEntry(prov, queriedAt) {
    const statusKey = typeof prov.status === "string" ? prov.status.trim().toLowerCase() : null;
    // Band from the provider's OWN health enum. available:false / rate_limited
    // are carried through independently and NOT folded into `state` or into a
    // synthesized availability - the adapter is an evidence mapper, not a
    // hard-gate owner.
    const state = statusKey !== null && statusKey in EVIDENCE_STATE_MAP ? EVIDENCE_STATE_MAP[statusKey] : "UNKNOWN";

    const windows = [];
    const unknownRoleWindows = [];
    for (const w of prov.windows) {
      const shaped = {
        key: w.scope,
        scope: w.scope,
        role: w.role,
        window_minutes: w.window_minutes,
        remaining_ratio: isFiniteNum(w.remaining_ratio) ? w.remaining_ratio : null,
        remaining_ratio_granularity: w.remaining_ratio_granularity,
        reset_at: w.reset_at,
        reset_at_source: w.reset_at_source,
      };
      if (w.role === "BURST" || w.role === "BUDGET") windows.push(shaped);
      else unknownRoleWindows.push(shaped); // retained raw, never fed to BURST/BUDGET semantics
    }

    return {
      // Freshness is source_updated_at based - never queried_at.
      checked_at: prov.source_updated_at,
      available: typeof prov.available === "boolean" ? prov.available : null,
      state,
      source: "ORCA_RUNTIME",
      windows,
      unknown_role_windows: unknownRoleWindows,
      // passthrough / observability (ignored by the shared resolvers):
      provider: prov.provider,
      status: prov.status,
      rate_limited: prov.rate_limited,
      retry_at: prov.retry_at,
      data_age_ms: prov.data_age_ms,
      queried_at: queriedAt,
    };
  }

  /**
   * Append the current snapshot's windows to the bounded ephemeral store.
   * Only BURST and BUDGET windows with a numeric remaining_ratio AND a valid
   * source_updated_at are recorded. Deduplicates identical snapshots. Breaks
   * (and restarts) a series on any generation discontinuity. BURST and BUDGET
   * series are kept strictly apart.
   */
  #observe(resourceKey, prov) {
    const checkedAt = prov.source_updated_at;
    const tMs = toMillis(checkedAt);
    if (!Number.isFinite(tMs)) return { appended: 0, segmented: false };

    let appended = 0;
    let segmented = false;

    for (const w of prov.windows) {
      if (w.role !== "BURST" && w.role !== "BUDGET") continue;
      if (!isFiniteNum(w.remaining_ratio)) continue;

      const record = {
        provider: prov.provider,
        resource_state_key: resourceKey,
        scope: w.scope,
        role: w.role,
        source_updated_at: checkedAt,
        checked_at: checkedAt, // alias the PACE resolver reads
        remaining_ratio: w.remaining_ratio,
        reset_at: w.reset_at ?? null,
        reset_at_source: w.reset_at_source ?? "unknown",
        remaining_ratio_granularity: w.remaining_ratio_granularity ?? null,
        window_minutes: w.window_minutes ?? null,
      };

      const k = seriesKey(resourceKey, w.scope, w.role);
      const series = this.#series.get(k) ?? [];

      // Dedup: an identical (source_updated_at, remaining_ratio, reset_at)
      // snapshot anywhere in the series does not grow history.
      const dup = series.some(
        (o) =>
          o.source_updated_at === record.source_updated_at &&
          o.remaining_ratio === record.remaining_ratio &&
          (o.reset_at ?? null) === record.reset_at,
      );
      if (dup) continue;

      const last = series.length > 0 ? series[series.length - 1] : null;
      let next;
      if (last !== null && this.#breaksContinuity(last, record)) {
        next = [record]; // capacity grant / reset / long gap -> fresh generation
        segmented = true;
      } else {
        next = [...series, record];
      }

      // Keep ascending by checked_at, then bound.
      next.sort((a, b) => toMillis(a.checked_at) - toMillis(b.checked_at));
      const newestMs = toMillis(next[next.length - 1].checked_at);
      let bounded = next.filter((o) => newestMs - toMillis(o.checked_at) <= this.#storeLimits.max_horizon_ms);
      if (bounded.length > this.#storeLimits.max_observations_per_series) {
        bounded = bounded.slice(bounded.length - this.#storeLimits.max_observations_per_series);
      }

      this.#series.set(k, bounded);
      appended += 1;
    }

    return { appended, segmented };
  }

  /**
   * Generation continuity break test between the last retained observation and
   * a new one. Mirrors RESOURCE_AWARE_ROUTING.md's continuity rules and reuses
   * the shared PACE_EVIDENCE tolerances so there is one threshold definition.
   * The shared `resolvePace` re-checks continuity across the whole series, so
   * this is a conservative ingest-time guard, not the semantic authority.
   */
  #breaksContinuity(prev, cur) {
    const tPrev = toMillis(prev.checked_at);
    const tCur = toMillis(cur.checked_at);
    if (!Number.isFinite(tPrev) || !Number.isFinite(tCur)) return true;

    // remaining_ratio jumped upward materially -> new generation / grant.
    if (cur.remaining_ratio - prev.remaining_ratio > PACE_EVIDENCE.upward_jump_ratio) return true;

    // A >gap between observations: cannot rule out an unobserved reset between.
    if (tCur - tPrev > this.#storeLimits.continuity_max_gap_ms) return true;

    const rPrev = toMillis(prev.reset_at);
    const rCur = toMillis(cur.reset_at);

    // The previous window's reset has already passed by the time of this obs.
    if (Number.isFinite(rPrev) && rPrev <= tCur) return true;

    if (Number.isFinite(rPrev) && Number.isFinite(rCur)) {
      const relative =
        prev.reset_at_source === "RELATIVE_PROVIDER_DURATION" || cur.reset_at_source === "RELATIVE_PROVIDER_DURATION";
      if (relative) {
        // Implied remaining duration should shrink roughly in step with time.
        const impliedPrev = rPrev - tPrev;
        const impliedCur = rCur - tCur;
        if (Math.abs(impliedCur - impliedPrev) > PACE_EVIDENCE.reset_at_tolerance_ms) return true;
      } else if (Math.abs(rCur - rPrev) > PACE_EVIDENCE.reset_at_tolerance_ms) {
        return true; // reset_at moved materially -> generation changed
      }
    }
    return false;
  }

  #findInTree(tree, resourceKey) {
    let cursor = tree;
    const segs = resourceKey.split(".");
    for (const seg of segs) {
      if (!isPlainObject(cursor)) return null;
      cursor = Object.hasOwn(cursor, seg) ? cursor[seg] : cursor?.pools?.[seg];
    }
    return isPlainObject(cursor) ? cursor : null;
  }
}

function cloneObservation(o) {
  return { ...o };
}

function maxWindowMinutes(series) {
  let m = 0;
  for (const o of series) if (isFiniteNum(o.window_minutes) && o.window_minutes > m) m = o.window_minutes;
  return m;
}
