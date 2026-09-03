import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  admitStage,
  CAPABILITY_DIAGNOSTIC_TOKENS,
  classifyCallbackRecovery,
  containsCredentialBearingUrl,
  dispatchInjectsSecret,
  envDiagnosticTokenAllowed,
  mustReprovisionOnRestart,
  normalizeRequiredCapabilities,
  resolveCapability,
  resolveEnvironmentCapability,
  sanitizeRecoveredOutput,
} from "../scripts/validate-policy-pack.mjs";

// A synthetic credential-bearing connection string. Dotless host so it never
// looks like an email; no `name = value` so the repo secret scanner is quiet.
const CONNSTR = "db://svcuser:REDACTED_PW@dbendpoint:6543/foundation";

const base = (overrides = {}) => ({
  requested: ["FOUNDATION_DB_READONLY"],
  authorization: "not_required",
  task_requires_capability: true,
  fulfillment_mechanism: "ENV_INJECTION",
  available_mechanisms: ["ENV_INJECTION", "CAPABILITY_WRAPPER", "SECRET_BROKER", "REMOTE_EXECUTOR"],
  preflight: { capability_present: true, target_identity: "TARGET_MATCH", ca_config: "PRESENT" },
  worker_env_present: true,
  ...overrides,
});

test("1. a UI worker with no required_capabilities is fulfilled at NONE", () => {
  const r = resolveCapability({ requested: [] });
  assert.equal(r.outcome, "CAPABILITY_FULFILLED");
  assert.equal(r.effective_privilege, "NONE");
  assert.equal(r.worker_receives_secret, "NO");
});

test("2. a readonly DB worker fulfilled by ENV_INJECTION at readonly", () => {
  const r = resolveCapability(base({ effective_privilege: "READONLY" }));
  assert.equal(r.outcome, "CAPABILITY_FULFILLED");
  assert.equal(r.effective_privilege, "READONLY");
  assert.equal(r.fulfillment_mechanism, "ENV_INJECTION");
  assert.equal(r.worker_receives_secret, "YES");
});

test("3. a readonly DB worker fulfilled by a CAPABILITY_WRAPPER at readonly", () => {
  const r = resolveCapability(base({ fulfillment_mechanism: "CAPABILITY_WRAPPER", wrapper_allowlist_only: true, effective_privilege: "READONLY" }));
  assert.equal(r.outcome, "CAPABILITY_FULFILLED");
  assert.equal(r.effective_privilege, "READONLY");
  assert.equal(r.worker_receives_secret, "NO");
});

test("4. a wrapper fulfilment with worker_receives_secret NO is a valid outcome", () => {
  const r = resolveCapability(base({ fulfillment_mechanism: "SECRET_BROKER", worker_receives_secret: "NO", effective_privilege: "READONLY" }));
  assert.equal(r.outcome, "CAPABILITY_FULFILLED");
  assert.equal(r.worker_receives_secret, "NO");
});

test("5. readonly requested but a privileged wrapper -> PRIVILEGE_LEVEL_MISMATCH", () => {
  const r = resolveCapability(base({ fulfillment_mechanism: "CAPABILITY_WRAPPER", wrapper_allowlist_only: true, effective_privilege: "PRIVILEGED" }));
  assert.equal(r.outcome, "PRIVILEGE_LEVEL_MISMATCH");
});

test("6. privileged requested but a readonly executor -> PRIVILEGE_LEVEL_MISMATCH", () => {
  const r = resolveCapability(base({
    requested: ["FOUNDATION_DB_PRIVILEGED"],
    authorization: "required_and_provided",
    fulfillment_mechanism: "REMOTE_EXECUTOR",
    effective_privilege: "READONLY",
  }));
  assert.equal(r.outcome, "PRIVILEGE_LEVEL_MISMATCH");
});

test("7. a privileged capability without authorization -> AUTHORIZATION_REQUIRED", () => {
  const r = resolveCapability(base({ requested: ["FOUNDATION_DB_PRIVILEGED"], authorization: "MISSING", effective_privilege: "PRIVILEGED" }));
  assert.equal(r.outcome, "AUTHORIZATION_REQUIRED");
  assert.equal(r.effective_privilege, "NONE");
});

test("8. a G3 task with no capability need gets no privileged capability", () => {
  const r = resolveCapability({
    requested: ["FOUNDATION_DB_PRIVILEGED"],
    authorization: "required_and_provided",
    task_requires_capability: false,
  });
  assert.equal(r.outcome, "CAPABILITY_FULFILLED");
  assert.equal(r.effective_privilege, "NONE");
  assert.match(r.reason, /governance tier alone/);
});

