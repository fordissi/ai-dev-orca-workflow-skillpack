import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { parse } from "yaml";
import {
  attemptResume,
  budgetExpiryOpportunity,
  canonicalFingerprint,
  canonicalContinuationFacts,
  classifyCommand,
  classifyExecutionState,
  classifyPermissionRequest,
  classifySessionCleanup,
  normalizePermissionCeiling,
  conservationPressure,
  diffContinuationScope,
  evaluateContinuation,
  humanInstructionRevision,
  objectiveFingerprint,
  permissionScopeFingerprint,
  resetProximity,
  resolveConservationPressure,
  resolveCurrentIntent,
  resolveStrandedCapacity,
  resourceWindows,
  scanText,
  selectCandidate,
  strandedCapacityRisk,
  terminalIsResumable,
  validateContinuationCases,
  validateExecutionCases,
  validateHistory,
  validateMarkdownLinks,
  validateRegistry,
  validateResourceState,
  validateRepository,
  validateRoutingCases,
} from "../scripts/validate-policy-pack.mjs";

// Execution classifications also carry a human-readable reason. The tests
// assert on the decision, not on its wording.
const pick = ({ state, action, code }) => ({ state, action, code });

const registry = {
  capability_tier_order: ["CHEAP", "DEFAULT", "STRONG", "DEEP"],
  capability_slots: {
    DEFAULT_IMPLEMENTER: {
      role: "IMPLEMENTATION",
      minimum_tier: "DEFAULT",
      max_repair_attempts: 2,
      candidates: [
        { provider: "codex", resource_state_key: "codex", model: "luna", model_family: "gpt-5.6", reasoning: "medium", capability_tier: "DEFAULT", status: "stable" },
        { provider: "claude", resource_state_key: "claude", model: "sonnet", model_family: "claude-sonnet", reasoning: "high", capability_tier: "STRONG", status: "stable" },
      ],
    },
  },
};

test("registry accepts ordered candidates at or above minimum capability", () => {
  assert.deepEqual(validateRegistry(registry), []);
});

test("registry rejects a fallback below minimum capability", () => {
  const invalid = structuredClone(registry);
  invalid.capability_slots.DEFAULT_IMPLEMENTER.candidates[1].capability_tier = "CHEAP";
  assert.match(validateRegistry(invalid).join("\n"), /below minimum tier/);
});

test("all-UNKNOWN resource state never changes registry order", () => {
  const selected = selectCandidate(registry.capability_slots.DEFAULT_IMPLEMENTER, {
    codex: { state: "UNKNOWN", available: true, source: "ORCA_RUNTIME" },
    claude: { state: "UNKNOWN", available: true, source: "ORCA_RUNTIME" },
  }, registry.capability_tier_order, { allowExperimental: false, taskRisk: "low" });
  assert.equal(selected.status, "SELECTED");
  assert.equal(selected.candidate.model, "luna");
});

test("UNKNOWN primary is not demoted below a YELLOW fallback", () => {
  const selected = selectCandidate(registry.capability_slots.DEFAULT_IMPLEMENTER, {
    codex: { state: "UNKNOWN", available: true, source: "ORCA_RUNTIME" },
    claude: { state: "YELLOW", available: true, source: "ORCA_RUNTIME" },
  }, registry.capability_tier_order, { allowExperimental: false, taskRisk: "low" });
  assert.equal(selected.candidate.model, "luna");
});

test("YELLOW resource state is not demoted below UNKNOWN", () => {
  const selected = selectCandidate(registry.capability_slots.DEFAULT_IMPLEMENTER, {
    codex: { state: "YELLOW", available: true, source: "ORCA_RUNTIME" },
    claude: { state: "UNKNOWN", available: true, source: "ORCA_RUNTIME" },
  }, registry.capability_tier_order, { allowExperimental: false, taskRisk: "low" });
  assert.equal(selected.candidate.model, "luna");
});

test("GREEN candidate is preferred over RED without crossing the minimum", () => {
  const selected = selectCandidate(registry.capability_slots.DEFAULT_IMPLEMENTER, {
    codex: { state: "RED", available: true, source: "ORCA_RUNTIME" },
    claude: { state: "GREEN", available: true, source: "ORCA_RUNTIME" },
  }, registry.capability_tier_order, { allowExperimental: false, taskRisk: "low" });
  assert.equal(selected.candidate.model, "sonnet");
});

test("a disabled candidate is excluded; an experimental label alone is not", () => {
  const green = { codex: { state: "GREEN", available: true, source: "ORCA_RUNTIME" } };

  // enabled: false is the operator saying "do not route here".
  const disabled = structuredClone(registry.capability_slots.DEFAULT_IMPLEMENTER);
  disabled.candidates[0].enabled = false;
  disabled.candidates.splice(1);
  const blocked = selectCandidate(disabled, green, registry.capability_tier_order, { allowExperimental: false, taskRisk: "high" });
  assert.equal(blocked.status, "BLOCKED");
  assert.ok(typeof blocked.reason === "string" && blocked.reason.length > 0);

  // status: experimental is informational and does NOT gate, even on
  // high-risk work and even with allowExperimental false.
  const labelled = structuredClone(registry.capability_slots.DEFAULT_IMPLEMENTER);
  labelled.candidates[0].status = "experimental";
  labelled.candidates.splice(1);
  const selected = selectCandidate(labelled, green, registry.capability_tier_order, { allowExperimental: false, taskRisk: "high" });
  assert.equal(selected.status, "SELECTED");
  assert.equal(selected.candidate.provider, "codex");
});

test("independent review excludes the implementer provider and model family", () => {
  const selected = selectCandidate(registry.capability_slots.DEFAULT_IMPLEMENTER, {
    codex: { state: "GREEN", available: true, source: "ORCA_RUNTIME" },
    claude: { state: "UNKNOWN", available: true, source: "ORCA_RUNTIME" },
  }, registry.capability_tier_order, { allowExperimental: false, taskRisk: "high", excludeProvider: "codex", excludeModelFamily: "gpt-5.6" });
  assert.equal(selected.candidate.provider, "claude");
});

test("resource state rejects guessed or unknown enum values", () => {
  assert.match(validateResourceState({ providers: { codex: { checked_at: null, state: "MAYBE", available: true } } }).join("\n"), /invalid state/);
});

test("sensitive and unfinished markers are reported", () => {
  const findings = scanText("\u0074oken=secret\n\u0054ODO later");
  const patterns = new Set(findings.map(({ pattern }) => pattern));
  assert.ok(patterns.has("credential-assignment"));
  assert.ok(patterns.has("unfinished-marker"));
});

test("stable policies expose required executable enums", async () => {
  const workflow = await readFile("policies/WORKFLOW_POLICY.md", "utf8");
  const concurrency = await readFile("policies/CONCURRENCY_POLICY.md", "utf8");
  const routing = await readFile("policies/MODEL_ROUTING_POLICY.md", "utf8");
  for (const phrase of ["verify → classify → route → contract → execute → review → repair or escalate → close", "→ handback", "permission ceiling", "authoritative owner"]) assert.match(workflow, new RegExp(phrase));
  for (const mode of ["SEQUENTIAL", "PARALLEL_INDEPENDENT", "COMPETITIVE_DESIGN", "PARALLEL_SAME_CORE_IMPLEMENTATION"]) assert.match(concurrency, new RegExp(mode));
  for (const dimension of ["risk", "complexity", "context_size", "ambiguity", "change_intensity", "verification_need"]) assert.match(routing, new RegExp(dimension));
  for (const tier of ["CHEAP", "DEFAULT", "STRONG", "DEEP"]) assert.match(routing, new RegExp(tier));
  for (const role of ["ROUTER", "IMPLEMENTATION", "LONG_CONTEXT_DISCOVERY", "INDEPENDENT_REVIEWER", "REGRESSION_HUNTER", "ESCALATION"]) assert.match(routing, new RegExp(role));
  assert.match(routing, new RegExp("MODEL_REGISTRY.yaml"));
  assert.ok(routing.includes("failed_repair_count >= max_repair_attempts"));
  assert.match(workflow, new RegExp("normative"));
  assert.match(workflow, new RegExp("conformance checker"));
});

test("repository registry satisfies the executable schema", async () => {
  const registry = parse(await readFile("policies/MODEL_REGISTRY.yaml", "utf8"));
  assert.deepEqual(validateRegistry(registry), []);
});

test("resource example satisfies the safe snapshot schema", async () => {
  const state = JSON.parse(await readFile("runtime/RESOURCE_STATE.example.json", "utf8"));
  assert.deepEqual(validateResourceState(state, { allowExampleNulls: true }), []);
  assert.equal(state.providers.codex.checked_at, null);
  assert.equal(state.providers.antigravity.pools.gemini.checked_at, null);
  assert.equal(state.providers.antigravity.pools.non_gemini.checked_at, null);
});

test("repository rejects a fixture whose candidate is below the slot minimum", async () => {
  const fixture = parse(await readFile("tests/fixtures/invalid-model-registry.yaml", "utf8"));
  assert.match(validateRegistry(fixture).join("\n"), /below minimum tier/);
});

test("repository routing cases all conform to the registry", async () => {
  const registry = parse(await readFile("policies/MODEL_REGISTRY.yaml", "utf8"));
  const cases = parse(await readFile("tests/routing-cases.yaml", "utf8"));
  const names = new Set(cases.cases.map(({ name }) => name));
  for (const required of [
    "bounded_implementation_all_unknown", "yellow_primary_unknown_fallback",
    "unknown_primary_yellow_fallback", "auth_contract_requires_deep_reasoner",
    "large_cross_repo_with_independent_review", "green_fallback_over_red_primary",
    "independent_reviewer_is_disjoint", "no_candidate_meets_minimum",
    "experimental_label_does_not_block_enabled_candidate", "repair_budget_exhausted",
  ]) {
    assert.ok(names.has(required), `routing cases are missing ${required}`);
  }
  assert.ok(cases.cases.length >= 10);
  assert.deepEqual(validateRoutingCases(cases, registry), []);
});

const requiredContractFields = [
  "contract_version", "task_id", "authoritative_owner", "implementation_role", "implementation_slot", "minimum_tier",
  "review_role", "review_slot", "actual_provider", "actual_model", "actual_model_family", "resource_checked_at",
  "implementer_provider", "implementer_model_family", "reviewer_provider", "reviewer_model_family",
  "permission_ceiling", "max_repair_attempts", "failed_repair_count",
  "stop_conditions", "TASK_RESULT", "RESOURCE_STATUS",
];

// Added beyond the plan: the dispatch command is how the permission ceiling is
// actually enforced, and the routing evidence is what makes a selection
// auditable without storing quota payloads.
const requiredResolutionFields = [
  "dispatch_command", "capability_slot", "selected_candidate", "registry_version",
  "resource_overlay_applied", "fallback_used", "selection_reason",
];

test("execution contract template exposes every required field", async () => {
  const contract = await readFile("templates/ROUTER_EXECUTION_CONTRACT_TEMPLATE.md", "utf8");
  assert.deepEqual(requiredContractFields.filter((field) => !contract.includes(field)), []);
  assert.deepEqual(requiredResolutionFields.filter((field) => !contract.includes(field)), []);
});

test("contract template separates strategic contract from operational resolution", async () => {
  const contract = await readFile("templates/ROUTER_EXECUTION_CONTRACT_TEMPLATE.md", "utf8");
  assert.match(contract, /STRATEGIC CONTRACT/);
  assert.match(contract, /OPERATIONAL RESOLUTION/);
  // The strategic half must not depend on filesystem, registry or quota visibility.
  assert.match(contract, /MUST NOT DEPEND ON/);
  assert.match(contract, /unresolved/);
  for (const code of ["CONFIG_INVALID", "ROUTING_UNAVAILABLE", "POLICY_BLOCKED", "RESOURCE_BLOCKED", "PERMISSION_BLOCKED"]) {
    assert.ok(contract.includes(code), `contract template is missing blocked reason code ${code}`);
  }
});

test("handoff and session templates carry their required sections", async () => {
  const handoff = await readFile("templates/CURRENT_PROJECT_HANDOFF_TEMPLATE.md", "utf8");
  const session = await readFile("templates/NEW_SESSION_START_TEMPLATE.txt", "utf8");
  for (const field of ["active_contract", "resource_snapshot", "next_gate", "things_not_to_redo"]) {
    assert.ok(handoff.includes(field), `handoff template is missing ${field}`);
  }
  assert.match(session, /do not guess quota/);
  assert.ok(session.includes("production_access: false"));
});

test("benchmark record template captures comparable run data", async () => {
  const record = await readFile("templates/BENCHMARK_RECORD_TEMPLATE.md", "utf8");
  const required = [
    "task_class", "slot", "provider", "model", "reasoning", "correctness",
    "wall_clock_latency", "repair_count", "review_findings", "review_catch_rate",
    "quota_efficiency", "confounders",
  ];
  assert.deepEqual(required.filter((field) => !record.includes(field)), []);
  assert.match(record, /UNKNOWN/);
});

test("benchmark registry decision note records evidence and rollback", async () => {
  const note = await readFile("templates/REGISTRY_DECISION_NOTE_TEMPLATE.md", "utf8");
  const required = [
    "evidence_sample_size", "old_mapping", "new_mapping", "rollback_condition",
    "reviewer", "approval", "effective_date",
  ];
  assert.deepEqual(required.filter((field) => !note.includes(field)), []);
  // A single run must never be enough to move a stable mapping.
  assert.match(note, /single/i);
});

test("benchmark evidence reference records scope, limits and expiry", async () => {
  const evidence = await readFile("references/MODEL_EVIDENCE.md", "utf8");
  const required = [
    "source_url", "accessed_at", "scope", "methodology_limitation",
    "confidence", "expires_at", "evidence_status",
  ];
  assert.deepEqual(required.filter((field) => !evidence.includes(field)), []);
  assert.match(evidence, /provisional/);
});

test("project and experiment readmes forbid real operational data", async () => {
  const handoffs = await readFile("project-handoffs/README.md", "utf8");
  const experiment = await readFile("experiments/openusage-windows/README.md", "utf8");
  assert.match(handoffs, /sanitized/i);
  assert.match(experiment, /optional/i);
  assert.match(experiment, /UNKNOWN|not authoritative|non-authoritative/i);
});

test("official commands avoid stale or dangerous defaults", async () => {
  // Literals are assembled at runtime so this test is not itself a hit.
  const prohibited = [
    "--" + "screen",
    "approval_policy = " + '"untrusted"',
    "--" + "dangerously-skip-permissions",
  ];
  const offending = [];
  for (const file of ["references/OFFICIAL_COMMANDS.md", "references/SOURCE_NOTES.md"]) {
    const text = await readFile(file, "utf8");
    text.split(/\r?\n/).forEach((line, index) => {
      // A historical or deliberately prohibited example must declare itself.
      if (line.trimStart().startsWith("PROHIBITED:")) return;
      for (const literal of prohibited) {
        if (line.includes(literal)) offending.push(`${file}:${index + 1}: ${literal}`);
      }
    });
  }
  assert.deepEqual(offending, []);
});

const ROUTING_EXAMPLE = "classify -> slot -> overlay -> candidate -> contract -> dispatch";

test("entry points expose the read order, routing example and gates", async () => {
  const readme = await readFile("README.md", "utf8");
  const skill = await readFile("skills/orca-multi-agent-dev/SKILL.md", "utf8");

  for (const [name, text] of [["README.md", readme], ["SKILL.md", skill]]) {
    for (const chain of ["WORKFLOW_POLICY", "MODEL_ROUTING_POLICY", "MODEL_REGISTRY", "RESOURCE_AWARE_ROUTING", "OFFICIAL_COMMANDS"]) {
      assert.ok(text.includes(chain), `${name} is missing ${chain} from the authoritative read order`);
    }
    assert.ok(text.includes(ROUTING_EXAMPLE), `${name} is missing the six-stage routing example`);
    assert.ok(text.includes("UNKNOWN"), `${name} does not state UNKNOWN behaviour`);
    assert.match(text, /human gate/i, `${name} does not mention the human gate`);
    assert.ok(text.includes("npm run validate"), `${name} is missing the validation command`);
    assert.ok(
      text.includes("templates/ROUTER_EXECUTION_CONTRACT_TEMPLATE.md"),
      `${name} does not link the execution contract template`,
    );
  }

  // The README must keep the five layers distinguishable.
  for (const layer of ["stable workflow", "dynamic mapping", "runtime snapshot", "project handoff", "experimental"]) {
    assert.match(readme, new RegExp(layer, "i"), `README.md does not distinguish "${layer}"`);
  }
});

