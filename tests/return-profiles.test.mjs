import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { parse as parseYaml } from "yaml";
import {
  classifyCallbackRecovery,
  HUMAN_INTERACTION_TYPES,
  NORMALIZED_EXECUTION_STATUSES,
  normalizeExecutionState,
  resolveCapability,
  resolveResourceAcquisition,
  resolveReturnProfile,
  resolveRouterReserve,
  RETURN_BOUNDARIES,
  RETURN_PROFILES,
  selectCandidate,
  validateReturnPayload,
  verifyExternalHandoffCompleteness,
} from "../scripts/validate-policy-pack.mjs";

test("1. successful worker → INTERNAL_COMPACT", () => {
  const result = resolveReturnProfile({ boundary: "WORKER_TO_ROUTER", status: "PASS" });
  assert.equal(result.profile, "INTERNAL_COMPACT");
  assert.equal(result.expanded, false);
});

test("2. successful reviewer → INTERNAL_COMPACT", () => {
  const result = resolveReturnProfile({ boundary: "REVIEWER_TO_ROUTER", status: "PASS" });
  assert.equal(result.profile, "INTERNAL_COMPACT");
  assert.equal(result.expanded, false);
});

test("3. clean internal PASS omits redundant invariant repetition", () => {
  const compactPayload = {
    return_profile: "INTERNAL_COMPACT",
    status: "PASS",
    artifact: "commit 9960f24",
    validation: "PASS",
    exceptions: "NONE",
  };
  const validation = validateReturnPayload(compactPayload, { boundary: "WORKER_TO_ROUTER" });
  assert.equal(validation.valid, true);
  assert.equal(validation.findings.length, 0);

  // Redundant fields are absent and not required:
  assert.equal(compactPayload.secret_in_git, undefined);
  assert.equal(compactPayload.secret_in_logs, undefined);
  assert.equal(compactPayload.secret_in_argv, undefined);
  assert.equal(compactPayload.router_env_dependency, undefined);
  assert.equal(compactPayload.worker_receives_secret, undefined);
});

test("4. internal HUMAN_GATE expands with reason/evidence", () => {
  const resolution = resolveReturnProfile({ boundary: "WORKER_TO_ROUTER", status: "HUMAN_GATE" });
  assert.equal(resolution.profile, "INTERNAL_COMPACT");
  assert.equal(resolution.expanded, true);

  // Unexpanded fails validation
  const unexpanded = {
    return_profile: "INTERNAL_COMPACT",
    status: "HUMAN_GATE",
  };
  const invalid = validateReturnPayload(unexpanded, { boundary: "WORKER_TO_ROUTER" });
  assert.equal(invalid.valid, false);
  assert.ok(invalid.findings.some((f) => f.includes("reason_code")));
  assert.ok(invalid.findings.some((f) => f.includes("evidence")));
  assert.ok(invalid.findings.some((f) => f.includes("unresolved_state")));
  assert.ok(invalid.findings.some((f) => f.includes("required_next_action")));

  // Expanded passes validation
  const expanded = {
    return_profile: "INTERNAL_COMPACT",
    status: "HUMAN_GATE",
    reason_code: "AUTHORIZATION_REQUIRED",
    evidence: "privileged db migration requested",
    unresolved_state: "authorization pending human sign-off",
    required_next_action: "human review and approval",
  };
  const valid = validateReturnPayload(expanded, { boundary: "WORKER_TO_ROUTER" });
  assert.equal(valid.valid, true);
});

test("5. internal BLOCKED expands", () => {
  const resolution = resolveReturnProfile({ boundary: "WORKER_TO_ROUTER", status: "BLOCKED" });
  assert.equal(resolution.profile, "INTERNAL_COMPACT");
  assert.equal(resolution.expanded, true);

  const blocked = {
    return_profile: "INTERNAL_COMPACT",
    status: "BLOCKED",
    reason_code: "CAPABILITY_UNAVAILABLE",
    evidence: "requested capability FOUNDATION_DB_READONLY has no approved mechanism",
    unresolved_state: "capability fulfillment failed",
    required_next_action: "operator runtime mechanism configuration",
  };
  const valid = validateReturnPayload(blocked, { boundary: "WORKER_TO_ROUTER" });
  assert.equal(valid.valid, true);
});

test("6. security exception cannot be hidden by INTERNAL_COMPACT", () => {
  const attemptToHide = {
    return_profile: "INTERNAL_COMPACT",
    status: "PASS",
    artifact: "commit 1234567",
    validation: "PASS",
    exceptions: "NONE",
  };
  const result = validateReturnPayload(attemptToHide, {
    boundary: "WORKER_TO_ROUTER",
    security_exception: true,
  });
  assert.equal(result.valid, false);
  assert.ok(result.findings.some((f) => f.includes("security exception")));
});