test("9. Router env present but no worker mechanism -> not fulfilled", () => {
  const r = resolveCapability(base({ router_local_env_present: true, worker_env_present: false }));
  assert.equal(r.outcome, "CAPABILITY_UNAVAILABLE");
  assert.match(r.reason, /Router process-local/);
});

test("10. env injection unavailable but a wrapper is available -> the wrapper may fulfil", () => {
  const r = resolveCapability(base({
    fulfillment_mechanism: "CAPABILITY_WRAPPER",
    wrapper_allowlist_only: true,
    available_mechanisms: ["CAPABILITY_WRAPPER"], // ENV_INJECTION not offered
    effective_privilege: "READONLY",
  }));
  assert.equal(r.outcome, "CAPABILITY_FULFILLED");
  assert.equal(r.fulfillment_mechanism, "CAPABILITY_WRAPPER");
});

test("11. a readonly DB wrapper does not imply arbitrary SQL", () => {
  const r = resolveCapability(base({ fulfillment_mechanism: "CAPABILITY_WRAPPER", wrapper_allowlist_only: false, effective_privilege: "READONLY" }));
  assert.equal(r.outcome, "CAPABILITY_PREFLIGHT_FAILED");
  assert.match(r.reason, /allowlisted/);
});

test("12. a reviewer of sanitized evidence gets no capability by default", () => {
  const r = resolveCapability(base({
    reviewer: true,
    review_requires_direct_capability: false,
    requested: ["FOUNDATION_DB_PRIVILEGED"],
    authorization: "required_and_provided",
  }));
  assert.equal(r.outcome, "CAPABILITY_FULFILLED");
  assert.equal(r.effective_privilege, "NONE");
  assert.match(r.reason, /sanitized/);
});

test("13. a reviewer needing direct capability use must declare it explicitly", () => {
  const withoutFlag = resolveCapability(base({ reviewer: true, requested: ["FOUNDATION_DB_READONLY"], fulfillment_mechanism: "CAPABILITY_WRAPPER", wrapper_allowlist_only: true, effective_privilege: "READONLY" }));
  assert.equal(withoutFlag.effective_privilege, "NONE");
  const withFlag = resolveCapability(base({ reviewer: true, review_requires_direct_capability: true, requested: ["FOUNDATION_DB_READONLY"], fulfillment_mechanism: "CAPABILITY_WRAPPER", wrapper_allowlist_only: true, effective_privilege: "READONLY" }));
  assert.equal(withFlag.outcome, "CAPABILITY_FULFILLED");
  assert.equal(withFlag.effective_privilege, "READONLY");
});

test("14. a restart re-resolves required_capabilities and re-establishes access", () => {
  assert.equal(mustReprovisionOnRestart({ restarted_after_interruption: true }).reprovision, true);
  for (const stale of ["reuse_old_env_state", "reuse_old_wrapper_process", "reuse_old_broker_session", "reuse_old_remote_executor_session"]) {
    const r = mustReprovisionOnRestart({ restarted_after_interruption: true, [stale]: true });
    assert.equal(r.reprovision, true);
    assert.match(r.reason, /not authoritative/);
  }
});

test("15. the deprecated required_environment_capabilities alias normalizes exactly once", () => {
  const r = normalizeRequiredCapabilities({ required_environment_capabilities: ["FOUNDATION_DB_READONLY"] });
  assert.deepEqual(r.capabilities, ["FOUNDATION_DB_READONLY"]);
  assert.equal(r.deprecated_alias_used, true);
  assert.equal(r.normalized_once, true);
  // Canonical field alone: no alias in play.
  const c = normalizeRequiredCapabilities({ required_capabilities: ["FOUNDATION_DB_READONLY"] });
  assert.equal(c.deprecated_alias_used, false);
});

test("16. old and new capability fields disagreeing fails closed", () => {
  const r = normalizeRequiredCapabilities({
    required_capabilities: ["FOUNDATION_DB_READONLY"],
    required_environment_capabilities: ["FOUNDATION_DB_PRIVILEGED"],
  });
  assert.equal(r.error, "CONFLICTING_CAPABILITY_FIELDS");
  assert.equal(r.fail_closed, true);
  assert.equal(r.capabilities, undefined);
});