test("entry point link checker rejects broken repository links", async () => {
  const good = "see [the contract](templates/ROUTER_EXECUTION_CONTRACT_TEMPLATE.md)";
  assert.deepEqual(validateMarkdownLinks(good, { path: "README.md", root: process.cwd() }), []);

  const bad = await readFile("tests/fixtures/broken-links.md", "utf8");
  const findings = validateMarkdownLinks(bad, { path: "tests/fixtures/broken-links.md", root: process.cwd() });
  assert.ok(findings.length > 0, "a broken repository-relative link must be reported");
  assert.match(findings.join("\n"), /broken link/);
});

test("resource state requires a declared source and refuses sourceless confidence", () => {
  const base = { checked_at: null, available: true, source: "ORCA_RUNTIME" };

  assert.deepEqual(validateResourceState({ providers: { codex: { ...base, state: "GREEN" } } }), []);

  assert.match(
    validateResourceState({ providers: { codex: { checked_at: null, available: true, state: "GREEN" } } }).join("\n"),
    /source: expected one of/,
  );

  // A snapshot with no trustworthy source may not claim a confident state.
  assert.match(
    validateResourceState({ providers: { codex: { ...base, source: "UNKNOWN", state: "GREEN" } } }).join("\n"),
    /source UNKNOWN cannot carry state/,
  );

  assert.deepEqual(
    validateResourceState({ providers: { codex: { ...base, source: "USER_STATEMENT", state: "YELLOW" } } }),
    [],
  );
});

test("repository safety files protect the public artifact", async () => {
  const license = await readFile("LICENSE", "utf8");
  assert.match(license, /MIT License/);
  assert.match(license, /Copyright \(c\) 2026 fordissi/);
  assert.match(license, /without restriction/);
  assert.match(license, /WITHOUT WARRANTY OF ANY KIND/);

  const gitignore = await readFile(".gitignore", "utf8");
  for (const entry of ["node_modules/", "runtime/RESOURCE_STATE.json", "*.log", ".env", ".claude/"]) {
    assert.ok(gitignore.includes(entry), `.gitignore no longer protects ${entry}`);
  }

  // The design history is deliberately public and must stay inside the scan.
  const validator = await readFile("scripts/validate-policy-pack.mjs", "utf8");
  assert.ok(!validator.includes("docs/superpowers"), "docs/superpowers must not be excluded from scanning");
});

