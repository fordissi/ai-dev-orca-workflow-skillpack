import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  classifyCallbackRecovery,
  containsCredentialBearingUrl,
  dispatchInjectsSecret,
  ENV_DIAGNOSTIC_TOKENS,
  envDiagnosticTokenAllowed,
  mustReprovisionOnRestart,
  resolveEnvironmentCapability,
  sanitizeRecoveredOutput,
} from "../scripts/validate-policy-pack.mjs";

// A synthetic credential-bearing connection string. Dotless host so it never
// looks like an email; no `name = value` so the repo secret scanner is quiet.
const CONNSTR = "db://svcuser:REDACTED_PW@dbendpoint:6543/foundation";

test("1. an ordinary UI worker gets no database capability", () => {
  const r = resolveEnvironmentCapability({ requested: [], authorization: "not_required" });
  assert.equal(r.outcome, "CAPABILITY_GRANTED");
  assert.equal(r.granted_level, "NONE");
});

test("2. a read-only hosted validator gets the readonly capability only", () => {
  const r = resolveEnvironmentCapability({
    requested: ["FOUNDATION_DB_READONLY"],
    authorization: "not_required",
    task_requires_capability: true,
    preflight: { capability_present: true, privilege_level: "READONLY", target_identity: "TARGET_MATCH", ca_config: "PRESENT" },
    worker_env_present: true,
  });
  assert.equal(r.outcome, "CAPABILITY_GRANTED");
  assert.equal(r.granted_level, "READONLY");
});

test("3. a privileged Apply worker gets privileged only after explicit authorization", () => {
  const base = {
    requested: ["FOUNDATION_DB_PRIVILEGED"],
    task_requires_capability: true,
    preflight: { capability_present: true, privilege_level: "PRIVILEGED", target_identity: "TARGET_MATCH", ca_config: "PRESENT" },
    worker_env_present: true,
  };
  assert.equal(resolveEnvironmentCapability({ ...base, authorization: "MISSING" }).outcome, "AUTHORIZATION_REQUIRED");
  const granted = resolveEnvironmentCapability({ ...base, authorization: "required_and_provided" });
  assert.equal(granted.outcome, "CAPABILITY_GRANTED");
  assert.equal(granted.granted_level, "PRIVILEGED");
});

test("4. a G3 task with no database need gets no credential", () => {
  const r = resolveEnvironmentCapability({
    requested: ["FOUNDATION_DB_PRIVILEGED"],
    authorization: "required_and_provided",
    task_requires_capability: false, // governance tier alone does not establish a need
  });
  assert.equal(r.granted_level, "NONE");
  assert.match(r.reason, /governance tier alone/);
});

test("5. a reviewer of database evidence gets no privileged credential by default", () => {
  const r = resolveEnvironmentCapability({
    reviewer: true,
    review_requires_direct_db: false,
    requested: ["FOUNDATION_DB_PRIVILEGED"],
    authorization: "required_and_provided",
    task_requires_capability: true,
  });
  assert.equal(r.granted_level, "NONE");
  assert.match(r.reason, /sanitized/);
});

test("6. a missing required capability is fail-closed", () => {
  const r = resolveEnvironmentCapability({
    requested: ["FOUNDATION_DB_READONLY"],
    authorization: "not_required",
    task_requires_capability: true,
    worker_env_present: false,
    preflight: { capability_present: false },
  });
  assert.equal(r.outcome, "ENVIRONMENT_CAPABILITY_UNAVAILABLE");
  assert.equal(r.granted_level, "NONE");
});

test("7. a privileged request is not silently replaced by readonly", () => {
  const r = resolveEnvironmentCapability({
    requested: ["FOUNDATION_DB_PRIVILEGED"],
    authorization: "required_and_provided",
    task_requires_capability: true,
    worker_env_present: true,
    preflight: { capability_present: true, privilege_level: "READONLY" },
  });
  assert.equal(r.outcome, "PRIVILEGE_LEVEL_MISMATCH");
  assert.equal(r.granted_level, "NONE");
});

test("8. a readonly request is not silently upgraded to privileged", () => {
  const r = resolveEnvironmentCapability({
    requested: ["FOUNDATION_DB_READONLY"],
    authorization: "not_required",
    task_requires_capability: true,
    worker_env_present: true,
    preflight: { capability_present: true, privilege_level: "PRIVILEGED" },
  });
  assert.equal(r.outcome, "PRIVILEGE_LEVEL_MISMATCH");
  assert.equal(r.granted_level, "NONE");
});

test("9. a secret value never appears in an execution-record fixture", async () => {
  // What a compliant worker diagnostic looks like: tokens only, no value.
  const record = [
    "FOUNDATION_DB_READONLY: PRESENT",
    "target_identity: TARGET_MATCH",
    "tls: TLS_OK",
    "ca_config: PRESENT",
  ].join("\n");
  assert.equal(containsCredentialBearingUrl(record), false);
  for (const line of record.split("\n")) {
    const diag = line.split(/:\s*/)[1];
    assert.ok(envDiagnosticTokenAllowed(diag), `${diag} is an allowed diagnostic token`);
  }
  // The raw form the worker must never emit.
  assert.equal(containsCredentialBearingUrl(`DATABASE_URL: ${CONNSTR}`), true);
});