test("7. Router external result → EXTERNAL_HANDOFF", () => {
  const result = resolveReturnProfile({ boundary: "ROUTER_TO_EXTERNAL", status: "PASS" });
  assert.equal(result.profile, "EXTERNAL_HANDOFF");
});

test("8. EXTERNAL_HANDOFF preserves authoritative commit/result", () => {
  const noArtifact = {
    return_profile: "EXTERNAL_HANDOFF",
    status: "PASS",
    current_state: { what_changed: "updated policy", repo: "orca-pack" },
    not_done: "none",
    next_gate: "human acceptance",
    key_evidence: "npm test passed",
  };
  const invalid = validateReturnPayload(noArtifact, { boundary: "ROUTER_TO_EXTERNAL" });
  assert.equal(invalid.valid, false);
  assert.ok(invalid.findings.some((f) => f.includes("artifact")));

  const withArtifact = {
    ...noArtifact,
    artifact: "commit 9960f24",
  };
  const valid = validateReturnPayload(withArtifact, { boundary: "ROUTER_TO_EXTERNAL" });
  assert.equal(valid.valid, true);
});

test("9. EXTERNAL_HANDOFF preserves material NOT_DONE state", () => {
  const noNotDone = {
    return_profile: "EXTERNAL_HANDOFF",
    status: "PASS",
    artifact: "commit 9960f24",
    current_state: { what_changed: "updated policy" },
    next_gate: "human review",
    key_evidence: "validation passed",
  };
  const invalid = validateReturnPayload(noNotDone, { boundary: "ROUTER_TO_EXTERNAL" });
  assert.equal(invalid.valid, false);
  assert.ok(invalid.findings.some((f) => f.includes("not_done")));
});

test("10. EXTERNAL_HANDOFF preserves NEXT_GATE", () => {
  const noNextGate = {
    return_profile: "EXTERNAL_HANDOFF",
    status: "PASS",
    artifact: "commit 9960f24",
    current_state: { what_changed: "updated policy" },
    not_done: "no production deploy",
    key_evidence: "validation passed",
  };
  const invalid = validateReturnPayload(noNextGate, { boundary: "ROUTER_TO_EXTERNAL" });
  assert.equal(invalid.valid, false);
  assert.ok(invalid.findings.some((f) => f.includes("next_gate")));
});

test("11. external sensitive capability result preserves material boundary evidence", () => {
  const sensitiveWithoutBoundaries = {
    return_profile: "EXTERNAL_HANDOFF",
    status: "PASS",
    artifact: "commit 9960f24",
    current_state: { what_changed: "read DB view" },
    not_done: "none",
    next_gate: "review",
    key_evidence: "query succeeded",
  };
  const invalid = validateReturnPayload(sensitiveWithoutBoundaries, {
    boundary: "ROUTER_TO_EXTERNAL",
    sensitive_capability_used: true,
  });
  assert.equal(invalid.valid, false);
  assert.ok(invalid.findings.some((f) => f.includes("boundary evidence")));

  const sensitiveWithBoundaries = {
    ...sensitiveWithoutBoundaries,
    boundaries: {
      capability_wrapper_used: true,
      worker_receives_secret: "NO",
      privileged_operation_performed: "NO",
    },
  };
  const valid = validateReturnPayload(sensitiveWithBoundaries, {
    boundary: "ROUTER_TO_EXTERNAL",
    sensitive_capability_used: true,
  });
  assert.equal(valid.valid, true);
});

test("12. duplicate equivalent fields are not required", () => {
  const handoff = {
    return_profile: "EXTERNAL_HANDOFF",
    status: "PASS",
    artifact: "commit 9960f24",
    current_state: { what_changed: "schema check" },
    not_done: "none",
    next_gate: "close",
    key_evidence: "tests clean",
    boundaries: {
      target_match: "TARGET_MATCH",
    },
  };
  const result = validateReturnPayload(handoff, { boundary: "ROUTER_TO_EXTERNAL" });
  assert.equal(result.valid, true);
  // Redundant aliases not present:
  assert.equal(handoff.target, undefined);
  assert.equal(handoff.database_target, undefined);
});

test("13. explicit human full-audit request → AUDIT_FULL", () => {
  const result = resolveReturnProfile({
    boundary: "WORKER_TO_ROUTER",
    explicit_audit_request: true,
  });
  assert.equal(result.profile, "AUDIT_FULL");
});