test("repository history scan finds a secret that HEAD no longer contains", async (t) => {
  const { execFileSync } = await import("node:child_process");
  const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join: joinPath } = await import("node:path");

  const dir = await mkdtemp(joinPath(tmpdir(), "policy-history-"));
  const git = (...args) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" });

  try {
    git("init", "-q");
    git("config", "user.email", "test" + "@" + "example.invalid");
    git("config", "user.name", "history fixture");

    // Assembled at runtime so this test file is not itself a finding.
    const leaked = "api" + "_key=" + "abcdef123456";
    await writeFile(joinPath(dir, "leaked.txt"), `${leaked}\n`, "utf8");
    git("add", "leaked.txt");
    git("commit", "-q", "-m", "add file");

    await writeFile(joinPath(dir, "leaked.txt"), "cleaned\n", "utf8");
    git("add", "leaked.txt");
    git("commit", "-q", "-m", "remove secret");

    // HEAD is clean...
    const headFindings = validateRepository(dir).findings.filter((f) => f.includes("credential-assignment"));
    assert.deepEqual(headFindings, [], "HEAD should be clean in this fixture");

    // ...but the history is not, and a later commit must not hide it.
    const historyFindings = validateHistory(dir);
    assert.ok(historyFindings.length > 0, "history scan must report the older revision");
    assert.match(historyFindings.join("\n"), /credential-assignment/);
    // Findings must never echo what they matched.
    assert.ok(!historyFindings.join("\n").includes("abcdef123456"), "history findings must not echo matched text");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("blocked results carry a reason code that distinguishes cannot from must-not", async () => {
  const tierOrder = registry.capability_tier_order;
  const slot = registry.capability_slots.DEFAULT_IMPLEMENTER;

  // Misconfiguration is not a routing problem.
  const invalidFixture = parse(await readFile("tests/fixtures/invalid-model-registry.yaml", "utf8"));
  const brokenSlot = structuredClone(invalidFixture.capability_slots.STRONG_IMPLEMENTER);
  brokenSlot.minimum_tier = "NOT_A_TIER";
  assert.equal(selectCandidate(brokenSlot, {}, tierOrder, {}).code, "CONFIG_INVALID");
  assert.equal(selectCandidate({ candidates: [] }, {}, tierOrder, {}).code, "CONFIG_INVALID");

  // Only availability stands in the way: waiting fixes it.
  const unavailable = selectCandidate(slot, {
    codex: { state: "GREEN", available: false, source: "ORCA_RUNTIME" },
    claude: { state: "GREEN", available: false, source: "ORCA_RUNTIME" },
  }, tierOrder, { allowExperimental: false, taskRisk: "low" });
  assert.equal(unavailable.code, "ROUTING_UNAVAILABLE");

  // Policy stands in the way: only a human can lift it.
  const policyBlocked = selectCandidate(slot, {
    codex: { state: "GREEN", available: true, source: "ORCA_RUNTIME" },
    claude: { state: "GREEN", available: true, source: "ORCA_RUNTIME" },
  }, tierOrder, { allowExperimental: false, taskRisk: "high", excludeProvider: "codex", excludeModelFamily: "claude-sonnet" });
  assert.equal(policyBlocked.code, "POLICY_BLOCKED");

  // Qualified but all RED, and RED is not permitted for this task.
  const redOnly = selectCandidate(slot, {
    codex: { state: "RED", available: true, source: "ORCA_RUNTIME" },
    claude: { state: "RED", available: true, source: "ORCA_RUNTIME" },
  }, tierOrder, { allowExperimental: false, taskRisk: "low" });
  assert.equal(redOnly.code, "RESOURCE_BLOCKED");

  // ...and permitting RED selects rather than blocks.
  const redAllowed = selectCandidate(slot, {
    codex: { state: "RED", available: true, source: "ORCA_RUNTIME" },
    claude: { state: "RED", available: true, source: "ORCA_RUNTIME" },
  }, tierOrder, { allowExperimental: false, taskRisk: "low", allowRed: true });
  assert.equal(redAllowed.status, "SELECTED");
});

test("routing enforces the resource-source trust invariant, not just the example snapshot", () => {
  const tierOrder = registry.capability_tier_order;
  const slot = registry.capability_slots.DEFAULT_IMPLEMENTER;
  const options = { allowExperimental: false, taskRisk: "low" };

  // An untrusted GREEN must not win, even though it is first in registry order
  // and claims the best possible state.
  const untrustedPrimary = selectCandidate(slot, {
    codex: { state: "GREEN", available: true, source: "UNKNOWN" },
    claude: { state: "UNKNOWN", available: true, source: "ORCA_RUNTIME" },
  }, tierOrder, options);
  assert.equal(untrustedPrimary.status, "SELECTED");
  assert.equal(untrustedPrimary.candidate.provider, "claude");

  // With nothing trustworthy left, fail closed rather than route on a claim
  // the snapshot cannot back up.
  for (const bad of [
    { state: "GREEN", available: true, source: "UNKNOWN" },
    { state: "GREEN", available: true },
    { state: "GREEN", available: true, source: "SOMETHING_ELSE" },
  ]) {
    const result = selectCandidate(slot, { codex: bad, claude: bad }, tierOrder, options);
    assert.equal(result.status, "BLOCKED");
    assert.equal(result.code, "CONFIG_INVALID");
  }

  // Absence of an entry is missing data, not a malformed claim: it still routes
  // as UNKNOWN by registry order.
  const noEntry = selectCandidate(slot, {}, tierOrder, options);
  assert.equal(noEntry.status, "SELECTED");
  assert.equal(noEntry.candidate.provider, "codex");

  // A trusted source keeps its declared state.
  const trusted = selectCandidate(slot, {
    codex: { state: "RED", available: true, source: "ORCA_RUNTIME" },
    claude: { state: "GREEN", available: true, source: "USER_STATEMENT" },
  }, tierOrder, options);
  assert.equal(trusted.candidate.provider, "claude");
});

test("enabled is human-authoritative; RED authorisation still defaults to false", () => {
  const tierOrder = registry.capability_tier_order;
  const trustedRed = { state: "RED", available: true, source: "ORCA_RUNTIME" };
  const green = { codex: { state: "GREEN", available: true, source: "ORCA_RUNTIME" } };

  // enabled: false excludes; an experimental label with no enabled:false does not.
  const disabledSlot = structuredClone(registry.capability_slots.DEFAULT_IMPLEMENTER);
  disabledSlot.candidates[0].enabled = false;
  disabledSlot.candidates.splice(1);
  assert.equal(selectCandidate(disabledSlot, green, tierOrder, {}).status, "BLOCKED");

  const labelledSlot = structuredClone(registry.capability_slots.DEFAULT_IMPLEMENTER);
  labelledSlot.candidates[0].status = "experimental";
  labelledSlot.candidates.splice(1);
  assert.equal(selectCandidate(labelledSlot, green, tierOrder, {}).status, "SELECTED");
  // allowExperimental is retained for compatibility and has no effect either way.
  assert.equal(selectCandidate(labelledSlot, green, tierOrder, { allowExperimental: false }).status, "SELECTED");

  // RED is a resource state, not config: without explicit allow_red it blocks.
  assert.equal(
    selectCandidate(registry.capability_slots.DEFAULT_IMPLEMENTER, { codex: trustedRed, claude: trustedRed }, tierOrder, {}).code,
    "RESOURCE_BLOCKED",
  );
  assert.equal(
    selectCandidate(registry.capability_slots.DEFAULT_IMPLEMENTER, { codex: trustedRed, claude: trustedRed }, tierOrder, { allowRed: true }).status,
    "SELECTED",
  );
});

test("a legacy candidate with no enabled field is treated as enabled", () => {
  const tierOrder = registry.capability_tier_order;
  const legacy = structuredClone(registry.capability_slots.DEFAULT_IMPLEMENTER);
  delete legacy.candidates[0].enabled;
  delete legacy.candidates[0].status;
  legacy.candidates.splice(1);
  const selected = selectCandidate(
    legacy,
    { codex: { state: "GREEN", available: true, source: "ORCA_RUNTIME" } },
    tierOrder,
    { allowExperimental: false, taskRisk: "low" },
  );
  assert.equal(selected.status, "SELECTED");
  assert.equal(selected.candidate.provider, "codex");
});

test("an explicit human model pin outranks quota but not hard eligibility", () => {
  const tierOrder = registry.capability_tier_order;
  const codexScarce = { state: "GREEN", available: true, source: "ORCA_RUNTIME", checked_at: NOW, ...budget(0.05, at(120 * HOUR)) };
  const claudeHealthy = { state: "GREEN", available: true, source: "ORCA_RUNTIME", checked_at: NOW, ...healthyBudget() };
  const slot = registry.capability_slots.DEFAULT_IMPLEMENTER;

  // Without a pin, conservation demotes the scarce head.
  const auto = selectCandidate(slot, { codex: codexScarce, claude: claudeHealthy }, tierOrder, { allowExperimental: false, taskRisk: "low", now: NOW });
  assert.equal(auto.candidate.provider, "claude");

  // Pinned, the human's choice is used regardless of quota.
  const pinned = selectCandidate(slot, { codex: codexScarce, claude: claudeHealthy }, tierOrder, {
    allowExperimental: false, taskRisk: "low", now: NOW, pinnedCandidate: { provider: "codex", model: "luna" },
  });
  assert.equal(pinned.status, "SELECTED");
  assert.equal(pinned.candidate.provider, "codex");
  assert.equal(pinned.pinned, true);

  // A pin to a model the slot does not list is impossible, not a substitution.
  const bad = selectCandidate(slot, { codex: codexScarce, claude: claudeHealthy }, tierOrder, {
    allowExperimental: false, taskRisk: "low", now: NOW, pinnedCandidate: { provider: "codex", model: "gpt-5.6-sol" },
  });
  assert.equal(bad.status, "BLOCKED");
  assert.equal(bad.code, "CONFIG_INVALID");

  // A pin cannot resurrect a disabled candidate.
  const disabled = structuredClone(slot);
  disabled.candidates[0].enabled = false;
  const pinnedDisabled = selectCandidate(disabled, { codex: codexScarce, claude: claudeHealthy }, tierOrder, {
    allowExperimental: false, taskRisk: "low", now: NOW, pinnedCandidate: { provider: "codex", model: "luna" },
  });
  assert.equal(pinnedDisabled.status, "BLOCKED");
});

test("contract template defers reason-code semantics to the routing policy", async () => {
  const contract = await readFile("templates/ROUTER_EXECUTION_CONTRACT_TEMPLATE.md", "utf8");
  const routing = await readFile("policies/MODEL_ROUTING_POLICY.md", "utf8");

  // Strategic authorisation fields live in the contract, defaulting to false.
  for (const field of ["allow_experimental: false", "allow_red: false", "experimental_justification"]) {
    assert.ok(contract.includes(field), `contract template is missing ${field}`);
  }

  // Names may be enumerated anywhere; semantics have exactly one owner.
  assert.ok(contract.includes("MODEL_ROUTING_POLICY.md"), "contract must point at the reason-code owner");
  assert.match(routing, /## Blocked reason codes/);

  // The per-code meaning table must not be duplicated in the template.
  const codeRowsInContract = (contract.match(/^\| `(CONFIG_INVALID|ROUTING_UNAVAILABLE|POLICY_BLOCKED|RESOURCE_BLOCKED|PERMISSION_BLOCKED)`/gm) ?? []).length;
  assert.equal(codeRowsInContract, 0, "contract template must not redefine reason-code semantics");
});

test("release hygiene: host-specific registry warning and line-ending policy", async () => {
  const attributes = await readFile(".gitattributes", "utf8");
  assert.match(attributes, /\* text=auto eol=lf/);
  assert.match(attributes, /\*\.png binary/);

  const readme = await readFile("README.md", "utf8");
  assert.match(readme, /core\.longpaths true/);
  assert.match(readme, /provisional/);

  // Adopters must not read the shipped mapping as universal availability.
  const registryText = await readFile("policies/MODEL_REGISTRY.yaml", "utf8");
  assert.match(registryText, /AUTHORING HOST/);
  assert.match(registryText, /re-resolve/i);
});

/* ------------------------------------------------------------------------ *
 * Operational -> Strategic handback
 *
 * The return leg is what a strategic router without a filesystem actually
 * receives, so its shape, its direction and what it must never carry are all
 * conformance concerns.
 * ------------------------------------------------------------------------ */

const requiredReturnFields = [
  "STRATEGIC_RETURN", "task_id", "status", "CURRENT_STATE", "repo", "branch",
  "base_head", "result_head", "working_tree", "WHAT_WAS_DONE", "KEY_FINDINGS",
  "DECISIONS_MADE_BY_AGENT", "HUMAN_DECISIONS_REQUIRED", "CONTRACT_DRIFT",
  "ARTIFACTS", "commit", "VERIFICATION", "REMAINING_RISKS",
  "NEXT_RECOMMENDED_GATE", "BLOCKED_REASON", "RESOURCE_SUMMARY",
  "HANDOFF_UPDATE",
];

test("strategic return template exposes every required field and status", async () => {
  const ret = await readFile("templates/STRATEGIC_RETURN_TEMPLATE.md", "utf8");
  assert.deepEqual(requiredReturnFields.filter((field) => !ret.includes(field)), []);

  // All four outcomes must be expressible; a return that cannot say HUMAN_GATE
  // silently degrades into a PASS/FAIL guess.
  for (const status of ["PASS", "FAIL", "BLOCKED", "HUMAN_GATE"]) {
    assert.ok(ret.includes(status), `strategic return template cannot express ${status}`);
  }
  assert.ok(ret.includes("NONE"), "empty list fields must have an explicit NONE");
  assert.ok(ret.includes("UNKNOWN"), "unreadable values must stay UNKNOWN rather than be guessed");
});

test("handback direction is stated and never reversed", async () => {
  const ret = await readFile("templates/STRATEGIC_RETURN_TEMPLATE.md", "utf8");
  const contract = await readFile("templates/ROUTER_EXECUTION_CONTRACT_TEMPLATE.md", "utf8");
  const skill = await readFile("skills/orca-multi-agent-dev/SKILL.md", "utf8");
  const workflow = await readFile("policies/WORKFLOW_POLICY.md", "utf8");

  // TASK_RESULT stops at the operational router; STRATEGIC_RETURN starts there.
  for (const [name, text] of [["strategic return", ret], ["contract", contract], ["SKILL.md", skill]]) {
    assert.match(text, /TASK_RESULT[^\n]*Worker → Operational router/i, `${name} does not state the worker-side direction`);
    assert.match(text, /STRATEGIC_RETURN[^\n]*Operational router → Strategic router/i, `${name} does not state the handback direction`);
  }

  // Echoing the worker footer upward would make the strategic layer depend on
  // a self-summary it cannot verify.
  for (const [name, text] of [["strategic return", ret], ["contract", contract], ["SKILL.md", skill], ["workflow policy", workflow]]) {
    assert.match(text, /原樣 echo/, `${name} does not forbid echoing TASK_RESULT upward`);
  }

  // The reverse direction must appear nowhere.
  for (const [name, text] of [["strategic return", ret], ["contract", contract], ["SKILL.md", skill], ["workflow policy", workflow]]) {
    assert.ok(!/STRATEGIC_RETURN[^\n]*Worker →/.test(text), `${name} points STRATEGIC_RETURN in the wrong direction`);
    assert.ok(!/TASK_RESULT[^\n]*→ Strategic router/.test(text), `${name} points TASK_RESULT in the wrong direction`);
  }
});

test("workflow policy owns the handback lifecycle rule", async () => {
  const workflow = await readFile("policies/WORKFLOW_POLICY.md", "utf8");

  assert.match(workflow, /## Operational → Strategic handback/);
  assert.match(workflow, /9\. \*\*handback\*\*/, "handback must be a lifecycle step, not an aside");
  assert.ok(
    workflow.includes("templates/STRATEGIC_RETURN_TEMPLATE.md"),
    "the handback rule must point at the field specification",
  );
  assert.match(workflow, /本節是這條 handback lifecycle 規則的 normative owner/);

  // The four things the return leg exists to protect.
  assert.match(workflow, /不得依賴 worker transcript/);
  assert.match(workflow, /decision packet/);
  assert.match(workflow, /HUMAN_GATE/);
  assert.match(workflow, /contract drift 時不得靜默/);

  // The owner table must name handback so no second owner can claim it.
  assert.match(workflow, /\| `WORKFLOW_POLICY\.md` \|[^|]*handback/);
});

test("entry points route the return leg through the strategic return template", async () => {
  const skill = await readFile("skills/orca-multi-agent-dev/SKILL.md", "utf8");
  const readme = await readFile("README.md", "utf8");

  for (const [name, path, text, link] of [
    ["SKILL.md", "skills/orca-multi-agent-dev/SKILL.md", skill, "../../templates/STRATEGIC_RETURN_TEMPLATE.md"],
    ["README.md", "README.md", readme, "templates/STRATEGIC_RETURN_TEMPLATE.md"],
  ]) {
    assert.ok(text.includes(link), `${name} does not link the strategic return template`);
    assert.deepEqual(validateMarkdownLinks(text, { path, root: process.cwd() }), []);
  }

  // Synthesis is what separates a handback from a relay.
  for (const input of ["repo state", "git diff", "reviewer findings", "contract drift", "routing evidence"]) {
    assert.ok(skill.toLowerCase().includes(input.toLowerCase()), `SKILL.md does not require synthesising ${input}`);
  }
});

test("strategic return stays compact and expands only by reference", async () => {
  const ret = await readFile("templates/STRATEGIC_RETURN_TEMPLATE.md", "utf8");

  assert.match(ret, /500-1500 tokens/);
  assert.match(ret, /不是 hard parser limit/);

  // Over budget, the answer is a pointer, not a bigger paste.
  assert.match(ret, /commit SHA/);
  assert.match(ret, /artifact path/);
  assert.match(ret, /不要把完整 design document、完整 report 或完整 diff inline 回傳/);

  // Every escalation trigger must be listed, and escalation must not become a
  // way around the gate it usually accompanies.
  for (const trigger of [
    "architecture contract ambiguity", "privileged boundary", "auth / RBAC / RLS",
    "destructive", "reviewer 判斷不一致", "測試失敗", "design alternatives",
    "contract drift", "production-state",
  ]) {
    assert.ok(ret.includes(trigger), `evidence escalation is missing ${trigger}`);
  }
  assert.match(ret, /不是\*\*繞過 gate 的理由/);
});

test("strategic return forbids carrying anything that must not leave the machine", async () => {
  const ret = await readFile("templates/STRATEGIC_RETURN_TEMPLATE.md", "utf8");

  for (const prohibited of [
    "完整 terminal transcript", "原始 quota payload", "credential",
    "session identifier", "provider conversation ID", "個人資料",
  ]) {
    assert.ok(ret.includes(prohibited), `strategic return template does not forbid ${prohibited}`);
  }

  // The template itself must be clean under the publishable-file scanner.
  assert.deepEqual(scanText(ret, { path: "templates/STRATEGIC_RETURN_TEMPLATE.md" }), []);
});

test("strategic return defers reason-code and resource-state semantics to their owners", async () => {
  const ret = await readFile("templates/STRATEGIC_RETURN_TEMPLATE.md", "utf8");

  // Names may be enumerated here; meanings have exactly one owner each.
  for (const code of ["CONFIG_INVALID", "ROUTING_UNAVAILABLE", "POLICY_BLOCKED", "RESOURCE_BLOCKED", "PERMISSION_BLOCKED"]) {
    assert.ok(ret.includes(code), `strategic return template is missing blocked reason code ${code}`);
  }
  assert.ok(ret.includes("MODEL_ROUTING_POLICY.md"), "the return must point at the reason-code owner");
  assert.ok(ret.includes("RESOURCE_AWARE_ROUTING.md"), "the return must point at the resource-state owner");

  const codeRowsInReturn = (ret.match(/^\| `(CONFIG_INVALID|ROUTING_UNAVAILABLE|POLICY_BLOCKED|RESOURCE_BLOCKED|PERMISSION_BLOCKED)`/gm) ?? []).length;
  assert.equal(codeRowsInReturn, 0, "strategic return must not redefine reason-code semantics");

  const stateRowsInReturn = (ret.match(/^\| `(GREEN|YELLOW|RED)`/gm) ?? []).length;
  assert.equal(stateRowsInReturn, 0, "strategic return must not redefine resource-state semantics");

  // Only a resolved state label travels; the payload that produced it does not.
  assert.match(ret, /GREEN \| YELLOW \| RED \| UNKNOWN/);

  // A handback change must not have moved the model mapping.
  const registryText = await readFile("policies/MODEL_REGISTRY.yaml", "utf8");
  assert.ok(!registryText.includes("STRATEGIC_RETURN"), "the model registry must stay out of the handback layer");
});

test("per-cycle return and durable handoff stay distinguishable", async () => {
  const ret = await readFile("templates/STRATEGIC_RETURN_TEMPLATE.md", "utf8");
  const handoff = await readFile("templates/CURRENT_PROJECT_HANDOFF_TEMPLATE.md", "utf8");
  const workflow = await readFile("policies/WORKFLOW_POLICY.md", "utf8");

  for (const [name, text] of [["strategic return", ret], ["handoff", handoff], ["workflow policy", workflow]]) {
    assert.match(text, /decision delta/, `${name} does not scope the per-cycle return`);
    assert.match(text, /durable project state/, `${name} does not scope the durable handoff`);
  }

  // A durable change updates the handoff first, then says so in the return.
  assert.ok(ret.includes("HANDOFF_UPDATE"), "the return has no field for naming the updated handoff sections");
  assert.ok(handoff.includes("HANDOFF_UPDATE"), "the handoff does not explain how updates are reported back");
  assert.match(handoff, /不得互相取代/);
});

/* ------------------------------------------------------------------------ *
 * Operational execution lifecycle
 *
 * The three failures these cover are all misclassifications: a slow reviewer
 * read as blocked, a read-only ceiling read as "no shell at all", and an
 * exhausted turn budget read as a routing failure.
 * ------------------------------------------------------------------------ */

test("a poll window is a router heartbeat, never a worker deadline", () => {
  // The window expiring with new output is the ordinary case.
  assert.deepEqual(
    pick(classifyExecutionState({ session_active: true, progress_observed: true, elapsed_ms: 60_000, since_progress_ms: 0 })),
    { state: "ACTIVE", action: "CONTINUE", code: null },
  );

  // Total runtime carries no weight of its own: an hour of work with progress
  // a minute ago is the same decision as a minute of work.
  for (const elapsed of [60_000, 3_600_000, 86_400_000]) {
    assert.deepEqual(
      pick(classifyExecutionState({ session_active: true, progress_observed: false, elapsed_ms: elapsed, since_progress_ms: 60_000 })),
      { state: "QUIET", action: "CONTINUE", code: null },
      `total elapsed ${elapsed}ms must not change the decision`,
    );
  }
});

test("only silence since the last progress can produce a stall", () => {
  const silent = { session_active: true, progress_observed: false, elapsed_ms: 1_200_000, since_progress_ms: 1_200_000 };

  assert.equal(classifyExecutionState(silent, { stallThresholdMs: 900_000 }).state, "STALLED");
  assert.equal(classifyExecutionState(silent, { stallThresholdMs: 900_000 }).action, "STALL_INTERVENTION");

  // Deep reasoning raises the threshold rather than being declared stuck at an
  // implementation task's cadence.
  assert.equal(classifyExecutionState(silent, { stallThresholdMs: 2_400_000 }).state, "QUIET");

  // A stall buys an inspection. It is never a permission or routing verdict.
  const stalled = classifyExecutionState(silent, { stallThresholdMs: 900_000 });
  assert.equal(stalled.code, null);
  assert.notEqual(stalled.state, "PERMISSION_BLOCKED");
  assert.notEqual(stalled.state, "ROUTING_UNAVAILABLE");
});

test("a hard ceiling asks a human rather than declaring a failure", () => {
  const result = classifyExecutionState(
    { session_active: true, progress_observed: true, elapsed_ms: 7_200_000, since_progress_ms: 1_000 },
    { hardCeilingMs: 7_200_000 },
  );
  assert.deepEqual(pick(result), { state: "HARD_EXECUTION_CEILING", action: "HUMAN_GATE", code: null });

  // Absent a declared ceiling there is no ceiling to hit.
  assert.equal(
    classifyExecutionState({ session_active: true, progress_observed: true, elapsed_ms: 86_400_000, since_progress_ms: 1_000 }).state,
    "ACTIVE",
  );
});

test("an exhausted turn budget resumes the chain instead of failing it", () => {
  const exhausted = (continuationCount) => ({
    session_active: false,
    progress_observed: false,
    elapsed_ms: 900_000,
    since_progress_ms: 5_000,
    continuation_count: continuationCount,
    exit: { kind: "max_turns" },
  });

  for (const spent of [0, 1]) {
    const result = classifyExecutionState(exhausted(spent));
    assert.deepEqual(pick(result), { state: "MAX_TURNS_REACHED", action: "CONTINUATION", code: null });
  }

  // Bounded: the budget is spent, so the decision goes to a human.
  assert.deepEqual(pick(classifyExecutionState(exhausted(2))), { state: "MAX_TURNS_REACHED", action: "HUMAN_GATE", code: null });

  // A session that ended without a result is a different thing entirely, and
  // must not be resumable forever through the continuation path.
  assert.deepEqual(
    pick(classifyExecutionState({ session_active: false, elapsed_ms: 1_000, exit: { kind: "failure" } })),
    { state: "PROCESS_EXIT_FAILURE", action: "REPAIR_OR_ESCALATE", code: null },
  );
});

test("the two blocked exits stay distinct from every timing signal", () => {
  // A session that vanished without an exit record is genuinely unroutable.
  assert.deepEqual(
    pick(classifyExecutionState({ session_active: false, progress_observed: false, elapsed_ms: 300_000, since_progress_ms: 300_000 })),
    { state: "ROUTING_UNAVAILABLE", action: "BLOCKED", code: "ROUTING_UNAVAILABLE" },
  );

  // A request outside the ceiling is genuinely permission-blocked.
  const denied = classifyExecutionState(
    { session_active: true, permission_request: { kind: "filesystem_write", path: "src/app.ts" } },
    { permissionCeiling: { sandbox: "read-only" } },
  );
  assert.deepEqual(pick(denied), { state: "PERMISSION_BLOCKED", action: "BLOCKED", code: "PERMISSION_BLOCKED" });

  // A request inside the ceiling is not an interruption at all.
  const allowed = classifyExecutionState(
    { session_active: true, permission_request: { kind: "command", command: "git diff" } },
    { permissionCeiling: { sandbox: "read-only" } },
  );
  assert.deepEqual(pick(allowed), { state: "ACTIVE", action: "CONTINUE", code: null });
});

test("a command is classified by its invocation, not by its executable", () => {
  // The same executable on both sides of the boundary.
  assert.equal(classifyCommand("git diff --stat").classification, "read_only");
  assert.equal(classifyCommand("git log --oneline -5").classification, "read_only");
  assert.equal(classifyCommand("git commit -m wip").classification, "mutating");
  assert.equal(classifyCommand("git push origin main").classification, "mutating");

  // A read-only subcommand carrying a mutating flag is not read-only.
  assert.equal(classifyCommand("git branch").classification, "read_only");
  assert.equal(classifyCommand("git branch -D feature").classification, "mutating");

  // A reader that redirects is a writer.
  assert.equal(classifyCommand("cat notes.md").classification, "read_only");
  assert.equal(classifyCommand("cat notes.md > out.md").classification, "mutating");

  // Unrecognised is its own answer, so a refusal can be triaged.
  assert.equal(classifyCommand("deploy-tool --apply").classification, "unknown");
  assert.equal(classifyCommand("").classification, "unknown");

  // Paths, quoting and Windows extensions must not defeat the lookup.
  assert.equal(classifyCommand("/usr/bin/git status").classification, "read_only");
  assert.equal(classifyCommand("git.exe status").classification, "read_only");
  assert.equal(classifyCommand('"C:\\Program Files\\Git\\bin\\git.exe" push origin main').classification, "mutating");
});

test("read, execute and write are three capabilities, not one", () => {
  const reviewer = { sandbox: "read-only" };

  // The whole point: a read-only reviewer can still run its tools.
  assert.equal(classifyPermissionRequest({ kind: "command", command: "Get-Content migration.sql" }, reviewer).allowed, true);
  assert.equal(classifyPermissionRequest({ kind: "filesystem_read", path: "src/app.ts" }, reviewer).allowed, true);

  // And still cannot change anything.
  for (const request of [
    { kind: "filesystem_write", path: "src/app.ts" },
    { kind: "command", command: "git commit -m wip" },
    { kind: "command", command: "rm -rf build" },
    { kind: "database_write", target: "orders" },
    { kind: "production", target: "api" },
    { kind: "push" },
  ]) {
    const decision = classifyPermissionRequest(request, reviewer);
    assert.equal(decision.allowed, false, `${JSON.stringify(request)} must not be allowed`);
    assert.equal(decision.code, "PERMISSION_BLOCKED");
  }

  // The decomposed form can express what the legacy shorthand could not:
  // inspection without a shell at all.
  const noShell = { filesystem: { read: true, write: false }, command_execution: { allowed: false, mutation: false } };
  assert.equal(classifyPermissionRequest({ kind: "command", command: "git status" }, noShell).allowed, false);
  assert.equal(classifyPermissionRequest({ kind: "filesystem_read", path: "src/app.ts" }, noShell).allowed, true);

  // Commit and push stay fenced even when workspace mutation is granted.
  const implementer = { sandbox: "workspace-write", may_commit: false };
  assert.equal(classifyPermissionRequest({ kind: "filesystem_write", path: "src/app.ts" }, implementer).allowed, true);
  assert.equal(classifyPermissionRequest({ kind: "command", command: "git commit -m feat" }, implementer).allowed, false);
});

test("human approval gates a capability but never widens the ceiling", () => {
  const reviewer = { sandbox: "read-only" };

  // Approval is surfaced on a permitted operation...
  const read = classifyPermissionRequest({ kind: "command", command: "Get-Content migration.sql" }, reviewer);
  assert.equal(read.allowed, true);
  assert.equal(read.approval_required, true);

  // ...and cannot be used to carry a denied one through.
  const write = classifyPermissionRequest({ kind: "filesystem_write", path: "src/app.ts", human_approved: true }, reviewer);
  assert.equal(write.allowed, false);
  assert.equal(write.approval_required, false);

  // A contract that does not want per-command prompts says so explicitly.
  const unattended = { filesystem: { read: true, write: false }, command_execution: { allowed: true, mutation: false, human_approval: "never" } };
  assert.equal(classifyPermissionRequest({ kind: "command", command: "git status" }, unattended).approval_required, false);
});

test("v0.3 permission ceilings keep working and keep meaning what they meant", () => {
  const legacyReviewer = normalizePermissionCeiling({ sandbox: "read-only", network: "none", production_access: false });
  assert.deepEqual(legacyReviewer.filesystem, { read: true, write: false });
  assert.equal(legacyReviewer.command_execution.allowed, true);
  assert.equal(legacyReviewer.command_execution.mutation, false);
  assert.equal(legacyReviewer.network.allowed, false);
  assert.equal(legacyReviewer.legacy_sandbox, "read-only");

  const legacyImplementer = normalizePermissionCeiling({ sandbox: "workspace-write", network: "restricted" });
  assert.deepEqual(legacyImplementer.filesystem, { read: true, write: true });
  assert.equal(legacyImplementer.command_execution.mutation, true);
  assert.equal(legacyImplementer.network.allowed, true);

  // Unstated capabilities are denied, never inherited from the sandbox word.
  for (const ceiling of [legacyReviewer, legacyImplementer]) {
    assert.deepEqual(ceiling.database, { read: false, write: false });
    assert.equal(ceiling.production_access, false);
    assert.equal(ceiling.may_commit, false);
    assert.equal(ceiling.may_push, false);
  }

  // An explicit decomposed field wins over the legacy shorthand beside it.
  const mixed = normalizePermissionCeiling({ sandbox: "workspace-write", filesystem: { read: true, write: false } });
  assert.equal(mixed.filesystem.write, false);

  // An unrecognised sandbox word grants nothing rather than guessing.
  const unknown = normalizePermissionCeiling({ sandbox: "something-new" });
  assert.equal(unknown.filesystem.read, false);
  assert.equal(unknown.command_execution.allowed, false);

  // No ceiling at all is not an open ceiling.
  const absent = normalizePermissionCeiling(undefined);
  assert.equal(absent.filesystem.read, false);
  assert.equal(absent.command_execution.allowed, false);
  assert.equal(classifyPermissionRequest({ kind: "filesystem_read" }, undefined).allowed, false);
});

test("repository execution cases all conform to the executable semantics", async () => {
  const cases = parse(await readFile("tests/execution-cases.yaml", "utf8"));
  const names = new Set(cases.cases.map(({ name }) => name));

  for (const required of [
    "poll_timeout_with_new_output", "long_total_runtime_with_recent_progress",
    "no_progress_past_stall_threshold", "hard_ceiling_with_active_process",
    "long_audit_without_a_verdict_yet", "max_turns_with_recoverable_state",
    "max_turns_beyond_continuation_budget", "reviewer_reads_a_file_through_a_shell_command",
    "reviewer_attempts_a_filesystem_write", "reviewer_attempts_a_commit",
    "human_approval_does_not_widen_the_ceiling",
  ]) {
    assert.ok(names.has(required), `execution cases are missing ${required}`);
  }

  assert.deepEqual(validateExecutionCases(cases), []);
});

test("execution case validator rejects a case whose expectation drifts", () => {
  const drifted = {
    cases: [
      {
        name: "slow_is_not_blocked",
        kind: "waiting",
        why: "a fixture asserting the wrong thing must be caught",
        observation: { session_active: true, progress_observed: true, elapsed_ms: 3_600_000 },
        expect: { state: "PERMISSION_BLOCKED", action: "BLOCKED" },
      },
    ],
  };
  assert.match(validateExecutionCases(drifted).join("\n"), /expected state "PERMISSION_BLOCKED", got "ACTIVE"/);

  // `must_not` is what encodes the misclassifications this section exists for.
  const mustNot = {
    cases: [
      {
        name: "stall_must_not_be_permission",
        kind: "waiting",
        why: "guards the exact confusion the real cycle produced",
        observation: { session_active: true, permission_request: { kind: "filesystem_write" } },
        expect: { state: "PERMISSION_BLOCKED", action: "BLOCKED" },
        must_not: ["PERMISSION_BLOCKED"],
      },
    ],
  };
  assert.match(validateExecutionCases(mustNot).join("\n"), /must not classify as PERMISSION_BLOCKED/);

  assert.deepEqual(validateExecutionCases({ cases: [] }), ["execution cases: expected a non-empty `cases` list"]);
});

test("workflow policy owns the execution lifecycle and permission semantics", async () => {
  const workflow = await readFile("policies/WORKFLOW_POLICY.md", "utf8");

  assert.match(workflow, /## Execution lifecycle semantics/);
  assert.match(workflow, /## Permission ceiling 的能力分解/);

  // The invariant, stated where the rule lives.
  for (const line of ["poll timeout != task timeout", "total runtime != stall duration", "slow != blocked"]) {
    assert.ok(workflow.includes(line), `workflow policy is missing the invariant line: ${line}`);
  }

  // Every execution state must be nameable in the normative text.
  for (const state of [
    "ACTIVE", "QUIET", "STALLED", "COMPLETE", "MAX_TURNS_REACHED",
    "PROCESS_EXIT_FAILURE", "HARD_EXECUTION_CEILING", "PERMISSION_BLOCKED", "ROUTING_UNAVAILABLE",
  ]) {
    assert.ok(workflow.includes(state), `workflow policy is missing execution state ${state}`);
  }

  // Each decomposed capability must be expressible.
  for (const capability of ["filesystem", "command_execution", "mutation", "human_approval", "database", "production_access", "may_commit", "may_push"]) {
    assert.ok(workflow.includes(capability), `workflow policy cannot express ${capability}`);
  }

  // Backward compatibility is a stated rule, not an accident of parsing.
  assert.match(workflow, /sandbox: read-only/);
  assert.match(workflow, /仍然有效/);

  // Continuation is bounded and is not repair.
  assert.match(workflow, /max_continuation_attempts/);
  assert.match(workflow, /不得建立無限 continuation/);
  assert.match(workflow, /Repair 與 continuation 是兩件事/);

  // The owner table must name what this section now owns.
  assert.match(workflow, /\| `WORKFLOW_POLICY\.md` \|[^|]*execution lifecycle/);
  assert.match(workflow, /\| `WORKFLOW_POLICY\.md` \|[^|]*permission ceiling 語意/);
});

test("execution states never become a second definition of the blocked codes", async () => {
  const workflow = await readFile("policies/WORKFLOW_POLICY.md", "utf8");
  const routing = await readFile("policies/MODEL_ROUTING_POLICY.md", "utf8");

  // The workflow policy names the codes but defers their meaning.
  assert.match(workflow, /這些是觀察狀態，不是 blocked reason code/);
  assert.ok(workflow.includes("MODEL_ROUTING_POLICY.md"), "workflow policy must point at the reason-code owner");
  // The execution-state table legitimately names PERMISSION_BLOCKED and
  // ROUTING_UNAVAILABLE as its two hand-off exits. What must stay unique is the
  // reason-code definition table, which its "who can lift it" column
  // identifies: a second one of those is a second owner.
  const definitionHeader = "| Code | 意義 | 誰能解除 |";
  const owners = [];
  for (const file of [
    "policies/WORKFLOW_POLICY.md", "policies/MODEL_ROUTING_POLICY.md",
    "policies/CONCURRENCY_POLICY.md", "policies/RESOURCE_AWARE_ROUTING.md",
    "templates/ROUTER_EXECUTION_CONTRACT_TEMPLATE.md", "templates/STRATEGIC_RETURN_TEMPLATE.md",
    "skills/orca-multi-agent-dev/SKILL.md", "README.md",
  ]) {
    if ((await readFile(file, "utf8")).includes(definitionHeader)) owners.push(file);
  }
  assert.deepEqual(owners, ["policies/MODEL_ROUTING_POLICY.md"], "the reason-code table must have exactly one owner");

  // The routing policy, which does own them, states what they are not.
  assert.match(routing, /### Execution state 不是 blocked reason code/);
  for (const notBlocked of ["模型執行時間長", "polling window 逾時", "尚未產出最終結論", "Reached max turns"]) {
    assert.ok(routing.includes(notBlocked), `routing policy does not exclude "${notBlocked}" from PERMISSION_BLOCKED`);
  }

  // failed_repair_count is owned by the routing policy, so the continuation
  // exemption is stated there and only there.
  assert.match(routing, /\*\*Continuation 也不計入 `failed_repair_count`。\*\*/);
  assert.ok(
    !/continuation[^\n]*計入 `failed_repair_count`/.test(workflow.replace(/`failed_repair_count` 的計數規則[^\n]*\n/g, "")),
    "the repair-count rule must not be restated in the workflow policy",
  );
});

test("contract template can express the decomposed ceiling and the execution budget", async () => {
  const contract = await readFile("templates/ROUTER_EXECUTION_CONTRACT_TEMPLATE.md", "utf8");

  for (const field of [
    "filesystem", "command_execution", "mutation", "human_approval",
    "database", "production_access", "may_commit", "may_push",
    "execution_budget", "poll_interval_ms", "stall_threshold_ms",
    "hard_execution_ceiling_ms", "max_continuation_attempts",
    "execution_state", "last_progress_at", "continuation_count",
  ]) {
    assert.ok(contract.includes(field), `contract template cannot express ${field}`);
  }

  // The legacy field stays present, so an existing v0.3 contract still parses
  // against this template rather than being silently invalidated.
  assert.match(contract, /sandbox:\s+# read-only \| workspace-write（legacy 簡寫，optional）/);

  // And the template must not invite a slow worker to be filed as blocked.
  assert.match(contract, /\*\*不是 reason code\*\*/);
});

test("command reference separates a poll window from a worker deadline", async () => {
  const commands = await readFile("references/OFFICIAL_COMMANDS.md", "utf8");

  assert.match(commands, /`--timeout-ms` 是輪詢窗口，不是 worker 的完成期限/);
  assert.match(commands, /醒來重新觀察一次/);

  // Progress detection has to use the read mode that has history.
  assert.match(commands, /cursor read/);

  // The two provider-side facts that caused the misreadings.
  assert.match(commands, /`--sandbox read-only` 不是「不得執行命令」/);
  assert.match(commands, /Reached max turns/);
  assert.match(commands, /execution budget exhaustion/);

  // Implementation guidance points at the semantics owner rather than
  // restating it.
  assert.ok(commands.includes("policies/WORKFLOW_POLICY.md"), "command reference must point at the semantics owner");
});

test("the entry points teach slow-is-not-blocked", async () => {
  const skill = await readFile("skills/orca-multi-agent-dev/SKILL.md", "utf8");
  const readme = await readFile("README.md", "utf8");

  for (const [name, text] of [["SKILL.md", skill], ["README.md", readme]]) {
    assert.ok(text.includes("poll timeout != task timeout"), `${name} is missing the poll-window invariant`);
    assert.ok(text.includes("slow != blocked"), `${name} is missing the slow-is-not-blocked invariant`);
    assert.match(text, /MAX_TURNS_REACHED|Reached max turns/, `${name} does not mention turn-budget exhaustion`);
    assert.match(text, /唯讀命令/, `${name} does not state that read-only still executes commands`);
  }

  assert.deepEqual(validateMarkdownLinks(skill, { path: "skills/orca-multi-agent-dev/SKILL.md", root: process.cwd() }), []);
  assert.deepEqual(validateMarkdownLinks(readme, { path: "README.md", root: process.cwd() }), []);
});

test("hardening left model mapping, tiers, disjointness and concurrency untouched", async () => {
  const registryText = await readFile("policies/MODEL_REGISTRY.yaml", "utf8");
  const registryParsed = parse(registryText);
  const routing = await readFile("policies/MODEL_ROUTING_POLICY.md", "utf8");
  const concurrency = await readFile("policies/CONCURRENCY_POLICY.md", "utf8");

  // No execution-lifecycle vocabulary leaked into the mapping layer.
  for (const leaked of ["execution_state", "MAX_TURNS_REACHED", "stall_threshold", "max_continuation_attempts", "command_execution"]) {
    assert.ok(!registryText.includes(leaked), `the model registry must not carry ${leaked}`);
  }

  assert.deepEqual(registryParsed.capability_tier_order, ["CHEAP", "DEFAULT", "STRONG", "DEEP"]);
  assert.deepEqual(validateRegistry(registryParsed), []);

  // The rules this task was told not to touch are still stated.
  assert.match(routing, /reviewer 的 provider 與 model family \*\*都必須\*\*與 implementer 不同/);
  assert.match(concurrency, /\*\*永久禁止。\*\*/);
  assert.match(concurrency, /Concurrency is opt-in, not default/);

  // Continuation must not have grown a second budget inside the registry.
  for (const slot of Object.values(registryParsed.capability_slots)) {
    assert.equal(slot.max_continuation_attempts, undefined, "continuation budget belongs to the contract, not the registry");
  }
});

/* ------------------------------------------------------------------------ *
 * Reset proximity / stranded capacity
 *
 * The sixth ordering layer. Every test here is really one question: can this
 * signal reach anything it must not reach? It must not.
 * ------------------------------------------------------------------------ */

const NOW = "2026-09-01T12:00:00Z";
const at = (offsetMs) => new Date(Date.parse(NOW) + offsetMs).toISOString();
const HOUR = 60 * 60 * 1000;

// A pool whose reading is trustworthy and fresh, so the signals are in play.
const pool = (overrides = {}) => ({
  state: "GREEN",
  available: true,
  source: "ORCA_RUNTIME",
  checked_at: NOW,
  ...overrides,
});

const burst = (remaining, resetAt) => ({ short_window: { remaining_ratio: remaining, reset_at: resetAt } });
const budget = (remaining, resetAt) => ({ weekly_window: { remaining_ratio: remaining, reset_at: resetAt } });

// A budget somebody read and found healthy: the precondition for spending a
// burst window at all.
const healthyBudget = () => budget(0.8, at(120 * HOUR));

test("reset proximity buckets a window by how long it has left", () => {
  assert.equal(resetProximity(at(3 * HOUR), NOW), "NEAR");
  assert.equal(resetProximity(at(6 * HOUR), NOW), "NEAR");
  assert.equal(resetProximity(at(6 * HOUR + 1), NOW), "MEDIUM");
  assert.equal(resetProximity(at(36 * HOUR), NOW), "MEDIUM");
  assert.equal(resetProximity(at(48 * HOUR + 1), NOW), "FAR");

  // A reset already in the past describes a window that no longer exists, so
  // the honest answer is UNKNOWN rather than "extremely near".
  assert.equal(resetProximity(at(-1), NOW), "UNKNOWN");
  assert.equal(resetProximity(NOW, NOW), "UNKNOWN");

  for (const missing of [null, undefined, "", "not-a-date",
    {}]) {
    assert.equal(resetProximity(missing, NOW), "UNKNOWN");
  }
  assert.equal(resetProximity(at(HOUR), "not-a-date"), "UNKNOWN");
});

test("stranded risk needs both a full pool and a near reset", () => {
  // Plenty left and almost out of time: the case the layer exists for.
  assert.equal(strandedCapacityRisk(0.6, "NEAR"), "HIGH");

  // Plenty left but time to spend it is not stranded.
  assert.equal(strandedCapacityRisk(0.6, "MEDIUM"), "MEDIUM");
  assert.equal(strandedCapacityRisk(0.6, "FAR"), "LOW");

  // Nearly spent strands nothing, however soon it refills.
  assert.equal(strandedCapacityRisk(0.1, "NEAR"), "LOW");
  assert.equal(strandedCapacityRisk(0.3, "NEAR"), "MEDIUM");
  assert.equal(strandedCapacityRisk(0.3, "FAR"), "LOW");

  // No usable reading on either axis is neutral, never optimistic.
  assert.equal(strandedCapacityRisk(0.9, "UNKNOWN"), "UNKNOWN");
  assert.equal(strandedCapacityRisk(null, "NEAR"), "UNKNOWN");
  assert.equal(strandedCapacityRisk("0.9", "NEAR"), "UNKNOWN");
  assert.equal(strandedCapacityRisk(1.5, "NEAR"), "UNKNOWN");
  assert.equal(strandedCapacityRisk(-0.1, "NEAR"), "UNKNOWN");
});

test("the resolved signal carries labels only, never quota numbers", () => {
  const signal = resolveStrandedCapacity(
    pool({ short_window: { used: 0.41, remaining_ratio: 0.59, reset_at: at(3.75 * HOUR) } }),
    { now: NOW },
  );

  assert.deepEqual(signal, {
    state: "GREEN",
    reset_proximity: "NEAR",
    stranded_capacity_risk: "HIGH",
    confidence: "HIGH",
    stale: false,
  });

  // Nothing in the resolved view may be written into an artifact by accident.
  const serialized = JSON.stringify(signal);
  for (const leaked of ["0.59", "0.41", "2026-09-01T15:45"]) {
    assert.ok(!serialized.includes(leaked), `the resolved signal leaked ${leaked}`);
  }
});

test("a pool is as stranded as its most stranded window", () => {
  // The motivating shape: a five-hour window about to refill with most of it
  // left, behind a weekly window that is nowhere near resetting.
  const signal = resolveStrandedCapacity(
    pool({
      windows: [
        { key: "hourly", role: "BURST", remaining_ratio: 0.55, reset_at: at(7 * HOUR) },
        { key: "five_hour", role: "BURST", remaining_ratio: 0.59, reset_at: at(3.75 * HOUR) },
      ],
      ...healthyBudget(),
    }),
    { now: NOW },
  );
  assert.equal(signal.stranded_capacity_risk, "HIGH");
  assert.equal(signal.reset_proximity, "NEAR");

  // A BUDGET window never supplies the utilization signal, however urgent it
  // looks: that is the confusion this refinement exists to remove.
  const budgetOnly = resolveStrandedCapacity(pool(budget(0.9, at(2 * HOUR))), { now: NOW });
  assert.equal(budgetOnly.stranded_capacity_risk, "UNKNOWN");

  // With no window in play at all the signal stays neutral.
  assert.equal(resolveStrandedCapacity(pool(), { now: NOW }).stranded_capacity_risk, "UNKNOWN");
});

test("the signal goes neutral wherever the reading cannot carry weight", () => {
  const window = burst(0.9, at(HOUR));

  // Stale: a ratio read an hour ago is worse than no ratio at all.
  const stale = resolveStrandedCapacity(pool({ ...window, checked_at: at(-60 * 60 * 1000) }), { now: NOW });
  assert.equal(stale.stale, true);
  assert.equal(stale.stranded_capacity_risk, "UNKNOWN");

  // No checked_at means freshness cannot be established at all.
  const undated = resolveStrandedCapacity({ ...pool(window), checked_at: null }, { now: NOW });
  assert.equal(undated.stranded_capacity_risk, "UNKNOWN");

  // An UNKNOWN state cannot carry a confident opportunity reading.
  assert.equal(
    resolveStrandedCapacity(pool({ ...window, state: "UNKNOWN", source: "UNKNOWN" }), { now: NOW }).stranded_capacity_risk,
    "UNKNOWN",
  );

  // The source trust invariant reaches this layer too.
  assert.equal(
    resolveStrandedCapacity({ ...pool(window), source: "UNKNOWN" }, { now: NOW }).stranded_capacity_risk,
    "UNKNOWN",
  );
  assert.equal(resolveStrandedCapacity({ ...pool(window), source: undefined }, { now: NOW }).stranded_capacity_risk, "UNKNOWN");

  // Confidence below MEDIUM does not move routing.
  assert.equal(
    resolveStrandedCapacity(pool({ ...window, remaining_confidence: "LOW" }), { now: NOW }).stranded_capacity_risk,
    "UNKNOWN",
  );

  assert.equal(resolveStrandedCapacity(undefined, { now: NOW }).stranded_capacity_risk, "UNKNOWN");
});

test("declared confidence may lower the source trust but never raise it", () => {
  const window = burst(0.9, at(HOUR));

  // A hand-reported figure is MEDIUM by source and cannot promote itself.
  const inflated = resolveStrandedCapacity(
    { ...pool(window), source: "USER_STATEMENT", remaining_confidence: "HIGH" },
    { now: NOW },
  );
  assert.equal(inflated.confidence, "MEDIUM");
  // MEDIUM still routes: a person saying "Codex is nearly full" is usable.
  assert.equal(inflated.stranded_capacity_risk, "HIGH");

  // Lowering is always allowed, and drops the reading out of routing.
  const lowered = resolveStrandedCapacity(pool({ ...window, remaining_confidence: "LOW" }), { now: NOW });
  assert.equal(lowered.confidence, "LOW");
  assert.equal(lowered.stranded_capacity_risk, "UNKNOWN");

  // The snapshot validator rejects the inflated claim rather than silently
  // clamping it, so the misconfiguration is visible.
  const findings = validateResourceState({
    providers: { codex: { checked_at: NOW, available: true, state: "GREEN", source: "USER_STATEMENT", remaining_confidence: "HIGH" } },
  });
  assert.match(findings.join("\n"), /remaining_confidence: HIGH exceeds the trust of source USER_STATEMENT/);
});

test("stranded capacity reorders inside a state group and nowhere else", () => {
  const tierOrder = registry.capability_tier_order;
  const slot = registry.capability_slots.DEFAULT_IMPLEMENTER;
  const options = { allowExperimental: false, taskRisk: "low", now: NOW };
  const urgent = { ...burst(0.8, at(2 * HOUR)), ...healthyBudget() };
  const distant = { ...burst(0.8, at(120 * HOUR)), ...healthyBudget() };

  // It can move the pick when both sides are in the same state.
  const promoted = selectCandidate(
    slot,
    { codex: pool(distant), claude: pool(urgent) },
    tierOrder,
    options,
  );
  assert.equal(promoted.candidate.provider, "claude");
  assert.equal(promoted.stranded_capacity_risk, "HIGH");
  assert.equal(promoted.stranded_promotion.over, "codex/luna");

  // It cannot move the pick across resource-state bands.
  const acrossBands = selectCandidate(
    slot,
    { codex: pool({ ...urgent, state: "YELLOW" }), claude: pool(distant) },
    tierOrder,
    options,
  );
  assert.equal(acrossBands.candidate.provider, "claude");
  assert.equal(acrossBands.stranded_promotion, null);

  // And it cannot put a YELLOW ahead of an UNKNOWN, which is the invariant
  // that keeps "not checking" from ever being punished or rewarded.
  const yellowVersusUnknown = selectCandidate(
    slot,
    { codex: pool({ state: "UNKNOWN", source: "UNKNOWN" }), claude: pool({ ...urgent, state: "YELLOW" }) },
    tierOrder,
    options,
  );
  assert.equal(yellowVersusUnknown.candidate.provider, "codex");
  assert.equal(yellowVersusUnknown.stranded_promotion, null);

  // Mirrored: an UNKNOWN does not jump ahead of a YELLOW either.
  const unknownVersusYellow = selectCandidate(
    slot,
    { codex: pool({ ...urgent, state: "YELLOW" }), claude: pool({ state: "UNKNOWN", source: "UNKNOWN" }) },
    tierOrder,
    options,
  );
  assert.equal(unknownVersusYellow.candidate.provider, "codex");
});

test("only HIGH promotes, so a merely-known reading never displaces an UNKNOWN", () => {
  const tierOrder = registry.capability_tier_order;
  const slot = registry.capability_slots.DEFAULT_IMPLEMENTER;
  const options = { allowExperimental: false, taskRisk: "low", now: NOW };

  // MEDIUM stranded risk on the second candidate changes nothing.
  const medium = selectCandidate(
    slot,
    {
      codex: pool({ ...healthyBudget() }),
      claude: pool({ ...burst(0.3, at(2 * HOUR)), ...healthyBudget() }),
    },
    tierOrder,
    options,
  );
  assert.equal(medium.candidate.provider, "codex");
  assert.equal(medium.stranded_promotion, null);

  // When the registry head is itself the HIGH one, nothing was promoted.
  const headIsUrgent = selectCandidate(
    slot,
    {
      codex: pool({ ...burst(0.9, at(2 * HOUR)), ...healthyBudget() }),
      claude: pool({ ...burst(0.9, at(2 * HOUR)), ...healthyBudget() }),
    },
    tierOrder,
    options,
  );
  assert.equal(headIsUrgent.candidate.provider, "codex");
  assert.equal(headIsUrgent.stranded_promotion, null);
  assert.equal(headIsUrgent.stranded_capacity_risk, "HIGH");
});

test("stranded capacity cannot reach eligibility, tier, disjointness or gates", async () => {
  const tierOrder = registry.capability_tier_order;
  const urgent = pool({ ...burst(0.95, at(HOUR)), ...healthyBudget() });
  const dull = pool({ ...burst(0.05, at(200 * HOUR)), ...budget(0.6, at(120 * HOUR)) });

  // Below the slot minimum: expiring quota is not a capability grant. The
  // invalid fixture is the only place a below-minimum candidate can exist.
  const belowMinimum = parse(await readFile("tests/fixtures/invalid-model-registry.yaml", "utf8"));
  const blocked = selectCandidate(
    belowMinimum.capability_slots.STRONG_IMPLEMENTER,
    { codex: urgent },
    tierOrder,
    { allowExperimental: false, taskRisk: "high", now: NOW },
  );
  assert.equal(blocked.status, "BLOCKED");
  assert.equal(blocked.code, "POLICY_BLOCKED");

  // A disabled candidate stays excluded however urgent its pool is.
  const disabledSlot = structuredClone(registry.capability_slots.DEFAULT_IMPLEMENTER);
  disabledSlot.candidates[0].enabled = false;
  const skipsDisabled = selectCandidate(
    disabledSlot,
    { codex: urgent, claude: dull },
    tierOrder,
    { allowExperimental: false, taskRisk: "high", now: NOW },
  );
  assert.equal(skipsDisabled.candidate.provider, "claude");

  // Disjointness outranks quota economics.
  const reviewer = selectCandidate(
    registry.capability_slots.DEFAULT_IMPLEMENTER,
    { codex: urgent, claude: dull },
    tierOrder,
    { allowExperimental: false, taskRisk: "high", excludeProvider: "codex", excludeModelFamily: "gpt-5.6", now: NOW },
  );
  assert.equal(reviewer.candidate.provider, "claude");

  // Unavailable stays unavailable.
  const unavailable = selectCandidate(
    registry.capability_slots.DEFAULT_IMPLEMENTER,
    { codex: { ...urgent, available: false }, claude: dull },
    tierOrder,
    { allowExperimental: false, taskRisk: "low", now: NOW },
  );
  assert.equal(unavailable.candidate.provider, "claude");

  // RED stays excluded without explicit authorisation, urgency notwithstanding.
  const red = selectCandidate(
    registry.capability_slots.DEFAULT_IMPLEMENTER,
    { codex: { ...urgent, state: "RED" }, claude: { ...dull, state: "RED" } },
    tierOrder,
    { allowExperimental: false, taskRisk: "low", now: NOW },
  );
  assert.equal(red.status, "BLOCKED");
  assert.equal(red.code, "RESOURCE_BLOCKED");
});

test("with no opportunity reading the selection is byte-for-byte the old one", () => {
  const tierOrder = registry.capability_tier_order;
  const slot = registry.capability_slots.DEFAULT_IMPLEMENTER;

  for (const states of [
    {},
    { codex: { state: "UNKNOWN", available: true, source: "ORCA_RUNTIME" } },
    { codex: { state: "YELLOW", available: true, source: "ORCA_RUNTIME" }, claude: { state: "UNKNOWN", available: true, source: "ORCA_RUNTIME" } },
    { codex: { state: "GREEN", available: true, source: "ORCA_RUNTIME" }, claude: { state: "GREEN", available: true, source: "ORCA_RUNTIME" } },
  ]) {
    const withLayer = selectCandidate(slot, states, tierOrder, { allowExperimental: false, taskRisk: "low", now: NOW });
    const withoutLayer = selectCandidate(slot, states, tierOrder, {
      allowExperimental: false,
      taskRisk: "low",
      now: NOW,
      preferStrandedCapacity: false,
    });
    assert.equal(withLayer.candidate.model, withoutLayer.candidate.model);
    assert.equal(withLayer.stranded_promotion, null);
    assert.equal(withLayer.stranded_capacity_risk, "UNKNOWN");
  }
});

test("the snapshot schema accepts the new facts and rejects malformed ones", async () => {
  const example = JSON.parse(await readFile("runtime/RESOURCE_STATE.example.json", "utf8"));
  assert.deepEqual(validateResourceState(example, { allowExampleNulls: true }), []);

  // The public example must stay free of real readings.
  for (const entry of [example.providers.codex, example.providers.antigravity.pools.gemini]) {
    assert.equal(entry.short_window.remaining_ratio, null);
    assert.equal(entry.short_window.reset_at, null);
    assert.equal(entry.remaining_confidence, "UNKNOWN");
  }

  const base = { checked_at: NOW, available: true, state: "GREEN", source: "ORCA_RUNTIME" };
  assert.deepEqual(
    validateResourceState({ providers: { codex: { ...base, short_window: { remaining_ratio: 0.5, reset_at: NOW } } } }),
    [],
  );

  for (const [window, pattern] of [
    [{ remaining_ratio: 1.5 }, /remaining_ratio: expected a ratio between 0 and 1/],
    [{ remaining_ratio: "0.5" }, /remaining_ratio: expected a ratio between 0 and 1/],
    [{ reset_at: 12345 }, /reset_at: expected an ISO timestamp string or null/],
  ]) {
    assert.match(
      validateResourceState({ providers: { codex: { ...base, short_window: window } } }).join("\n"),
      pattern,
    );
  }

  assert.match(
    validateResourceState({ providers: { codex: { ...base, remaining_confidence: "VERY_HIGH" } } }).join("\n"),
    /remaining_confidence: expected one of/,
  );
});

test("resource policy owns the opportunity signal without claiming capability", async () => {
  const resource = await readFile("policies/RESOURCE_AWARE_ROUTING.md", "utf8");
  const routing = await readFile("policies/MODEL_ROUTING_POLICY.md", "utf8");

  // Both core principles, stated where the rule lives.
  for (const principle of [
    "quota opportunity cost is a routing signal, not capability authority",
    "short-window opportunity MUST NOT override long-horizon scarcity",
  ]) {
    assert.ok(resource.includes(principle), `the resource policy must state: ${principle}`);
  }
  assert.match(resource, /## Hierarchical quota windows/);

  // Every derived label and threshold has to be nameable.
  for (const token of [
    "remaining_ratio", "reset_at", "remaining_confidence",
    "reset_proximity", "stranded_capacity_risk", "conservation_pressure",
    "BURST", "BUDGET", "NEAR", "MEDIUM", "FAR", "HIGH", "LOW", "NONE", "CRITICAL", "UNKNOWN",
  ]) {
    assert.ok(resource.includes(token), `the resource policy is missing ${token}`);
  }

  // The three things it explicitly refuses to become.
  for (const refused of ["SURPLUS", "RESET_SOON", "cheaper/deeper override"]) {
    assert.ok(resource.includes(refused), `the resource policy does not refuse ${refused}`);
  }

  // The neutrality invariant it must not break, restated as a consequence.
  assert.match(resource, /`YELLOW` 與 `UNKNOWN` 之間\*\*仍然沒有優先級\*\*/);
  assert.match(resource, /選擇結果與本節存在之前\*\*完全相同\*\*/);

  // Evidence carries labels, never numbers.
  assert.match(resource, /只記錄標籤，不記錄數值/);

  // The seven-layer precedence belongs to the algorithm owner, and points back
  // here for the sixth layer rather than restating it.
  assert.match(routing, /1\. policy eligibility/);
  assert.match(routing, /6\. long-horizon conservation/);
  assert.match(routing, /7\. short-horizon opportunity/);
  assert.match(routing, /8\. registry preference/);
  assert.ok(routing.includes("RESOURCE_AWARE_ROUTING.md"), "the routing policy must point at the signal owner");
  assert.match(routing, /此處不重複/);
  // Scarcity before utilization, stated in the algorithm that applies them.
  assert.match(routing, /scarcity first, utilization second/);

  // No second definition of the thresholds.
  for (const threshold of ["≤ 6 小時", "≥ 0.5", "≥ 0.25"]) {
    assert.ok(!routing.includes(threshold), `the routing policy must not restate the threshold ${threshold}`);
  }
});

test("the opportunity layer left tiers, slots and registry mapping untouched", async () => {
  const registryText = await readFile("policies/MODEL_REGISTRY.yaml", "utf8");
  const registryParsed = parse(registryText);

  // No opportunity vocabulary leaked into the mapping layer.
  for (const leaked of [
    "stranded", "reset_proximity", "remaining_ratio", "conservation", "BUDGET",
    "SURPLUS", "RESET_SOON",
  ]) {
    assert.ok(!registryText.includes(leaked), `the model registry must not carry ${leaked}`);
  }

  assert.deepEqual(registryParsed.capability_tier_order, ["CHEAP", "DEFAULT", "STRONG", "DEEP"]);
  assert.deepEqual(validateRegistry(registryParsed), []);

  // Slot membership is registry-owned and must be exactly what it was: the
  // escalation-only candidates stay out of the general slots.
  assert.deepEqual(
    Object.keys(registryParsed.capability_slots).sort(),
    [
      "CHEAP_GENERALIST", "DEEP_REASONER", "DEFAULT_IMPLEMENTER", "ESCALATION_MODEL",
      "INDEPENDENT_REVIEWER", "LONG_CONTEXT_DISCOVERY", "REGRESSION_HUNTER", "ROUTER",
      "STRONG_IMPLEMENTER",
    ],
  );
  for (const [name, slot] of Object.entries(registryParsed.capability_slots)) {
    for (const candidate of slot.candidates) {
      assert.ok(
        registryParsed.capability_tier_order.indexOf(candidate.capability_tier) >=
          registryParsed.capability_tier_order.indexOf(slot.minimum_tier),
        `${name}/${candidate.model} sits below its slot minimum`,
      );
    }
  }

  // The contract records the labels and is told not to record the numbers.
  const contract = await readFile("templates/ROUTER_EXECUTION_CONTRACT_TEMPLATE.md", "utf8");
  for (const field of [
    "resource_signals", "conservation", "opportunity",
    "conservation_pressure", "budget_reset_proximity", "conservation_demotion",
    "reset_proximity", "stranded_capacity_risk", "stranded_promotion",
  ]) {
    assert.ok(contract.includes(field), `the contract template cannot record ${field}`);
  }
  assert.match(contract, /不寫 `remaining_ratio` 的數值或 `reset_at` 的時間戳/);
});

/* ------------------------------------------------------------------------ *
 * Hierarchical quota windows
 *
 * BURST supplies utilization, BUDGET supplies scarcity, and scarcity wins.
 * ------------------------------------------------------------------------ */

test("a window is typed by role, not by name", () => {
  // Legacy names keep their meaning, so a v0.3 snapshot needs no rewriting.
  assert.deepEqual(
    resourceWindows({ short_window: { remaining_ratio: 0.5 }, weekly_window: { remaining_ratio: 0.5 } }).map(({ key, role }) => [key, role]),
    [["short_window", "BURST"], ["weekly_window", "BUDGET"]],
  );

  // An explicit role wins, so a provider whose short window really is its cap
  // can say so rather than being misread as burst capacity.
  assert.equal(resourceWindows({ short_window: { role: "BUDGET" } })[0].role, "BUDGET");

  // The generic list is not tied to short/weekly at all.
  const generic = resourceWindows({
    windows: [
      { key: "daily", role: "BURST", remaining_ratio: 0.4 },
      { key: "monthly", role: "BUDGET", remaining_ratio: 0.4 },
    ],
  });
  assert.deepEqual(generic.map(({ key, role }) => [key, role]), [["daily", "BURST"], ["monthly", "BUDGET"]]);

  // A window nobody typed is evidence about neither horizon, so it is dropped
  // rather than guessed into one.
  assert.deepEqual(resourceWindows({ windows: [{ key: "mystery", remaining_ratio: 0.9 }] }), []);
  assert.deepEqual(resourceWindows({ windows: [{ key: "x", role: "OTHER" }] }), []);
  assert.deepEqual(resourceWindows(undefined), []);
});

test("conservation pressure reads remaining and proximity together", () => {
  // An ample budget is never a reason to conserve.
  assert.equal(conservationPressure(0.75, "FAR"), "LOW");
  assert.equal(conservationPressure(0.75, "NEAR"), "NONE");

  // The case that motivated the refinement: eight percent of the week left
  // with five days to run.
  assert.equal(conservationPressure(0.08, "FAR"), "CRITICAL");

  // Proximity softens scarcity here, the opposite of its effect on a burst
  // window: a cap that refills within the hour barely constrains anything.
  assert.equal(conservationPressure(0.1, "NEAR"), "LOW");
  assert.equal(conservationPressure(0.1, "MEDIUM"), "MEDIUM");
  assert.equal(conservationPressure(0.1, "FAR"), "HIGH");
  assert.ok(
    ["LOW", "NONE"].includes(conservationPressure(0.1, "NEAR")) && conservationPressure(0.1, "FAR") === "HIGH",
    "the same ratio must be less binding when it is about to refill",
  );

  // No usable reading on either axis is neutral, never optimistic.
  assert.equal(conservationPressure(0.05, "UNKNOWN"), "UNKNOWN");
  assert.equal(conservationPressure(null, "FAR"), "UNKNOWN");
  assert.equal(conservationPressure(1.5, "FAR"), "UNKNOWN");
});

test("budget expiry opportunity is the offensive mirror of conservation", () => {
  // A lot left AND about to reset: HIGH. This is the only combination that
  // earns a promotion.
  assert.equal(budgetExpiryOpportunity(0.70, "NEAR"), "HIGH");
  assert.equal(budgetExpiryOpportunity(0.50, "NEAR"), "HIGH");

  // A lot left but a distant reset strands nothing.
  assert.equal(budgetExpiryOpportunity(0.70, "MEDIUM"), "MEDIUM");
  assert.equal(budgetExpiryOpportunity(0.70, "FAR"), "LOW");

  // Middling remaining is at most MEDIUM, and only right at reset.
  assert.equal(budgetExpiryOpportunity(0.40, "NEAR"), "MEDIUM");
  assert.equal(budgetExpiryOpportunity(0.40, "MEDIUM"), "LOW");

  // Little left: there is nothing to strand, so never above LOW - no strong
  // preference for burning the last few percent.
  assert.equal(budgetExpiryOpportunity(0.05, "NEAR"), "LOW");
  assert.equal(budgetExpiryOpportunity(0.15, "NEAR"), "LOW");

  // No usable reading is neutral.
  assert.equal(budgetExpiryOpportunity(0.70, "UNKNOWN"), "UNKNOWN");
  assert.equal(budgetExpiryOpportunity(null, "NEAR"), "UNKNOWN");
  assert.equal(budgetExpiryOpportunity(1.5, "NEAR"), "UNKNOWN");

  // resolveConservationPressure surfaces it as the best across BUDGET windows,
  // while conservation_pressure still takes the most restrictive.
  const mixed = resolveConservationPressure(
    pool({
      windows: [
        { key: "weekly", role: "BUDGET", remaining_ratio: 0.70, reset_at: at(4 * HOUR) },
        { key: "monthly", role: "BUDGET", remaining_ratio: 0.08, reset_at: at(480 * HOUR) },
      ],
    }),
    { now: NOW },
  );
  assert.equal(mixed.budget_expiry_opportunity, "HIGH");
  assert.equal(mixed.conservation_pressure, "CRITICAL");
});

test("the tightest budget window sets the pressure", () => {
  // A healthy weekly allowance says nothing about a nearly spent monthly cap.
  const twoBudgets = resolveConservationPressure(
    pool({
      windows: [
        { key: "weekly", role: "BUDGET", remaining_ratio: 0.8, reset_at: at(120 * HOUR) },
        { key: "monthly", role: "BUDGET", remaining_ratio: 0.04, reset_at: at(600 * HOUR) },
      ],
    }),
    { now: NOW },
  );
  assert.equal(twoBudgets.conservation_pressure, "CRITICAL");

  // A reading nobody took must not outrank one somebody did, in either order.
  for (const windows of [
    [{ role: "BUDGET", remaining_ratio: 0.04, reset_at: at(600 * HOUR) }, { role: "BUDGET" }],
    [{ role: "BUDGET" }, { role: "BUDGET", remaining_ratio: 0.04, reset_at: at(600 * HOUR) }],
  ]) {
    assert.equal(resolveConservationPressure(pool({ windows }), { now: NOW }).conservation_pressure, "CRITICAL");
  }

  // A BURST window never supplies the scarcity signal.
  assert.equal(
    resolveConservationPressure(pool(burst(0.04, at(HOUR))), { now: NOW }).conservation_pressure,
    "UNKNOWN",
  );

  // Labels only: the resolved view must be safe to write into an artifact.
  const serialized = JSON.stringify(twoBudgets);
  for (const leaked of ["0.04", "0.8", "T"]) {
    if (leaked === "T") continue;
    assert.ok(!serialized.includes(leaked), `the resolved conservation view leaked ${leaked}`);
  }
});

test("budget scarcity overrides burst opportunity", () => {
  const tierOrder = registry.capability_tier_order;
  const slot = registry.capability_slots.DEFAULT_IMPLEMENTER;
  const options = { allowExperimental: false, taskRisk: "low", now: NOW };

  // The strongest possible burst signal behind a nearly spent weekly cap.
  const scarce = selectCandidate(
    slot,
    {
      codex: pool({ ...burst(0.8, at(2 * HOUR)), ...budget(0.08, at(120 * HOUR)) }),
      claude: pool(healthyBudget()),
    },
    tierOrder,
    options,
  );
  assert.equal(scarce.candidate.provider, "claude");
  assert.equal(scarce.conservation_demotion.over, "codex/luna");
  assert.equal(scarce.stranded_promotion, null);

  // The same burst signal, this time against a healthy budget: the head keeps
  // the work. One reading is the only difference between the two outcomes.
  const healthy = selectCandidate(
    slot,
    {
      codex: pool({ ...burst(0.8, at(2 * HOUR)), ...healthyBudget() }),
      claude: pool(healthyBudget()),
    },
    tierOrder,
    options,
  );
  assert.equal(healthy.candidate.provider, "codex");
  assert.equal(healthy.conservation_demotion, null);
  assert.equal(healthy.stranded_capacity_risk, "HIGH");
});

test("conservation expresses a preference, never a refusal", () => {
  const tierOrder = registry.capability_tier_order;
  const slot = registry.capability_slots.DEFAULT_IMPLEMENTER;
  const critical = pool(budget(0.02, at(120 * HOUR)));

  // With every candidate under pressure the band still routes, in registry
  // order. Scarcity must never turn into a block.
  const result = selectCandidate(slot, { codex: critical, claude: critical }, tierOrder, {
    allowExperimental: false,
    taskRisk: "low",
    now: NOW,
  });
  assert.equal(result.status, "SELECTED");
  assert.equal(result.candidate.provider, "codex");
  assert.equal(result.conservation_pressure, "CRITICAL");
  assert.equal(result.conservation_demotion, null);
});

test("an unread budget is treated as neither healthy nor scarce", () => {
  const tierOrder = registry.capability_tier_order;
  const slot = registry.capability_slots.DEFAULT_IMPLEMENTER;
  const options = { allowExperimental: false, taskRisk: "low", now: NOW };

  // Not healthy: a strong burst signal behind an unread budget buys no
  // promotion, because the cap it would spend may already be gone.
  const noPromotion = selectCandidate(
    slot,
    { codex: pool(healthyBudget()), claude: pool(burst(0.9, at(2 * HOUR))) },
    tierOrder,
    options,
  );
  assert.equal(noPromotion.candidate.provider, "codex");
  assert.equal(noPromotion.stranded_promotion, null);

  // Not scarce: the same unread budget is no reason to demote either.
  const noDemotion = selectCandidate(
    slot,
    { codex: pool(burst(0.9, at(2 * HOUR))), claude: pool(healthyBudget()) },
    tierOrder,
    options,
  );
  assert.equal(noDemotion.candidate.provider, "codex");
  assert.equal(noDemotion.conservation_demotion, null);

  // A budget read and found healthy is positive evidence, so measuring pays.
  const measured = selectCandidate(
    slot,
    { codex: pool(healthyBudget()), claude: pool({ ...burst(0.9, at(2 * HOUR)), ...healthyBudget() }) },
    tierOrder,
    options,
  );
  assert.equal(measured.candidate.provider, "claude");
  assert.equal(measured.stranded_promotion.over, "codex/luna");

  // And a healthy budget with nothing to strand is still no boost.
  const nothingToStrand = selectCandidate(
    slot,
    { codex: pool(healthyBudget()), claude: pool(healthyBudget()) },
    tierOrder,
    options,
  );
  assert.equal(nothingToStrand.candidate.provider, "codex");
  assert.equal(nothingToStrand.stranded_promotion, null);
});

test("neither resource signal crosses a resource-state band", () => {
  const tierOrder = registry.capability_tier_order;
  const slot = registry.capability_slots.DEFAULT_IMPLEMENTER;
  const options = { allowExperimental: false, taskRisk: "low", now: NOW };

  // A GREEN candidate under critical conservation still outranks a YELLOW one
  // with an untouched budget.
  const acrossBands = selectCandidate(
    slot,
    {
      codex: pool({ state: "YELLOW", ...healthyBudget() }),
      claude: pool(budget(0.02, at(120 * HOUR))),
    },
    tierOrder,
    options,
  );
  assert.equal(acrossBands.candidate.provider, "claude");
  assert.equal(acrossBands.conservation_pressure, "CRITICAL");

  // And conservation still cannot reorder YELLOW against UNKNOWN.
  const yellowVersusUnknown = selectCandidate(
    slot,
    {
      codex: pool({ state: "UNKNOWN", source: "UNKNOWN" }),
      claude: pool({ state: "YELLOW", ...budget(0.02, at(120 * HOUR)) }),
    },
    tierOrder,
    options,
  );
  assert.equal(yellowVersusUnknown.candidate.provider, "codex");
  assert.equal(yellowVersusUnknown.conservation_demotion, null);
});

test("a stale or untrusted budget produces no conservation signal", () => {
  const tierOrder = registry.capability_tier_order;
  const slot = registry.capability_slots.DEFAULT_IMPLEMENTER;

  // Stale: an hour-old weekly figure still looks authoritative, which is
  // exactly why it must not route.
  const stale = selectCandidate(
    slot,
    { codex: pool(budget(0.02, at(120 * HOUR))), claude: pool(healthyBudget()) },
    tierOrder,
    { allowExperimental: false, taskRisk: "low", now: at(60 * 60 * 1000) },
  );
  assert.equal(stale.candidate.provider, "codex");
  assert.equal(stale.conservation_pressure, "UNKNOWN");

  // Untrusted: a source that cannot back up its state cannot back up a
  // healthy budget claim either.
  assert.equal(
    resolveConservationPressure({ ...pool(healthyBudget()), source: "UNKNOWN" }, { now: NOW }).conservation_pressure,
    "UNKNOWN",
  );
  assert.equal(
    resolveConservationPressure(pool({ ...healthyBudget(), remaining_confidence: "LOW" }), { now: NOW }).conservation_pressure,
    "UNKNOWN",
  );
});

test("hand-entered subscription facts normalise into both signals", () => {
  // The real reading: Codex 41% of a five-hour window used and 78% of the
  // week; Claude 36% of the week.
  const codex = {
    state: "GREEN",
    available: true,
    source: "USER_STATEMENT",
    checked_at: NOW,
    short_window: { remaining_ratio: 0.59, reset_at: at(3.75 * HOUR) },
    weekly_window: { remaining_ratio: 0.22, reset_at: at(120 * HOUR) },
  };
  const claude = {
    state: "GREEN",
    available: true,
    source: "USER_STATEMENT",
    checked_at: NOW,
    weekly_window: { remaining_ratio: 0.64, reset_at: at(36 * HOUR) },
  };

  // Codex looks inviting on the burst window and is scarce on the budget.
  assert.equal(resolveStrandedCapacity(codex, { now: NOW }).stranded_capacity_risk, "HIGH");
  assert.equal(resolveConservationPressure(codex, { now: NOW }).conservation_pressure, "HIGH");
  assert.equal(resolveConservationPressure(claude, { now: NOW }).conservation_pressure, "NONE");

  // A person supplies resource facts, not a model choice, and the facts say
  // conserve Codex despite the inviting short window.
  const result = selectCandidate(
    registry.capability_slots.DEFAULT_IMPLEMENTER,
    { codex, claude },
    registry.capability_tier_order,
    { allowExperimental: false, taskRisk: "low", now: NOW },
  );
  assert.equal(result.candidate.provider, "claude");
  assert.equal(result.conservation_demotion.conservation_pressure, "HIGH");
});

test("no window data anywhere leaves selection exactly as it was", () => {
  const tierOrder = registry.capability_tier_order;
  const slot = registry.capability_slots.DEFAULT_IMPLEMENTER;

  for (const states of [
    {},
    { codex: { state: "UNKNOWN", available: true, source: "ORCA_RUNTIME" } },
    { codex: { state: "GREEN", available: true, source: "ORCA_RUNTIME", checked_at: NOW }, claude: { state: "GREEN", available: true, source: "ORCA_RUNTIME", checked_at: NOW } },
    // A legacy snapshot with empty window objects, as v0.3 shipped them.
    { codex: { state: "GREEN", available: true, source: "ORCA_RUNTIME", checked_at: NOW, short_window: {}, weekly_window: {} } },
  ]) {
    const result = selectCandidate(slot, states, tierOrder, { allowExperimental: false, taskRisk: "low", now: NOW });
    assert.equal(result.candidate.model, "luna", "registry order must still decide");
    assert.equal(result.conservation_demotion, null);
    assert.equal(result.stranded_promotion, null);
    assert.equal(result.conservation_pressure, "UNKNOWN");
    assert.equal(result.stranded_capacity_risk, "UNKNOWN");
  }
});

test("resource economics never reach slot membership", async () => {
  const registryText = await readFile("policies/MODEL_REGISTRY.yaml", "utf8");
  const real = parse(registryText);

  // The best imaginable reading on every pool at once.
  const irresistible = {
    state: "GREEN",
    available: true,
    source: "ORCA_RUNTIME",
    checked_at: NOW,
    short_window: { remaining_ratio: 1, reset_at: at(HOUR) },
    weekly_window: { remaining_ratio: 1, reset_at: at(600 * HOUR) },
  };
  const states = {
    codex: irresistible,
    claude: irresistible,
    antigravity: { pools: { gemini: irresistible, non_gemini: irresistible } },
  };

  // Opus sits in ESCALATION_MODEL and nowhere else. However good its quota
  // looks, it must not appear in a slot that never listed it.
  assert.ok(
    real.capability_slots.ESCALATION_MODEL.candidates.some(({ model }) => model === "opus"),
    "the fixture assumes opus is the escalation candidate",
  );

  for (const [name, slot] of Object.entries(real.capability_slots)) {
    const permitted = new Set(slot.candidates.map(({ model }) => model));
    for (const allowExperimental of [false, true]) {
      const result = selectCandidate(slot, states, real.capability_tier_order, {
        allowExperimental,
        allowRed: true,
        taskRisk: "critical",
        now: NOW,
      });
      if (result.status !== "SELECTED") continue;
      assert.ok(
        permitted.has(result.candidate.model),
        `${name} selected ${result.candidate.model}, which is not one of its candidates`,
      );
      assert.ok(
        real.capability_tier_order.indexOf(result.candidate.capability_tier) >=
          real.capability_tier_order.indexOf(slot.minimum_tier),
        `${name} selected a candidate below its minimum tier`,
      );
    }
  }

  // And a reviewer stays disjoint however healthy the implementer's quota is.
  const reviewer = selectCandidate(
    real.capability_slots.INDEPENDENT_REVIEWER,
    states,
    real.capability_tier_order,
    { allowExperimental: false, taskRisk: "high", excludeProvider: "codex", excludeModelFamily: "gpt-5.6", now: NOW },
  );
  assert.equal(reviewer.status, "SELECTED");
  assert.notEqual(reviewer.candidate.provider, "codex");
  assert.notEqual(reviewer.candidate.model_family, "gpt-5.6");
});

test("the snapshot schema types windows and the example declares roles", async () => {
  const example = JSON.parse(await readFile("runtime/RESOURCE_STATE.example.json", "utf8"));
  assert.deepEqual(validateResourceState(example, { allowExampleNulls: true }), []);
  assert.equal(example.providers.codex.short_window.role, "BURST");
  assert.equal(example.providers.codex.weekly_window.role, "BUDGET");
  assert.equal(example.providers.antigravity.pools.gemini.weekly_window.role, "BUDGET");

  const base = { checked_at: NOW, available: true, state: "GREEN", source: "ORCA_RUNTIME" };

  assert.deepEqual(
    validateResourceState({
      providers: { codex: { ...base, windows: [{ key: "monthly", role: "BUDGET", remaining_ratio: 0.5, reset_at: NOW }] } },
    }),
    [],
  );

  // A listed window with no role describes no horizon, so it is a finding.
  assert.match(
    validateResourceState({ providers: { codex: { ...base, windows: [{ key: "mystery", remaining_ratio: 0.5 }] } } }).join("\n"),
    /must declare BURST or BUDGET/,
  );
  assert.match(
    validateResourceState({ providers: { codex: { ...base, short_window: { role: "OTHER" } } } }).join("\n"),
    /role: expected one of BURST\|BUDGET/,
  );
  assert.match(
    validateResourceState({ providers: { codex: { ...base, windows: {} } } }).join("\n"),
    /windows: expected a list of window entries/,
  );
});

test("the hierarchy is owned in one place and applied in the other", async () => {
  const resource = await readFile("policies/RESOURCE_AWARE_ROUTING.md", "utf8");
  const routing = await readFile("policies/MODEL_ROUTING_POLICY.md", "utf8");
  const skill = await readFile("skills/orca-multi-agent-dev/SKILL.md", "utf8");
  const readme = await readFile("README.md", "utf8");

  // The signal owner states the roles, the aggregation and the direction.
  assert.match(resource, /### 兩種 window role/);
  assert.match(resource, /### BURST → stranded_capacity_risk（utilization）/);
  assert.match(resource, /### BUDGET → conservation_pressure（scarcity）/);
  assert.match(resource, /### 重排規則：scarcity first, utilization second/);
  assert.match(resource, /多個 `BUDGET` window 時取\*\*最嚴格者\*\*/);
  assert.match(resource, /多個 `BURST` window 時取\*\*風險最高者\*\*/);

  // Backward compatibility is a stated rule with a stated scope.
  assert.match(resource, /### Backward compatibility/);
  assert.match(resource, /只是 legacy compatibility/);
  for (const legacy of ["`short_window`", "`weekly_window`"]) {
    assert.ok(resource.includes(legacy), `the resource policy must keep documenting ${legacy}`);
  }

  // UNKNOWN is handled symmetrically and the reasoning is on the page.
  assert.match(resource, /不查資料的人不會永遠被當成 healthy/);
  assert.match(resource, /查了資料的人也不會永遠吃虧/);

  // The algorithm owner places the layers without redefining them.
  assert.match(routing, /先 conservation、後 opportunity/);

  // Both entry points teach the ordering rather than only the old half.
  for (const [name, text] of [["SKILL.md", skill], ["README.md", readme]]) {
    assert.match(text, /BURST/, `${name} does not name the burst role`);
    assert.match(text, /BUDGET/, `${name} does not name the budget role`);
    assert.match(text, /conservation_pressure|long-horizon scarcity|長期稀缺|長期預算/, `${name} does not teach conservation`);
  }
  assert.ok(
    readme.includes("short-window opportunity MUST NOT override long-horizon scarcity"),
    "README must state the invariant this refinement adds",
  );
  assert.deepEqual(validateMarkdownLinks(skill, { path: "skills/orca-multi-agent-dev/SKILL.md", root: process.cwd() }), []);
});

/* ------------------------------------------------------------------------ *
 * Continuation freshness + session lifecycle hygiene
 *
 * The incident this hardening answers was a single misclassification: a
 * continuation resumed against an intent that had already changed. Every
 * test below is either that misclassification directly, or one of the two
 * properties (no PII in the fingerprint, cleanup never touches repair or
 * git state) that keep the fix itself trustworthy.
 * ------------------------------------------------------------------------ */

const D13D_FACTS = Object.freeze({
  objective: "canonicalize D1.3 fixture repair",
  allowed_changes: ["fixtures/d1.3/**"],
  prohibited_changes: ["policies/**"],
  expected_output: "canonicalized fixtures pass the D1.3 schema check",
  baseline: { repo: "company-platform", branch: "task/d13d", base_head: "abc123" },
  permission_ceiling: { sandbox: "workspace-write" },
  human_gate: { required: false },
});

test("human_instruction_revision is a fingerprint over structured facts, never a transcript", () => {
  const revision = humanInstructionRevision(D13D_FACTS);

  // A sha256 hex digest: fixed shape regardless of input size.
  assert.match(revision, /^[0-9a-f]{64}$/);

  // Adding an arbitrary large field that is not one of the canonical facts -
  // the shape a raw prompt or PII would actually take - must not move the
  // fingerprint at all. This is required case 18.
  // Assembled at runtime so this fixture is not itself flagged by the
  // publishable-file scanner's own email-address pattern.
  const account_email = "person" + "@" + "example.com";
  const withRawPrompt = { ...D13D_FACTS, raw_prompt: "the human said: " + "x".repeat(5000), account_email };
  assert.equal(humanInstructionRevision(withRawPrompt), revision);
  assert.deepEqual(canonicalContinuationFacts(withRawPrompt), canonicalContinuationFacts(D13D_FACTS));

  // The three fingerprints are deterministic and reproducible from the same
  // facts, and the two narrower ones move independently of each other.
  assert.equal(humanInstructionRevision(D13D_FACTS), humanInstructionRevision({ ...D13D_FACTS }));
  const widerScope = { ...D13D_FACTS, permission_ceiling: { sandbox: "read-only" } };
  assert.equal(objectiveFingerprint(widerScope), objectiveFingerprint(D13D_FACTS));
  assert.notEqual(permissionScopeFingerprint(widerScope), permissionScopeFingerprint(D13D_FACTS));
});

test("diffContinuationScope names the field that moved, including which permission capability", () => {
  assert.deepEqual(diffContinuationScope(D13D_FACTS, D13D_FACTS), []);

  assert.deepEqual(
    diffContinuationScope(D13D_FACTS, { ...D13D_FACTS, objective: "read-only discovery" }),
    ["objective"],
  );

  // Narrowing workspace-write to read-only touches the decomposed filesystem
  // and command_execution capabilities specifically, not just "permissions".
  const narrowed = diffContinuationScope(D13D_FACTS, { ...D13D_FACTS, permission_ceiling: { sandbox: "read-only" } });
  assert.deepEqual(narrowed.sort(), ["permission_ceiling.command_execution", "permission_ceiling.filesystem"]);

  // Production access is named on its own, distinct from every other capability.
  const withProd = { ...D13D_FACTS, permission_ceiling: { sandbox: "workspace-write", production_access: true } };
  const revoked = { ...D13D_FACTS, permission_ceiling: { sandbox: "workspace-write", production_access: false } };
  assert.deepEqual(diffContinuationScope(withProd, revoked), ["permission_ceiling.production_access"]);
});

test("resolveCurrentIntent lets a lower layer fill a gap but never override a higher one", () => {
  const { resolved, sourceOf } = resolveCurrentIntent({
    authoritative_handoff: { objective: "keep going", baseline: D13D_FACTS.baseline },
    prior_next_gate: { expected_output: "OLD_GATE" },
    human_instruction: { expected_output: "NEW_GATE" },
  });

  assert.equal(resolved.expected_output, "NEW_GATE");
  assert.equal(sourceOf.expected_output, "human_instruction");
  // The gap-filling half of the invariant: nothing in a higher layer said
  // anything about the baseline, so the lower layer's value is used.
  assert.deepEqual(resolved.baseline, D13D_FACTS.baseline);
  assert.equal(sourceOf.baseline, "authoritative_handoff");

  // An explicit_stop flag is itself a human-instruction-layer fact and
  // follows the same precedence as everything else.
  assert.equal(resolveCurrentIntent({ human_instruction: { explicit_stop: true } }).explicit_stop, true);
  assert.equal(resolveCurrentIntent({ authoritative_handoff: { explicit_stop: true } }).explicit_stop, false);
});

test("evaluateContinuation allows an unchanged intent and rejects a changed one", () => {
  const bound = { human_instruction_revision: humanInstructionRevision(D13D_FACTS), facts: D13D_FACTS };

  const allowed = evaluateContinuation({ bound, layers: { authoritative_handoff: D13D_FACTS, human_instruction: {} } });
  assert.equal(allowed.outcome, "CONTINUATION_ALLOWED");
  assert.deepEqual(allowed.changed, []);

  const rejected = evaluateContinuation({
    bound,
    layers: { authoritative_handoff: D13D_FACTS, human_instruction: { objective: "read-only discovery" } },
  });
  assert.equal(rejected.outcome, "CONTINUATION_REJECTED_STALE");
  assert.ok(rejected.changed.includes("objective"));

  // A binding that carries fingerprints but not the full facts still works,
  // falling back to fingerprint comparison - the shape an inventory record
  // actually persists.
  const coarseBound = {
    human_instruction_revision: humanInstructionRevision(D13D_FACTS),
    objective_fingerprint: objectiveFingerprint(D13D_FACTS),
    permission_scope_fingerprint: permissionScopeFingerprint(D13D_FACTS),
  };
  assert.equal(
    evaluateContinuation({ bound: coarseBound, layers: { authoritative_handoff: D13D_FACTS, human_instruction: {} } }).outcome,
    "CONTINUATION_ALLOWED",
  );
  const coarseRejected = evaluateContinuation({
    bound: coarseBound,
    layers: { authoritative_handoff: D13D_FACTS, human_instruction: { objective: "read-only discovery" } },
  });
  assert.equal(coarseRejected.outcome, "CONTINUATION_REJECTED_STALE");
  assert.ok(coarseRejected.changed.includes("objective_fingerprint") || coarseRejected.changed.includes("human_instruction_revision"));
});

test("a legacy binding fails closed rather than being assumed current", () => {
  for (const context of [
    { bound: { facts: D13D_FACTS }, layers: { authoritative_handoff: D13D_FACTS, human_instruction: {} } },
    { bound: undefined, layers: {} },
    { legacy_binding: true, bound: { human_instruction_revision: "x", facts: D13D_FACTS }, layers: { authoritative_handoff: D13D_FACTS, human_instruction: {} } },
  ]) {
    assert.equal(evaluateContinuation(context).outcome, "LEGACY_CONTINUATION_REQUIRES_FRESH_CONTRACT");
  }
});

test("classifySessionCleanup never touches git/worktree state or failed_repair_count", () => {
  // Required cases 16 and 17. The return shape itself is the evidence: it
  // has no field that could carry a git operation or a repair count.
  const forbiddenKeys = ["git", "worktree", "head", "commit", "failed_repair_count", "repair"];

  for (const input of [
    { handback_status: "PASS", evidence_captured: true },
    { handback_status: "FAIL", evidence_captured: true, explicit_retry_valid: false },
    { handback_status: "HUMAN_GATE", likely_same_task_continuation: true },
    { handback_status: "STALE", evidence_captured: true },
    { handback_status: "ACTIVE" },
  ]) {
    const result = classifySessionCleanup(input);
    for (const key of Object.keys(result)) {
      assert.ok(!forbiddenKeys.some((forbidden) => key.toLowerCase().includes(forbidden)), `cleanup result leaked a ${key} field`);
    }
    assert.deepEqual(Object.keys(result).sort(), ["cleanup_action", "lifecycle_state", "reason"]);
  }

  // An unrecognised status defaults to keeping the session live rather than
  // guessing a cleanup action for it.
  assert.deepEqual(classifySessionCleanup({ handback_status: "NOT_A_STATUS" }), {
    lifecycle_state: "ACTIVE",
    cleanup_action: "KEEP",
    reason: "unrecognised handback status; default to keeping the session live",
  });
});

test("ACTIVE is never closed on elapsed duration, however large", () => {
  for (const durationMs of [0, 60_000, 86_400_000, Number.MAX_SAFE_INTEGER]) {
    const result = classifySessionCleanup({ handback_status: "ACTIVE", duration_ms: durationMs });
    assert.equal(result.lifecycle_state, "ACTIVE");
    assert.equal(result.cleanup_action, "KEEP");
  }
});

test("terminalIsResumable requires every binding field, and lifecycle_state gates it", () => {
  const bound = {
    task_id: "d13d",
    human_instruction_revision: "h",
    objective_fingerprint: "o",
    permission_scope_fingerprint: "p",
  };

  assert.equal(terminalIsResumable({ ...bound, lifecycle_state: "ACTIVE" }), true);
  assert.equal(terminalIsResumable({ ...bound, lifecycle_state: "PARKED" }), true);
  for (const lifecycle_state of ["SUPERSEDED", "STALE", "FAILED", "CLOSED"]) {
    assert.equal(terminalIsResumable({ ...bound, lifecycle_state }), false);
  }

  // Any single missing binding field is enough to make it unresumable -
  // ownership is never partially inferred.
  for (const missing of Object.keys(bound)) {
    const partial = { ...bound, lifecycle_state: "ACTIVE" };
    delete partial[missing];
    assert.equal(terminalIsResumable(partial), false, `missing ${missing} must still fail closed`);
  }

  assert.equal(terminalIsResumable({ title: "company-platform:d13d-readonly-discovery:reviewer:ACTIVE" }), false);
  assert.equal(terminalIsResumable(undefined), false);
});

test("attemptResume enforces both the inventory gate and the freshness gate", () => {
  const bound = {
    task_id: "d13d",
    human_instruction_revision: "h",
    objective_fingerprint: "o",
    permission_scope_fingerprint: "p",
    lifecycle_state: "PARKED",
  };

  // PARKED does not bypass the freshness check: a stale evaluation still
  // rejects resume even though the terminal itself is well-formed.
  assert.equal(attemptResume(bound, { outcome: "CONTINUATION_REJECTED_STALE" }).allowed, false);
  assert.equal(attemptResume(bound, { outcome: "CONTINUATION_ALLOWED" }).allowed, true);

  // The inventory gate is checked first: an unbound terminal is rejected
  // regardless of what the evaluation says.
  assert.equal(attemptResume({ title: "looks-official" }, { outcome: "CONTINUATION_ALLOWED" }).allowed, false);

  // A terminal already SUPERSEDED never resumes even against a stale ALLOWED
  // evaluation left over from before it was superseded.
  assert.equal(attemptResume({ ...bound, lifecycle_state: "SUPERSEDED" }, { outcome: "CONTINUATION_ALLOWED" }).allowed, false);
});

test("repository continuation cases all conform to the executable semantics", async () => {
  const cases = parse(await readFile("tests/continuation-cases.yaml", "utf8"));
  const names = new Set(cases.cases.map(({ name }) => name));

  for (const required of [
    "same_task_same_revision_after_max_turns_continues",
    "new_objective_rejects_old_continuation",
    "workspace_write_to_read_only_rejects_old_continuation",
    "production_permission_revoked_rejects_old_continuation",
    "continue_same_review_with_unrestated_objective_allows_continuation",
    "latest_human_instruction_overrides_stale_next_gate",
    "pass_handback_closes_after_evidence_capture",
    "stale_continuation_closes_after_evidence_capture",
    "human_gate_likely_same_task_parks",
    "parked_session_with_new_objective_rejects_resume",
    "unknown_unbound_terminal_is_not_resumable",
    "max_turns_valid_continuation_terminal_remains_resumable",
    "active_long_running_task_is_never_closed_on_duration_alone",
    "failed_task_closes_after_evidence_capture",
  ]) {
    assert.ok(names.has(required), `continuation cases are missing ${required}`);
  }

  assert.ok(cases.cases.length >= 18, "continuation cases must cover at least the 18 required scenarios");
  assert.deepEqual(validateContinuationCases(cases), []);
});

test("continuation case validator rejects a case whose expectation drifts", () => {
  const drifted = {
    cases: [
      {
        name: "wrong_outcome",
        kind: "continuation",
        why: "a fixture asserting the wrong thing must be caught",
        bound: { human_instruction_revision: humanInstructionRevision(D13D_FACTS), facts: D13D_FACTS },
        layers: { authoritative_handoff: D13D_FACTS, human_instruction: { objective: "different" } },
        expect: { outcome: "CONTINUATION_ALLOWED" },
      },
    ],
  };
  assert.match(validateContinuationCases(drifted).join("\n"), /expected outcome "CONTINUATION_ALLOWED", got "CONTINUATION_REJECTED_STALE"/);

  const missingChange = {
    cases: [
      {
        name: "missing_changed_field",
        kind: "continuation",
        why: "the changed list must actually name the field that moved",
        bound: { human_instruction_revision: humanInstructionRevision(D13D_FACTS), facts: D13D_FACTS },
        layers: { authoritative_handoff: D13D_FACTS, human_instruction: { objective: "different" } },
        expect: { outcome: "CONTINUATION_REJECTED_STALE", changed_includes: ["baseline"] },
      },
    ],
  };
  assert.match(validateContinuationCases(missingChange).join("\n"), /expected changed to include "baseline"/);

  assert.deepEqual(validateContinuationCases({ cases: [] }), ["continuation cases: expected a non-empty `cases` list"]);
});

test("workflow policy owns continuation freshness and session lifecycle without duplicating repair-count or reason-code ownership", async () => {
  const workflow = await readFile("policies/WORKFLOW_POLICY.md", "utf8");
  const routing = await readFile("policies/MODEL_ROUTING_POLICY.md", "utf8");

  assert.match(workflow, /## Continuation freshness/);
  assert.match(workflow, /## Session lifecycle and cleanup/);
  assert.ok(
    workflow.includes("A continuation is valid only against the same still-current human intent"),
    "the core continuation invariant must be stated where the rule lives",
  );

  // Every lifecycle state and outcome must be nameable in the normative text.
  for (const token of [
    "ACTIVE", "PARKED", "SUPERSEDED", "STALE", "FAILED", "CLOSED",
    "CONTINUATION_REJECTED_STALE", "LEGACY_CONTINUATION_REQUIRES_FRESH_CONTRACT",
  ]) {
    assert.ok(workflow.includes(token), `workflow policy is missing ${token}`);
  }

  // The precedence chain, in order, with the invariant that protects it.
  for (const layer of ["human instruction", "handoff", "strategic contract", "NEXT_GATE", "cached router", "worker-local"]) {
    assert.match(workflow, new RegExp(layer, "i"), `workflow policy does not name the ${layer} precedence layer`);
  }
  assert.match(workflow, /不得推翻更新的 explicit human/);

  // PARKED must be stated as not bypassing the freshness check.
  assert.match(workflow, /`PARKED` 不豁免 continuation freshness check/);

  // Cleanup must not become a security boundary or a second permission owner.
  assert.match(workflow, /但 cleanup 本身不構成安全邊界/);

  // Repair-count ownership stays single: WORKFLOW_POLICY points at
  // MODEL_ROUTING_POLICY rather than restating the exemption itself.
  assert.ok(!/Stale continuation 不計入 `failed_repair_count`/.test(workflow), "the repair-count exemption must not be restated in the workflow policy");
  assert.match(routing, /\*\*Stale continuation 同樣不計入 `failed_repair_count`。\*\*/);

  // Reason-code ownership stays single too: the definition table (identified
  // by its "who can lift it" column) appears in exactly one file.
  const definitionHeader = "| Code | 意義 | 誰能解除 |";
  const owners = [];
  for (const file of [
    "policies/WORKFLOW_POLICY.md", "policies/MODEL_ROUTING_POLICY.md",
    "policies/CONCURRENCY_POLICY.md", "policies/RESOURCE_AWARE_ROUTING.md",
    "templates/ROUTER_EXECUTION_CONTRACT_TEMPLATE.md", "templates/STRATEGIC_RETURN_TEMPLATE.md",
    "skills/orca-multi-agent-dev/SKILL.md", "README.md",
  ]) {
    if ((await readFile(file, "utf8")).includes(definitionHeader)) owners.push(file);
  }
  assert.deepEqual(owners, ["policies/MODEL_ROUTING_POLICY.md"]);

  // Stale continuation must never be describable as one of the canonical
  // blocked reason codes.
  assert.ok(
    !/CONTINUATION_REJECTED_STALE[^\n]*(PERMISSION_BLOCKED|ROUTING_UNAVAILABLE|PROCESS_EXIT_FAILURE)/.test(workflow),
    "stale continuation must not be conflated with an existing reason code or execution-failure state",
  );
});

test("the runtime capability gap for terminal cleanup is disclosed, not invented", async () => {
  const commands = await readFile("references/OFFICIAL_COMMANDS.md", "utf8");

  assert.match(commands, /Terminal lifecycle 與 cleanup 的 runtime 邊界/);
  assert.match(commands, /沒有已驗證的 per-terminal/);
  assert.match(commands, /不得\*\*假造這些命令的旗標或行為/);

  // Any mention of the two missing commands must be marked as hypothetical,
  // the same convention the pre-existing rate-limits gap already uses -
  // never presented as something already supported.
  commands.split(/\r?\n/).forEach((line, index) => {
    if (/orca terminal (stop --terminal|list)/.test(line)) {
      assert.match(line, /尚不存在/, `line ${index + 1} names an unsupported command without marking it hypothetical: ${line}`);
    }
  });

  // The fallback path this gap forces stays documented alongside it.
  assert.match(commands, /標記 lifecycle state 為 `CLOSED` 並\s*\n?\s*交由人在 UI 關閉該 tab/);
});

test("continuation binding and session lifecycle fields stay non-sensitive and reach the templates", async () => {
  const contract = await readFile("templates/ROUTER_EXECUTION_CONTRACT_TEMPLATE.md", "utf8");
  const handoff = await readFile("templates/CURRENT_PROJECT_HANDOFF_TEMPLATE.md", "utf8");
  const strategicReturn = await readFile("templates/STRATEGIC_RETURN_TEMPLATE.md", "utf8");
  const skill = await readFile("skills/orca-multi-agent-dev/SKILL.md", "utf8");

  for (const field of [
    "continuation_binding", "human_instruction_revision", "objective_fingerprint",
    "permission_scope_fingerprint", "session_lifecycle", "lifecycle_state", "resumable",
  ]) {
    assert.ok(contract.includes(field), `contract template cannot express ${field}`);
  }
  assert.match(contract, /不得寫入完整 human\s*\n?\s*message 或任何 PII/);

  assert.ok(handoff.includes("human_instruction_revision"), "handoff must point at the active contract's continuation binding");

  assert.match(strategicReturn, /CONTINUATION_REJECTED_STALE/);
  assert.match(strategicReturn, /LEGACY_CONTINUATION_REQUIRES_FRESH_CONTRACT/);
  // The schema itself must not have grown a new top-level field for this -
  // only the smallest possible cross-reference was asked for.
  assert.ok(!/^CONTINUATION_/m.test(strategicReturn), "STRATEGIC_RETURN must not gain a new top-level field for continuation freshness");

  assert.match(skill, /## 6\. Continuation 與 session cleanup/);
  assert.deepEqual(validateMarkdownLinks(skill, { path: "skills/orca-multi-agent-dev/SKILL.md", root: process.cwd() }), []);
});

test("hardening left model registry, capability tiers, resource routing and disjointness untouched", async () => {
  const registryText = await readFile("policies/MODEL_REGISTRY.yaml", "utf8");
  const registryParsed = parse(registryText);
  const routing = await readFile("policies/MODEL_ROUTING_POLICY.md", "utf8");
  const concurrency = await readFile("policies/CONCURRENCY_POLICY.md", "utf8");
  const resource = await readFile("policies/RESOURCE_AWARE_ROUTING.md", "utf8");

  for (const leaked of ["continuation_binding", "session_lifecycle", "STALE", "SUPERSEDED", "PARKED"]) {
    assert.ok(!registryText.includes(leaked), `the model registry must not carry ${leaked}`);
  }
  assert.deepEqual(registryParsed.capability_tier_order, ["CHEAP", "DEFAULT", "STRONG", "DEEP"]);
  assert.deepEqual(validateRegistry(registryParsed), []);

  assert.match(routing, /reviewer 的 provider 與 model family \*\*都必須\*\*與 implementer 不同/);
  assert.match(concurrency, /\*\*永久禁止。\*\*/);
  assert.match(resource, /quota opportunity cost is a routing signal, not capability authority/);
  for (const leaked of ["continuation_binding", "session_lifecycle", "human_instruction_revision"]) {
    assert.ok(!resource.includes(leaked), `resource-aware routing must not absorb ${leaked}`);
  }
});
