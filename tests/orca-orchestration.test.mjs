import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { parse } from "yaml";
import {
  classifyCompletionWaiter,
  classifyOrchestrationMessaging,
  decideWorkerRecovery,
  mapTaskResultToOutcome,
  processDelivery,
  validateWorkerDone,
  workerStartSupport,
} from "../scripts/lib/orca-orchestration.mjs";
import { evaluateDispatchCompliance, validateRegistry } from "../scripts/validate-policy-pack.mjs";

const registry = parse(await readFile("policies/MODEL_REGISTRY.yaml", "utf8"));

// Real receipts / messages from the 2026-09-24 bounded probe on orca 1.4.209.
const CODEX_LAUNCH = {
  requested: { agent: "codex", model: "gpt-5.6-luna", effort: "low" },
  effective: { agent: "codex", model: "gpt-5.6-luna", effort: "low" },
};
const CODEX_WORKER_DONE = {
  id: "msg_704b1f6e74e3",
  type: "worker_done",
  subject: "probe complete",
  body: "probe ok. no files touched. nothing remains.",
  payload: '{"taskId":"task_23b0611ccc69","dispatchId":"ctx_a50dbd1533d4","outcome":"succeeded"}',
};
const AGY_LAUNCH = {
  requested: { agent: "antigravity", model: null, effort: null },
  effective: { agent: "antigravity", model: null, effort: null },
};

const codexRequest = { runtime_adapter: "codex_cli", provider_family: "openai", exact_model: "gpt-5.6-luna", effort: "low" };
const lifecycle = { model_launched: true, worker_active: true, completed: true };

const workerStartEvidence = (overrides = {}) => ({
  task_id: "task_23b0611ccc69",
  dispatch_id: "ctx_a50dbd1533d4",
  launch: CODEX_LAUNCH,
  lifecycle,
  completion: CODEX_WORKER_DONE,
  ...overrides,
});

const evaluate = (input) => evaluateDispatchCompliance({ registry, ...input });

// --- Dispatch compliance: the original safety purpose is kept -------------

test("internal subagent can never stand in for an Orca worker", () => {
  const r = evaluate({ task_class: "SPECIALIST_REVIEWER", dispatch_mode: "ORCA_WORKER", execution_mechanism: "ANTIGRAVITY_INVOKE_SUBAGENT" });
  assert.equal(r.result, "HARD_FAIL");
  assert.equal(r.reason_code, "INTERNAL_SUBAGENT_AS_ORCA_WORKER");
  assert.equal(r.orca_dispatch_verified, "NO");
});

test("explicit INTERNAL_SUBAGENT still requires the task class to allow it", () => {
  const base = { task_class: "BOUNDED_RESEARCH_ASSIST", dispatch_mode: "INTERNAL_SUBAGENT", execution_mechanism: "ANTIGRAVITY_INVOKE_SUBAGENT" };
  assert.equal(evaluate({ ...base, internal_subagent_policy: "ALLOWED" }).result, "PASS");
  assert.equal(evaluate(base).result, "HARD_FAIL");
  assert.equal(evaluate({ ...base, task_class: "IMPLEMENTATION_WORKER", internal_subagent_policy: "ALLOWED" }).result, "HARD_FAIL");
});

// --- Supervised-first: worker-start ----------------------------------------

test("worker-start with matching launch.effective is a verified supervised worker", () => {
  const r = evaluate({
    task_class: "IMPLEMENTATION_WORKER",
    dispatch_mode: "ORCA_WORKER",
    execution_mechanism: "ORCA_WORKER_START",
    requested_identity: codexRequest,
    evidence: workerStartEvidence(),
  });
  assert.equal(r.result, "PASS");
  assert.equal(r.dispatch_path, "WORKER_START");
  assert.equal(r.supervision, "SUPERVISED");
  assert.equal(r.orca_dispatch_verified, "YES");
  assert.equal(r.exact_runtime_attestation, "MATCH");
  assert.equal(r.release_semantics, "WORKER_RELEASE");
});

test("a terminal handle is optional: not every worker has a terminal", () => {
  const r = evaluate({
    task_class: "INDEPENDENT_REVIEWER",
    dispatch_mode: "ORCA_WORKER",
    execution_mechanism: "ORCA_WORKER_START",
    requested_identity: codexRequest,
    evidence: workerStartEvidence({ terminal_handle: undefined }),
  });
  assert.equal(r.result, "PASS");
});

