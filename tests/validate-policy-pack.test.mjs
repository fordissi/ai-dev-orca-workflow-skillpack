import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { parse } from "yaml";
import {
  scanText,
  selectCandidate,
  validateHistory,
  validateMarkdownLinks,
  validateRegistry,
  validateResourceState,
  validateRepository,
  validateRoutingCases,
} from "../scripts/validate-policy-pack.mjs";

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
  for (const phrase of ["verify → classify → route → contract → execute → review → repair or escalate → close", "permission ceiling", "authoritative owner"]) assert.match(workflow, new RegExp(phrase));
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
