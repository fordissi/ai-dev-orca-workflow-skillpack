// External asynchronous waiting: how the Router waits for something it does
// not control (a deployment, a check run, CI, a container, a migration).
//
// Incident LLM_BUSY_POLLING_AND_STALE_CHECK_RUN_TARGET. Two independent
// failures, both represented here:
//   1. the Router was re-entered to look at an UNCHANGED external status, so
//      low-information waiting burned reasoning budget;
//   2. monitoring was pinned to the first observed check-run id, so a newer
//      run for the same commit succeeded while the workflow kept watching a
//      stale in_progress run.
//
// Pure functions: nothing here sleeps, polls or launches a process. They
// decide what the waiting mechanism must be and what a deterministic waiter
// should conclude, so the LLM is re-entered only on a terminal signal.

import { isNonEmptyString, isPlainObject, toMillis } from "./resource-routing.mjs";

/* ------------------------------------------------------------------------ *
 * A. NO_LLM_BUSY_POLLING
 * ------------------------------------------------------------------------ */

// Preference order for waiting on external async state. Earlier is better:
// each one costs less LLM budget than the next, and all four cost none while
// the state is unchanged.
export const WAIT_MECHANISMS = ["NATIVE_WATCH", "BACKGROUND_WAIT", "HELPER_BACKOFF", "EVENT_SIGNAL"];

const MECHANISM_CAPABILITY = Object.freeze({
  NATIVE_WATCH: "native_watch", // `gh run watch`, `wrangler tail`, `docker wait`, ...
  BACKGROUND_WAIT: "background_wait", // a deterministic background shell wait
  HELPER_BACKOFF: "helper_backoff", // a bounded helper script with backoff
  EVENT_SIGNAL: "event_signal", // webhook / completion callback
});

// The only signals that may re-enter the LLM.
export const WAIT_TERMINAL_SIGNALS = ["SUCCESS", "FAILURE", "TIMEOUT", "ACTION_REQUIRED"];

// External wait shapes this invariant covers. Informational: any external
// async wait is covered, this list names the observed ones.
export const EXTERNAL_WAIT_KINDS = [
  "CLOUDFLARE_PAGES",
  "GITHUB_CHECK_RUN",
  "GITHUB_ACTIONS",
  "CI_CD",
  "DOCKER_STARTUP",
  "BACKGROUND_TESTS",
  "MIGRATION",
  "NETWORK_OR_PROCESS_WAIT",
];

/**
 * Picks the waiting mechanism from the capabilities actually available, in
 * the policy's preference order. No capability at all is a human gate, not a
 * licence to poll from the model.
 */
export function chooseWaitMechanism(capabilities = {}) {
  const caps = isPlainObject(capabilities) ? capabilities : {};
  for (const mechanism of WAIT_MECHANISMS) {
    if (caps[MECHANISM_CAPABILITY[mechanism]] === true) {
      return { mechanism, capability: MECHANISM_CAPABILITY[mechanism] };
    }
  }
  return { mechanism: null, capability: null };
}

/**
 * Decides whether the LLM may be re-entered for one observation of an
 * external asynchronous wait.
 *
 * `signal` is the deterministic waiter's terminal signal (SUCCESS / FAILURE /
 * TIMEOUT / ACTION_REQUIRED) or null while it is still waiting. An unchanged
 * intermediate state NEVER re-enters the model, and intermediate narration is
 * suppressed - "still building..." is a reasoning turn spent on no new
 * information.
 */
export function classifyAsyncWait(observation = {}, options = {}) {
  const o = isPlainObject(observation) ? observation : {};
  const { capabilities = o.capabilities ?? {} } = options;
  const signal = isNonEmptyString(o.signal) ? o.signal : null;

  if (signal !== null && WAIT_TERMINAL_SIGNALS.includes(signal)) {
    return {
      llm_reentry: "REQUIRED",
      terminal_signal: signal,
      wait_mechanism: null,
      narration: "ALLOWED",
      next_delay_ms: null,
      reason: `terminal signal ${signal}: the model is re-entered exactly once, to act on it`,
    };
  }
  if (signal !== null) {
    return {
      llm_reentry: "FORBIDDEN",
      terminal_signal: null,
      wait_mechanism: null,
      narration: "SUPPRESSED",
      next_delay_ms: null,
      reason: `unknown signal ${JSON.stringify(signal)} is not terminal; keep waiting deterministically`,
    };
  }

  const { mechanism } = chooseWaitMechanism(capabilities);
  if (mechanism === null) {
    return {
      llm_reentry: "FORBIDDEN",
      terminal_signal: null,
      wait_mechanism: null,
      narration: "SUPPRESSED",
      action: "HUMAN_GATE",
      reason: "no deterministic waiting mechanism is available; ask the human rather than polling from the model",
    };
  }

  const attempt = typeof o.poll_attempt === "number" ? o.poll_attempt : 0;
  return {
    llm_reentry: "FORBIDDEN",
    terminal_signal: null,
    wait_mechanism: mechanism,
    narration: "SUPPRESSED",
    next_delay_ms: mechanism === "HELPER_BACKOFF" ? nextPollDelayMs(attempt + 1) : null,
    action: "WAIT_DETERMINISTICALLY",
    reason:
      o.state_changed === true
        ? "state changed but is not terminal; the deterministic waiter continues without re-entering the model"
        : "unchanged intermediate external status is not a reason to re-enter the model",
  };
}