test("TASK_ID + DISPATCH_ID is the canonical identity; missing either blocks", () => {
  for (const missing of ["task_id", "dispatch_id"]) {
    const r = evaluate({
      task_class: "IMPLEMENTATION_WORKER",
      dispatch_mode: "ORCA_WORKER",
      execution_mechanism: "ORCA_WORKER_START",
      requested_identity: codexRequest,
      evidence: workerStartEvidence({ [missing]: undefined, terminal_handle: "term_x" }),
    });
    assert.equal(r.result, "DISPATCH_BLOCKED", missing);
    assert.equal(r.reason_code, "ORCA_DISPATCH_IDENTITY_MISSING");
    assert.equal(r.orca_dispatch_verified, "NO");
  }
});

test("requested launch arguments alone never prove the model", () => {
  const r = evaluate({
    task_class: "IMPLEMENTATION_WORKER",
    dispatch_mode: "ORCA_WORKER",
    execution_mechanism: "ORCA_WORKER_START",
    requested_identity: codexRequest,
    evidence: workerStartEvidence({ launch: { requested: CODEX_LAUNCH.requested } }),
  });
  assert.equal(r.result, "DISPATCH_BLOCKED");
  assert.equal(r.reason_code, "EXACT_RUNTIME_UNVERIFIED");
});

test("launch.effective differing from the routing decision is an exact dispatch failure", () => {
  const r = evaluate({
    task_class: "SECURITY_SPECIALIST",
    dispatch_mode: "ORCA_WORKER",
    execution_mechanism: "ORCA_WORKER_START",
    requested_identity: { ...codexRequest, exact_model: "gpt-5.6-terra", effort: "high" },
    evidence: workerStartEvidence(),
  });
  assert.equal(r.result, "HARD_FAIL");
  assert.equal(r.reason_code, "EXACT_DISPATCH_FAILURE");
  assert.equal(r.exact_runtime_attestation, "MISMATCH");
});

test("worker-start cannot express an exact Antigravity model; custom dispatch is recommended", () => {
  const r = evaluate({
    task_class: "IMPLEMENTATION_WORKER",
    dispatch_mode: "ORCA_WORKER",
    execution_mechanism: "ORCA_WORKER_START",
    requested_identity: { runtime_adapter: "antigravity", provider_family: "gemini", exact_model: "gemini-3.8-flash-medium", effort: "medium" },
    evidence: workerStartEvidence({ launch: AGY_LAUNCH, completion: undefined, lifecycle: { model_launched: true, worker_active: true } }),
  });
  assert.equal(r.result, "DISPATCH_BLOCKED");
  assert.equal(r.reason_code, "WORKER_START_CANNOT_EXPRESS_EXACT_MODEL");
  assert.equal(r.recommended_path, "CUSTOM_DISPATCHED_WORKER");
});

// --- Custom dispatched worker ----------------------------------------------

const agyCustomEvidence = (overrides = {}) => ({
  task_id: "task_agy1",
  dispatch_id: "ctx_agy1",
  terminal_handle: "term_agy1",
  tui_ready: true,
  injected: true,
  launch_command: "agy --model gemini-3.8-flash-medium --effort medium",
  runtime_adapter: "antigravity",
  provider_family: "gemini",
  exact_model: "gemini-3.8-flash-medium",
  effort: "medium",
  lifecycle,
  completion: {
    type: "worker_done",
    body: "Done. Found x. Nothing remains.",
    payload: { taskId: "task_agy1", dispatchId: "ctx_agy1", outcome: "succeeded" },
  },
  ...overrides,
});

test("Antigravity exact model via custom topology + dispatch --inject is a tracked worker", () => {
  const r = evaluate({
    task_class: "IMPLEMENTATION_WORKER",
    dispatch_mode: "ORCA_WORKER",
    execution_mechanism: "ORCA_CUSTOM_DISPATCH",
    requested_identity: { runtime_adapter: "antigravity", provider_family: "gemini", exact_model: "gemini-3.8-flash-medium", effort: "medium" },
    evidence: agyCustomEvidence(),
  });
  assert.equal(r.result, "PASS");
  assert.equal(r.dispatch_path, "CUSTOM_DISPATCHED_WORKER");
  // Task/Dispatch tracked with a worker_done contract; not "unsupervised" in the
  // sense of untracked, but its terminal is operator-owned.
  assert.equal(r.supervision, "TRACKED_CUSTOM");
  assert.equal(r.release_semantics, "OPERATOR_OWNED_TERMINAL");
  assert.equal(r.orca_dispatch_verified, "YES");
});

