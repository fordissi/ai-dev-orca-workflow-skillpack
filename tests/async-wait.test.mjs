import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  accountRouterBudget,
  chooseWaitMechanism,
  classifyAsyncWait,
  monitorAsyncDeployment,
  nextPollDelayMs,
  POLLING_BACKOFF,
  pollSchedule,
  resolveAsyncTarget,
} from "../scripts/lib/async-wait.mjs";
import { classifyRouterExecution } from "../scripts/validate-policy-pack.mjs";

// The incident regression fixture: run A in_progress, superseding run B
// completed/success, same commit SHA.
const incident = JSON.parse(await readFile("tests/fixtures/check-runs/cloudflare-superseded-run.json", "utf8"));

// --- A. NO_LLM_BUSY_POLLING ------------------------------------------------

test("mechanism preference is native watch, background wait, helper, event", () => {
  assert.equal(chooseWaitMechanism({ native_watch: true, background_wait: true, helper_backoff: true }).mechanism, "NATIVE_WATCH");
  assert.equal(chooseWaitMechanism({ background_wait: true, helper_backoff: true, event_signal: true }).mechanism, "BACKGROUND_WAIT");
  assert.equal(chooseWaitMechanism({ helper_backoff: true, event_signal: true }).mechanism, "HELPER_BACKOFF");
  assert.equal(chooseWaitMechanism({ event_signal: true }).mechanism, "EVENT_SIGNAL");
  assert.equal(chooseWaitMechanism({}).mechanism, null);
});

test("no intermediate observation re-enters the model, whatever the attempt", () => {
  for (const attempt of [0, 1, 4, 7]) {
    const r = classifyAsyncWait({ signal: null, poll_attempt: attempt }, { capabilities: { native_watch: true } });
    assert.equal(r.llm_reentry, "FORBIDDEN");
    assert.equal(r.narration, "SUPPRESSED");
  }
});

test("only the four terminal signals re-enter the model", () => {
  for (const signal of ["SUCCESS", "FAILURE", "TIMEOUT", "ACTION_REQUIRED"]) {
    assert.equal(classifyAsyncWait({ signal }).llm_reentry, "REQUIRED");
  }
  for (const signal of ["in_progress", "queued", "PENDING", "still_building"]) {
    assert.equal(classifyAsyncWait({ signal }, { capabilities: { native_watch: true } }).llm_reentry, "FORBIDDEN");
  }
});

// --- D. Backoff standard ---------------------------------------------------

test("backoff is 30s, 60s, 120s, 240s and then repeats the last step", () => {
  assert.deepEqual([1, 2, 3, 4, 5].map((a) => nextPollDelayMs(a)), [30_000, 60_000, 120_000, 240_000, 240_000]);
});

test("the schedule is bounded by 8 attempts and 10 minutes, ending in TIMEOUT", () => {
  const plan = pollSchedule();
  assert.ok(plan.polls.length <= POLLING_BACKOFF.maxAttempts);
  assert.ok(plan.total_ms <= POLLING_BACKOFF.maxTotalMs, `${plan.total_ms}`);
  assert.equal(plan.terminal_signal_on_exhaustion, "TIMEOUT");
  // The model is entered once for the whole schedule, not once per poll.
  assert.equal(plan.llm_reentries, 1);
  assert.deepEqual(plan.polls.slice(0, 4).map((p) => p.delay_ms), [30_000, 60_000, 120_000, 240_000]);
  // Each step stays inside the budget.
  assert.equal(plan.polls.at(-1).at_ms, plan.total_ms);
});

// --- B. Async target re-resolution ----------------------------------------

test("incident regression: superseding run B ends monitoring, stale run A does not", () => {
  const r = resolveAsyncTarget({ commit_sha: incident.commit_sha, app: incident.app, runs: incident.check_runs });
  assert.equal(r.monitoring, "COMPLETE");
  assert.equal(r.outcome, "SUCCESS");
  assert.equal(r.target_run_id, "B-104462");
  assert.deepEqual(r.superseded_run_ids, ["A-104417"]);
  assert.deepEqual(r.stale_in_progress_ignored, ["A-104417"]);
});

test("incident regression through the monitor: one re-entry, on SUCCESS", () => {
  const m = monitorAsyncDeployment({
    commit_sha: incident.commit_sha,
    app: incident.app,
    runs: incident.check_runs,
    capabilities: { native_watch: true },
    poll_attempt: 2,
  });
  assert.equal(m.signal, "SUCCESS");
  assert.equal(m.llm_reentry, "REQUIRED");
  assert.equal(m.target.target_run_id, "B-104462");
});

test("the run list order does not decide the target; creation time does", () => {
  const reversed = [...incident.check_runs].reverse();
  assert.equal(resolveAsyncTarget({ commit_sha: incident.commit_sha, runs: reversed }).target_run_id, "B-104462");
});

test("a stale in_progress run alone never completes or blocks monitoring", () => {
  const onlyStale = incident.check_runs.filter((r) => r.id === "A-104417");
  const r = resolveAsyncTarget({ commit_sha: incident.commit_sha, runs: onlyStale });
  assert.equal(r.monitoring, "CONTINUE");
  assert.equal(r.target_run_id, "A-104417");
});

