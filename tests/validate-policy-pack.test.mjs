import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { parse } from "yaml";
import {
  classifyCommand,
  classifyExecutionState,
  classifyPermissionRequest,
  normalizePermissionCeiling,
  scanText,
  selectCandidate,
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

test("high-risk work rejects experimental candidates unless explicitly allowed", () => {
  const slot = structuredClone(registry.capability_slots.DEFAULT_IMPLEMENTER);
  slot.candidates[0].status = "experimental";
  slot.candidates.splice(1);
  const selected = selectCandidate(slot, { codex: { state: "GREEN", available: true, source: "ORCA_RUNTIME" } }, registry.capability_tier_order, { allowExperimental: false, taskRisk: "high" });
  assert.equal(selected.status, "BLOCKED");
  assert.equal(typeof selected.reason, "string");
  assert.ok(selected.reason.length > 0);
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
    "experimental_high_risk_is_blocked", "repair_budget_exhausted",
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

test("experimental and RED authorisation default to false and are honoured when granted", () => {
  const tierOrder = registry.capability_tier_order;
  const trustedRed = { state: "RED", available: true, source: "ORCA_RUNTIME" };

  const experimentalSlot = structuredClone(registry.capability_slots.DEFAULT_IMPLEMENTER);
  experimentalSlot.candidates[0].status = "experimental";
  experimentalSlot.candidates.splice(1);
  const green = { codex: { state: "GREEN", available: true, source: "ORCA_RUNTIME" } };

  // Defaults: both authorisations absent means both are denied.
  assert.equal(selectCandidate(experimentalSlot, green, tierOrder, {}).status, "BLOCKED");
  assert.equal(
    selectCandidate(registry.capability_slots.DEFAULT_IMPLEMENTER, { codex: trustedRed, claude: trustedRed }, tierOrder, {}).code,
    "RESOURCE_BLOCKED",
  );

  // Granted explicitly in the Strategic Contract, both proceed.
  assert.equal(selectCandidate(experimentalSlot, green, tierOrder, { allowExperimental: true }).status, "SELECTED");
  assert.equal(
    selectCandidate(registry.capability_slots.DEFAULT_IMPLEMENTER, { codex: trustedRed, claude: trustedRed }, tierOrder, { allowRed: true }).status,
    "SELECTED",
  );
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