test("custom dispatch without --inject has no Task/Dispatch authority", () => {
  const r = evaluate({
    task_class: "IMPLEMENTATION_WORKER",
    dispatch_mode: "ORCA_WORKER",
    execution_mechanism: "ORCA_CUSTOM_DISPATCH",
    requested_identity: { runtime_adapter: "antigravity", provider_family: "gemini", exact_model: "gemini-3.8-flash-medium", effort: "medium" },
    evidence: agyCustomEvidence({ injected: false }),
  });
  assert.equal(r.result, "DISPATCH_BLOCKED");
  assert.equal(r.reason_code, "CUSTOM_DISPATCH_NOT_INJECTED");
});

test("Antigravity Claude (effort NONE) custom dispatch attests provider_default", () => {
  const r = evaluate({
    task_class: "ARCHITECTURE_SPECIALIST",
    dispatch_mode: "ORCA_WORKER",
    execution_mechanism: "ORCA_CUSTOM_DISPATCH",
    requested_identity: { runtime_adapter: "antigravity", provider_family: "claude", exact_model: "claude-sonnet-4-6", effort: "provider_default" },
    evidence: agyCustomEvidence({
      launch_command: "agy --model claude-sonnet-4-6",
      provider_family: "claude",
      exact_model: "claude-sonnet-4-6",
      effort: "provider_default",
    }),
  });
  assert.equal(r.result, "PASS");
});

test("custom dispatch for a worker-start-capable runtime passes but is advised back to worker-start", () => {
  const r = evaluate({
    task_class: "IMPLEMENTATION_WORKER",
    dispatch_mode: "ORCA_WORKER",
    execution_mechanism: "ORCA_CUSTOM_DISPATCH",
    requested_identity: codexRequest,
    evidence: agyCustomEvidence({
      launch_command: "codex -m gpt-5.6-luna -c model_reasoning_effort=\"low\"",
      runtime_adapter: "codex_cli",
      provider_family: "openai",
      exact_model: "gpt-5.6-luna",
      effort: "low",
    }),
  });
  assert.equal(r.result, "PASS");
  assert.equal(r.advisory, "WORKER_START_PREFERRED");
});

// --- Lightweight terminal prompt -------------------------------------------

test("terminal create + terminal send is a lightweight prompt, never an Orca worker", () => {
  const r = evaluate({
    task_class: "SPECIALIST_REVIEWER",
    dispatch_mode: "ORCA_WORKER",
    execution_mechanism: "ORCA_TERMINAL_PROMPT",
    requested_identity: codexRequest,
    evidence: { terminal_handle: "term_1", launch_command: "codex -m gpt-5.6-luna", lifecycle },
  });
  assert.equal(r.result, "HARD_FAIL");
  assert.equal(r.dispatch_path, "LIGHTWEIGHT_TERMINAL_PROMPT");
  assert.equal(r.reason_code, "LIGHTWEIGHT_TERMINAL_PROMPT_AS_ORCA_WORKER");
  assert.equal(r.orca_dispatch_verified, "NO");
});

test("the legacy ORCA_TERMINAL mechanism with only a terminal handle is a lightweight prompt", () => {
  const r = evaluate({
    task_class: "IMPLEMENTATION_WORKER",
    dispatch_mode: "ORCA_WORKER",
    execution_mechanism: "ORCA_TERMINAL",
    requested_identity: codexRequest,
    evidence: { orca_terminal_handle: "terminal-42", launch_command: "codex exec -m gpt-5.6-luna -", lifecycle },
  });
  assert.equal(r.dispatch_path, "LIGHTWEIGHT_TERMINAL_PROMPT");
  assert.equal(r.result, "HARD_FAIL");
});

test("a worker whose worker_done belongs to another dispatch is not complete", () => {
  const r = evaluate({
    task_class: "IMPLEMENTATION_WORKER",
    dispatch_mode: "ORCA_WORKER",
    execution_mechanism: "ORCA_WORKER_START",
    requested_identity: codexRequest,
    evidence: workerStartEvidence({ dispatch_id: "ctx_other" }),
  });
  assert.equal(r.result, "DISPATCH_BLOCKED");
  assert.equal(r.reason_code, "WORKER_DONE_INVALID");
});