test("14. G1 success does not default to AUDIT_FULL", () => {
  const internal = resolveReturnProfile({
    boundary: "WORKER_TO_ROUTER",
    governance_tier: "G1_LIGHTWEIGHT",
    status: "PASS",
  });
  assert.equal(internal.profile, "INTERNAL_COMPACT");

  const external = resolveReturnProfile({
    boundary: "ROUTER_TO_EXTERNAL",
    governance_tier: "G1_LIGHTWEIGHT",
    status: "PASS",
  });
  assert.equal(external.profile, "EXTERNAL_HANDOFF");
});

test("15. G3 does not automatically force every internal return to full verbosity", () => {
  const internalG3 = resolveReturnProfile({
    boundary: "WORKER_TO_ROUTER",
    governance_tier: "G3_HIGH_RISK",
    status: "PASS",
  });
  assert.equal(internalG3.profile, "INTERNAL_COMPACT");
  assert.equal(internalG3.expanded, false);
});

test("16. callback recovery semantics unchanged", () => {
  const evidence = {
    worker_state: "completed",
    worker_read: { complete: true, ambiguous: false },
  };
  const normal = classifyCallbackRecovery(evidence);
  assert.equal(normal.tier, "WORKER_READ");
  assert.equal(normal.callback_transport, "FAILED_RECOVERED");
  assert.equal(normal.duplicate_dispatch, false);
});

test("17. capability semantics unchanged", () => {
  const request = {
    requested: ["FOUNDATION_DB_READONLY"],
    authorization: "not_required",
    task_requires_capability: true,
    fulfillment_mechanism: "CAPABILITY_WRAPPER",
    wrapper_allowlist_only: true,
    effective_privilege: "READONLY",
    worker_receives_secret: "NO",
  };
  const resolved = resolveCapability(request);
  assert.equal(resolved.outcome, "CAPABILITY_FULFILLED");
  assert.equal(resolved.effective_privilege, "READONLY");
  assert.equal(resolved.worker_receives_secret, "NO");
});

test("18. model selection unchanged by return_profile", async () => {
  const registryText = await readFile("policies/MODEL_REGISTRY.yaml", "utf8");
  const registry = parseYaml(registryText);
  const slot = registry.capability_slots.DEFAULT_IMPLEMENTER;
  const states = {
    codex: { state: "AVAILABLE", checked_at: new Date().toISOString() },
    claude: { state: "AVAILABLE", checked_at: new Date().toISOString() },
  };

  const candidateDefault = selectCandidate(slot, states, registry.capability_tier_order, {});
  const candidateCompact = selectCandidate(slot, states, registry.capability_tier_order, {
    return_profile: "INTERNAL_COMPACT",
  });
  const candidateAudit = selectCandidate(slot, states, registry.capability_tier_order, {
    return_profile: "AUDIT_FULL",
  });

  assert.deepEqual(candidateDefault, candidateCompact);
  assert.deepEqual(candidateDefault, candidateAudit);
});

test("19. provider quota routing unchanged", () => {
  const entry = {
    state: "AVAILABLE",
    remaining_ratio: 0.05,
    reset_at: new Date(Date.now() + 3600000).toISOString(),
    checked_at: new Date().toISOString(),
    windows: [{ role: "BUDGET", remaining_ratio: 0.05, reset_at: new Date(Date.now() + 3600000).toISOString() }],
  };
  const r1 = resolveRouterReserve(entry);
  const r2 = resolveRouterReserve(entry, { return_profile: "INTERNAL_COMPACT" });
  const r3 = resolveRouterReserve(entry, { return_profile: "AUDIT_FULL" });
  assert.deepEqual(r1, r2);
  assert.deepEqual(r1, r3);

  const acq1 = resolveResourceAcquisition({ probe: { checked_at: new Date().toISOString() } });
  const acq2 = resolveResourceAcquisition({ probe: { checked_at: new Date().toISOString() } }, { return_profile: "AUDIT_FULL" });
  assert.deepEqual(acq1, acq2);
});

test("20. legacy detailed return remains accepted where compatibility requires it", () => {
  // Legacy shape without explicit return_profile field
  const legacyReturn = {
    status: "PASS",
    artifact: "commit 9960f24",
    validation: "PASS",
    exceptions: "NONE",
  };
  const result = validateReturnPayload(legacyReturn, { boundary: "WORKER_TO_ROUTER" });
  assert.equal(result.valid, true);
  assert.equal(result.profile, "INTERNAL_COMPACT");
});

test("21. compact profile cannot suppress policy exception", () => {
  const suppressedAttempt = {
    return_profile: "INTERNAL_COMPACT",
    status: "PASS",
    artifact: "commit 9960f24",
    validation: "PASS",
    exceptions: "NONE",
    policy_exception: true,
  };
  const validation = validateReturnPayload(suppressedAttempt, { boundary: "WORKER_TO_ROUTER" });
  assert.equal(validation.valid, false);
  assert.ok(validation.findings.some((f) => f.includes("cannot suppress policy or security exception")));
});

