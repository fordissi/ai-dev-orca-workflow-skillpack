/**
 * Conformance checker for the Orca workflow policy pack.
 *
 * The Markdown policies are normative. This module only checks that the
 * machine-readable inputs agree with them; whenever code and policy disagree,
 * the code is what gets corrected.
 *
 * It never reads environment variables, contacts a provider, or dispatches
 * work. Run directly (`npm run validate`) it checks the repository; imported,
 * it is a library of pure conformance functions.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parse as parseYaml } from "yaml";

const RESOURCE_STATES = ["GREEN", "YELLOW", "RED", "UNKNOWN"];

// A snapshot's authority is inherited from its source; the snapshot itself is
// only an overlay/cache. Trust levels live in RESOURCE_AWARE_ROUTING.md.
const RESOURCE_SOURCES = ["ORCA_RUNTIME", "USER_STATEMENT", "UNKNOWN"];
const CANDIDATE_STATUSES = ["stable", "experimental"];

// Capability stage: a backward-compatible band ABOVE capability_tier. Ordered,
// but not a ladder you can climb past - the gate is "meet the required stage,
// and a flagship (STAGE_3) candidate is admitted only when the required stage
// IS STAGE_3". MODEL_ROUTING_POLICY.md owns the semantics; MODEL_REGISTRY.yaml
// owns which tier maps to which stage.
const STAGE_ORDER = ["STAGE_1_DEFAULT", "STAGE_2_ADVANCED", "STAGE_3_FLAGSHIP"];

// Fallback tier->stage partition, used only when the registry omits `stages`.
const DEFAULT_STAGE_TIERS = {
  STAGE_1_DEFAULT: ["CHEAP", "DEFAULT"],
  STAGE_2_ADVANCED: ["STRONG"],
  STAGE_3_FLAGSHIP: ["DEEP"],
};

function stageIndex(stage) {
  return STAGE_ORDER.indexOf(stage);
}

function stageForTier(registry, tier) {
  const declared = isPlainObject(registry?.stages) ? registry.stages : null;
  const table = declared
    ? Object.fromEntries(
        Object.entries(declared).map(([name, def]) => [name, Array.isArray(def?.tiers) ? def.tiers : []]),
      )
    : DEFAULT_STAGE_TIERS;
  for (const [name, tiers] of Object.entries(table)) {
    if (tiers.includes(tier)) return name;
  }
  return null;
}

/**
 * Task capability difficulty -> capability stage. Risk, production-relatedness,
 * security sensitivity and test volume are NOT inputs: only complexity,
 * ambiguity, structural change, architecture/security semantic reasoning,
 * adversarial verification and prior-stage failure raise the stage.
 * MODEL_ROUTING_POLICY.md's "Stage admission" section is the normative owner.
 */
export function admitStage(classification, signals = {}) {
  const c = isPlainObject(classification) ? classification : {};
  const s = isPlainObject(signals) ? signals : {};

  const flagship =
    s.prior_stage_failed === "STAGE_2_ADVANCED" ||
    s.reviewer_disagreement_unresolved === true ||
    (s.irreversible === true && c.ambiguity === "high") ||
    (s.security_involvement === true && c.verification_need === "adversarial") ||
    s.exceptional_execution === true ||
    s.human_authorized_flagship === true;
  if (flagship) return "STAGE_3_FLAGSHIP";

  const advanced =
    c.complexity === "high" ||
    c.ambiguity === "high" ||
    c.change_intensity === "structural" ||
    s.architecture_involvement === true ||
    (s.security_involvement === true && (c.complexity !== "low" || c.ambiguity !== "low")) ||
    c.verification_need === "adversarial" ||
    s.high_semantic_coupling === true ||
    s.prior_stage_failed === "STAGE_1_DEFAULT";
  if (advanced) return "STAGE_2_ADVANCED";

  return "STAGE_1_DEFAULT";
}

/**
 * provider + model + reasoning_effort is the execution identity. For a Codex
 * dispatch the launch command MUST set reasoning explicitly (never inherit it
 * from ~/.codex/config.toml). If an observed identity is supplied it must
 * match the expected one. OFFICIAL_COMMANDS.md owns the exact syntax.
 */
export function checkReasoningDispatch(dispatch) {
  const d = isPlainObject(dispatch) ? dispatch : {};
  const expected = isPlainObject(d.expected) ? d.expected : {};
  const actual = isPlainObject(d.actual) ? d.actual : null;
  const command = isNonEmptyString(d.command) ? d.command : "";
  const supported = Array.isArray(d.supported_efforts) ? d.supported_efforts : null;

  // A user-selected reasoning effort the provider's CLI cannot express is a
  // genuine capability gap, not a routing preference. Even an explicit human
  // directive cannot make it possible.
  if (supported !== null && "reasoning_effort" in expected && !supported.includes(expected.reasoning_effort)) {
    return {
      result: "CONFIG_INVALID",
      why: `reasoning effort ${expected.reasoning_effort} is not supported by ${d.provider ?? "the provider"} (supported: ${supported.join("|")})`,
    };
  }

  if (d.provider === "codex" && command) {
    const hasModel = /(?:^|\s)(?:-m|--model)\s+\S/.test(command);
    const hasReasoning = /model_reasoning_effort\s*=\s*"[^"]+"/.test(command);
    if (!hasModel || !hasReasoning) {
      return {
        result: "INVALID_DISPATCH",
        why: "codex dispatch omits an explicit model and/or model_reasoning_effort",
      };
    }
  }

  if (actual !== null) {
    const modelMismatch = "model" in expected && actual.model !== expected.model;
    const effortMismatch =
      "reasoning_effort" in expected && actual.reasoning_effort !== expected.reasoning_effort;
    if (modelMismatch || effortMismatch) {
      return {
        result: "DISPATCH_CONTRACT_MISMATCH",
        why: `expected ${expected.model ?? "?"}/${expected.reasoning_effort ?? "?"}, observed ${actual.model ?? "?"}/${actual.reasoning_effort ?? "?"}`,
      };
    }
  }

  return { result: "PASS" };
}
const REQUIRED_CANDIDATE_FIELDS = [
  "provider",
  "resource_state_key",
  "model",
  "model_family",
  "reasoning",
  "capability_tier",
  "status",
];

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

export function validateRegistry(registry) {
  const findings = [];

  if (!isPlainObject(registry)) {
    return ["registry: expected a mapping at the top level"];
  }

  const tierOrder = registry.capability_tier_order;
  if (!Array.isArray(tierOrder) || tierOrder.length === 0 || !tierOrder.every(isNonEmptyString)) {
    findings.push("capability_tier_order: expected a non-empty list of tier names");
    return findings;
  }

  // `stages` is optional for backward compatibility, but when present it must
  // be a clean partition of capability_tier_order into the three known stages.
  if ("stages" in registry) {
    const stages = registry.stages;
    if (!isPlainObject(stages)) {
      findings.push("stages: expected a mapping of stage name to definition");
    } else {
      const seenTiers = new Set();
      for (const name of Object.keys(stages)) {
        if (!STAGE_ORDER.includes(name)) {
          findings.push(`stages.${name}: not one of ${STAGE_ORDER.join("|")}`);
        }
      }
      for (const stageName of STAGE_ORDER) {
        const def = stages[stageName];
        if (!isPlainObject(def)) {
          findings.push(`stages.${stageName}: expected a mapping`);
          continue;
        }
        if (!Array.isArray(def.tiers) || def.tiers.length === 0) {
          findings.push(`stages.${stageName}.tiers: expected a non-empty list of tier names`);
        } else {
          for (const tier of def.tiers) {
            if (tierIndex(tierOrder, tier) === -1) {
              findings.push(`stages.${stageName}.tiers: ${JSON.stringify(tier)} is not in capability_tier_order`);
            }
            if (seenTiers.has(tier)) {
              findings.push(`stages: tier ${JSON.stringify(tier)} appears in more than one stage`);
            }
            seenTiers.add(tier);
          }
        }
        if (!isNonEmptyString(def.admission)) {
          findings.push(`stages.${stageName}.admission: expected a non-empty value`);
        }
      }
      for (const tier of tierOrder) {
        if (!seenTiers.has(tier)) findings.push(`stages: tier ${JSON.stringify(tier)} is not assigned to any stage`);
      }
    }
  }

  const slots = registry.capability_slots;
  if (!isPlainObject(slots) || Object.keys(slots).length === 0) {
    findings.push("capability_slots: expected at least one capability slot");
    return findings;
  }

  for (const [slotName, slot] of Object.entries(slots)) {
    const at = `capability_slots.${slotName}`;

    if (!isPlainObject(slot)) {
      findings.push(`${at}: expected a mapping`);
      continue;
    }

    if (!isNonEmptyString(slot.role)) {
      findings.push(`${at}.role: expected a non-empty role tag`);
    }

    // A slot's stage, when declared, must be a known stage and must agree
    // with the stage that contains its minimum_tier.
    if ("stage" in slot) {
      if (!STAGE_ORDER.includes(slot.stage)) {
        findings.push(`${at}.stage: ${JSON.stringify(slot.stage)} is not one of ${STAGE_ORDER.join("|")}`);
      } else if (isNonEmptyString(slot.minimum_tier)) {
        const expectedStage = stageForTier(registry, slot.minimum_tier);
        if (expectedStage !== null && expectedStage !== slot.stage) {
          findings.push(
            `${at}.stage: ${slot.stage} disagrees with minimum_tier ${slot.minimum_tier} (expected ${expectedStage})`,
          );
        }
      }
    }

    const minimumTier = slot.minimum_tier;
    const minimumIndex = tierIndex(tierOrder, minimumTier);
    if (minimumIndex === -1) {
      findings.push(`${at}.minimum_tier: ${JSON.stringify(minimumTier)} is not in capability_tier_order`);
    }

    if (!Number.isInteger(slot.max_repair_attempts) || slot.max_repair_attempts < 0) {
      findings.push(`${at}.max_repair_attempts: expected a non-negative integer`);
    }

    const candidates = slot.candidates;
    if (!Array.isArray(candidates) || candidates.length === 0) {
      findings.push(`${at}.candidates: expected a non-empty ordered list`);
      continue;
    }

    candidates.forEach((candidate, index) => {
      const candidateAt = `${at}.candidates[${index}]`;

      if (!isPlainObject(candidate)) {
        findings.push(`${candidateAt}: expected a mapping`);
        return;
      }

      for (const field of REQUIRED_CANDIDATE_FIELDS) {
        if (!isNonEmptyString(candidate[field])) {
          findings.push(`${candidateAt}.${field}: expected a non-empty value`);
        }
      }

      if (isNonEmptyString(candidate.status) && !CANDIDATE_STATUSES.includes(candidate.status)) {
        findings.push(
          `${candidateAt}.status: ${JSON.stringify(candidate.status)} is not one of ${CANDIDATE_STATUSES.join("|")}`,
        );
      }

      // `enabled` is human-authoritative configuration. Optional (absence means
      // enabled); when present it must be a boolean.
      if ("enabled" in candidate && typeof candidate.enabled !== "boolean") {
        findings.push(`${candidateAt}.enabled: expected true or false`);
      }

      // A candidate's stage, when declared, must be the stage that contains
      // its capability_tier - stage is derived from tier, never independent.
      if ("stage" in candidate) {
        if (!STAGE_ORDER.includes(candidate.stage)) {
          findings.push(`${candidateAt}.stage: ${JSON.stringify(candidate.stage)} is not one of ${STAGE_ORDER.join("|")}`);
        } else if (isNonEmptyString(candidate.capability_tier)) {
          const expectedStage = stageForTier(registry, candidate.capability_tier);
          if (expectedStage !== null && expectedStage !== candidate.stage) {
            findings.push(
              `${candidateAt}.stage: ${candidate.stage} disagrees with capability_tier ${candidate.capability_tier} (expected ${expectedStage})`,
            );
          }
        }
      }

      const candidateIndex = tierIndex(tierOrder, candidate.capability_tier);
      if (candidateIndex === -1) {
        if (isNonEmptyString(candidate.capability_tier)) {
          findings.push(
            `${candidateAt}.capability_tier: ${JSON.stringify(candidate.capability_tier)} is not in capability_tier_order`,
          );
        }
        return;
      }

      if (minimumIndex !== -1 && candidateIndex < minimumIndex) {
        findings.push(
          `${candidateAt}.capability_tier: ${candidate.capability_tier} is below minimum tier ${minimumTier}`,
        );
      }
    });
  }

  return findings;
}

