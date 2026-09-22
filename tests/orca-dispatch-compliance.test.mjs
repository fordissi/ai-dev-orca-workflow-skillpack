import assert from "node:assert/strict";
import test from "node:test";
import * as policy from "../scripts/validate-policy-pack.mjs";

const validOrcaEvidence = (overrides = {}) => ({
  orca_terminal_handle: "terminal-42",
  runtime_adapter: "codex_cli",
  provider_family: "codex",
  exact_model: "gpt-5.6-terra",
  effort: "high",
  launch_command: "codex exec -m gpt-5.6-terra -c 'model_reasoning_effort=\"high\"' -",
  lifecycle: {
    terminal_started: true,
    model_launched: true,
    worker_active: true,
    completed: true,
  },
  ...overrides,
});

const evaluate = (input) => {
  assert.equal(typeof policy.evaluateDispatchCompliance, "function", "dispatch compliance evaluator is required");
  return policy.evaluateDispatchCompliance(input);
};

test("Orca worker routed through invoke_subagent is a hard failure", () => {
  const result = evaluate({
    task_class: "SPECIALIST_REVIEWER",
    dispatch_mode: "ORCA_WORKER",
    execution_mechanism: "ANTIGRAVITY_INVOKE_SUBAGENT",
  });
  assert.equal(result.workflow_policy_compliance, "NON_COMPLIANT");
  assert.equal(result.result, "HARD_FAIL");
  assert.equal(result.reason_code, "INTERNAL_SUBAGENT_AS_ORCA_WORKER");
  assert.equal(result.orca_dispatch_verified, "NO");
});

test("explicit INTERNAL_SUBAGENT is allowed only when policy permits the task class", () => {
  const result = evaluate({
    task_class: "BOUNDED_RESEARCH_ASSIST",
    dispatch_mode: "INTERNAL_SUBAGENT",
    execution_mechanism: "ANTIGRAVITY_INVOKE_SUBAGENT",
    internal_subagent_policy: "ALLOWED",
  });
  assert.equal(result.workflow_policy_compliance, "COMPLIANT");
  assert.equal(result.result, "PASS");
  assert.equal(result.orca_dispatch_required, false);
});

test("Orca worker with terminal handle and exact runtime evidence is compliant", () => {
  const result = evaluate({
    task_class: "IMPLEMENTATION_WORKER",
    dispatch_mode: "ORCA_WORKER",
    execution_mechanism: "ORCA_TERMINAL",
    requested_identity: {
      runtime_adapter: "codex_cli",
      provider_family: "codex",
      exact_model: "gpt-5.6-terra",
      effort: "high",
    },
    evidence: validOrcaEvidence(),
  });
  assert.equal(result.workflow_policy_compliance, "COMPLIANT");
  assert.equal(result.result, "PASS");
  assert.equal(result.orca_dispatch_verified, "YES");
  assert.equal(result.exact_runtime_attestation, "MATCH");
});

test("missing Orca terminal handle cannot verify Orca dispatch", () => {
  const evidence = validOrcaEvidence();
  delete evidence.orca_terminal_handle;
  const result = evaluate({
    task_class: "ARCHITECTURE_SPECIALIST",
    dispatch_mode: "ORCA_WORKER",
    execution_mechanism: "ORCA_TERMINAL",
    evidence,
  });
  assert.equal(result.orca_dispatch_verified, "NO");
  assert.equal(result.result, "DISPATCH_BLOCKED");
  assert.equal(result.reason_code, "ORCA_TERMINAL_HANDLE_MISSING");
});

test("requested exact provider/model differing from actual evidence fails exact dispatch", () => {
  const result = evaluate({
    task_class: "SECURITY_SPECIALIST",
    dispatch_mode: "ORCA_WORKER",
    execution_mechanism: "ORCA_TERMINAL",
    requested_identity: {
      runtime_adapter: "claude_cli",
      provider_family: "claude",
      exact_model: "opus",
      effort: "high",
    },
    evidence: validOrcaEvidence(),
  });
  assert.equal(result.workflow_policy_compliance, "NON_COMPLIANT");
  assert.equal(result.result, "HARD_FAIL");
  assert.equal(result.reason_code, "EXACT_DISPATCH_FAILURE");
  assert.equal(result.exact_runtime_attestation, "MISMATCH");
});
