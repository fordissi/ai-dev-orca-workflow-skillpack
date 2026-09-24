import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { parse } from "yaml";
import * as policy from "../scripts/validate-policy-pack.mjs";

// Regression coverage for the ORCA_WORKER_DISPATCH_REQUIRED incident: a
// Company Platform specialist designated as an Orca worker was executed via
// Antigravity invoke_subagent. Rewritten for the supervised-first contract:
// canonical worker identity is TASK_ID + DISPATCH_ID + launch evidence, and a
// terminal handle is optional evidence, never the identity.

const registry = parse(await readFile("policies/MODEL_REGISTRY.yaml", "utf8"));

const requestedTerra = {
  runtime_adapter: "codex_cli",
  provider_family: "openai",
  exact_model: "gpt-5.6-terra",
  effort: "high",
};

const supervisedEvidence = (overrides = {}) => ({
  task_id: "task_terra1",
  dispatch_id: "ctx_terra1",
  launch: {
    requested: { agent: "codex", model: "gpt-5.6-terra", effort: "high" },
    effective: { agent: "codex", model: "gpt-5.6-terra", effort: "high" },
  },
  lifecycle: { model_launched: true, worker_active: true, completed: true },
  completion: {
    type: "worker_done",
    body: "Implemented the change. Tests pass. Nothing remains.",
    payload: { taskId: "task_terra1", dispatchId: "ctx_terra1", outcome: "succeeded" },
  },
  ...overrides,
});

const evaluate = (input) => {
  assert.equal(typeof policy.evaluateDispatchCompliance, "function", "dispatch compliance evaluator is required");
  return policy.evaluateDispatchCompliance({ registry, ...input });
};

test("1. Orca worker routed through invoke_subagent is a hard failure", () => {
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

test("2. explicit INTERNAL_SUBAGENT is allowed only when policy permits the task class", () => {
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

test("3. supervised worker-start with matching launch.effective is compliant", () => {
  const result = evaluate({
    task_class: "IMPLEMENTATION_WORKER",
    dispatch_mode: "ORCA_WORKER",
    execution_mechanism: "ORCA_WORKER_START",
    requested_identity: requestedTerra,
    evidence: supervisedEvidence(),
  });
  assert.equal(result.workflow_policy_compliance, "COMPLIANT");
  assert.equal(result.result, "PASS");
  assert.equal(result.orca_dispatch_verified, "YES");
  assert.equal(result.exact_runtime_attestation, "MATCH");
  assert.equal(result.dispatch_path, "WORKER_START");
});

test("4. missing Dispatch identity cannot verify Orca dispatch, terminal or not", () => {
  const result = evaluate({
    task_class: "ARCHITECTURE_SPECIALIST",
    dispatch_mode: "ORCA_WORKER",
    execution_mechanism: "ORCA_WORKER_START",
    requested_identity: requestedTerra,
    evidence: supervisedEvidence({ dispatch_id: undefined, terminal_handle: "term_present" }),
  });
  assert.equal(result.orca_dispatch_verified, "NO");
  assert.equal(result.result, "DISPATCH_BLOCKED");
  assert.equal(result.reason_code, "ORCA_DISPATCH_IDENTITY_MISSING");
});

test("4b. a bare terminal handle (terminal create + send) is a lightweight prompt, not a worker", () => {
  const result = evaluate({
    task_class: "ARCHITECTURE_SPECIALIST",
    dispatch_mode: "ORCA_WORKER",
    execution_mechanism: "ORCA_TERMINAL_PROMPT",
    requested_identity: requestedTerra,
    evidence: { terminal_handle: "terminal-42", launch_command: "codex -m gpt-5.6-terra" },
  });
  assert.equal(result.orca_dispatch_verified, "NO");
  assert.equal(result.result, "HARD_FAIL");
  assert.equal(result.reason_code, "LIGHTWEIGHT_TERMINAL_PROMPT_AS_ORCA_WORKER");
});

test("5. requested exact model differing from launch.effective fails exact dispatch", () => {
  const result = evaluate({
    task_class: "SECURITY_SPECIALIST",
    dispatch_mode: "ORCA_WORKER",
    execution_mechanism: "ORCA_WORKER_START",
    requested_identity: requestedTerra,
    evidence: supervisedEvidence({
      launch: {
        requested: { agent: "codex", model: "gpt-5.6-terra", effort: "high" },
        effective: { agent: "codex", model: "gpt-5.5", effort: "high" },
      },
    }),
  });
  assert.equal(result.workflow_policy_compliance, "NON_COMPLIANT");
  assert.equal(result.result, "HARD_FAIL");
  assert.equal(result.reason_code, "EXACT_DISPATCH_FAILURE");
  assert.equal(result.exact_runtime_attestation, "MISMATCH");
});