// --- worker_done protocol ---------------------------------------------------

test("the real probe worker_done validates against its own dispatch", () => {
  const v = validateWorkerDone(CODEX_WORKER_DONE, { task_id: "task_23b0611ccc69", dispatch_id: "ctx_a50dbd1533d4" });
  assert.equal(v.valid, true);
  assert.equal(v.outcome, "succeeded");
  assert.equal(v.settles_task, true);
});

test("worker_done for a stale or foreign dispatch is rejected", () => {
  const v = validateWorkerDone(CODEX_WORKER_DONE, { task_id: "task_23b0611ccc69", dispatch_id: "ctx_retry2" });
  assert.equal(v.valid, false);
  assert.equal(v.reason_code, "STALE_OR_FOREIGN_COMPLETION");
});

test("worker_done needs an explicit outcome and a body summary", () => {
  const noOutcome = { ...CODEX_WORKER_DONE, payload: { taskId: "task_23b0611ccc69", dispatchId: "ctx_a50dbd1533d4" } };
  assert.equal(validateWorkerDone(noOutcome, { task_id: "task_23b0611ccc69", dispatch_id: "ctx_a50dbd1533d4" }).reason_code, "OUTCOME_MISSING");
  const noBody = { ...CODEX_WORKER_DONE, body: "" };
  assert.equal(validateWorkerDone(noBody, { task_id: "task_23b0611ccc69", dispatch_id: "ctx_a50dbd1533d4" }).reason_code, "BODY_MISSING");
  assert.equal(validateWorkerDone({ ...CODEX_WORKER_DONE, type: "heartbeat" }).reason_code, "NOT_WORKER_DONE");
});

test("only PASS and a terminal failure settle the dispatch", () => {
  const pass = mapTaskResultToOutcome("PASS");
  assert.deepEqual([pass.use, pass.outcome, pass.settles], ["worker_done", "succeeded", true]);
  for (const status of ["TERMINAL_FAIL", "FAIL"]) {
    const r = mapTaskResultToOutcome(status);
    assert.deepEqual([r.use, r.outcome, r.settles], ["worker_done", "failed", true], status);
  }
});

test("non-terminal blockers keep the attempt alive and never send worker_done", () => {
  const expected = {
    HUMAN_DECISION_REQUIRED: "ask",
    HUMAN_GATE: "ask",
    RECOVERABLE_BLOCKER: "escalation",
    DEPENDENCY_WAIT: "message_or_escalation",
    COORDINATOR_ACTION: "message_or_escalation",
  };
  for (const [status, use] of Object.entries(expected)) {
    const r = mapTaskResultToOutcome(status);
    assert.equal(r.use, use, status);
    assert.equal(r.settles, false, status);
    assert.equal(r.outcome, null, status);
  }
});

test("BLOCKED settles as failed only when the blocker is terminal", () => {
  const terminal = mapTaskResultToOutcome("BLOCKED", { blocker_kind: "TERMINAL_FAIL" });
  assert.deepEqual([terminal.use, terminal.outcome, terminal.settles], ["worker_done", "failed", true]);
  const recoverable = mapTaskResultToOutcome("BLOCKED", { blocker_kind: "RECOVERABLE_BLOCKER" });
  assert.deepEqual([recoverable.use, recoverable.settles], ["escalation", false]);
  const waiting = mapTaskResultToOutcome("BLOCKED", { blocker_kind: "DEPENDENCY_WAIT" });
  assert.equal(waiting.settles, false);
  const human = mapTaskResultToOutcome("BLOCKED", { blocker_kind: "HUMAN_DECISION_REQUIRED" });
  assert.deepEqual([human.use, human.settles], ["ask", false]);
});

test("an unclassified BLOCKED is escalated, never silently failed", () => {
  const r = mapTaskResultToOutcome("BLOCKED");
  assert.equal(r.use, "escalation");
  assert.equal(r.settles, false);
  assert.equal(r.outcome, null);
});

// --- Capability provenance ---------------------------------------------------

