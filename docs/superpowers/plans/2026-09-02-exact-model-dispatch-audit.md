# Exact Model Dispatch Audit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent autonomous reviewer dispatch from leaving the human-authoritative registry or silently inheriting provider/runtime model and reasoning defaults.

**Architecture:** Keep candidate selection in `MODEL_REGISTRY.yaml` and add a pure conformance boundary after selection and before acceptance. The boundary records selection source, compares expected and observed provider/model/family/reasoning identity, rejects unregistered autonomous candidates, and refuses exact-dispatch claims when runtime identity is unavailable. Provider command references and the router contract template document the same invariant.

**Tech Stack:** Node.js ESM, `node:test`, YAML fixtures, Markdown policy documents.

---

### Task 1: Add failing dispatch-contract conformance cases

**Files:**
- Modify: `tests/validate-policy-pack.test.mjs`
- Modify: `scripts/validate-policy-pack.mjs`

- [x] **Step 1: Write tests for registry membership, human override freshness, command identity, attestation, and terminal compatibility.** Cover the twelve requested cases, including the actual `gpt-5.5` mismatch and unavailable runtime identity.

- [x] **Step 2: Run the focused test file and confirm the new cases fail against the current `PASS`/`INVALID_DISPATCH` implementation.**

Run: `node --test tests/validate-policy-pack.test.mjs`

Expected: failures for the new dispatch identity result names and registry/override/reuse checks.

- [x] **Step 3: Implement pure helpers in `scripts/validate-policy-pack.mjs`.** Add exact identity comparison, explicit command checks for supported providers, registry candidate admission, current human override validation, and terminal reuse validation. Preserve existing routing, resource, quota, disjointness, continuation, and permission behavior.

- [x] **Step 4: Re-run the focused tests and confirm all dispatch cases pass.**

Run: `node --test tests/validate-policy-pack.test.mjs`

Expected: PASS.

### Task 2: Make the policy and contract boundary normative

**Files:**
- Modify: `policies/WORKFLOW_POLICY.md`
- Modify: `policies/MODEL_ROUTING_POLICY.md`
- Modify: `skills/orca-multi-agent-dev/SKILL.md`
- Modify: `references/OFFICIAL_COMMANDS.md`
- Modify: `templates/ROUTER_EXECUTION_CONTRACT_TEMPLATE.md`

- [x] **Step 1: State the dispatch invariant and result names.** Require `EXPECTED_IDENTITY` and `ACTUAL_IDENTITY` to contain provider, model, model family, and reasoning; known differences are `DISPATCH_CONTRACT_MISMATCH`, unavailable actual values are `DISPATCH_IDENTITY_UNVERIFIED`, and all four matching values are `DISPATCH_IDENTITY_MATCH`.

- [x] **Step 2: Bind autonomous selection to the enabled registry.** Require `REGISTRY_AUTONOMOUS` selection to identify an enabled candidate in the selected slot after disjointness; reject an unregistered model before dispatch. Permit only a current, task-local `HUMAN_EXPLICIT_OVERRIDE`; document that `HUMAN_RETROACTIVE_ACCEPTANCE` is audit history and cannot authorize or expand future routing.

- [x] **Step 3: Document launch-path requirements.** Require explicit model and reasoning arguments for Orca `worker-start`, direct provider commands, and commands injected into existing terminals. Classify `dispatch --inject`, `worktree create --agent`, generic reviewer helpers, and uninspectable reused terminals as fallback-risk or unverified unless the full identity is attested.

- [x] **Step 4: Add the identity and selection-source fields to the router contract template.** Keep the operational command unresolved until candidate selection, then require the explicit command and attestation result.

### Task 3: Validate the complete skillpack

**Files:**
- No additional files.

- [x] **Step 1: Run `npm test`.**

- [x] **Step 2: Run `npm run validate`.**

- [x] **Step 3: Run `git diff --check` and inspect the diff.** Confirm the registry, architecture, resource probes, quota matrices, and pre-existing user files are unchanged.

- [x] **Step 4: Report the incident as a confirmed pre-fix dispatch defect while preserving the human-accepted Foundation review as historical evidence only.**