/**
 * Freshness is evaluated from each provider or independently limited pool's own
 * `checked_at`, so a provider with several billing pools is walked entry by
 * entry rather than collapsed into one global timestamp.
 */
function walkResourceEntries(providers, prefix, visit) {
  for (const [name, entry] of Object.entries(providers)) {
    const at = `${prefix}.${name}`;

    if (!isPlainObject(entry)) {
      visit(at, entry);
      continue;
    }

    if (isPlainObject(entry.pools)) {
      walkResourceEntries(entry.pools, `${at}.pools`, visit);
      continue;
    }

    visit(at, entry);
  }
}

export function validateResourceState(state, options = {}) {
  const { allowExampleNulls = false } = options;
  const findings = [];

  if (!isPlainObject(state)) {
    return ["resource state: expected a mapping at the top level"];
  }

  if (!isPlainObject(state.providers) || Object.keys(state.providers).length === 0) {
    return ["providers: expected at least one provider entry"];
  }

  walkResourceEntries(state.providers, "providers", (at, entry) => {
    if (!isPlainObject(entry)) {
      findings.push(`${at}: expected a mapping`);
      return;
    }

    if (!RESOURCE_STATES.includes(entry.state)) {
      findings.push(`${at}: invalid state ${JSON.stringify(entry.state)}`);
    }

    if (!("checked_at" in entry)) {
      findings.push(`${at}.checked_at: expected a timestamp or null`);
    } else if (entry.checked_at !== null && !isNonEmptyString(entry.checked_at)) {
      findings.push(`${at}.checked_at: expected an ISO timestamp string or null`);
    }

    if (!RESOURCE_SOURCES.includes(entry.source)) {
      findings.push(`${at}.source: expected one of ${RESOURCE_SOURCES.join("|")}`);
    } else if (entry.source === "UNKNOWN" && entry.state !== "UNKNOWN") {
      // No trustworthy source cannot produce a confident state. That is a guess.
      findings.push(`${at}: source UNKNOWN cannot carry state ${JSON.stringify(entry.state)}`);
    }

    const namedWindows = LEGACY_WINDOW_ROLES.filter(([key]) => key in entry).map(([key]) => [key, entry[key]]);
    const listedWindows = Array.isArray(entry.windows)
      ? entry.windows.map((window, index) => [`windows[${index}]`, window])
      : [];

    if ("windows" in entry && !Array.isArray(entry.windows)) {
      findings.push(`${at}.windows: expected a list of window entries`);
    }

    for (const [windowName, window] of [...namedWindows, ...listedWindows]) {
      if (!isPlainObject(window)) {
        findings.push(`${at}.${windowName}: expected a mapping`);
        continue;
      }

      // A named window may override its default role; a listed one must
      // declare it, because nothing else says which horizon it describes.
      if ("role" in window && !WINDOW_ROLES.includes(window.role)) {
        findings.push(`${at}.${windowName}.role: expected one of ${WINDOW_ROLES.join("|")}`);
      } else if (windowName.startsWith("windows[") && !("role" in window)) {
        findings.push(`${at}.${windowName}.role: a listed window must declare BURST or BUDGET`);
      }

      if ("reset_at" in window && window.reset_at !== null && !isNonEmptyString(window.reset_at)) {
        findings.push(`${at}.${windowName}.reset_at: expected an ISO timestamp string or null`);
      }

      if ("remaining_ratio" in window && window.remaining_ratio !== null) {
        const ratio = window.remaining_ratio;
        if (typeof ratio !== "number" || !Number.isFinite(ratio) || ratio < 0 || ratio > 1) {
          findings.push(`${at}.${windowName}.remaining_ratio: expected a ratio between 0 and 1, or null`);
        }
      }
    }

    if ("remaining_confidence" in entry) {
      if (!CONFIDENCE_VALUES.includes(entry.remaining_confidence)) {
        findings.push(
          `${at}.remaining_confidence: expected one of ${CONFIDENCE_VALUES.join("|")}`,
        );
      } else if (
        RESOURCE_SOURCES.includes(entry.source) &&
        confidenceRank(entry.remaining_confidence) > confidenceRank(SOURCE_TRUST[entry.source])
      ) {
        // A reading cannot be more confident than where it came from.
        findings.push(
          `${at}.remaining_confidence: ${entry.remaining_confidence} exceeds the trust of source ${entry.source}`,
        );
      }
    }

    if (typeof entry.available === "boolean") {
      return;
    }

    // `available: null` is an example-only affordance and never enters live
    // routing: it is accepted solely alongside an explicit UNKNOWN state.
    if (allowExampleNulls && entry.available === null && entry.state === "UNKNOWN") {
      return;
    }

    findings.push(`${at}.available: expected a boolean availability value`);
  });

  return findings;
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

// A reading can never be more confident than the source it came from.
const SOURCE_TRUST = { ORCA_RUNTIME: "HIGH", USER_STATEMENT: "MEDIUM", UNKNOWN: "UNKNOWN" };

// Legacy v0.3 snapshots named their windows instead of typing them. The names
// keep working and mean what they always meant; an explicit `role` wins, so a
// provider whose short window really is its budget can say so.
const LEGACY_WINDOW_ROLES = [
  ["short_window", "BURST"],
  ["weekly_window", "BUDGET"],
];

const RESET_NEAR_MS = 6 * 60 * 60 * 1000;
const RESET_MEDIUM_MS = 48 * 60 * 60 * 1000;

const REMAINING_HIGH = 0.5;
const REMAINING_MODERATE = 0.2;

const BUDGET_AMPLE = 0.5;
const BUDGET_COMFORTABLE = 0.25;
const BUDGET_LOW = 0.1;

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

function toMillis(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : Number.NaN;
  if (isNonEmptyString(value)) return Date.parse(value);
  if (value instanceof Date) return value.getTime();
  return Number.NaN;
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
  } = options;

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

    if (failures.length === 0) {
      qualified.push({
        candidate,
        label,
        resourceState,
        stranded: resolveStrandedCapacity(entry, { now }),
        conservation: resolveConservationPressure(entry, { now }),
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
    const matches = (providerOrLabelProvider, model) =>
      model === pinnedCandidate.model &&
      (pinnedCandidate.provider === undefined || pinnedCandidate.provider === null ||
        providerOrLabelProvider === pinnedCandidate.provider);

    if (!slot.candidates.some((c) => matches(c?.provider, c?.model))) {
      return {
        status: "BLOCKED",
        code: "CONFIG_INVALID",
        reason: `pinned model ${pinnedCandidate.provider ?? "?"}/${pinnedCandidate.model} is not a candidate for this slot`,
      };
    }

    const hit = qualified.find(({ candidate }) => matches(candidate?.provider, candidate?.model));
    if (hit !== undefined) {
      return {
        status: "SELECTED",
        candidate: hit.candidate,
        resource_state: hit.resourceState,
        reset_proximity: hit.stranded.reset_proximity,
        stranded_capacity_risk: hit.stranded.stranded_capacity_risk,
        budget_reset_proximity: hit.conservation.budget_reset_proximity,
        conservation_pressure: hit.conservation.conservation_pressure,
        budget_expiry_opportunity: hit.conservation.budget_expiry_opportunity,
        conservation_demotion: null,
        expiry_promotion: null,
        stranded_promotion: null,
        pinned: true,
      };
    }

    const rej = rejected.find(({ label }) => {
      const [prov, ...rest] = label.split("/");
      return matches(prov, rest.join("/"));
    });
    const code =
      rej === undefined
        ? "CONFIG_INVALID"
        : rej.failures.some(({ kind }) => kind === "config")
          ? "CONFIG_INVALID"
          : rej.onlyUnavailable
            ? "ROUTING_UNAVAILABLE"
            : "POLICY_BLOCKED";
    return {
      status: "BLOCKED",
      code,
      reason: `pinned model ${pinnedCandidate.model} is not eligible: ${
        (rej?.failures ?? []).map(({ why }) => why).join("; ") || "no qualifying entry"
      }`,
    };
  }

  // Registry order picks the head of the band. The two resource signals may
  // then reorder inside the head's own resource state, and only there.
  //
  // Conservation runs first and only demotes, on HIGH or CRITICAL: a provider
  // whose long-horizon budget is nearly spent goes behind the ones that are
  // not, and everything softer is neutral. Burst opportunity runs second and
  // only promotes, on HIGH stranded risk - and only for a candidate whose own
  // budget somebody has read and found sustainable. UNKNOWN is in neither set,
  // so not checking buys neither a promotion nor a penalty.
  const pickFromBand = (band) => {
    const head = band[0];
    if (head === undefined) return undefined;
    if (!preferStrandedCapacity) return { pick: head, head };

    const sameState = band.filter(({ resourceState }) => resourceState === head.resourceState);

    const conserve = sameState.filter(({ conservation }) => CONSERVE_PRESSURES.has(conservation.conservation_pressure));
    const sustainable = sameState.filter(({ conservation }) => !CONSERVE_PRESSURES.has(conservation.conservation_pressure));

    // Model-role preference is the LAST tie-break: it reorders inside the
    // sustainable and conserve groups separately (so conservation stays
    // dominant), and burst opportunity still runs after it (so opportunity
    // stays dominant over preference). No preference list -> registry order.
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

    // Conservation expresses a preference, never a refusal: with every
    // candidate under pressure the band still routes, in registry order.
    const ordered = [...byPreference(sustainable), ...byPreference(conserve)];

    // Layer 4: BUDGET expiry opportunity (offensive). Prefer a candidate whose
    // own long-horizon budget has room left and is about to reset - but only
    // when that same candidate's BUDGET is not itself under HIGH/CRITICAL
    // scarcity. Scarcity is defensive and always wins (BUDGET scarcity MUST
    // override BUDGET expiry opportunity).
    const expiryPromoted = ordered.find(
      ({ conservation }) =>
        conservation.budget_expiry_opportunity === "HIGH" &&
        !CONSERVE_PRESSURES.has(conservation.conservation_pressure),
    );

    // Layer 5: BURST stranded-capacity opportunity - shorter-horizon secondary
    // optimisation, applied only if expiry did not already move the pick.
    const burstPromoted = ordered.find(
      ({ stranded, conservation }) =>
        stranded.stranded_capacity_risk === "HIGH" && SUSTAINABLE_PRESSURES.has(conservation.conservation_pressure),
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
    const demoted = moved && CONSERVE_PRESSURES.has(head.conservation.conservation_pressure);

    return {
      status: "SELECTED",
      candidate: pick.candidate,
      resource_state: pick.resourceState,
      reset_proximity: pick.stranded.reset_proximity,
      stranded_capacity_risk: pick.stranded.stranded_capacity_risk,
      budget_reset_proximity: pick.conservation.budget_reset_proximity,
      conservation_pressure: pick.conservation.conservation_pressure,
      budget_expiry_opportunity: pick.conservation.budget_expiry_opportunity,
      conservation_demotion: demoted
        ? {
            over: head.label,
            budget_reset_proximity: head.conservation.budget_reset_proximity,
            conservation_pressure: head.conservation.conservation_pressure,
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
      : "POLICY_BLOCKED";

  return {
    status: "BLOCKED",
    code,
    reason: `no candidate qualifies: ${rejected.flatMap(({ failures }) => failures.map(({ why }) => why)).join("; ")}`,
  };
}

/**
 * Marker words are assembled at runtime so the scanner never reports its own
 * source as a finding.
 */
const UNFINISHED_WORDS = ["TO" + "DO", "TB" + "D", "FIX" + "ME"];

const CREDENTIAL_NAMES = [
  "to" + "ken",
  "api" + "_key",
  "api" + "key",
  "access" + "_token",
  "refresh" + "_token",
  "session" + "_token",
  "client" + "_secret",
  "se" + "cret",
  "pass" + "word",
  "pass" + "wd",
  "private" + "_key",
  "aws" + "_secret_access_key",
];

const PERSONAL_DATA_NAMES = [
  "customer" + "_name",
  "customer" + "_email",
  "customer" + "_data",
  "personal" + "_data",
  "national" + "_id",
  "credit" + "_card",
  "phone" + "_number",
  "date" + "_of_birth",
  "ss" + "n",
];

function alternation(names) {
  return names.map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
}

const SCAN_PATTERNS = [
  {
    name: "unfinished-marker",
    regex: new RegExp(`\\b(?:${alternation(UNFINISHED_WORDS)})\\b`, "g"),
  },
  {
    name: "credential-assignment",
    regex: new RegExp(`(?:^|[^A-Za-z0-9_])(?:${alternation(CREDENTIAL_NAMES)})\\s*=\\s*["']?[^\\s"']`, "gi"),
  },
  {
    name: "private-key-block",
    regex: /-----BEGIN[A-Z ]*PRIVATE KEY-----/g,
  },
  {
    name: "authorization-header",
    regex: /\bauthorization\s*:\s*(?:bearer|basic)\s+\S/gi,
  },
  {
    name: "personal-data-assignment",
    regex: new RegExp(`(?:^|[^A-Za-z0-9_])(?:${alternation(PERSONAL_DATA_NAMES)})\\s*=\\s*["']?[^\\s"']`, "gi"),
  },
  {
    name: "email-address",
    regex: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
  },
];

/**
 * Reports sensitive and unfinished markers as location metadata only. The
 * matched text is deliberately never returned or logged, so a finding can be
 * triaged without re-exposing whatever it found.
 */
export function scanText(text, options = {}) {
  const { path = null } = options;
  const findings = [];

  if (typeof text !== "string" || text.length === 0) {
    return findings;
  }

  const lines = text.split(/\r?\n/);

  lines.forEach((lineText, lineIndex) => {
    for (const { name, regex } of SCAN_PATTERNS) {
      regex.lastIndex = 0;
      let match;
      while ((match = regex.exec(lineText)) !== null) {
        findings.push({
          pattern: name,
          line: lineIndex + 1,
          column: match.index + 1,
          ...(path === null ? {} : { path }),
        });
        if (match[0].length === 0) regex.lastIndex += 1;
      }
    }
  });

  return findings;
}

/* ------------------------------------------------------------------------ *
 * Routing conformance cases
 *
 * tests/routing-cases.yaml is a conformance check on MODEL_ROUTING_POLICY.md,
 * which stays normative. If a case and the Markdown policy disagree, correct
 * the case, not the policy.
 * ------------------------------------------------------------------------ */

const CASE_KINDS = ["selection", "multi_stage", "stage_admission", "reasoning_dispatch"];

const STAGE_ADMISSION_RESULTS = ["STAGE_1_DEFAULT", "STAGE_2_ADVANCED", "STAGE_3_FLAGSHIP"];
const DISPATCH_RESULTS = ["PASS", "INVALID_DISPATCH", "DISPATCH_CONTRACT_MISMATCH", "CONFIG_INVALID"];

// "Cannot" and "must not" need different handling upstream, so a BLOCKED
// result always says which it is. Owner: MODEL_ROUTING_POLICY.md.
const BLOCKED_REASON_CODES = [
  "CONFIG_INVALID",
  "ROUTING_UNAVAILABLE",
  "POLICY_BLOCKED",
  "RESOURCE_BLOCKED",
  "PERMISSION_BLOCKED",
];

const CONCURRENCY_MODES = [
  "SEQUENTIAL",
  "PARALLEL_INDEPENDENT",
  "COMPETITIVE_DESIGN",
  "PARALLEL_SAME_CORE_IMPLEMENTATION",
];

const CLASSIFICATION_VALUES = {
  risk: ["low", "medium", "high", "critical"],
  complexity: ["low", "medium", "high"],
  context_size: ["small", "medium", "large"],
  ambiguity: ["low", "medium", "high"],
  change_intensity: ["none", "localized", "structural"],
  verification_need: ["standard", "independent", "adversarial"],
};

function validateClassification(classification, at, findings) {
  if (!isPlainObject(classification)) {
    findings.push(`${at}.classification: expected a mapping of the six dimensions`);
    return;
  }
  for (const [field, allowed] of Object.entries(CLASSIFICATION_VALUES)) {
    if (!allowed.includes(classification[field])) {
      findings.push(
        `${at}.classification.${field}: ${JSON.stringify(classification[field])} is not one of ${allowed.join("|")}`,
      );
    }
  }
}

export function validateRoutingCases(document, registry) {
  const findings = [];

  if (!isPlainObject(document) || !Array.isArray(document.cases) || document.cases.length === 0) {
    return ["routing cases: expected a non-empty `cases` list"];
  }

  const slots = isPlainObject(registry?.capability_slots) ? registry.capability_slots : {};
  const tierOrder = Array.isArray(registry?.capability_tier_order) ? registry.capability_tier_order : [];
  const seen = new Set();

  for (const [index, testCase] of document.cases.entries()) {
    const at = `cases[${index}]`;

    if (!isPlainObject(testCase) || !isNonEmptyString(testCase.name)) {
      findings.push(`${at}.name: expected a non-empty case name`);
      continue;
    }

    const named = `case ${testCase.name}`;

    if (seen.has(testCase.name)) findings.push(`${named}: duplicate case name`);
    seen.add(testCase.name);

    if (!CASE_KINDS.includes(testCase.kind)) {
      findings.push(`${named}: kind ${JSON.stringify(testCase.kind)} is not one of ${CASE_KINDS.join("|")}`);
      continue;
    }

    if (!isPlainObject(testCase.expect)) {
      findings.push(`${named}: expected an \`expect\` mapping`);
      continue;
    }

    if ("classification" in testCase) validateClassification(testCase.classification, named, findings);

    if (testCase.kind === "selection") {
      let slot = slots[testCase.slot];
      if (slot === undefined) {
        findings.push(`${named}: slot ${JSON.stringify(testCase.slot)} is not defined in the registry`);
        continue;
      }

      // A case may exercise operator config it cannot express in the shipped
      // registry: `disable_models` flips `enabled: false` on the named models.
      if (Array.isArray(testCase.disable_models) && testCase.disable_models.length > 0) {
        slot = structuredClone(slot);
        for (const candidate of slot.candidates) {
          if (testCase.disable_models.includes(candidate.model)) candidate.enabled = false;
        }
      }

      const result = selectCandidate(
        slot,
        isPlainObject(testCase.resource_states) ? testCase.resource_states : {},
        tierOrder,
        isPlainObject(testCase.options) ? testCase.options : {},
      );

      if (result.status !== testCase.expect.status) {
        findings.push(`${named}: expected status ${testCase.expect.status}, got ${result.status}`);
        continue;
      }

      if (result.status === "BLOCKED") {
        if (!isNonEmptyString(result.reason)) findings.push(`${named}: BLOCKED result must carry a reason`);
        if (!BLOCKED_REASON_CODES.includes(result.code)) {
          findings.push(`${named}: BLOCKED result carries invalid code ${JSON.stringify(result.code)}`);
        }
        if ("code" in testCase.expect && result.code !== testCase.expect.code) {
          findings.push(`${named}: expected code ${testCase.expect.code}, got ${result.code}`);
        }
        continue;
      }

      if ("provider" in testCase.expect && result.candidate.provider !== testCase.expect.provider) {
        findings.push(`${named}: expected provider ${testCase.expect.provider}, got ${result.candidate.provider}`);
      }

      if ("model" in testCase.expect && result.candidate.model !== testCase.expect.model) {
        findings.push(`${named}: expected model ${testCase.expect.model}, got ${result.candidate.model}`);
      }

      if ("stranded_capacity_risk" in testCase.expect && result.stranded_capacity_risk !== testCase.expect.stranded_capacity_risk) {
        findings.push(
          `${named}: expected stranded_capacity_risk ${testCase.expect.stranded_capacity_risk}, got ${result.stranded_capacity_risk}`,
        );
      }

      if ("conservation_pressure" in testCase.expect && result.conservation_pressure !== testCase.expect.conservation_pressure) {
        findings.push(
          `${named}: expected conservation_pressure ${testCase.expect.conservation_pressure}, got ${result.conservation_pressure}`,
        );
      }

      if ("budget_expiry_opportunity" in testCase.expect && result.budget_expiry_opportunity !== testCase.expect.budget_expiry_opportunity) {
        findings.push(
          `${named}: expected budget_expiry_opportunity ${testCase.expect.budget_expiry_opportunity}, got ${result.budget_expiry_opportunity}`,
        );
      }

      if ("expiry_promotion" in testCase.expect) {
        const promoted = result.expiry_promotion !== null;
        if (promoted !== testCase.expect.expiry_promotion) {
          findings.push(`${named}: expected expiry_promotion ${testCase.expect.expiry_promotion}, got ${promoted}`);
        }
        if (promoted && !isNonEmptyString(result.expiry_promotion.over)) {
          findings.push(`${named}: an expiry promotion must record the candidate it moved ahead of`);
        }
      }

      if ("conservation_demotion" in testCase.expect) {
        const demoted = result.conservation_demotion !== null;
        if (demoted !== testCase.expect.conservation_demotion) {
          findings.push(
            `${named}: expected conservation_demotion ${testCase.expect.conservation_demotion}, got ${demoted}`,
          );
        }
        if (demoted && !isNonEmptyString(result.conservation_demotion.over)) {
          findings.push(`${named}: a conservation demotion must record the candidate it moved ahead of`);
        }
      }

      // A promotion that is not recorded is a promotion nobody can audit.
      if ("stranded_promotion" in testCase.expect) {
        const promoted = result.stranded_promotion !== null;
        if (promoted !== testCase.expect.stranded_promotion) {
          findings.push(
            `${named}: expected stranded_promotion ${testCase.expect.stranded_promotion}, got ${promoted}`,
          );
        }
        if (promoted && !isNonEmptyString(result.stranded_promotion.over)) {
          findings.push(`${named}: a stranded promotion must record the candidate it moved ahead of`);
        }
      }

      const disjoint = testCase.expect.disjoint_from;
      if (isPlainObject(disjoint)) {
        if (result.candidate.provider === disjoint.provider) {
          findings.push(`${named}: reviewer shares the implementer provider ${disjoint.provider}`);
        }
        if (result.candidate.model_family === disjoint.model_family) {
          findings.push(`${named}: reviewer shares the implementer model family ${disjoint.model_family}`);
        }
      }

      // Flagship admission: selecting into a STAGE_3 slot without recording
      // why Stage 2 was insufficient is not a legal routing decision.
      if (slot.stage === "STAGE_3_FLAGSHIP") {
        const fr = testCase.flagship_reason;
        if (!isPlainObject(fr) || !isNonEmptyString(fr.escalation_reason) || !isNonEmptyString(fr.why_stage_2_insufficient)) {
          findings.push(
            `${named}: a STAGE_3_FLAGSHIP selection must record flagship_reason.escalation_reason and .why_stage_2_insufficient`,
          );
        }
      }

      continue;
    }

    if (testCase.kind === "stage_admission") {
      const produced = admitStage(testCase.classification, testCase.signals);
      if (!STAGE_ADMISSION_RESULTS.includes(produced)) {
        findings.push(`${named}: admitStage produced unknown stage ${JSON.stringify(produced)}`);
      } else if (produced !== testCase.expect.stage) {
        findings.push(`${named}: expected stage ${testCase.expect.stage}, got ${produced}`);
      }
      continue;
    }

    if (testCase.kind === "reasoning_dispatch") {
      const outcome = checkReasoningDispatch(testCase.dispatch);
      if (!DISPATCH_RESULTS.includes(outcome.result)) {
        findings.push(`${named}: checkReasoningDispatch produced unknown result ${JSON.stringify(outcome.result)}`);
      } else if (outcome.result !== testCase.expect.result) {
        findings.push(`${named}: expected dispatch result ${testCase.expect.result}, got ${outcome.result}`);
      }
      continue;
    }

    // multi_stage
    const stages = testCase.expect.stages;
    if (!Array.isArray(stages) || stages.length === 0) {
      findings.push(`${named}: expected a non-empty \`expect.stages\` list`);
    } else {
      for (const [stageIndex, stage] of stages.entries()) {
        const stageAt = `${named} stage[${stageIndex}]`;
        const slot = slots[stage?.slot];
        if (slot === undefined) {
          findings.push(`${stageAt}: slot ${JSON.stringify(stage?.slot)} is not defined in the registry`);
          continue;
        }
        if (slot.role !== stage.role) {
          findings.push(`${stageAt}: declared role ${stage.role} does not match registry role ${slot.role}`);
        }
        if (slot.minimum_tier !== stage.minimum_tier) {
          findings.push(
            `${stageAt}: declared minimum_tier ${stage.minimum_tier} does not match registry ${slot.minimum_tier}`,
          );
        }
      }
    }

    if (!CONCURRENCY_MODES.includes(testCase.expect.concurrency_mode)) {
      findings.push(
        `${named}: concurrency_mode ${JSON.stringify(testCase.expect.concurrency_mode)} is not a defined mode`,
      );
    }

    if (typeof testCase.expect.human_gate !== "boolean") {
      findings.push(`${named}: expect.human_gate must be a boolean`);
    } else if (testCase.expect.human_gate && !isNonEmptyString(testCase.expect.human_gate_reason)) {
      findings.push(`${named}: a required human gate must state human_gate_reason`);
    }

    if (isPlainObject(testCase.repair)) {
      const slot = slots[testCase.repair.slot];
      if (slot === undefined) {
        findings.push(`${named}: repair.slot ${JSON.stringify(testCase.repair.slot)} is not defined in the registry`);
      } else if (testCase.repair.initial_attempt_counts_as_repair !== false) {
        findings.push(`${named}: the initial implementation attempt must not count as a repair`);
      } else if (!(testCase.repair.failed_repair_count >= slot.max_repair_attempts)) {
        findings.push(
          `${named}: failed_repair_count ${testCase.repair.failed_repair_count} does not reach max_repair_attempts ${slot.max_repair_attempts}`,
        );
      }
    }
  }

  return findings;
}

/* ------------------------------------------------------------------------ *
 * Operational execution lifecycle
 *
 * WORKFLOW_POLICY.md is the normative owner of these semantics; this section
 * only makes them executable. The point of the split is that a slow model, a
 * quiet terminal and an exhausted turn budget are three different facts, and
 * none of them is a routing or permission failure.
 * ------------------------------------------------------------------------ */

// Observation states. PERMISSION_BLOCKED and ROUTING_UNAVAILABLE are the two
// exits that hand off to a canonical blocked reason code; their meaning is
// owned by MODEL_ROUTING_POLICY.md and is not redefined here.
const EXECUTION_STATES = [
  "ACTIVE",
  "QUIET",
  "STALLED",
  "COMPLETE",
  "MAX_TURNS_REACHED",
  "PROCESS_EXIT_FAILURE",
  "HARD_EXECUTION_CEILING",
  "PERMISSION_BLOCKED",
  "ROUTING_UNAVAILABLE",
];

const EXECUTION_ACTIONS = [
  "CONTINUE",
  "CLOSE",
  "STALL_INTERVENTION",
  "CONTINUATION",
  "REPAIR_OR_ESCALATE",
  "HUMAN_GATE",
  "BLOCKED",
];

const PROCESS_EXIT_KINDS = ["clean", "max_turns", "failure"];

// Operational guidance, not parser limits. WORKFLOW_POLICY.md states the
// ranges; these are the midpoints used when a contract declares nothing.
const EXECUTION_DEFAULTS = {
  pollIntervalMs: 90_000, // 60-120s
  stallThresholdMs: 15 * 60_000, // 10-20 min
  hardCeilingMs: null, // opt-in; absent means no ceiling
  maxContinuationAttempts: 2,
};

/**
 * A read-only allowlist keyed on the actual invocation, never on the
 * executable alone: `git` carries both `git log` and `git push`.
 */
const READ_ONLY_EXECUTABLES = new Set([
  "cat", "type", "ls", "dir", "tree", "head", "tail", "wc", "stat", "file",
  "pwd", "rg", "grep", "find", "diff", "sed", "awk", "nl", "sort", "uniq",
  "get-content", "get-childitem", "get-item", "get-location", "select-string",
  "test-path", "resolve-path", "measure-object",
]);

const GIT_READ_ONLY_SUBCOMMANDS = new Set([
  "status", "rev-parse", "branch", "log", "show", "diff", "grep",
  "ls-files", "ls-tree", "cat-file", "describe", "blame", "shortlog",
]);

// `git branch` reads; `git branch -d feature` does not.
const GIT_MUTATING_FLAGS = new Set(["-d", "-D", "-m", "-M", "--delete", "--move", "--force", "-f"]);

const GIT_COMMIT_SUBCOMMANDS = new Set(["commit", "merge", "rebase", "revert", "cherry-pick", "am"]);
const GIT_PUSH_SUBCOMMANDS = new Set(["push"]);

function commandTokens(command) {
  if (!isNonEmptyString(command)) return [];

  // Quotes are honoured so that a quoted Windows path does not split into
  // fragments and make a known executable look unrecognised.
  const tokens = [];
  let current = "";
  let quote = null;

  for (const character of command.trim()) {
    if (quote !== null) {
      if (character === quote) quote = null;
      else current += character;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (/\s/.test(character)) {
      if (current.length > 0) tokens.push(current);
      current = "";
      continue;
    }
    current += character;
  }
  if (current.length > 0) tokens.push(current);

  return tokens;
}

function executableName(rawToken) {
  const withoutPath = rawToken.replace(/^.*[\\/]/, "");
  return withoutPath.replace(/\.(exe|cmd|bat|ps1)$/i, "").toLowerCase();
}

/**
 * Classifies an invocation as read-only, mutating, or unknown.
 *
 * Unknown is deliberately distinct from mutating: the caller fails closed on
 * both, but an operator triaging a refusal needs to know whether the command
 * was recognised and rejected, or simply not recognised.
 */
export function classifyCommand(command) {
  const tokens = commandTokens(command);
  if (tokens.length === 0) {
    return { classification: "unknown", reason: "empty invocation" };
  }

  const executable = executableName(tokens[0]);
  const args = tokens.slice(1);

  if (executable === "git") {
    const subcommand = args.find((argument) => !argument.startsWith("-"));
    if (subcommand === undefined) {
      return { classification: "read_only", reason: "git with no subcommand only prints usage" };
    }
    if (GIT_COMMIT_SUBCOMMANDS.has(subcommand)) {
      return { classification: "mutating", reason: `git ${subcommand} writes git state`, git_subcommand: subcommand };
    }
    if (GIT_PUSH_SUBCOMMANDS.has(subcommand)) {
      return { classification: "mutating", reason: "git push writes a remote", git_subcommand: subcommand };
    }
    if (GIT_READ_ONLY_SUBCOMMANDS.has(subcommand)) {
      const mutatingFlag = args.find((argument) => GIT_MUTATING_FLAGS.has(argument));
      if (mutatingFlag !== undefined) {
        return {
          classification: "mutating",
          reason: `git ${subcommand} ${mutatingFlag} mutates despite a read-only subcommand`,
          git_subcommand: subcommand,
        };
      }
      return { classification: "read_only", reason: `git ${subcommand} inspects without writing`, git_subcommand: subcommand };
    }
    return { classification: "mutating", reason: `git ${subcommand} is not on the read-only subcommand list`, git_subcommand: subcommand };
  }

  if (READ_ONLY_EXECUTABLES.has(executable)) {
    // A redirection turns any reader into a writer.
    if (tokens.some((piece) => piece === ">" || piece === ">>" || piece.startsWith(">"))) {
      return { classification: "mutating", reason: `${executable} redirects output to a file` };
    }
    return { classification: "read_only", reason: `${executable} inspects without writing` };
  }

  return { classification: "unknown", reason: `${executable} is not on the read-only list` };
}

/**
 * Expands a permission ceiling into the decomposed capability model.
 *
 * v0.3 contracts wrote `sandbox: read-only`, which conflated three separate
 * capabilities. Those contracts stay valid: the legacy shorthand is read as
 * the decomposition it always meant, and any explicit decomposed field wins.
 */
export function normalizePermissionCeiling(ceiling) {
  const source = isPlainObject(ceiling) ? ceiling : {};

  const legacy = { filesystemRead: false, filesystemWrite: false, commandAllowed: false, commandMutation: false };
  if (source.sandbox === "read-only") {
    legacy.filesystemRead = true;
    legacy.commandAllowed = true;
  } else if (source.sandbox === "workspace-write") {
    legacy.filesystemRead = true;
    legacy.filesystemWrite = true;
    legacy.commandAllowed = true;
    legacy.commandMutation = true;
  }

  const filesystem = isPlainObject(source.filesystem) ? source.filesystem : {};
  const command = isPlainObject(source.command_execution) ? source.command_execution : {};
  const network = isPlainObject(source.network) ? source.network : {};
  const database = isPlainObject(source.database) ? source.database : {};

  const pick = (explicit, fallback) => (typeof explicit === "boolean" ? explicit : fallback);

  return {
    filesystem: {
      read: pick(filesystem.read, legacy.filesystemRead),
      write: pick(filesystem.write, legacy.filesystemWrite),
    },
    command_execution: {
      allowed: pick(command.allowed, legacy.commandAllowed),
      mutation: pick(command.mutation, legacy.commandMutation),
      human_approval: isNonEmptyString(command.human_approval) ? command.human_approval : "as_required",
    },
    network: {
      // Legacy wrote a string; `none` is the only value that denies.
      allowed: pick(network.allowed, source.network !== undefined && source.network !== "none"),
    },
    database: {
      read: pick(database.read, false),
      write: pick(database.write, false),
    },
    production_access: pick(source.production_access, false),
    may_commit: pick(source.may_commit, false),
    may_push: pick(source.may_push, false),
    legacy_sandbox: isNonEmptyString(source.sandbox) ? source.sandbox : null,
  };
}

function denied(reason) {
  return { allowed: false, code: "PERMISSION_BLOCKED", approval_required: false, reason };
}

function permitted(ceiling, reason) {
  return {
    allowed: true,
    code: null,
    // Approval is a gate in front of a permitted capability. It never widens
    // one: an approved read is still not a write.
    approval_required: ceiling.command_execution.human_approval === "as_required",
    reason,
  };
}

/**
 * Decides one requested operation against a permission ceiling.
 *
 * `human_approved` on the request is deliberately never consulted. A human
 * approving `Get-Content migration.sql` approves that read, not filesystem
 * writes; letting approval flip a denial would make the ceiling advisory.
 */
export function classifyPermissionRequest(request, ceiling) {
  const limits = normalizePermissionCeiling(ceiling);

  if (!isPlainObject(request) || !isNonEmptyString(request.kind)) {
    return denied("request kind is missing; an unreadable request is not an approved one");
  }

  switch (request.kind) {
    case "filesystem_read":
      return limits.filesystem.read
        ? permitted(limits, "filesystem read is within the ceiling")
        : denied("filesystem read is outside the ceiling");

    case "filesystem_write":
      return limits.filesystem.write
        ? permitted(limits, "filesystem write is within the ceiling")
        : denied("filesystem write is outside the ceiling");

    case "network":
      return limits.network.allowed
        ? permitted(limits, "network access is within the ceiling")
        : denied("network access is outside the ceiling");

    case "database_read":
      return limits.database.read ? permitted(limits, "database read is within the ceiling") : denied("database read is outside the ceiling");

    case "database_write":
      return limits.database.write ? permitted(limits, "database write is within the ceiling") : denied("database write is outside the ceiling");

    case "commit":
      return limits.may_commit ? permitted(limits, "commit is within the ceiling") : denied("commit is outside the ceiling");

    case "push":
      return limits.may_push ? permitted(limits, "push is within the ceiling") : denied("push is outside the ceiling");

    case "production":
      return limits.production_access
        ? permitted(limits, "production access is within the ceiling")
        : denied("production access is outside the ceiling");

    case "command": {
      if (!limits.command_execution.allowed) {
        return denied("command execution is outside the ceiling");
      }

      const { classification, reason, git_subcommand: gitSubcommand } = classifyCommand(request.command);

      // Commit and push are separately fenced, so a workspace-write worker
      // that may not commit is still stopped here.
      if (gitSubcommand !== undefined && GIT_COMMIT_SUBCOMMANDS.has(gitSubcommand) && !limits.may_commit) {
        return denied(`${reason}; may_commit is false`);
      }
      if (gitSubcommand !== undefined && GIT_PUSH_SUBCOMMANDS.has(gitSubcommand) && !limits.may_push) {
        return denied(`${reason}; may_push is false`);
      }

      if (classification === "read_only") {
        return permitted(limits, `${reason}; read-only command execution is within the ceiling`);
      }
      if (!limits.command_execution.mutation) {
        return denied(`${reason}; command mutation is outside the ceiling`);
      }
      return permitted(limits, `${reason}; command mutation is within the ceiling`);
    }

    default:
      return denied(`unrecognised request kind ${JSON.stringify(request.kind)}`);
  }
}

/**
 * Classifies one poll of a dispatched worker or reviewer.
 *
 * The ordering is the whole point. A process fact (exit, permission request,
 * unreachable session) outranks every clock reading, and no clock reading on
 * its own may produce a failure: total elapsed time never blocks, only
 * silence since the last observed progress does.
 */
export function classifyExecutionState(observation, options = {}) {
  const {
    stallThresholdMs = EXECUTION_DEFAULTS.stallThresholdMs,
    hardCeilingMs = EXECUTION_DEFAULTS.hardCeilingMs,
    maxContinuationAttempts = EXECUTION_DEFAULTS.maxContinuationAttempts,
    permissionCeiling = {},
  } = options;

  if (!isPlainObject(observation)) {
    // No reading is not evidence of failure, exactly as an absent resource
    // entry is not evidence of exhaustion. The hard ceiling bounds this.
    return { state: "QUIET", action: "CONTINUE", code: null, reason: "no observation available; absence of a reading is not failure" };
  }

  const elapsedMs = typeof observation.elapsed_ms === "number" ? observation.elapsed_ms : 0;
  const sinceProgressMs = typeof observation.since_progress_ms === "number" ? observation.since_progress_ms : elapsedMs;
  const continuationCount = typeof observation.continuation_count === "number" ? observation.continuation_count : 0;

  // 1. The process exited. That is a fact; timing no longer matters.
  if (isPlainObject(observation.exit)) {
    const kind = observation.exit.kind;
    if (kind === "clean") {
      return { state: "COMPLETE", action: "CLOSE", code: null, reason: "process exited with a usable result" };
    }
    if (kind === "max_turns") {
      if (continuationCount >= maxContinuationAttempts) {
        return {
          state: "MAX_TURNS_REACHED",
          action: "HUMAN_GATE",
          code: null,
          reason: `continuation budget of ${maxContinuationAttempts} is exhausted`,
        };
      }
      return {
        state: "MAX_TURNS_REACHED",
        action: "CONTINUATION",
        code: null,
        reason: "turn budget exhausted without an error result; resume the same chain",
      };
    }
    return { state: "PROCESS_EXIT_FAILURE", action: "REPAIR_OR_ESCALATE", code: null, reason: "process exited without a usable result" };
  }

  // 2. A permission request is decided against the ceiling, not the clock.
  if (isPlainObject(observation.permission_request)) {
    const decision = classifyPermissionRequest(observation.permission_request, permissionCeiling);
    if (decision.allowed) {
      return { state: "ACTIVE", action: "CONTINUE", code: null, reason: decision.reason };
    }
    return { state: "PERMISSION_BLOCKED", action: "BLOCKED", code: "PERMISSION_BLOCKED", reason: decision.reason };
  }

  // 3. The session is gone and left no exit record: the runtime is unreachable.
  if (observation.session_active === false) {
    return { state: "ROUTING_UNAVAILABLE", action: "BLOCKED", code: "ROUTING_UNAVAILABLE", reason: "session is no longer reachable and left no exit record" };
  }

  // 4. A hard ceiling is a decision point, never an automatic failure.
  if (typeof hardCeilingMs === "number" && elapsedMs >= hardCeilingMs) {
    return { state: "HARD_EXECUTION_CEILING", action: "HUMAN_GATE", code: null, reason: "hard execution ceiling reached while the session is still active" };
  }

  // 5. Observable progress resets the stall clock, however long the run is.
  if (observation.progress_observed === true) {
    return { state: "ACTIVE", action: "CONTINUE", code: null, reason: "observable progress since the last poll" };
  }

  // 6. Silence long enough to be worth inspecting - inspection, not a verdict.
  if (sinceProgressMs >= stallThresholdMs) {
    return { state: "STALLED", action: "STALL_INTERVENTION", code: null, reason: "no observable progress for the stall threshold" };
  }

  // 7. Silent but alive.
  return { state: "QUIET", action: "CONTINUE", code: null, reason: "session active with no new output yet" };
}

/* ------------------------------------------------------------------------ *
 * Execution conformance cases
 *
 * tests/execution-cases.yaml is a conformance check on the execution
 * lifecycle section of WORKFLOW_POLICY.md, which stays normative.
 * ------------------------------------------------------------------------ */

const EXECUTION_CASE_KINDS = ["waiting", "permission"];

export function validateExecutionCases(document) {
  const findings = [];

  if (!isPlainObject(document) || !Array.isArray(document.cases) || document.cases.length === 0) {
    return ["execution cases: expected a non-empty `cases` list"];
  }

  const seen = new Set();

  for (const [index, testCase] of document.cases.entries()) {
    const named = isNonEmptyString(testCase?.name) ? testCase.name : `cases[${index}]`;

    if (!isPlainObject(testCase)) {
      findings.push(`${named}: expected a mapping`);
      continue;
    }
    if (!isNonEmptyString(testCase.name)) {
      findings.push(`${named}: a case needs a name`);
      continue;
    }
    if (seen.has(testCase.name)) findings.push(`${named}: duplicate case name`);
    seen.add(testCase.name);

    // Every case states why it exists; a case nobody can read is a case
    // nobody will correct.
    if (!isNonEmptyString(testCase.why)) findings.push(`${named}: a case needs a \`why\``);

    if (!EXECUTION_CASE_KINDS.includes(testCase.kind)) {
      findings.push(`${named}: kind ${JSON.stringify(testCase.kind)} is not one of ${EXECUTION_CASE_KINDS.join("|")}`);
      continue;
    }

    if (!isPlainObject(testCase.expect)) {
      findings.push(`${named}: expected an \`expect\` mapping`);
      continue;
    }

    if (testCase.kind === "waiting") {
      const options = isPlainObject(testCase.options) ? testCase.options : {};
      const result = classifyExecutionState(testCase.observation, {
        stallThresholdMs: options.stall_threshold_ms,
        hardCeilingMs: options.hard_ceiling_ms ?? null,
        maxContinuationAttempts: options.max_continuation_attempts,
        permissionCeiling: testCase.ceiling,
      });

      if (!EXECUTION_STATES.includes(result.state)) {
        findings.push(`${named}: produced unknown state ${JSON.stringify(result.state)}`);
      }
      if (!EXECUTION_ACTIONS.includes(result.action)) {
        findings.push(`${named}: produced unknown action ${JSON.stringify(result.action)}`);
      }
      if (testCase.expect.state !== result.state) {
        findings.push(`${named}: expected state ${JSON.stringify(testCase.expect.state)}, got ${JSON.stringify(result.state)}`);
      }
      if (testCase.expect.action !== result.action) {
        findings.push(`${named}: expected action ${JSON.stringify(testCase.expect.action)}, got ${JSON.stringify(result.action)}`);
      }
      for (const forbidden of testCase.must_not ?? []) {
        if (result.state === forbidden || result.code === forbidden) {
          findings.push(`${named}: must not classify as ${forbidden}`);
        }
      }
      if (isPlainObject(testCase.observation) && testCase.observation.exit !== undefined && testCase.observation.exit !== null) {
        if (!PROCESS_EXIT_KINDS.includes(testCase.observation.exit?.kind)) {
          findings.push(`${named}: exit.kind ${JSON.stringify(testCase.observation.exit?.kind)} is not one of ${PROCESS_EXIT_KINDS.join("|")}`);
        }
      }
      continue;
    }

    const decision = classifyPermissionRequest(testCase.request, testCase.ceiling);
    if (testCase.expect.allowed !== decision.allowed) {
      findings.push(`${named}: expected allowed ${JSON.stringify(testCase.expect.allowed)}, got ${JSON.stringify(decision.allowed)}`);
    }
    if (testCase.expect.code !== undefined && testCase.expect.code !== decision.code) {
      findings.push(`${named}: expected code ${JSON.stringify(testCase.expect.code)}, got ${JSON.stringify(decision.code)}`);
    }
    if (testCase.expect.approval_required !== undefined && testCase.expect.approval_required !== decision.approval_required) {
      findings.push(
        `${named}: expected approval_required ${JSON.stringify(testCase.expect.approval_required)}, got ${JSON.stringify(decision.approval_required)}`,
      );
    }
    if (testCase.expect.classification !== undefined) {
      const { classification } = classifyCommand(testCase.request?.command);
      if (testCase.expect.classification !== classification) {
        findings.push(`${named}: expected classification ${JSON.stringify(testCase.expect.classification)}, got ${JSON.stringify(classification)}`);
      }
    }
  }

  return findings;
}

/* ------------------------------------------------------------------------ *
 * Continuation freshness
 *
 * A continuation is valid only against the same still-current human intent
 * and permission scope. WORKFLOW_POLICY.md owns this invariant; this section
 * only makes it executable. It never inspects raw prompt text - it operates
 * on the same structured, already-normalized fields the execution contract
 * already carries, so nothing here needs a transcript to work.
 * ------------------------------------------------------------------------ */

// Precedence, highest first. A lower layer's value is used only where every
// higher layer leaves the field unset - it can supply a default, never
// override an explicit one.
const INTENT_PRECEDENCE = [
  "human_instruction",
  "authoritative_handoff",
  "active_strategic_contract",
  "prior_next_gate",
  "cached_router_context",
  "worker_local_state",
];

const CONTINUATION_FACT_FIELDS = [
  "objective",
  "allowed_changes",
  "prohibited_changes",
  "expected_output",
  "baseline",
  "permission_ceiling",
  "human_gate",
];

const PERMISSION_CAPABILITY_KEYS = [
  "filesystem",
  "command_execution",
  "network",
  "database",
  "production_access",
  "may_commit",
  "may_push",
];

const CONTINUATION_OUTCOMES = [
  "CONTINUATION_ALLOWED",
  "CONTINUATION_REJECTED_STALE",
  "LEGACY_CONTINUATION_REQUIRES_FRESH_CONTRACT",
];

const SESSION_LIFECYCLE_STATES = ["ACTIVE", "PARKED", "SUPERSEDED", "STALE", "FAILED", "CLOSED"];
const CLEANUP_ACTIONS = ["KEEP", "PARK", "CLOSE"];
const CLEANUP_INPUT_STATUSES = ["ACTIVE", "PASS", "FAIL", "BLOCKED", "HUMAN_GATE", "STALE", "SUPERSEDED"];

/**
 * Deterministic canonical form: object keys sorted, array order preserved.
 * Two facts compare equal exactly when this string is equal, which is also
 * what feeds the fingerprint hash below.
 */
function canonicalize(value) {
  return JSON.stringify(sortForCanonicalization(value ?? null));
}

function sortForCanonicalization(value) {
  if (Array.isArray(value)) return value.map(sortForCanonicalization);
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortForCanonicalization(value[key])]),
    );
  }
  return value;
}

/**
 * A low-cost, deterministic revision marker over structured fields - never
 * over a transcript. Recomputing it from the same facts always yields the
 * same value; recomputing it from a superset of unrelated fields (a stray
 * raw-prompt field, say) yields the SAME value too, because only the named
 * fields ever enter the canonical form. That is what keeps PII out of it by
 * construction rather than by discipline.
 */
export function canonicalFingerprint(value) {
  return createHash("sha256").update(canonicalize(value)).digest("hex");
}

/**
 * Picks only the execution-relevant fields a continuation is bound to. Any
 * other field on the input (a raw instruction string, a transcript, an
 * account identifier) is invisible to every fingerprint and every diff below.
 */
export function canonicalContinuationFacts(materials) {
  const source = isPlainObject(materials) ? materials : {};
  const facts = {};
  for (const field of CONTINUATION_FACT_FIELDS) {
    if (field !== "permission_ceiling") {
      facts[field] = source[field] ?? null;
      continue;
    }

    // `legacy_sandbox` is provenance (how the ceiling was originally spelled),
    // not scope: `{sandbox: "workspace-write"}` and its fully decomposed
    // equivalent are the SAME permission scope per WORKFLOW_POLICY's
    // backward-compatible reading, so it must never register as a
    // continuation-freshness change. Dropping it also makes this function
    // idempotent - re-running it on its own output (as resolveCurrentIntent's
    // result later is, once by the caller and once inside diffContinuationScope)
    // reproduces the same fingerprint instead of losing the original `sandbox`
    // key the second time around.
    const { legacy_sandbox, ...scope } = normalizePermissionCeiling(source[field]);
    facts[field] = scope;
  }
  return facts;
}

export function objectiveFingerprint(materials) {
  const { permission_ceiling, human_gate, ...rest } = canonicalContinuationFacts(materials);
  return canonicalFingerprint(rest);
}

export function permissionScopeFingerprint(materials) {
  const { permission_ceiling } = canonicalContinuationFacts(materials);
  return canonicalFingerprint({ permission_ceiling });
}

export function humanInstructionRevision(materials) {
  return canonicalFingerprint(canonicalContinuationFacts(materials));
}

/**
 * Merges layered sources of intent under the fixed precedence. Returns both
 * the resolved facts and which layer each field actually came from, so a
 * conflict between a higher and lower layer is auditable rather than
 * silently resolved.
 *
 * This is the executable form of "latest explicit human instruction MUST NOT
 * be overridden by a stale NEXT_GATE or cached continuation state": a lower
 * layer's value is used only where every higher layer left the field unset.
 */
export function resolveCurrentIntent(layers) {
  const source = isPlainObject(layers) ? layers : {};
  const resolved = {};
  const sourceOf = {};

  for (const field of CONTINUATION_FACT_FIELDS) {
    for (const layer of INTENT_PRECEDENCE) {
      const layerFacts = source[layer];
      if (!isPlainObject(layerFacts) || !(field in layerFacts) || layerFacts[field] === undefined) continue;
      resolved[field] = layerFacts[field];
      sourceOf[field] = layer;
      break;
    }
  }

  // An explicit stop is a human-instruction-layer fact like any other and
  // follows the same precedence: only the human_instruction layer may set it.
  const explicitStop = source.human_instruction?.explicit_stop === true;

  return { resolved: canonicalContinuationFacts(resolved), sourceOf, explicit_stop: explicitStop };
}

/**
 * Names every execution-relevant field that differs between a continuation's
 * bound facts and the currently resolved intent. Permission capabilities are
 * broken out individually so a rejection can say exactly which one moved
 * (network, production access, ...) rather than only "permissions changed".
 */
export function diffContinuationScope(boundMaterials, currentMaterials) {
  const bound = canonicalContinuationFacts(boundMaterials);
  const current = canonicalContinuationFacts(currentMaterials);
  const changed = [];

  for (const field of CONTINUATION_FACT_FIELDS) {
    if (field === "permission_ceiling") continue;
    if (canonicalize(bound[field]) !== canonicalize(current[field])) changed.push(field);
  }

  for (const key of PERMISSION_CAPABILITY_KEYS) {
    if (canonicalize(bound.permission_ceiling[key]) !== canonicalize(current.permission_ceiling[key])) {
      changed.push(`permission_ceiling.${key}`);
    }
  }

  return changed;
}

/**
 * Coarse fallback when the bound continuation's structured facts are not at
 * hand and only its fingerprints are - the shape a compact session-binding
 * record actually persists. Less informative than a field-level diff, but
 * still correct: a fingerprint mismatch is real evidence of drift even when
 * it cannot say which field moved.
 */
function coarseFingerprintDiff(bound, current) {
  const changed = [];
  if (bound.human_instruction_revision !== humanInstructionRevision(current)) changed.push("human_instruction_revision");
  if (isNonEmptyString(bound.objective_fingerprint) && bound.objective_fingerprint !== objectiveFingerprint(current)) {
    changed.push("objective_fingerprint");
  }
  if (isNonEmptyString(bound.permission_scope_fingerprint) && bound.permission_scope_fingerprint !== permissionScopeFingerprint(current)) {
    changed.push("permission_scope_fingerprint");
  }
  return changed;
}

/**
 * The continuation eligibility check. Everything upstream (dispatch,
 * bounded-continuation, stall intervention, reviewer continuation,
 * parked-terminal reuse) must call this before resuming anything; it never
 * resumes on its own.
 *
 * `bound.facts` - the bound continuation's own canonical facts - gives a
 * field-level diagnosis and is what the operational router actually has on
 * hand: the prior contract document, already on disk. It is never what gets
 * persisted into a compact session-binding record or terminal-inventory
 * entry; those carry only the fingerprints computed from it. When only the
 * fingerprints are available, `coarseFingerprintDiff` is used instead.
 *
 * A binding with no fingerprint at all predates this invariant and fails
 * closed rather than being assumed current - see WORKFLOW_POLICY.md's
 * backward-compatibility rule for continuation.
 */
export function evaluateContinuation(context) {
  const { bound, layers, legacy_binding: legacyBinding = false } = isPlainObject(context) ? context : {};

  if (legacyBinding || !isPlainObject(bound) || !isNonEmptyString(bound.human_instruction_revision)) {
    return {
      outcome: "LEGACY_CONTINUATION_REQUIRES_FRESH_CONTRACT",
      changed: [],
      reason: "the prior binding carries no continuation-freshness metadata and cannot be assumed current",
    };
  }

  const { resolved: current, explicit_stop: explicitStop } = resolveCurrentIntent(layers);

  if (explicitStop) {
    return {
      outcome: "CONTINUATION_REJECTED_STALE",
      changed: ["explicit_stop"],
      reason: "the human instruction layer explicitly ended the prior task",
    };
  }

  const changed = isPlainObject(bound.facts) ? diffContinuationScope(bound.facts, current) : coarseFingerprintDiff(bound, current);

  if (changed.length > 0) {
    return {
      outcome: "CONTINUATION_REJECTED_STALE",
      changed,
      reason: `execution-relevant scope changed: ${changed.join(", ")}`,
    };
  }

  return { outcome: "CONTINUATION_ALLOWED", changed: [], reason: "bound scope matches the currently resolved intent" };
}

/**
 * Cleanup and lifecycle-state decision for one session, applied after a
 * handback outcome (or a continuation-eligibility outcome fed in as STALE /
 * SUPERSEDED). This never touches git or worktree state and never
 * contributes to failed_repair_count - it only classifies what should
 * happen to the terminal that carried the work.
 */
export function classifySessionCleanup(input) {
  const {
    handback_status: handbackStatus,
    evidence_captured: evidenceCaptured = false,
    explicit_retry_valid: explicitRetryValid = false,
    likely_same_task_continuation: likelySameTaskContinuation = false,
    sensitive_context: sensitiveContext = false,
    resource_cost_acceptable: resourceCostAcceptable = true,
  } = isPlainObject(input) ? input : {};

  if (!CLEANUP_INPUT_STATUSES.includes(handbackStatus)) {
    return { lifecycle_state: "ACTIVE", cleanup_action: "KEEP", reason: "unrecognised handback status; default to keeping the session live" };
  }

  switch (handbackStatus) {
    case "ACTIVE":
      // Never closed on elapsed time alone - see Execution lifecycle semantics.
      return { lifecycle_state: "ACTIVE", cleanup_action: "KEEP", reason: "task is still executing" };

    case "PASS":
      return evidenceCaptured
        ? { lifecycle_state: "CLOSED", cleanup_action: "CLOSE", reason: "evidence captured and strategic return produced" }
        : { lifecycle_state: "ACTIVE", cleanup_action: "KEEP", reason: "PASS handback is pending evidence capture" };

    case "FAIL":
    case "BLOCKED":
      if (!evidenceCaptured) {
        return { lifecycle_state: handbackStatus === "FAIL" ? "FAILED" : "ACTIVE", cleanup_action: "KEEP", reason: "evidence not yet captured" };
      }
      return explicitRetryValid
        ? { lifecycle_state: "ACTIVE", cleanup_action: "KEEP", reason: "an explicit retry remains valid" }
        : { lifecycle_state: "CLOSED", cleanup_action: "CLOSE", reason: "evidence captured; no valid retry remains" };

    case "HUMAN_GATE":
      return likelySameTaskContinuation && !sensitiveContext && resourceCostAcceptable
        ? { lifecycle_state: "PARKED", cleanup_action: "PARK", reason: "likely exact-task continuation, no sensitive context, acceptable resource cost" }
        : { lifecycle_state: "CLOSED", cleanup_action: "CLOSE", reason: "contract likely to change, sensitive context present, or terminal accumulation pressure" };

    case "STALE":
      return {
        lifecycle_state: "STALE",
        cleanup_action: evidenceCaptured ? "CLOSE" : "KEEP",
        reason: "continuation fingerprint/revision mismatch",
      };

    case "SUPERSEDED":
      return {
        lifecycle_state: "SUPERSEDED",
        cleanup_action: evidenceCaptured ? "CLOSE" : "KEEP",
        reason: "a newer human instruction replaced this task",
      };

    default:
      return { lifecycle_state: "ACTIVE", cleanup_action: "KEEP", reason: "unhandled status" };
  }
}

/**
 * Inventory-time check only: does this terminal even carry enough binding
 * metadata to be considered for resume at all. An unknown or unbound
 * terminal is never resumable, regardless of what its title suggests - task
 * ownership is never inferred from a title.
 */
export function terminalIsResumable(entry) {
  if (!isPlainObject(entry)) return false;

  const requiredBindings = ["task_id", "human_instruction_revision", "objective_fingerprint", "permission_scope_fingerprint"];
  if (!requiredBindings.every((field) => isNonEmptyString(entry[field]))) return false;

  return entry.lifecycle_state === "ACTIVE" || entry.lifecycle_state === "PARKED";
}

/**
 * The actual gate a resume attempt must pass. Being PARKED never substitutes
 * for a fresh continuation-eligibility check - PARKED only means the
 * terminal was retained; it says nothing about whether the current human
 * intent still matches what it was retained for.
 */
export function attemptResume(entry, evaluation) {
  if (!terminalIsResumable(entry)) {
    return { allowed: false, reason: "terminal is unknown, unbound, or in a non-resumable lifecycle state" };
  }
  if (!isPlainObject(evaluation) || evaluation.outcome !== "CONTINUATION_ALLOWED") {
    return { allowed: false, reason: evaluation?.reason ?? "continuation eligibility was not confirmed" };
  }
  return { allowed: true, reason: "continuation freshness confirmed" };
}

/* ------------------------------------------------------------------------ *
 * Continuation / cleanup conformance cases
 *
 * tests/continuation-cases.yaml is a conformance check on the continuation
 * freshness and session lifecycle sections of WORKFLOW_POLICY.md, which
 * stays normative.
 * ------------------------------------------------------------------------ */

const CONTINUATION_CASE_KINDS = ["continuation", "cleanup", "resume", "precedence"];

export function validateContinuationCases(document) {
  const findings = [];

  if (!isPlainObject(document) || !Array.isArray(document.cases) || document.cases.length === 0) {
    return ["continuation cases: expected a non-empty `cases` list"];
  }

  const seen = new Set();

  for (const [index, testCase] of document.cases.entries()) {
    const named = isNonEmptyString(testCase?.name) ? testCase.name : `cases[${index}]`;

    if (!isPlainObject(testCase)) {
      findings.push(`${named}: expected a mapping`);
      continue;
    }
    if (!isNonEmptyString(testCase.name)) {
      findings.push(`${named}: a case needs a name`);
      continue;
    }
    if (seen.has(testCase.name)) findings.push(`${named}: duplicate case name`);
    seen.add(testCase.name);

    if (!isNonEmptyString(testCase.why)) findings.push(`${named}: a case needs a \`why\``);

    if (!CONTINUATION_CASE_KINDS.includes(testCase.kind)) {
      findings.push(`${named}: kind ${JSON.stringify(testCase.kind)} is not one of ${CONTINUATION_CASE_KINDS.join("|")}`);
      continue;
    }

    if (!isPlainObject(testCase.expect)) {
      findings.push(`${named}: expected an \`expect\` mapping`);
      continue;
    }

    if (testCase.kind === "continuation") {
      const result = evaluateContinuation({ bound: testCase.bound, layers: testCase.layers, legacy_binding: testCase.legacy_binding });

      if (!CONTINUATION_OUTCOMES.includes(result.outcome)) {
        findings.push(`${named}: produced unknown outcome ${JSON.stringify(result.outcome)}`);
      }
      if (testCase.expect.outcome !== result.outcome) {
        findings.push(`${named}: expected outcome ${JSON.stringify(testCase.expect.outcome)}, got ${JSON.stringify(result.outcome)}`);
      }
      for (const requiredChange of testCase.expect.changed_includes ?? []) {
        if (!result.changed.includes(requiredChange)) {
          findings.push(`${named}: expected changed to include ${JSON.stringify(requiredChange)}, got ${JSON.stringify(result.changed)}`);
        }
      }
      if (testCase.expect.changed_is_empty === true && result.changed.length !== 0) {
        findings.push(`${named}: expected no changed fields, got ${JSON.stringify(result.changed)}`);
      }
      continue;
    }

    if (testCase.kind === "cleanup") {
      const result = classifySessionCleanup(testCase.input);

      if (!SESSION_LIFECYCLE_STATES.includes(result.lifecycle_state)) {
        findings.push(`${named}: produced unknown lifecycle_state ${JSON.stringify(result.lifecycle_state)}`);
      }
      if (!CLEANUP_ACTIONS.includes(result.cleanup_action)) {
        findings.push(`${named}: produced unknown cleanup_action ${JSON.stringify(result.cleanup_action)}`);
      }
      if (testCase.expect.lifecycle_state !== result.lifecycle_state) {
        findings.push(`${named}: expected lifecycle_state ${JSON.stringify(testCase.expect.lifecycle_state)}, got ${JSON.stringify(result.lifecycle_state)}`);
      }
      if (testCase.expect.cleanup_action !== result.cleanup_action) {
        findings.push(`${named}: expected cleanup_action ${JSON.stringify(testCase.expect.cleanup_action)}, got ${JSON.stringify(result.cleanup_action)}`);
      }
      continue;
    }

    if (testCase.kind === "precedence") {
      const { resolved, sourceOf } = resolveCurrentIntent(testCase.layers);

      for (const [field, expectedSource] of Object.entries(testCase.expect.source_of ?? {})) {
        if (sourceOf[field] !== expectedSource) {
          findings.push(`${named}: expected ${field} to resolve from ${JSON.stringify(expectedSource)}, got ${JSON.stringify(sourceOf[field])}`);
        }
      }
      for (const [field, expectedValue] of Object.entries(testCase.expect.resolved ?? {})) {
        if (JSON.stringify(resolved[field]) !== JSON.stringify(expectedValue)) {
          findings.push(`${named}: expected resolved.${field} to be ${JSON.stringify(expectedValue)}, got ${JSON.stringify(resolved[field])}`);
        }
      }
      continue;
    }

    // resume
    const resumable = terminalIsResumable(testCase.entry);
    if ("resumable" in testCase.expect && testCase.expect.resumable !== resumable) {
      findings.push(`${named}: expected resumable ${JSON.stringify(testCase.expect.resumable)}, got ${JSON.stringify(resumable)}`);
    }
    const decision = attemptResume(testCase.entry, testCase.evaluation);
    if (testCase.expect.allowed !== decision.allowed) {
      findings.push(`${named}: expected allowed ${JSON.stringify(testCase.expect.allowed)}, got ${JSON.stringify(decision.allowed)}`);
    }
  }

  return findings;
}

/* ------------------------------------------------------------------------ *
 * Repository validation (direct-run entry point)
 * ------------------------------------------------------------------------ */

const BINARY_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".ico", ".webp", ".bmp", ".pdf",
  ".zip", ".gz", ".tar", ".7z", ".woff", ".woff2", ".ttf", ".otf",
  ".eot", ".mp4", ".mp3", ".wav", ".exe", ".dll", ".node",
]);

// Files whose intentional invalidity would otherwise be reported. Kept
// explicit and minimal so nothing is silently exempted from the scan.
const SCAN_EXEMPT_PATHS = new Set([]);

// The broken-link fixture exists precisely to be broken.
const LINK_CHECK_EXEMPT_PATHS = new Set(["tests/fixtures/broken-links.md"]);

function publishableFiles(root) {
  // tracked plus untracked-but-not-ignored is exactly what a publish would
  // carry. Ignored files and .git are therefore never scanned.
  const output = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });

  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .filter((file) => !file.startsWith("node_modules/"))
    .filter((file) => !BINARY_EXTENSIONS.has(extname(file).toLowerCase()));
}

