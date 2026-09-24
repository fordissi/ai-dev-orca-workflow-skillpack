// Supervised-first Orca orchestration protocol (orca 1.4.209).
//
// Source precedence for everything in this file, highest first:
//   1. installed-version guide: `orca skills get orchestration --full`
//   2. local `orca orchestration <verb> --help`
//   3. https://www.onorca.dev/docs/cli/orchestration
//   4. this skillpack's cached docs
// When they disagree about command behaviour, the installed runtime's guide wins.
//
// Pure functions: nothing here launches, waits, sends or releases. They grade
// evidence and name the next protocol step, so a Router cannot confuse "a
// terminal exists" with "a supervised worker settled".

import { isNonEmptyString, isPlainObject } from "./resource-routing.mjs";

/* ------------------------------------------------------------------------ *
 * Dispatch paths
 * ------------------------------------------------------------------------ */

// WORKER_START               `orca orchestration worker-start`: Task, Dispatch,
//                            terminal, prompt injection and supervised
//                            resource ownership in one call. The default.
// CUSTOM_DISPATCHED_WORKER   operator-created terminal/worktree running the
//                            exact runtime argv -> TUI-ready -> `dispatch
//                            --inject`. Task/Dispatch tracked with a
//                            worker_done contract; terminal lifecycle is
//                            operator-owned (worker-release takes no process
//                            action on it).
// LIGHTWEIGHT_TERMINAL_PROMPT `terminal create` + `terminal send`. No Task, no
//                            Dispatch, no worker_done authority. Never an Orca
//                            worker.
export const DISPATCH_PATHS = ["WORKER_START", "CUSTOM_DISPATCHED_WORKER", "LIGHTWEIGHT_TERMINAL_PROMPT", "INTERNAL_SUBAGENT"];

export const EXECUTION_MECHANISM_PATH = Object.freeze({
  ORCA_WORKER_START: "WORKER_START",
  ORCA_CUSTOM_DISPATCH: "CUSTOM_DISPATCHED_WORKER",
  ORCA_TERMINAL_PROMPT: "LIGHTWEIGHT_TERMINAL_PROMPT",
});

// Where a worker-start capability claim came from. Only live_probe means an
// actual receipt was observed on this host; the other two are documentation.
export const CAPABILITY_EVIDENCE_SOURCES = ["live_probe", "local_help", "version_matched_guide"];
export const WORKER_START_CAPABILITY_FIELDS = ["launch_model_selection", "effective_identity_reported"];

/**
 * Whether `worker-start` can both express and attest the exact model for a
 * runtime adapter, read from MODEL_REGISTRY.yaml `runtime_adapters.<name>.
 * orca_worker_start`. Provenance is reported alongside and does not change
 * routing: a help-derived "supported" still routes, but is never described as
 * live-probed.
 */
export function workerStartSupport(registry, runtimeAdapter) {
  const adapter = registry?.runtime_adapters?.[runtimeAdapter];
  const ws = isPlainObject(adapter?.orca_worker_start) ? adapter.orca_worker_start : null;
  const evidence = isPlainObject(ws?.evidence) ? ws.evidence : {};
  return {
    agent: ws?.agent ?? null,
    expressible: ws?.launch_model_selection === "supported",
    attestable: ws?.effective_identity_reported === true,
    known: ws !== null,
    evidence: Object.fromEntries(WORKER_START_CAPABILITY_FIELDS.map((f) => [f, evidence[f] ?? null])),
    live_probed: WORKER_START_CAPABILITY_FIELDS.every((f) => evidence[f] === "live_probe"),
  };
}

/* ------------------------------------------------------------------------ *
 * worker_done protocol
 * ------------------------------------------------------------------------ */

const WORKER_OUTCOMES = ["succeeded", "failed"];