test("22. external handoff contains sufficient fields to continue from another runtime without transcript access", () => {
  const completeHandoff = {
    status: "PASS",
    current_state: {
      repo: "ai-dev-orca-workflow-skillpack",
      branch: "main",
      base_head: "9960f24",
      result_head: "9960f24",
      working_tree: "clean",
      what_changed: "introduced tiered return profiles policy and conformance validators",
    },
    artifact: "commit 9960f24",
    key_evidence: {
      verification: "npm test passed (182 tests) and npm run validate passed",
      freshness: "fresh",
    },
    decisions: [
      "added resolveReturnProfile, validateReturnPayload, verifyExternalHandoffCompleteness",
      "retained single-source ownership in WORKFLOW_POLICY.md",
    ],
    boundaries: {
      privileged_operation_performed: "NO",
      production_mutation_performed: "NO",
    },
    not_done: "no registry modification, no routing semantics alteration",
    next_gate: "human review and PR merge",
    dispatch: {
      provider: "antigravity",
      model: "gemini-3.8-flash-high",
    },
  };

  const completeness = verifyExternalHandoffCompleteness(completeHandoff);
  assert.equal(completeness.complete, true);
  assert.equal(completeness.can_continue_without_transcript, true);
  assert.deepEqual(completeness.missing, []);
});

test("normalized state and reason model behaves deterministically", () => {
  const pass = normalizeExecutionState({ status: "PASS" });
  assert.equal(pass.status, "PASS");

  const gate = normalizeExecutionState({ status: "HUMAN_GATE", reason_code: "AUTHORIZATION_REQUIRED" });
  assert.equal(gate.status, "HUMAN_GATE");
  assert.equal(gate.reason_code, "AUTHORIZATION_REQUIRED");

  const retryable = normalizeExecutionState({ status: "FAIL", retryable: true, reason_code: "CALLBACK_TRANSPORT_FAILURE" });
  assert.equal(retryable.status, "RETRYABLE");
  assert.equal(retryable.reason_code, "CALLBACK_TRANSPORT_FAILURE");

  const blocked = normalizeExecutionState({ status: "BLOCKED", reason_code: "CAPABILITY_UNAVAILABLE" });
  assert.equal(blocked.status, "BLOCKED");
  assert.equal(blocked.reason_code, "CAPABILITY_UNAVAILABLE");
});

test("human action vs human gate distinction is clearly typed", () => {
  assert.deepEqual(HUMAN_INTERACTION_TYPES, ["HUMAN_ACTION", "HUMAN_GATE"]);
  assert.deepEqual(RETURN_PROFILES, ["INTERNAL_COMPACT", "EXTERNAL_HANDOFF", "AUDIT_FULL"]);
  assert.deepEqual(RETURN_BOUNDARIES, ["WORKER_TO_ROUTER", "REVIEWER_TO_ROUTER", "ROUTER_TO_EXTERNAL"]);
  assert.deepEqual(NORMALIZED_EXECUTION_STATUSES, ["PASS", "RETRYABLE", "HUMAN_GATE", "BLOCKED"]);
});

test("the policy owns the tiered return and handoff profiles and avoids duplication", async () => {
  const workflow = await readFile("policies/WORKFLOW_POLICY.md", "utf8");
  const contract = await readFile("templates/ROUTER_EXECUTION_CONTRACT_TEMPLATE.md", "utf8");
  const strategicReturn = await readFile("templates/STRATEGIC_RETURN_TEMPLATE.md", "utf8");
  const skill = await readFile("skills/orca-multi-agent-dev/SKILL.md", "utf8");

  // WORKFLOW_POLICY is the normative owner
  assert.match(workflow, /## Tiered return and handoff profiles/);
  assert.match(workflow, /tiered return \/ handoff profiles/);
  assert.match(workflow, /The return profile controls reporting detail only/);

  for (const profile of ["INTERNAL_COMPACT", "EXTERNAL_HANDOFF", "AUDIT_FULL"]) {
    assert.ok(workflow.includes(profile), `workflow policy must name ${profile}`);
  }

  // Templates and SKILL link or refer to WORKFLOW_POLICY without duplicating full policy text
  assert.match(contract, /return_profile/);
  assert.match(contract, /INTERNAL_COMPACT/);
  assert.match(contract, /WORKFLOW_POLICY\.md/);

  assert.match(strategicReturn, /return_profile: "EXTERNAL_HANDOFF"/);
  assert.match(strategicReturn, /WORKFLOW_POLICY\.md/);

  assert.match(skill, /INTERNAL_COMPACT/);
  assert.match(skill, /EXTERNAL_HANDOFF/);
  assert.match(skill, /WORKFLOW_POLICY\.md/);
});