/* ------------------------------------------------------------------------ *
 * D. Polling backoff standard
 * ------------------------------------------------------------------------ */

export const POLLING_BACKOFF = Object.freeze({
  delaysMs: Object.freeze([30_000, 60_000, 120_000, 240_000]),
  maxAttempts: 8,
  maxTotalMs: 10 * 60_000,
});

/** Delay before poll `attempt` (1-based); the last step repeats. */
export function nextPollDelayMs(attempt, config = POLLING_BACKOFF) {
  const delays = config.delaysMs ?? POLLING_BACKOFF.delaysMs;
  if (!Number.isFinite(attempt) || attempt < 1) return delays[0];
  return delays[Math.min(attempt, delays.length) - 1];
}

/**
 * The whole bounded schedule a helper follows: 30s -> 60s -> 120s -> 240s,
 * capped at maxAttempts and maxTotalMs, ending in TIMEOUT. The model is not
 * re-entered between these polls.
 */
export function pollSchedule(config = POLLING_BACKOFF) {
  const maxAttempts = config.maxAttempts ?? POLLING_BACKOFF.maxAttempts;
  const maxTotalMs = config.maxTotalMs ?? POLLING_BACKOFF.maxTotalMs;
  const polls = [];
  let elapsed = 0;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const remaining = maxTotalMs - elapsed;
    if (remaining <= 0) break;
    const delay = Math.min(nextPollDelayMs(attempt, config), remaining);
    elapsed += delay;
    polls.push({ attempt, delay_ms: delay, at_ms: elapsed });
  }
  return { polls, total_ms: elapsed, max_attempts: maxAttempts, terminal_signal_on_exhaustion: "TIMEOUT", llm_reentries: 1 };
}

/* ------------------------------------------------------------------------ *
 * B. Async target re-resolution
 * ------------------------------------------------------------------------ */

const TERMINAL_RUN_STATUSES = new Set(["completed", "COMPLETED", "success", "failure", "cancelled", "timed_out", "skipped"]);
const SUCCESS_CONCLUSIONS = new Set(["success", "neutral", "skipped"]);
const ACTION_REQUIRED_CONCLUSIONS = new Set(["action_required", "waiting", "manual"]);

// toMillis returns NaN (not null) for anything unparseable, so each candidate
// is tested for finiteness rather than nullishness.
function runOrderKey(run) {
  for (const field of ["created_at", "started_at", "updated_at"]) {
    const ms = toMillis(run?.[field]);
    if (Number.isFinite(ms)) return ms;
  }
  return Number.NEGATIVE_INFINITY;
}

/**
 * Re-resolves the authoritative external run for a deployment on EVERY
 * deterministic status check, keyed on the immutable commit SHA and the
 * provider/app - never on the first observed run id.
 *
 * The newest matching run wins. Older runs are reported as superseded and are
 * ignored even when they are still `in_progress`: a stale run must not keep
 * the workflow alive, and a terminal success on the latest authoritative run
 * ends monitoring.
 */