/**
 * Reads and parses a required input. A missing or unparseable input is a
 * CONFIG_INVALID finding, never a crash: the validator must be able to report
 * on a repository that is broken in exactly that way.
 */
function readInput(root, relativePath, parseAs, findings) {
  try {
    const text = readFileSync(join(root, relativePath), "utf8");
    return parseAs === "json" ? JSON.parse(text) : parseYaml(text);
  } catch (error) {
    findings.push(`${relativePath}: CONFIG_INVALID - could not read or parse (${error.code ?? "parse error"})`);
    return undefined;
  }
}

export function validateRepository(root = process.cwd()) {
  const findings = [];
  const summary = { registry: 0, resourceExample: 0, routingCases: 0, executionCases: 0, continuationCases: 0, filesScanned: 0, scanFindings: 0, markdownFilesLinkChecked: 0 };

  const registry = readInput(root, "policies/MODEL_REGISTRY.yaml", "yaml", findings);
  if (registry !== undefined) {
    for (const finding of validateRegistry(registry)) {
      findings.push(`policies/MODEL_REGISTRY.yaml: ${finding}`);
    }
    summary.registry = Object.keys(registry?.capability_slots ?? {}).length;
  }

  const example = readInput(root, "runtime/RESOURCE_STATE.example.json", "json", findings);
  if (example !== undefined) {
    // The example-only null affordance is granted here and nowhere else.
    for (const finding of validateResourceState(example, { allowExampleNulls: true })) {
      findings.push(`runtime/RESOURCE_STATE.example.json: ${finding}`);
    }
    summary.resourceExample = 1;
  }

  const cases = readInput(root, "tests/routing-cases.yaml", "yaml", findings);
  if (cases !== undefined && registry !== undefined) {
    for (const finding of validateRoutingCases(cases, registry)) {
      findings.push(`tests/routing-cases.yaml: ${finding}`);
    }
    summary.routingCases = Array.isArray(cases?.cases) ? cases.cases.length : 0;
  }

  const executionCases = readInput(root, "tests/execution-cases.yaml", "yaml", findings);
  if (executionCases !== undefined) {
    for (const finding of validateExecutionCases(executionCases)) {
      findings.push(`tests/execution-cases.yaml: ${finding}`);
    }
    summary.executionCases = Array.isArray(executionCases?.cases) ? executionCases.cases.length : 0;
  }

  const continuationCases = readInput(root, "tests/continuation-cases.yaml", "yaml", findings);
  if (continuationCases !== undefined) {
    for (const finding of validateContinuationCases(continuationCases)) {
      findings.push(`tests/continuation-cases.yaml: ${finding}`);
    }
    summary.continuationCases = Array.isArray(continuationCases?.cases) ? continuationCases.cases.length : 0;
  }

  const invalidFixturePath = join(root, "tests", "fixtures", "invalid-model-registry.yaml");
  if (existsSync(invalidFixturePath)) {
    const fixture = parseYaml(readFileSync(invalidFixturePath, "utf8"));
    const fixtureFindings = validateRegistry(fixture).join("\n");
    if (!/below minimum tier/.test(fixtureFindings)) {
      findings.push("tests/fixtures/invalid-model-registry.yaml: expected a 'below minimum tier' rejection");
    }
  }

  for (const file of publishableFiles(root)) {
    if (SCAN_EXEMPT_PATHS.has(file)) continue;

    let text;
    try {
      text = readFileSync(join(root, file), "utf8");
    } catch {
      continue;
    }

    if (text.includes("\0")) continue;
    summary.filesScanned += 1;

    // Historical or deliberately prohibited command examples are marked with a
    // leading PROHIBITED: so they can be documented without being flagged.
    const scannable = text
      .split(/\r?\n/)
      .map((line) => (line.trimStart().startsWith("PROHIBITED:") ? "" : line))
      .join("\n");

    for (const finding of scanText(scannable, { path: file })) {
      // Location metadata only. The matched text is never printed.
      findings.push(`${finding.path}:${finding.line}:${finding.column}: ${finding.pattern}`);
      summary.scanFindings += 1;
    }

    if (extname(file).toLowerCase() === ".md" && !LINK_CHECK_EXEMPT_PATHS.has(file)) {
      summary.markdownFilesLinkChecked += 1;
      for (const finding of validateMarkdownLinks(text, { path: file, root })) {
        findings.push(finding);
      }
    }
  }

  return { findings, summary };
}

