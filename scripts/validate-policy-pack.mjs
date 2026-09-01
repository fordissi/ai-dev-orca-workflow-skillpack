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
import { existsSync, readFileSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parse as parseYaml } from "yaml";

const RESOURCE_STATES = ["GREEN", "YELLOW", "RED", "UNKNOWN"];

// A snapshot's authority is inherited from its source; the snapshot itself is
// only an overlay/cache. Trust levels live in RESOURCE_AWARE_ROUTING.md.
const RESOURCE_SOURCES = ["ORCA_RUNTIME", "USER_STATEMENT", "UNKNOWN"];
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

    if (!RESOURCE_SOURCES.includes(entry.source)) {
      findings.push(`${at}.source: expected one of ${RESOURCE_SOURCES.join("|")}`);
    } else if (entry.source === "UNKNOWN" && entry.state !== "UNKNOWN") {
      // No trustworthy source cannot produce a confident state. That is a guess.
      findings.push(`${at}: source UNKNOWN cannot carry state ${JSON.stringify(entry.state)}`);
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

    // No trustworthy reading resolves to UNKNOWN rather than an assumption in
    // either direction.
    const resourceState = RESOURCE_STATES.includes(entry?.state) ? entry.state : "UNKNOWN";

    // Every condition is evaluated, not short-circuited, so a candidate whose
    // ONLY problem is availability can be told apart from one that policy
    // would reject anyway. That distinction decides the blocked reason code.
    const failures = [];

    if (entry?.available === false) {
      failures.push({ kind: "unavailable", why: `${label}: provider or pool is unavailable` });
    }

    if (candidate?.status === "experimental" && !allowExperimental) {
      failures.push({
        kind: "policy",
        why: `${label}: experimental candidate is not permitted for ${taskRisk}-risk work`,
      });
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
      qualified.push({ candidate, resourceState });
      continue;
    }

    rejected.push({
      label,
      failures,
      // True when waiting for the provider to come back would be enough.
      onlyUnavailable: failures.every(({ kind }) => kind === "unavailable"),
    });
  }

  const pick =
    qualified.find(({ resourceState }) => resourceState === "GREEN") ??
    qualified.find(({ resourceState }) => resourceState === "YELLOW" || resourceState === "UNKNOWN") ??
    (allowRed ? qualified.find(({ resourceState }) => resourceState === "RED") : undefined);

  if (pick !== undefined) {
    return { status: "SELECTED", candidate: pick.candidate };
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

  // If some candidate would qualify once its provider is available again, this
  // is an availability problem. Otherwise policy is what stands in the way, and
  // a human has to decide - not the router.
  const code = rejected.some(({ onlyUnavailable }) => onlyUnavailable) ? "ROUTING_UNAVAILABLE" : "POLICY_BLOCKED";

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

const CASE_KINDS = ["selection", "multi_stage"];

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
      const slot = slots[testCase.slot];
      if (slot === undefined) {
        findings.push(`${named}: slot ${JSON.stringify(testCase.slot)} is not defined in the registry`);
        continue;
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

      const disjoint = testCase.expect.disjoint_from;
      if (isPlainObject(disjoint)) {
        if (result.candidate.provider === disjoint.provider) {
          findings.push(`${named}: reviewer shares the implementer provider ${disjoint.provider}`);
        }
        if (result.candidate.model_family === disjoint.model_family) {
          findings.push(`${named}: reviewer shares the implementer model family ${disjoint.model_family}`);
        }
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
  const summary = { registry: 0, resourceExample: 0, routingCases: 0, filesScanned: 0, scanFindings: 0, markdownFilesLinkChecked: 0 };

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
      `routing cases: ${summary.routingCases} | files scanned: ${summary.filesScanned} | ` +
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