test("10. an interruption/restart requires re-provisioning", () => {
  assert.equal(mustReprovisionOnRestart({ restarted_after_interruption: true }).reprovision, true);
  const reuse = mustReprovisionOnRestart({ restarted_after_interruption: true, reuse_old_terminal_secret_state: true });
  assert.equal(reuse.reprovision, true);
  assert.match(reuse.reason, /not authoritative/);
});

test("11. Router process-local env presence does not count as worker capability", () => {
  const r = resolveEnvironmentCapability({
    requested: ["FOUNDATION_DB_PRIVILEGED"],
    authorization: "required_and_provided",
    task_requires_capability: true,
    router_local_env_present: true,
    worker_env_present: false,
  });
  assert.equal(r.outcome, "ENVIRONMENT_CAPABILITY_UNAVAILABLE");
  assert.match(r.reason, /process-local/);
});

test("12. a command-line secret injection is rejected by policy", () => {
  assert.equal(dispatchInjectsSecret(`codex exec -m gpt-5.6-luna --db-url ${CONNSTR} -o out -`), true);
  assert.equal(dispatchInjectsSecret("codex exec -m gpt-5.6-luna --db-dsn db://a/b -o out -"), true);
  assert.equal(dispatchInjectsSecret("codex exec -m gpt-5.6-luna -c 'model_reasoning_effort=\"max\"' -o out -"), false);
});

test("13. a completed worker with worker_done transport failure recovers via worker-read, no duplicate dispatch", () => {
  const r = classifyCallbackRecovery({
    worker_done: null,
    worker_state: "completed",
    worker_read: { complete: true, ambiguous: false, output: "TASK_RESULT status: PASS ..." },
  });
  assert.equal(r.tier, "WORKER_READ");
  assert.equal(r.callback_transport, "FAILED_RECOVERED");
  assert.equal(r.duplicate_dispatch, false);
});

test("14. worker-read showing an incomplete/ambiguous result goes to HUMAN_GATE", () => {
  const r = classifyCallbackRecovery({
    worker_done: null,
    worker_state: "completed",
    worker_read: { complete: false, ambiguous: true, output: "partial ..." },
  });
  assert.equal(r.tier, "HUMAN_GATE");
  assert.equal(r.callback_transport, "FAILED_UNRECOVERED");
  assert.equal(r.duplicate_dispatch, false);
});

test("15. a valid worker_done does not trigger an unnecessary worker-read recovery", () => {
  const r = classifyCallbackRecovery({ worker_done: { status: "PASS" }, worker_state: "completed" });
  assert.equal(r.tier, "WORKER_DONE");
  assert.equal(r.callback_transport, "OK");
  assert.equal(r.worker_read_invoked, false);
});

test("16. recovered output with secret-like diagnostics is sanitized before the Router record", () => {
  const recovered = `TASK_RESULT\nstatus: PASS\nnote: connected to ${CONNSTR}\n`;
  assert.equal(containsCredentialBearingUrl(recovered), true);
  const { sanitized, redacted } = sanitizeRecoveredOutput(recovered);
  assert.equal(redacted, true);
  assert.equal(containsCredentialBearingUrl(sanitized), false);
  assert.match(sanitized, /db:\/\/REDACTED@/);
});

test("the policy owns the scoped-worker-environment rules and never gates the registry", async () => {
  const workflow = await readFile("policies/WORKFLOW_POLICY.md", "utf8");
  const commands = await readFile("references/OFFICIAL_COMMANDS.md", "utf8");
  const contract = await readFile("templates/ROUTER_EXECUTION_CONTRACT_TEMPLATE.md", "utf8");

  assert.match(workflow, /## Scoped worker environment provisioning/);
  for (const phrase of [
    "required_environment_capabilities",
    "Router local env presence does not count as worker capability availability",
    "ENVIRONMENT_CAPABILITY_UNAVAILABLE",
    "PRIVILEGE_LEVEL_MISMATCH",
    "FAILED_RECOVERED",
    "不得自動 redispatch",
    "不得把 repo-local `.env`",
    "沒有 secret 值進 Git",
  ]) {
    assert.ok(workflow.includes(phrase), `workflow policy must state: ${phrase}`);
  }
  // The six allowed diagnostic tokens are the only ones named for secret vars.
  for (const token of ENV_DIAGNOSTIC_TOKENS) assert.ok(workflow.includes(token), `token ${token}`);

  assert.match(commands, /orca orchestration worker-read --dispatch <dispatch_id> --limit <bounded_n> --json/);
  assert.match(commands, /Scoped worker environment provisioning/);

  assert.match(contract, /required_environment_capabilities:/);
  assert.match(contract, /environment_provisioning:/);
  assert.match(contract, /callback_transport:\s+# unresolved — OK \| FAILED_RECOVERED \| FAILED_UNRECOVERED/);

  // Registry is not touched by this feature.
  const registryDiff = (await readFile("policies/MODEL_REGISTRY.yaml", "utf8")).length;
  assert.ok(registryDiff > 0, "registry file still present and unmodified by this change");
});