export function resolveAsyncTarget({ commit_sha, app = null, name = null, runs = [] } = {}) {
  const all = Array.isArray(runs) ? runs.filter(isPlainObject) : [];
  const matching = all.filter(
    (r) =>
      isNonEmptyString(commit_sha) &&
      (r.head_sha ?? r.commit_sha ?? r.sha) === commit_sha &&
      (app === null || (r.app ?? r.app_slug ?? r.provider) === app) &&
      (name === null || r.name === name),
  );

  if (matching.length === 0) {
    return {
      monitoring: "CONTINUE",
      outcome: null,
      target_run_id: null,
      commit_sha: commit_sha ?? null,
      superseded_run_ids: [],
      stale_in_progress_ignored: [],
      reason: "no run for this commit yet; keep waiting deterministically for one to appear",
    };
  }

  const ordered = [...matching].sort((a, b) => runOrderKey(b) - runOrderKey(a));
  const authoritative = ordered[0];
  const superseded = ordered.slice(1);
  const staleInProgress = superseded.filter((r) => !TERMINAL_RUN_STATUSES.has(r.status)).map((r) => r.id);

  const base = {
    target_run_id: authoritative.id ?? null,
    commit_sha,
    superseded_run_ids: superseded.map((r) => r.id),
    stale_in_progress_ignored: staleInProgress,
    re_resolved: true,
  };

  if (!TERMINAL_RUN_STATUSES.has(authoritative.status)) {
    return { ...base, monitoring: "CONTINUE", outcome: null, reason: `latest run ${authoritative.id} for ${commit_sha} is ${authoritative.status}` };
  }

  const conclusion = authoritative.conclusion ?? authoritative.status;
  const outcome = SUCCESS_CONCLUSIONS.has(conclusion)
    ? "SUCCESS"
    : ACTION_REQUIRED_CONCLUSIONS.has(conclusion)
      ? "ACTION_REQUIRED"
      : "FAILURE";
  return {
    ...base,
    monitoring: "COMPLETE",
    outcome,
    reason:
      staleInProgress.length > 0
        ? `latest authoritative run ${authoritative.id} concluded ${conclusion}; superseded run(s) ${staleInProgress.join(", ")} are stale and do not extend monitoring`
        : `latest authoritative run ${authoritative.id} concluded ${conclusion}`,
  };
}

/* ------------------------------------------------------------------------ *
 * C. Burst-aware Router self-accounting
 * ------------------------------------------------------------------------ */

// Everything that spends the Router's own reasoning budget, plus the one
// event that must not: a deterministic wait.
export const ROUTER_BUDGET_EVENTS = [
  "ROUTER_TURN",
  "TIMER_WAKEUP",
  "STATUS_RECHECK",
  "WORKER_LAUNCH",
  "REVIEW_PASS",
  "DETERMINISTIC_WAIT",
];

const LLM_COSTED_EVENTS = new Set(ROUTER_BUDGET_EVENTS.filter((e) => e !== "DETERMINISTIC_WAIT"));

/**
 * Counts the Router's own LLM consumption, including the turns that are easy
 * to forget: timer wakeups and status re-checks. A re-entry that happened
 * during an external wait without a terminal signal is a NO_LLM_BUSY_POLLING
 * violation - that is the incident, measured.
 *
 * Under BURST depletion / conservation pressure the same violation is graded
 * harder, because low-information waiting is exactly what a pressured pool
 * cannot afford.
 */
export function accountRouterBudget(events = [], options = {}) {
  const { burstPressure = "UNKNOWN", conservationPressure = "UNKNOWN" } = options;
  const list = Array.isArray(events) ? events.filter(isPlainObject) : [];

  const counts = Object.fromEntries(ROUTER_BUDGET_EVENTS.map((k) => [k, 0]));
  let llmTurns = 0;
  const busyPolls = [];

  for (const [index, event] of list.entries()) {
    const kind = ROUTER_BUDGET_EVENTS.includes(event.kind) ? event.kind : null;
    if (kind === null) continue;
    counts[kind] += 1;
    if (!LLM_COSTED_EVENTS.has(kind)) continue;
    llmTurns += 1;
    const terminal = isNonEmptyString(event.terminal_signal) && WAIT_TERMINAL_SIGNALS.includes(event.terminal_signal);
    if (event.during_wait === true && !terminal) {
      busyPolls.push({ index, kind, reason: "re-entered during an external wait without a terminal signal" });
    }
  }

  const pressured = ["HIGH", "CRITICAL"].includes(burstPressure) || ["HIGH", "CRITICAL"].includes(conservationPressure);
  return {
    counts,
    llm_turns: llmTurns,
    deterministic_waits: counts.DETERMINISTIC_WAIT,
    busy_poll_turns: busyPolls.length,
    violations: busyPolls.length > 0 ? ["NO_LLM_BUSY_POLLING"] : [],
    severity: busyPolls.length === 0 ? null : pressured ? "HIGH" : "MEDIUM",
    compliant: busyPolls.length === 0,
    detail: busyPolls,
  };
}

/**
 * One deterministic monitoring step: re-resolve the target, then decide
 * whether this step may re-enter the model. Composes B and A so a caller
 * cannot do one without the other.
 */
export function monitorAsyncDeployment({ commit_sha, app = null, name = null, runs = [], capabilities = {}, poll_attempt = 0, config = POLLING_BACKOFF } = {}) {
  const target = resolveAsyncTarget({ commit_sha, app, name, runs });
  const exhausted = poll_attempt >= (config.maxAttempts ?? POLLING_BACKOFF.maxAttempts);
  const signal = target.monitoring === "COMPLETE" ? target.outcome : exhausted ? "TIMEOUT" : null;
  const wait = classifyAsyncWait({ signal, poll_attempt, state_changed: false }, { capabilities });
  return { target, signal, ...wait, poll_attempt };
}
