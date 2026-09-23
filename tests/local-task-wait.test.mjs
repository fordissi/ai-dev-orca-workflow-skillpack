import assert from "node:assert/strict";
import test from "node:test";
import {
  accountRouterBudget,
  classifyLocalTaskWait,
  LOCAL_TASK_KINDS,
  LOCAL_WAIT_MECHANISMS,
  recoverLocalTaskResult,
} from "../scripts/lib/async-wait.mjs";

// Incident SCHEDULE_TOOL_HANG / LOST_COMPLETION_RESUME: `npm --prefix web test`
// finished cleanly (exit 0, 189/189), but the Router had used
// Schedule(20s: check in on vitest) as its waiter. The Schedule call hung and
// the completion was never picked up.

// --- The prohibited waiter -------------------------------------------------

test("Schedule is not a completion waiter for a local task", () => {
  const r = classifyLocalTaskWait({ task_kind: "TEST_RUNNER", waiter: "SCHEDULE", command: "npm --prefix web test" });
  assert.equal(r.verdict, "NON_COMPLIANT");
  assert.ok(r.violations.includes("LOCAL_TASK_WAIT_MUST_BE_DETERMINISTIC"));
  assert.equal(r.compliant, false);
  // It must say what to do instead, not merely refuse.
  assert.ok(LOCAL_WAIT_MECHANISMS.includes(r.required_mechanism));
});

test("every local task kind rejects the Schedule waiter", () => {
  for (const task_kind of LOCAL_TASK_KINDS) {
    const r = classifyLocalTaskWait({ task_kind, waiter: "SCHEDULE" });
    assert.equal(r.compliant, false, task_kind);
  }
});

test("repeated Schedule polling is a hard fail under NO_LLM_BUSY_POLLING", () => {
  const r = classifyLocalTaskWait({ task_kind: "TEST_RUNNER", waiter: "SCHEDULE", poll_count: 4 });
  assert.equal(r.verdict, "HARD_FAIL");
  assert.deepEqual(r.violations.sort(), ["LOCAL_TASK_WAIT_MUST_BE_DETERMINISTIC", "NO_LLM_BUSY_POLLING"]);
});

test("other model-side waiters are refused too", () => {
  for (const waiter of ["TIMER_WAKEUP", "LLM_STATUS_POLL", "PERIODIC_ROUTER_WAKEUP"]) {
    assert.equal(classifyLocalTaskWait({ task_kind: "BUILD", waiter }).compliant, false, waiter);
  }
});

// --- The required pattern --------------------------------------------------

test("a native process wait passes and resumes the Router exactly once", () => {
  const r = classifyLocalTaskWait({
    task_kind: "TEST_RUNNER",
    waiter: "NATIVE_PROCESS_WAIT",
    command: "npm --prefix web test",
    exit_code_captured: true,
    output_captured: true,
  });
  assert.equal(r.verdict, "PASS");
  assert.equal(r.compliant, true);
  assert.equal(r.router_resumes, 1);
});

test("a native wait that drops the exit code is incomplete, not compliant", () => {
  const r = classifyLocalTaskWait({ task_kind: "BUILD", waiter: "NATIVE_PROCESS_WAIT", exit_code_captured: false });
  assert.equal(r.compliant, false);
  assert.ok(r.violations.includes("COMPLETION_EVIDENCE_INCOMPLETE"));
});

test("blocking run and completion callback are both accepted mechanisms", () => {
  for (const waiter of ["BLOCKING_RUN", "TASK_COMPLETION_CALLBACK"]) {
    const r = classifyLocalTaskWait({ task_kind: "DEPLOY_CLI", waiter, exit_code_captured: true, output_captured: true });
    assert.equal(r.verdict, "PASS", waiter);
  }
});

// --- Failure recovery ------------------------------------------------------

test("a task that finished while the Router was away is recovered, never rerun", () => {
  const r = recoverLocalTaskResult({ task: { status: "DONE", exit_code: 0, output_available: true } });
  assert.equal(r.action, "RECOVER_RESULT");
  assert.equal(r.rerun, false);
  assert.equal(r.exit_code, 0);
});

test("a still-running task gets a deterministic wait attached, not another Schedule", () => {
  const r = recoverLocalTaskResult({ task: { status: "RUNNING" } });
  assert.equal(r.action, "ATTACH_NATIVE_WAIT");
  assert.equal(r.rerun, false);
});

test("a missing task with no result is LOST_COMPLETION_SIGNAL", () => {
  const r = recoverLocalTaskResult({ task: { status: "MISSING" } });
  assert.equal(r.action, "LOST_COMPLETION_SIGNAL");
  assert.equal(r.rerun, false);
});

test("a lost completion may be rerun at most once, and only when safe and justified", () => {
  const lost = { task: { status: "MISSING" } };
  const unsafe = recoverLocalTaskResult({ ...lost, rerun_safe: true });
  assert.equal(unsafe.rerun, false, "a justification is required as well");
  const ok = recoverLocalTaskResult({ ...lost, rerun_safe: true, justification: "read-only test run, no side effects" });
  assert.equal(ok.action, "LOST_COMPLETION_SIGNAL");
  assert.equal(ok.rerun, true);
  const again = recoverLocalTaskResult({ ...lost, rerun_safe: true, justification: "same", rerun_count: 1 });
  assert.equal(again.rerun, false, "at most once");
});

test("never blindly rerun a completed task, even when a rerun is offered", () => {
  const r = recoverLocalTaskResult({
    task: { status: "DONE", exit_code: 0, output_available: true },
    rerun_safe: true,
    justification: "looks stuck",
  });
  assert.equal(r.action, "RECOVER_RESULT");
  assert.equal(r.rerun, false);
  assert.ok(r.violations.includes("BLIND_RERUN_OF_COMPLETED_TASK"));
});

test("a completed task whose output is gone is a lost signal, not a silent pass", () => {
  const r = recoverLocalTaskResult({ task: { status: "DONE", output_available: false } });
  assert.equal(r.action, "LOST_COMPLETION_SIGNAL");
});

test("status is inspected once; recovery is not a polling loop", () => {
  const r = recoverLocalTaskResult({ task: { status: "RUNNING" } });
  assert.equal(r.status_inspections, 1);
});

// --- Budget interaction ----------------------------------------------------

test("the incident shape is measured as busy polling on the Router budget", () => {
  const b = accountRouterBudget([
    { kind: "ROUTER_TURN" },
    { kind: "TIMER_WAKEUP", during_wait: true },
    { kind: "TIMER_WAKEUP", during_wait: true },
  ]);
  assert.equal(b.compliant, false);
  assert.deepEqual(b.violations, ["NO_LLM_BUSY_POLLING"]);
});