test("registry capability claims carry provenance; only real receipts are live_probe", () => {
  const codex = workerStartSupport(registry, "codex_cli");
  assert.equal(codex.live_probed, true);
  assert.deepEqual(codex.evidence, { launch_model_selection: "live_probe", effective_identity_reported: "live_probe" });

  const claude = workerStartSupport(registry, "claude_cli");
  assert.equal(claude.live_probed, false);
  assert.equal(claude.evidence.launch_model_selection, "local_help");
  assert.equal(claude.evidence.effective_identity_reported, "version_matched_guide");
  // Provenance never changes routing: help-derived support still routes.
  assert.equal(claude.expressible, true);

  const agy = workerStartSupport(registry, "antigravity");
  assert.equal(agy.live_probed, true);
  assert.equal(agy.expressible, false);
});

test("the registry validator rejects unmarked or undated live_probe capability claims", () => {
  assert.deepEqual(validateRegistry(registry), []);
  const unmarked = structuredClone(registry);
  delete unmarked.runtime_adapters.claude_cli.orca_worker_start.evidence;
  assert.ok(validateRegistry(unmarked).some((f) => f.includes("claude_cli.orca_worker_start.evidence")));
  const inflated = structuredClone(registry);
  inflated.runtime_adapters.claude_cli.orca_worker_start.evidence.launch_model_selection = "live_probe";
  assert.ok(validateRegistry(inflated).some((f) => f.includes("live_probe requires a verified_at date")));
});

// --- Wait protocol -----------------------------------------------------------

test("orchestration check --wait is the completion waiter", () => {
  assert.equal(classifyCompletionWaiter({ waiter: "ORCA_CHECK_WAIT", purpose: "WORKER_COMPLETION" }).compliant, true);
  for (const waiter of ["TERMINAL_WAIT", "TERMINAL_READ_POLL", "SCHEDULE"]) {
    const r = classifyCompletionWaiter({ waiter, purpose: "WORKER_COMPLETION" });
    assert.equal(r.compliant, false, waiter);
  }
});

test("terminal wait is only for TUI readiness in low-level topology", () => {
  assert.equal(classifyCompletionWaiter({ waiter: "TERMINAL_WAIT", purpose: "TUI_READY" }).compliant, true);
});

test("a check --wait timeout is a checkpoint, and three empty waits enumerate", () => {
  assert.equal(processDelivery({ timed_out: true, consecutive_empty_waits: 1 }).action, "CHECKPOINT_CONTINUE_WAITING");
  assert.equal(processDelivery({ timed_out: true, consecutive_empty_waits: 3 }).action, "ENUMERATE_WORKER_LIST");
});

test("a delivery is acked only after every message and settled terminal is handled", () => {
  const messages = [
    { id: "m1", type: "worker_done", payload: { taskId: "t1", dispatchId: "d1", outcome: "succeeded" }, body: "a. b. c." },
    { id: "m2", type: "question" },
  ];
  const expected = [{ task_id: "t1", dispatch_id: "d1" }];
  const partial = processDelivery({ messages, expected_dispatches: expected, processed: ["m1"], terminal_decisions: { d1: "RELEASE" } });
  assert.equal(partial.ack_allowed, false);
  assert.deepEqual(partial.unprocessed, ["m2"]);
  const undecided = processDelivery({ messages, expected_dispatches: expected, processed: ["m1", "m2"], terminal_decisions: {} });
  assert.equal(undecided.ack_allowed, false);
  assert.deepEqual(undecided.undecided_terminals, ["d1"]);
  const done = processDelivery({ messages, expected_dispatches: expected, processed: ["m1", "m2"], terminal_decisions: { d1: "RELEASE" } });
  assert.equal(done.ack_allowed, true);
  // A valid worker_done settles the Task; no task-update --status completed.
  assert.equal(done.task_update_required, false);
});

// --- Messaging: ask and follow-up ------------------------------------------

test("a worker blocking question goes through orchestration ask", () => {
  assert.equal(classifyOrchestrationMessaging({ actor: "WORKER", action: "ORCA_ASK" }).compliant, true);
  assert.equal(classifyOrchestrationMessaging({ actor: "WORKER", action: "LOCAL_QUESTION_TUI" }).compliant, false);
});

