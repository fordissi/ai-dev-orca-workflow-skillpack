import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { parse } from "yaml";
import {
  attestDispatchIdentity,
  canReuseTerminal,
  checkReasoningDispatch,
  validateModelSelection,
} from "../scripts/validate-policy-pack.mjs";

const identity = (overrides = {}) => ({
  provider: "codex",
  model: "gpt-5.6-luna",
  model_family: "gpt-5.6",
  reasoning_effort: "medium",
  ...overrides,
});

const codexCommand = (model = "gpt-5.6-luna", effort = "medium") =>
  `codex exec -m ${model} -c 'model_reasoning_effort="${effort}"' -s read-only --color never -o out -`;

const currentInstruction = {
  task_id: "dispatch-audit-task",
  instruction_revision: "rev-3",
};

test("registry-selected Luna medium preserves exact model and effort", () => {
  const expected = identity();
  const result = checkReasoningDispatch({
    provider: "codex",
    expected,
    actual: expected,
    command: codexCommand(),
  });
  assert.equal(result.result, "DISPATCH_IDENTITY_MATCH");
});

test("Terra high executed as gpt-5.5 high is a contract mismatch", () => {
  const result = checkReasoningDispatch({
    provider: "codex",
    expected: identity({ model: "gpt-5.6-terra", reasoning_effort: "high" }),
    actual: identity({ model: "gpt-5.5", model_family: "gpt-5.5", reasoning_effort: "high" }),
    command: codexCommand("gpt-5.5", "high"),
  });
  assert.equal(result.result, "DISPATCH_CONTRACT_MISMATCH");
});

test("omitted model argument followed by a runtime default is detected", () => {
  const result = checkReasoningDispatch({
    provider: "codex",
    expected: identity({ model: "gpt-5.6-terra", reasoning_effort: "high" }),
    actual: identity({ model: "gpt-5.5", model_family: "gpt-5.5", reasoning_effort: "high" }),
    command: `codex exec -c 'model_reasoning_effort="high"' -s read-only --color never -o out -`,
  });
  assert.equal(result.result, "DISPATCH_CONTRACT_MISMATCH");
});

test("omitted reasoning argument overridden by local config is detected", () => {
  const result = checkReasoningDispatch({
    provider: "codex",
    expected: identity(),
    actual: identity({ reasoning_effort: "max" }),
    command: "codex exec -m gpt-5.6-luna -s read-only --color never -o out -",
  });
  assert.equal(result.result, "DISPATCH_CONTRACT_MISMATCH");
});

test("an autonomous reviewer model absent from the slot is rejected before dispatch", async () => {
  const registry = parse(await readFile("policies/MODEL_REGISTRY.yaml", "utf8"));
  const result = validateModelSelection({
    model_selection_source: "REGISTRY_AUTONOMOUS",
    registry,
    slot: "INDEPENDENT_REVIEWER",
    selected_identity: identity({ model: "gpt-5.5", model_family: "gpt-5.5", reasoning_effort: "high" }),
  });
  assert.equal(result.result, "AUTONOMOUS_CANDIDATE_REJECTED");
});

test("a current task-local human override may use gpt-5.5 and is recorded", async () => {
  const registry = parse(await readFile("policies/MODEL_REGISTRY.yaml", "utf8"));
  const result = validateModelSelection({
    ...currentInstruction,
    model_selection_source: "HUMAN_EXPLICIT_OVERRIDE",
    registry,
    slot: "INDEPENDENT_REVIEWER",
    human_override: {
      ...currentInstruction,
      provider: "codex",
      model: "gpt-5.5",
      model_family: "gpt-5.5",
      reasoning_effort: "high",
    },
  });
  assert.equal(result.result, "HUMAN_MODEL_OVERRIDE");
  assert.equal(result.model_selection_source, "HUMAN_EXPLICIT_OVERRIDE");
});

test("retroactive acceptance does not mutate or expand the registry", async () => {
  const registry = parse(await readFile("policies/MODEL_REGISTRY.yaml", "utf8"));
  const before = JSON.stringify(registry);
  const result = validateModelSelection({
    model_selection_source: "HUMAN_RETROACTIVE_ACCEPTANCE",
    registry,
    slot: "INDEPENDENT_REVIEWER",
    selected_identity: identity({ model: "gpt-5.5", model_family: "gpt-5.5", reasoning_effort: "high" }),
  });
  assert.equal(result.result, "RETROACTIVE_ACCEPTANCE_NOT_ROUTABLE");
  assert.equal(JSON.stringify(registry), before);
  assert.equal(
    registry.capability_slots.INDEPENDENT_REVIEWER.candidates.some((candidate) => candidate.model === "gpt-5.5"),
    false,
  );
});

test("a stale previous human override cannot apply to a new task", async () => {
  const registry = parse(await readFile("policies/MODEL_REGISTRY.yaml", "utf8"));
  const result = validateModelSelection({
    task_id: "new-task",
    instruction_revision: "rev-4",
    model_selection_source: "HUMAN_EXPLICIT_OVERRIDE",
    registry,
    slot: "INDEPENDENT_REVIEWER",
    human_override: {
      task_id: "old-task",
      instruction_revision: "rev-2",
      provider: "codex",
      model: "gpt-5.5",
      model_family: "gpt-5.5",
      reasoning_effort: "high",
    },
  });
  assert.equal(result.result, "HUMAN_OVERRIDE_STALE");
});

test("a terminal with the right provider but wrong model is not reusable", () => {
  const result = canReuseTerminal(identity(), identity({ model: "gpt-5.6-terra" }));
  assert.equal(result.reusable, false);
  assert.equal(result.attestation_result, "DISPATCH_CONTRACT_MISMATCH");
});

test("a terminal with the right model but wrong effort is not reusable", () => {
  const result = canReuseTerminal(identity(), identity({ reasoning_effort: "max" }));
  assert.equal(result.reusable, false);
  assert.equal(result.attestation_result, "DISPATCH_CONTRACT_MISMATCH");
});

test("a Superpowers reviewer default cannot bypass workflow registry governance", async () => {
  const registry = parse(await readFile("policies/MODEL_REGISTRY.yaml", "utf8"));
  const result = validateModelSelection({
    model_selection_source: "REGISTRY_AUTONOMOUS",
    execution_method: "superpowers-reviewer-helper",
    registry,
    slot: "INDEPENDENT_REVIEWER",
    selected_identity: identity({ model: "gpt-5.5", model_family: "gpt-5.5", reasoning_effort: "high" }),
  });
  assert.equal(result.result, "AUTONOMOUS_CANDIDATE_REJECTED");
});

test("missing runtime identity is explicitly unverified", () => {
  const result = attestDispatchIdentity(identity(), null);
  assert.equal(result.attestation_result, "DISPATCH_IDENTITY_UNVERIFIED");
});

test("UNKNOWN runtime identity fields are unavailable, not a false mismatch", () => {
  const result = attestDispatchIdentity(identity(), {
    provider: "UNKNOWN",
    model: "UNKNOWN",
    model_family: "UNKNOWN",
    reasoning_effort: "UNKNOWN",
  });
  assert.equal(result.attestation_result, "DISPATCH_IDENTITY_UNVERIFIED");
});