function parsePayload(payload) {
  if (isPlainObject(payload)) return payload;
  if (isNonEmptyString(payload)) {
    try {
      const parsed = JSON.parse(payload);
      return isPlainObject(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return {};
}

/**
 * Validates one worker_done against the Dispatch the coordinator expects.
 * worker_done is sent exactly once with task id, dispatch id, an explicit
 * outcome and a short body; a valid one settles the Task and Dispatch on its
 * own (no follow-up `task-update --status completed`). A stale or foreign
 * dispatch id is rejected so a late retry cannot settle the wrong attempt.
 */
export function validateWorkerDone(message, expected = {}) {
  const m = isPlainObject(message) ? message : {};
  const payload = parsePayload(m.payload);
  const taskId = payload.taskId ?? m.task_id ?? null;
  const dispatchId = payload.dispatchId ?? m.dispatch_id ?? null;
  const outcome = payload.outcome ?? m.outcome ?? null;
  const base = { task_id: taskId, dispatch_id: dispatchId, outcome, settles_task: false };

  if (m.type !== "worker_done") return { ...base, valid: false, reason_code: "NOT_WORKER_DONE" };
  if (!isNonEmptyString(taskId) || !isNonEmptyString(dispatchId)) {
    return { ...base, valid: false, reason_code: "LIFECYCLE_IDS_MISSING" };
  }
  if (
    (isNonEmptyString(expected.task_id) && expected.task_id !== taskId) ||
    (isNonEmptyString(expected.dispatch_id) && expected.dispatch_id !== dispatchId)
  ) {
    return { ...base, valid: false, reason_code: "STALE_OR_FOREIGN_COMPLETION" };
  }
  if (!WORKER_OUTCOMES.includes(outcome)) return { ...base, valid: false, reason_code: "OUTCOME_MISSING" };
  if (!isNonEmptyString(m.body)) return { ...base, valid: false, reason_code: "BODY_MISSING" };
  return { ...base, valid: true, reason_code: null, settles_task: true };
}

// How a worker reports a non-PASS state. Only a TERMINAL failure settles the
// Dispatch; every other kind of blocker keeps the attempt alive and asks the
// coordinator to act.
//   TERMINAL_FAIL            this dispatch can no longer complete -> worker_done failed
//   HUMAN_DECISION_REQUIRED  a human must choose                  -> ask, do not settle
//   RECOVERABLE_BLOCKER      coordinator can unblock (access,     -> escalation, do not settle
//                            missing input, environment)
//   DEPENDENCY_WAIT          waiting on another Task / external   -> message or escalation,
//   COORDINATOR_ACTION       a coordinator-owned action            do not settle
export const BLOCKER_KINDS = [
  "TERMINAL_FAIL",
  "HUMAN_DECISION_REQUIRED",
  "RECOVERABLE_BLOCKER",
  "DEPENDENCY_WAIT",
  "COORDINATOR_ACTION",
];

const NON_SETTLING = Object.freeze({
  HUMAN_DECISION_REQUIRED: { use: "ask", reason: "a human decision is a blocking question, not a completion" },
  RECOVERABLE_BLOCKER: { use: "escalation", reason: "the coordinator can unblock this attempt; keep it alive" },
  DEPENDENCY_WAIT: { use: "message_or_escalation", reason: "waiting on a dependency is not a failure of this attempt" },
  COORDINATOR_ACTION: { use: "message_or_escalation", reason: "the coordinator must act; this attempt is not finished" },
});

/**
 * Maps the skillpack TASK_RESULT (the human-facing report) onto the Orca
 * lifecycle signal. Settling as `failed` ends the Dispatch and counts toward
 * the three-failure circuit breaker, so it is reserved for a dispatch that is
 * terminally unable to complete. A bare `BLOCKED` with no blocker kind is
 * treated as recoverable (escalate, do not settle): wrongly keeping an
 * attempt alive costs one coordinator look, wrongly failing it costs a retry
 * and a circuit-breaker strike.
 */
export function mapTaskResultToOutcome(status, { blocker_kind = null } = {}) {
  const settle = (outcome) => ({ outcome, use: "worker_done", settles: true, blocker_kind: outcome === "failed" ? "TERMINAL_FAIL" : null });
  const hold = (kind) => ({ outcome: null, settles: false, blocker_kind: kind, ...NON_SETTLING[kind] });

  switch (status) {
    case "PASS":
      return settle("succeeded");
    case "TERMINAL_FAIL":
    case "FAIL": // legacy spelling of a terminal failure
      return settle("failed");
    case "HUMAN_GATE": // legacy spelling
    case "HUMAN_DECISION_REQUIRED":
      return hold("HUMAN_DECISION_REQUIRED");
    case "RECOVERABLE_BLOCKER":
    case "DEPENDENCY_WAIT":
    case "COORDINATOR_ACTION":
      return hold(status);
    case "BLOCKED":
      if (blocker_kind === "TERMINAL_FAIL") return settle("failed");
      if (blocker_kind !== null && blocker_kind in NON_SETTLING) return hold(blocker_kind);
      return { ...hold("RECOVERABLE_BLOCKER"), reason: "BLOCKED without a blocker kind is escalated, not settled; classify it before failing the dispatch" };
    default:
      return { outcome: null, use: null, settles: false, blocker_kind: null, reason: `unknown TASK_RESULT status ${JSON.stringify(status)}` };
  }
}

/* ------------------------------------------------------------------------ *
 * Wait protocol
 * ------------------------------------------------------------------------ */

/**
 * The coordinator's worker-completion waiter is
 *   orca orchestration check --wait --types "worker_done,escalation,question"
 *     --timeout-ms 900000 --json
 * It blocks natively (keepalive on stderr every 15s) and wakes on lifecycle
 * mail. `terminal wait` is only for TUI readiness in low-level topology.
 */
export function classifyCompletionWaiter({ waiter, purpose = "WORKER_COMPLETION" } = {}) {
  if (purpose === "TUI_READY") {
    return waiter === "TERMINAL_WAIT"
      ? { compliant: true, reason: "terminal wait --for tui-idle gates prompt injection in low-level topology" }
      : { compliant: false, reason_code: "TUI_READY_NEEDS_TERMINAL_WAIT" };
  }
  if (waiter === "ORCA_CHECK_WAIT") {
    return { compliant: true, reason: "orchestration check --wait is the supervised completion waiter" };
  }
  const reasons = {
    TERMINAL_WAIT: "TERMINAL_WAIT_AS_COMPLETION_WAITER",
    TERMINAL_READ_POLL: "TERMINAL_READ_POLLING",
    SCHEDULE: "SCHEDULE_AS_COMPLETION_WAITER",
  };
  return {
    compliant: false,
    reason_code: reasons[waiter] ?? "UNKNOWN_COMPLETION_WAITER",
    required: "orca orchestration check --wait --types \"worker_done,escalation,question\" --timeout-ms 900000 --json",
  };
}

const TERMINAL_DECISIONS = ["REUSE", "RETAIN", "RELEASE"];

/**
 * One consuming check. A Delivery is the whole FIFO batch and replays until
 * acked, so the ack is allowed only after every message was processed and
 * every settled worker terminal has a next owner (reuse / retain / release).
 * A timeout is a checkpoint; three consecutive empty waits switch to
 * enumerating `worker-list --run <id> --include-remote`.
 */
export function processDelivery({
  timed_out = false,
  consecutive_empty_waits = 0,
  messages = [],
  expected_dispatches = [],
  processed = [],
  terminal_decisions = {},
} = {}) {
  const list = Array.isArray(messages) ? messages.filter(isPlainObject) : [];
  if (timed_out || list.length === 0) {
    return consecutive_empty_waits >= 3
      ? { action: "ENUMERATE_WORKER_LIST", ack_allowed: false, reason: "three empty waits: enumerate worker-list and follow projection.nextAction" }
      : { action: "CHECKPOINT_CONTINUE_WAITING", ack_allowed: false, reason: "a timeout or empty result is a checkpoint, not a failure" };
  }

  const done = new Set(processed);
  const unprocessed = list.map((m) => m.id).filter((id) => !done.has(id));

  const settled = [];
  const rejected = [];
  for (const m of list.filter((x) => x.type === "worker_done")) {
    const payload = parsePayload(m.payload);
    const expected = expected_dispatches.find((d) => d.dispatch_id === payload.dispatchId) ?? {};
    const v = validateWorkerDone(m, expected);
    if (v.valid && isNonEmptyString(expected.dispatch_id)) settled.push(v.dispatch_id);
    else rejected.push({ id: m.id, reason_code: v.valid ? "UNEXPECTED_DISPATCH" : v.reason_code });
  }
  const undecided = settled.filter((d) => !TERMINAL_DECISIONS.includes(terminal_decisions[d]));

  return {
    action: unprocessed.length === 0 && undecided.length === 0 ? "ACK" : "PROCESS_REMAINING",
    ack_allowed: unprocessed.length === 0 && undecided.length === 0,
    unprocessed,
    undecided_terminals: undecided,
    settled_dispatches: settled,
    rejected_completions: rejected,
    // A valid worker_done already settled the Task and Dispatch.
    task_update_required: false,
  };
}

/* ------------------------------------------------------------------------ *
 * Messaging: ask, follow-up, groups, fencing
 * ------------------------------------------------------------------------ */

const LIFECYCLE_TYPES = new Set(["worker_done", "heartbeat", "escalation"]);

export function classifyOrchestrationMessaging(input = {}) {
  const i = isPlainObject(input) ? input : {};
  const ok = (extra = {}) => ({ compliant: true, reason_code: null, ...extra });
  const bad = (reason_code, extra = {}) => ({ compliant: false, reason_code, ...extra });

  if (i.actor === "WORKER") {
    if (i.action === "CHECK_RESULT" && i.check_error === "consumer_fenced") {
      // The only way a worker learns its Dispatch was re-attached or settled
      // without it. An empty check never means that.
      return ok({ next: "STOP_WITHOUT_WORKER_DONE" });
    }
    if (i.action === "LOCAL_QUESTION_TUI") {
      return bad("LOCAL_QUESTION_TUI", { required: "orca orchestration ask --from <handle> --dispatch-capability <cap> --question ..." });
    }
    if (i.action === "ORCA_ASK") {
      return isNonEmptyString(i.pending_message_id)
        ? bad("DUPLICATE_PENDING_QUESTION", { required: `orca orchestration ask ... --resume ${i.pending_message_id}` })
        : ok();
    }
    if (i.action === "ORCA_ASK_RESUME") return ok();
    if (i.action === "SEND" && LIFECYCLE_TYPES.has(i.message_type) && isNonEmptyString(i.to) && i.to.startsWith("@")) {
      return bad("LIFECYCLE_MESSAGE_TO_GROUP");
    }
    return ok();
  }

  if (i.actor === "COORDINATOR") {
    if (i.action === "TERMINAL_SEND" && i.tracked_worker === true) {
      return bad("TERMINAL_SEND_TO_TRACKED_WORKER", { required: "orca orchestration send --to dispatch:<dispatch_id> --subject ... --body ..." });
    }
    if (i.action === "SEND_TO_DISPATCH") return ok();
    if (i.action === "GATE_FOR_WORKER_ASK") return bad("GATE_IS_NOT_AN_ASK_REPLY", { required: "orca orchestration reply --id <message_id>" });
    return ok();
  }

  return bad("UNKNOWN_ACTOR");
}

/* ------------------------------------------------------------------------ *
 * Liveness, recovery, retry, cleanup
 * ------------------------------------------------------------------------ */

const ABSENCE_FORBIDDEN = ["stop", "abandon", "retry", "release"];
const CIRCUIT_BREAKER_FAILURES = 3;

/**
 * Only positive proof moves a worker: `exited` liveness, a proven failure, or
 * an accepted settlement. `unverifiable` is absence and authorizes nothing.
 * `worker-list`'s projection.liveness is the fleet verdict; `worker-show`'s
 * observation.status is PTY liveness only.
 */
export function decideWorkerRecovery(input = {}) {
  const i = isPlainObject(input) ? input : {};

  if (i.mutation_response_lost === true) {
    switch (i.request_status) {
      case "completed":
        return { action: "READ_RECORDED_RECEIPT", reason: "the mutation already took effect; do not rerun" };
      case "pending":
        return { action: "REPLAY_WITH_RETRY_REQUEST", reason: "replay the original command with --retry-request <id>" };
      case "absent":
        return { action: "INSPECT_BEFORE_RETRY", reason: "absent is not proof nothing happened; inspect Task, Dispatch and terminal" };
      default:
        return { action: "RUN_REQUEST_SHOW", reason: "orca orchestration request-show --request <id> --json before any replay" };
    }
  }

  if (i.release_status === "release_pending" || i.release_status === "release_unknown") {
    return { action: "FOLLOW_RELEASE_RECEIPT", forbidden: ["terminal_close"], reason: "follow the receipt's exact recovery action" };
  }

  if (i.state === "settled") {
    return {
      action: "REUSE_RETAIN_OR_RELEASE",
      options: ["worker-start --task <next> --terminal <handle>", "worker-retain --dispatch <id>", "worker-release --dispatch <id>"],
      forbidden: ["terminal_close", "task_update_completed"],
    };
  }

  if (i.state === "failed" || i.state === "stopped") {
    const failures = typeof i.consecutive_failures === "number" ? i.consecutive_failures : 1;
    if (failures >= CIRCUIT_BREAKER_FAILURES) {
      return { action: "CIRCUIT_BROKEN", reason: "three consecutive failures fail the Task; do not route around it with a new Run" };
    }
    return {
      action: "RETRY_WITH_RETRY_OF",
      placement_inherited: false,
      command: "worker-start --task <task_id> --retry-of <dispatch_id> --worktree <explicit> --agent <agent> --json",
    };
  }

  if (i.state === "outcome_unknown") {
    return { action: "INSPECT_THEN_EXPLICIT_STOP_OR_ABANDON", inspect: ["worker-list --run <id> --include-remote", "worker-show --dispatch <id>", "worker-read --dispatch <id> --limit 50"] };
  }

  if (i.liveness === "exited") {
    return { action: "FOLLOW_NEXT_ACTION", next_action: Array.isArray(i.next_action) ? i.next_action : null };
  }

  if (i.liveness === "live" && isPlainObject(i.agent_wait)) {
    return { action: "HEALTHY_WAITING_ON_HUMAN", reason: "observation.agentWait: parked on a prompt only a human can answer" };
  }

  if (i.liveness === "live") return { action: "KEEP_WAITING", forbidden: ABSENCE_FORBIDDEN };

  return {
    action: "KEEP_WAITING_OR_INSPECT",
    forbidden: ABSENCE_FORBIDDEN,
    reason: `liveness ${JSON.stringify(i.liveness ?? null)}${i.liveness_reason ? ` (${i.liveness_reason})` : ""} is absence; absence authorizes nothing`,
  };
}