test("exhausting the poll budget yields TIMEOUT with exactly one re-entry", () => {
  const stale = incident.check_runs.filter((r) => r.id === "A-104417");
  const m = monitorAsyncDeployment({ commit_sha: incident.commit_sha, runs: stale, capabilities: { helper_backoff: true }, poll_attempt: POLLING_BACKOFF.maxAttempts });
  assert.equal(m.signal, "TIMEOUT");
  assert.equal(m.llm_reentry, "REQUIRED");
  const before = monitorAsyncDeployment({ commit_sha: incident.commit_sha, runs: stale, capabilities: { helper_backoff: true }, poll_attempt: 3 });
  assert.equal(before.signal, null);
  assert.equal(before.llm_reentry, "FORBIDDEN");
});

test("another app's run for the same commit is not this deployment", () => {
  const runs = [
    ...incident.check_runs.filter((r) => r.id === "A-104417"),
    { id: "OTHER-1", app: "vercel", head_sha: incident.commit_sha, status: "completed", conclusion: "success", created_at: "2026-09-22T09:20:00Z" },
  ];
  const r = resolveAsyncTarget({ commit_sha: incident.commit_sha, app: "cloudflare-pages", runs });
  assert.equal(r.monitoring, "CONTINUE");
  assert.equal(r.target_run_id, "A-104417");
});

// --- C. Router self-accounting --------------------------------------------

test("a full deterministic wait costs two Router turns regardless of poll count", () => {
  const events = [{ kind: "ROUTER_TURN" }];
  for (const { attempt } of pollSchedule().polls) events.push({ kind: "DETERMINISTIC_WAIT", attempt });
  events.push({ kind: "ROUTER_TURN", during_wait: true, terminal_signal: "SUCCESS" });
  const b = accountRouterBudget(events);
  assert.equal(b.llm_turns, 2);
  assert.equal(b.busy_poll_turns, 0);
  assert.equal(b.compliant, true);
});

test("one re-entry per poll is measured as the incident and graded by pressure", () => {
  const events = [{ kind: "ROUTER_TURN" }];
  for (const { attempt } of pollSchedule().polls) events.push({ kind: "TIMER_WAKEUP", during_wait: true, attempt });
  const normal = accountRouterBudget(events);
  assert.equal(normal.busy_poll_turns, pollSchedule().polls.length);
  assert.deepEqual(normal.violations, ["NO_LLM_BUSY_POLLING"]);
  assert.equal(normal.severity, "MEDIUM");
  assert.equal(accountRouterBudget(events, { burstPressure: "CRITICAL" }).severity, "HIGH");
  assert.equal(accountRouterBudget(events, { conservationPressure: "HIGH" }).severity, "HIGH");
});

test("router cost includes wakeups, re-checks, launches and review passes", () => {
  const b = accountRouterBudget([
    { kind: "ROUTER_TURN" },
    { kind: "TIMER_WAKEUP", terminal_signal: "TIMEOUT", during_wait: true },
    { kind: "STATUS_RECHECK", terminal_signal: "SUCCESS", during_wait: true },
    { kind: "WORKER_LAUNCH" },
    { kind: "REVIEW_PASS" },
    { kind: "DETERMINISTIC_WAIT" },
    { kind: "NOT_A_KIND" },
  ]);
  assert.equal(b.llm_turns, 5);
  assert.equal(b.deterministic_waits, 1);
  assert.equal(b.compliant, true);
});

// --- Router execution boundary --------------------------------------------

test("EXTERNAL_ASYNC_WAIT is a deterministic wait, never a dispatch or a direct poll", () => {
  const waiting = classifyRouterExecution({ intent: "EXTERNAL_ASYNC_WAIT", wait_capabilities: { native_watch: true } });
  assert.equal(waiting.router_execution_class, "EXTERNAL_WAIT");
  assert.equal(waiting.router_execution_decision, "DETERMINISTIC_WAIT_REQUIRED");
  assert.equal(waiting.dispatch_slot, null);
  assert.equal(waiting.narration, "SUPPRESSED");

  const done = classifyRouterExecution({ intent: "EXTERNAL_ASYNC_WAIT", terminal_signal: "SUCCESS" });
  assert.equal(done.router_execution_decision, "DIRECT_ALLOWED");
  assert.equal(done.llm_reentry, "REQUIRED");
});

test("a current human override cannot license busy polling", () => {
  const r = classifyRouterExecution({
    intent: "EXTERNAL_ASYNC_WAIT",
    wait_capabilities: { background_wait: true },
    current_task_id: "t1",
    current_instruction_revision: "rev-1",
    human_override: { task_id: "t1", instruction_revision: "rev-1" },
  });
  assert.equal(r.router_execution_decision, "DETERMINISTIC_WAIT_REQUIRED");
});

test("a non-router slot is unaffected by the external-wait branch", () => {
  const r = classifyRouterExecution({ intent: "EXTERNAL_ASYNC_WAIT" }, { isRouterSlot: false });
  assert.equal(r.router_execution_decision, "DISPATCH_REQUIRED");
});