test("an ask timeout resumes the same message instead of asking again", () => {
  assert.equal(classifyOrchestrationMessaging({ actor: "WORKER", action: "ORCA_ASK_RESUME", pending_message_id: "msg_1" }).compliant, true);
  const dup = classifyOrchestrationMessaging({ actor: "WORKER", action: "ORCA_ASK", pending_message_id: "msg_1" });
  assert.equal(dup.compliant, false);
  assert.equal(dup.reason_code, "DUPLICATE_PENDING_QUESTION");
});

test("coordinator follow-up to a tracked worker uses send --to dispatch:<id>", () => {
  assert.equal(classifyOrchestrationMessaging({ actor: "COORDINATOR", action: "SEND_TO_DISPATCH", tracked_worker: true }).compliant, true);
  const r = classifyOrchestrationMessaging({ actor: "COORDINATOR", action: "TERMINAL_SEND", tracked_worker: true });
  assert.equal(r.compliant, false);
  assert.equal(r.reason_code, "TERMINAL_SEND_TO_TRACKED_WORKER");
});

test("lifecycle messages never target groups", () => {
  const r = classifyOrchestrationMessaging({ actor: "WORKER", action: "SEND", message_type: "worker_done", to: "@all" });
  assert.equal(r.compliant, false);
  assert.equal(r.reason_code, "LIFECYCLE_MESSAGE_TO_GROUP");
});

test("a worker that is fenced stops without worker_done", () => {
  const r = classifyOrchestrationMessaging({ actor: "WORKER", action: "CHECK_RESULT", check_error: "consumer_fenced" });
  assert.equal(r.next, "STOP_WITHOUT_WORKER_DONE");
});

// --- Liveness / recovery / retry / cleanup ---------------------------------

test("unverifiable liveness never authorizes stop, retry or release", () => {
  const r = decideWorkerRecovery({ liveness: "unverifiable", liveness_reason: "missing_status" });
  assert.equal(r.action, "KEEP_WAITING_OR_INSPECT");
  assert.deepEqual(r.forbidden.sort(), ["abandon", "release", "retry", "stop"]);
});

test("a worker parked on a human-only prompt is healthy, not failed", () => {
  assert.equal(decideWorkerRecovery({ liveness: "live", agent_wait: { evidence: "prompt-text" } }).action, "HEALTHY_WAITING_ON_HUMAN");
});

test("proven exit follows the fleet row's nextAction", () => {
  assert.equal(decideWorkerRecovery({ liveness: "exited", next_action: ["orca", "orchestration", "worker-stop"] }).action, "FOLLOW_NEXT_ACTION");
});

test("retry needs a proven failure, explicit placement, and stops at the circuit breaker", () => {
  const retry = decideWorkerRecovery({ state: "failed", consecutive_failures: 1 });
  assert.equal(retry.action, "RETRY_WITH_RETRY_OF");
  assert.equal(retry.placement_inherited, false);
  assert.equal(decideWorkerRecovery({ state: "failed", consecutive_failures: 3 }).action, "CIRCUIT_BROKEN");
});

test("outcome_unknown is inspected before an explicit stop or abandon", () => {
  assert.equal(decideWorkerRecovery({ state: "outcome_unknown" }).action, "INSPECT_THEN_EXPLICIT_STOP_OR_ABANDON");
});

test("an accepted settlement is reused, retained or released - never terminal close", () => {
  const r = decideWorkerRecovery({ state: "settled" });
  assert.equal(r.action, "REUSE_RETAIN_OR_RELEASE");
  assert.ok(r.forbidden.includes("terminal_close"));
  const pending = decideWorkerRecovery({ release_status: "release_pending" });
  assert.equal(pending.action, "FOLLOW_RELEASE_RECEIPT");
  assert.ok(pending.forbidden.includes("terminal_close"));
});

test("a lost mutation response is resolved through request-show, never a blind replay", () => {
  assert.equal(decideWorkerRecovery({ mutation_response_lost: true, request_status: "completed" }).action, "READ_RECORDED_RECEIPT");
  assert.equal(decideWorkerRecovery({ mutation_response_lost: true, request_status: "pending" }).action, "REPLAY_WITH_RETRY_REQUEST");
  assert.equal(decideWorkerRecovery({ mutation_response_lost: true, request_status: "absent" }).action, "INSPECT_BEFORE_RETRY");
  assert.equal(decideWorkerRecovery({ mutation_response_lost: true }).action, "RUN_REQUEST_SHOW");
});