/**
 * Scans every blob reachable from any revision, not just HEAD.
 *
 * A later commit that deletes a secret does not remove it from history, so a
 * clean working tree proves nothing before a first public push. Blobs are
 * deduplicated by object id, so an unchanged file is scanned once rather than
 * once per revision. Findings carry revision, path, line and pattern only -
 * the matched text is never returned.
 */
export function validateHistory(root = process.cwd()) {
  const findings = [];
  const git = (args) =>
    execFileSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });

  let revisions;
  try {
    revisions = git(["rev-list", "--all"]).split(/\r?\n/).filter((line) => line.length > 0);
  } catch {
    return ["history: could not enumerate reachable revisions"];
  }

  const seenBlobs = new Set();

  for (const revision of revisions) {
    let listing;
    try {
      listing = git(["ls-tree", "-r", revision]);
    } catch {
      findings.push(`history: could not list revision ${revision.slice(0, 9)}`);
      continue;
    }

    for (const line of listing.split(/\r?\n/)) {
      if (line.length === 0) continue;

      const [meta, path] = line.split("\t");
      if (path === undefined) continue;

      const [, type, objectId] = meta.split(/\s+/);
      if (type !== "blob" || seenBlobs.has(objectId)) continue;
      seenBlobs.add(objectId);

      if (path.startsWith("node_modules/")) continue;
      if (BINARY_EXTENSIONS.has(extname(path).toLowerCase())) continue;

      let content;
      try {
        content = git(["cat-file", "blob", objectId]);
      } catch {
        continue;
      }
      if (content.includes("\0")) continue;

      const scannable = content
        .split(/\r?\n/)
        .map((entry) => (entry.trimStart().startsWith("PROHIBITED:") ? "" : entry))
        .join("\n");

      for (const finding of scanText(scannable, { path })) {
        findings.push(
          `${revision.slice(0, 9)}:${finding.path}:${finding.line}:${finding.column}: ${finding.pattern}`,
        );
      }
    }
  }

  return findings;
}