test("17. a command-line secret injection is rejected by policy", () => {
  assert.equal(dispatchInjectsSecret(`codex exec -m gpt-5.6-luna --db-url ${CONNSTR} -o out -`), true);
  assert.equal(dispatchInjectsSecret("codex exec -m gpt-5.6-luna --db-dsn db://a/b -o out -"), true);
  assert.equal(dispatchInjectsSecret("codex exec -m gpt-5.6-luna -c 'model_reasoning_effort=\"max\"' -o out -"), false);
});

test("18. capability fulfilment does not alter model stage selection", () => {
  const classification = { risk: "high", complexity: "high", context_size: "large", ambiguity: "high", change_intensity: "structural", verification_need: "standard" };
  const stageA = admitStage(classification, {});
  const stageB = admitStage(classification, { fulfillment_mechanism: "CAPABILITY_WRAPPER", worker_receives_secret: "NO" });
  assert.equal(stageA, stageB);
  // The capability resolver output carries no model / stage keys.
  const r = resolveCapability(base({ effective_privilege: "READONLY" }));
  for (const k of ["stage", "selected_stage", "model", "provider", "capability_tier"]) {
    assert.equal(k in r, false, `resolveCapability result must not carry ${k}`);
  }
});

test("19. callback recovery behaviour is unchanged", () => {
  assert.equal(classifyCallbackRecovery({ worker_done: { status: "PASS" }, worker_state: "completed" }).tier, "WORKER_DONE");
  const recovered = classifyCallbackRecovery({ worker_done: null, worker_state: "completed", worker_read: { complete: true, ambiguous: false } });
  assert.equal(recovered.tier, "WORKER_READ");
  assert.equal(recovered.callback_transport, "FAILED_RECOVERED");
  assert.equal(recovered.duplicate_dispatch, false);
  assert.equal(classifyCallbackRecovery({ worker_done: null, worker_state: "completed", worker_read: { complete: false, ambiguous: true } }).tier, "HUMAN_GATE");
});

test("20. a secret value never appears in an execution-record fixture", () => {
  const record = ["FOUNDATION_DB_READONLY: PRESENT", "target_identity: TARGET_MATCH", "tls: TLS_OK", "worker_receives_secret: NO"].join("\n");
  assert.equal(containsCredentialBearingUrl(record), false);
  for (const line of record.split("\n").slice(0, 3)) {
    const diag = line.split(/:\s*/)[1];
    assert.ok(envDiagnosticTokenAllowed(diag), `${diag} is an allowed diagnostic token`);
  }
  const { sanitized, redacted } = sanitizeRecoveredOutput(`note: connected via ${CONNSTR}`);
  assert.equal(redacted, true);
  assert.equal(containsCredentialBearingUrl(sanitized), false);
  // Deprecated alias still resolves to the same behaviour.
  assert.equal(resolveEnvironmentCapability({ requested: [] }).outcome, "CAPABILITY_FULFILLED");
});

test("the policy owns the generalized capability model and never gates the registry", async () => {
  const workflow = await readFile("policies/WORKFLOW_POLICY.md", "utf8");
  const commands = await readFile("references/OFFICIAL_COMMANDS.md", "utf8");
  const contract = await readFile("templates/ROUTER_EXECUTION_CONTRACT_TEMPLATE.md", "utf8");

  assert.match(workflow, /## Scoped worker capabilities/);
  for (const phrase of [
    "required_capabilities",
    "CAPABILITY_FULFILLMENT_MECHANISM",
    "CAPABILITY_WRAPPER",
    "SECRET_BROKER",
    "REMOTE_EXECUTOR",
    "ENV_INJECTION",
    "worker_receives_secret",
    "No mechanism is preferred globally",
    "The worker's required capability is the authority boundary",
    "Router local env presence is not capability fulfillment",
    "PRIVILEGE_LEVEL_MISMATCH",
    "required_environment_capabilities",  // documented as deprecated alias
  ]) {
    assert.ok(workflow.includes(phrase), `workflow policy must state: ${phrase}`);
  }
  for (const token of CAPABILITY_DIAGNOSTIC_TOKENS) assert.ok(workflow.includes(token), `token ${token}`);

  assert.match(commands, /orca orchestration worker-read --dispatch <dispatch_id> --limit <bounded_n> --json/);

  assert.match(contract, /required_capabilities:/);
  assert.match(contract, /capability_resolution:/);
  assert.match(contract, /fulfillment_mechanism/);
  assert.match(contract, /worker_receives_secret/);
  assert.match(contract, /callback_transport:\s+# unresolved — OK \| FAILED_RECOVERED \| FAILED_UNRECOVERED/);

  const registry = await readFile("policies/MODEL_REGISTRY.yaml", "utf8");
  assert.ok(registry.length > 0, "registry file still present");
});
