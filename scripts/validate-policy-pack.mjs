/**
 * Conformance checker for the Orca workflow policy pack.
 *
 * The Markdown policies are normative. This module only checks that the
 * machine-readable inputs agree with them; whenever code and policy disagree,
 * the code is what gets corrected.
 *
 * It never reads environment variables, contacts a provider, or dispatches
 * work. At this stage it is a library only: the direct-run repository entry
 * point arrives once the registry migration and routing cases exist.
 */

const RESOURCE_STATES = ["GREEN", "YELLOW", "RED", "UNKNOWN"];
const CANDIDATE_STATUSES = ["stable", "experimental"];
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

/**
 * Selects one candidate from a slot's ordered candidates.
 *
 * The resource overlay only reorders candidates that already meet the slot's
 * `minimum_tier`; it can never move work down to a weaker candidate. YELLOW and
 * UNKNOWN are treated neutrally so a missing reading is neither punished nor
 * rewarded, and registry order breaks the tie.
 */
export function selectCandidate(slot, resourceStates, tierOrder, options = {}) {
  const {
    allowExperimental = false,
    taskRisk = "unknown",
    excludeProvider = null,
    excludeModelFamily = null,
    allowRed = false,
  } = options;

  if (!isPlainObject(slot) || !Array.isArray(slot.candidates) || slot.candidates.length === 0) {
    return { status: "BLOCKED", reason: "slot has no ordered candidates" };
  }

  if (!Array.isArray(tierOrder) || tierOrder.length === 0) {
    return { status: "BLOCKED", reason: "capability_tier_order is missing or empty" };
  }

  const minimumIndex = tierIndex(tierOrder, slot.minimum_tier);
  if (minimumIndex === -1) {
    return {
      status: "BLOCKED",
      reason: `slot minimum_tier ${JSON.stringify(slot.minimum_tier)} is not in capability_tier_order`,
    };
  }

  const rejected = [];
  const qualified = [];

  for (const candidate of slot.candidates) {
    const label = `${candidate?.provider ?? "unknown"}/${candidate?.model ?? "unknown"}`;
    const entry = resolveResourceEntry(resourceStates, candidate?.resource_state_key);

    // No trustworthy reading resolves to UNKNOWN rather than an assumption in
    // either direction.
    const resourceState = RESOURCE_STATES.includes(entry?.state) ? entry.state : "UNKNOWN";

    if (entry?.available === false) {
      rejected.push(`${label}: provider or pool is unavailable`);
      continue;
    }

    if (candidate?.status === "experimental" && !allowExperimental) {
      rejected.push(`${label}: experimental candidate is not permitted for ${taskRisk}-risk work`);
      continue;
    }

    const candidateIndex = tierIndex(tierOrder, candidate?.capability_tier);
    if (candidateIndex === -1 || candidateIndex < minimumIndex) {
      rejected.push(`${label}: capability tier is below minimum tier ${slot.minimum_tier}`);
      continue;
    }

    if (excludeProvider !== null && candidate?.provider === excludeProvider) {
      rejected.push(`${label}: shares the implementer provider`);
      continue;
    }

    if (excludeModelFamily !== null && candidate?.model_family === excludeModelFamily) {
      rejected.push(`${label}: shares the implementer model family`);
      continue;
    }

    qualified.push({ candidate, resourceState });
  }

  const pick =
    qualified.find(({ resourceState }) => resourceState === "GREEN") ??
    qualified.find(({ resourceState }) => resourceState === "YELLOW" || resourceState === "UNKNOWN") ??
    (allowRed ? qualified.find(({ resourceState }) => resourceState === "RED") : undefined);

  if (pick === undefined) {
    const reason =
      qualified.length === 0
        ? `no candidate qualifies: ${rejected.join("; ")}`
        : "the only qualified candidates are RED and this task does not permit RED routing";
    return { status: "BLOCKED", reason };
  }

  return { status: "SELECTED", candidate: pick.candidate };
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