/**
 * Checks that repository-relative Markdown links resolve to real files.
 * External URLs, bare anchors and mail links are out of scope.
 */
export function validateMarkdownLinks(text, options = {}) {
  const { path = "", root = process.cwd() } = options;
  const findings = [];

  if (typeof text !== "string") return findings;

  text.split(/\r?\n/).forEach((line, index) => {
    for (const match of line.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
      const target = match[1].trim();

      // Skip absolute schemes (https:, mailto:, ...) and pure anchors.
      if (target === "" || target.startsWith("#") || /^[a-z][a-z0-9+.-]*:/i.test(target)) continue;

      const [filePart] = target.split("#");
      if (filePart === "") continue;

      if (!existsSync(resolve(root, dirname(path), filePart))) {
        findings.push(`${path}:${index + 1}: broken link to ${filePart}`);
      }
    }
  });

  return findings;
}

if (process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const { findings, summary } = validateRepository(process.cwd());

  console.log(
    `slots: ${summary.registry} | resource examples: ${summary.resourceExample} | ` +
      `routing cases: ${summary.routingCases} | execution cases: ${summary.executionCases} | ` +
      `continuation cases: ${summary.continuationCases} | ` +
      `files scanned: ${summary.filesScanned} | ` +
      `markdown link-checked: ${summary.markdownFilesLinkChecked}`,
  );

  // Required before a first public push: a clean HEAD proves nothing about
  // what earlier revisions still carry.
  if (process.argv.includes("--history")) {
    const historyFindings = validateHistory(process.cwd());
    console.log(`history: all reachable revisions scanned, ${historyFindings.length} finding(s)`);
    findings.push(...historyFindings);
  }

  if (findings.length > 0) {
    console.error(`\n${findings.length} finding(s):`);
    for (const finding of findings) console.error(`  - ${finding}`);
    process.exit(1);
  }

  console.log("Policy pack validation passed");
}
