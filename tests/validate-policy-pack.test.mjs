import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { parse } from "yaml";
import {
  scanText,
  selectCandidate,
  validateRegistry,
  validateResourceState,
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
    codex: { state: "UNKNOWN", available: true },
    claude: { state: "UNKNOWN", available: true },
  }, registry.capability_tier_order, { allowExperimental: false, taskRisk: "low" });
  assert.equal(selected.status, "SELECTED");
  assert.equal(selected.candidate.model, "luna");
});

test("UNKNOWN primary is not demoted below a YELLOW fallback", () => {
  const selected = selectCandidate(registry.capability_slots.DEFAULT_IMPLEMENTER, {
    codex: { state: "UNKNOWN", available: true },
    claude: { state: "YELLOW", available: true },
  }, registry.capability_tier_order, { allowExperimental: false, taskRisk: "low" });
  assert.equal(selected.candidate.model, "luna");
});

test("YELLOW resource state is not demoted below UNKNOWN", () => {
  const selected = selectCandidate(registry.capability_slots.DEFAULT_IMPLEMENTER, {
    codex: { state: "YELLOW", available: true },
    claude: { state: "UNKNOWN", available: true },
  }, registry.capability_tier_order, { allowExperimental: false, taskRisk: "low" });
  assert.equal(selected.candidate.model, "luna");
});

test("GREEN candidate is preferred over RED without crossing the minimum", () => {
  const selected = selectCandidate(registry.capability_slots.DEFAULT_IMPLEMENTER, {
    codex: { state: "RED", available: true },
    claude: { state: "GREEN", available: true },
  }, registry.capability_tier_order, { allowExperimental: false, taskRisk: "low" });
  assert.equal(selected.candidate.model, "sonnet");
});

test("high-risk work rejects experimental candidates unless explicitly allowed", () => {
  const slot = structuredClone(registry.capability_slots.DEFAULT_IMPLEMENTER);
  slot.candidates[0].status = "experimental";
  slot.candidates.splice(1);
  const selected = selectCandidate(slot, { codex: { state: "GREEN", available: true } }, registry.capability_tier_order, { allowExperimental: false, taskRisk: "high" });
  assert.equal(selected.status, "BLOCKED");
  assert.equal(typeof selected.reason, "string");
  assert.ok(selected.reason.length > 0);
});

test("independent review excludes the implementer provider and model family", () => {
  const selected = selectCandidate(registry.capability_slots.DEFAULT_IMPLEMENTER, {
    codex: { state: "GREEN", available: true },
    claude: { state: "UNKNOWN", available: true },
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
  assert.equal(cases.cases.length, 10);
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
