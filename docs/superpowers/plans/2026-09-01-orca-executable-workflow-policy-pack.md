# Orca Executable Workflow Policy Pack Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 將現有 Orca 多模型治理草稿升級為可驗證、可直接派工、能依可靠 quota 狀態選擇合格模型，並可安全發布到公開 GitHub repository 的政策包。

**Architecture:** 穩定流程規則留在 Markdown policies，快速變動的 provider/model mapping 集中在 `MODEL_REGISTRY.yaml`，資源快照使用不含敏感資料的 JSON。Node.js 驗證工具只做 schema、cross-file consistency 與 deterministic reference cases，不連接 provider、不讀帳號、不自動派工，因此 repository 仍是政策包而不是 router 應用程式。

**Tech Stack:** Markdown、YAML、JSON、Node.js 24、built-in `node:test`、`yaml` npm package、PowerShell、Git、Orca CLI、Codex CLI、Claude Code、Antigravity CLI、GitHub CLI。

---

## File responsibility map

**Create**

- `package.json`：只定義 policy validation scripts 與 YAML parser dev dependency。
- `package-lock.json`：鎖定 validation dependency。
- `scripts/validate-policy-pack.mjs`：解析並驗證 registry、resource state、routing cases、必要文件與敏感字樣。
- `tests/validate-policy-pack.test.mjs`：validator 的 red/green tests。
- `tests/fixtures/invalid-model-registry.yaml`：確認 validator 能拒絕低於能力門檻的 fallback。
- `tests/routing-cases.yaml`：經核准的 deterministic routing examples。
- `templates/BENCHMARK_RECORD_TEMPLATE.md`：低風險 benchmark 記錄格式。
- `templates/REGISTRY_DECISION_NOTE_TEMPLATE.md`：模型 mapping 升降級的證據與核准紀錄。
- `LICENSE`：MIT License。
- `.gitignore`：排除 dependencies、真實 runtime state、logs 與暫存檔。

**Modify**

- `policies/WORKFLOW_POLICY.md`：角色、生命週期、human gate、repair 與 cross-repo owner。
- `policies/CONCURRENCY_POLICY.md`：mode 判定與單一 integration owner。
- `policies/MODEL_ROUTING_POLICY.md`：六維分類、slot 表、候選演算法與 escalation。
- `policies/MODEL_REGISTRY.yaml`：ordered candidates、能力標籤、status、repair budget 與 resolver。
- `policies/RESOURCE_AWARE_ROUTING.md`：resource state、freshness、排序與 `UNKNOWN` 行為。
- `runtime/RESOURCE_STATE.example.json`：安全的 resource snapshot schema example。
- `templates/ROUTER_EXECUTION_CONTRACT_TEMPLATE.md`：可直接派工的完整 contract。
- `templates/CURRENT_PROJECT_HANDOFF_TEMPLATE.md`：加入 active contract、resource snapshot 與 next gate。
- `templates/NEW_SESSION_START_TEMPLATE.txt`：加入 authoritative owner 與禁止猜 quota 的啟動檢查。
- `references/OFFICIAL_COMMANDS.md`：只保留重新核對過的命令與版本差異。
- `references/SOURCE_NOTES.md`：記錄來源、查核日期、本機版本與差異。
- `skills/orca-multi-agent-dev/SKILL.md`：把政策包入口改為實際可執行順序。
- `README.md`：五分鐘快速開始、完整範例、檔案責任與發布說明。
- `project-handoffs/README.md`：說明只能存 sanitized example。
- `experiments/openusage-windows/README.md`：維持 optional/experimental 邊界。
- `AGENTS.md`：只在讀取順序需要同步時做最小變更。

## Spec coverage matrix

| Approved design area | Implementation owner |
|---|---|
| 六維 task classification 與 Capability slot 選擇 | Task 2 |
| Resource overlay、`UNKNOWN` 與候選演算法 | Task 3 |
| Model registry schema 與 routing cases | Task 3 |
| Execution lifecycle、contract、repair 與 escalation | Tasks 2 and 4 |
| Concurrency、worktree 與 human gates | Task 2 |
| Benchmark feedback loop | Task 5 |
| Official command verification | Task 6 |
| Five-minute entry point and file ownership | Task 7 |
| Privacy, MIT License, and public-repository safety | Task 8 |
| End-to-end acceptance and GitHub release | Tasks 9 and 10 |

## Task 1: Add the policy validation harness

**Files:**

- Create: `package.json`
- Create: `package-lock.json`
- Create: `tests/validate-policy-pack.test.mjs`
- Create: `scripts/validate-policy-pack.mjs`

- [ ] **Step 1: Create the package manifest**

Use this exact manifest; install resolves and records the current compatible `yaml` release in `package-lock.json`:

```json
{
  "name": "ai-dev-orca-workflow-skillpack",
  "version": "0.3.0",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "node --test",
    "validate": "node scripts/validate-policy-pack.mjs"
  },
  "devDependencies": {
    "yaml": "^2.8.1"
  }
}
```

Run: `npm install`

Expected: exit 0; `package-lock.json` exists; `npm audit` reports no unresolved high/critical issue. If the declared range is no longer installable, consult the official `yaml` package documentation, update only the dependency version, and record the selected version in the commit.

- [ ] **Step 2: Write failing validator tests**

Create `tests/validate-policy-pack.test.mjs` with tests that import `validateRegistry`, `validateResourceState`, `selectCandidate`, and `scanText` from the not-yet-created validator. Cover these exact assertions:

```js
import test from "node:test";
import assert from "node:assert/strict";
import {
  scanText,
  selectCandidate,
  validateRegistry,
  validateResourceState,
} from "../scripts/validate-policy-pack.mjs";

const registry = {
  capability_order: ["CHEAP_GENERALIST", "DEFAULT_IMPLEMENTER", "STRONG_IMPLEMENTER"],
  capability_slots: {
    DEFAULT_IMPLEMENTER: {
      minimum_capability: "DEFAULT_IMPLEMENTER",
      max_repair_attempts: 2,
      candidates: [
        { provider: "codex", model: "luna", reasoning: "medium", capability: "DEFAULT_IMPLEMENTER", status: "stable" },
        { provider: "codex", model: "sol", reasoning: "medium", capability: "STRONG_IMPLEMENTER", status: "stable" },
      ],
    },
  },
};

test("registry accepts ordered candidates at or above minimum capability", () => {
  assert.deepEqual(validateRegistry(registry), []);
});

test("registry rejects a fallback below minimum capability", () => {
  const invalid = structuredClone(registry);
  invalid.capability_slots.DEFAULT_IMPLEMENTER.candidates[1].capability = "CHEAP_GENERALIST";
  assert.match(validateRegistry(invalid).join("\n"), /below minimum capability/);
});

test("UNKNOWN resource state never changes registry order", () => {
  const selected = selectCandidate(registry.capability_slots.DEFAULT_IMPLEMENTER, {
    codex: { state: "UNKNOWN", available: true },
  }, registry.capability_order);
  assert.equal(selected.model, "luna");
});

test("GREEN candidate is preferred over RED without crossing the minimum", () => {
  const slot = structuredClone(registry.capability_slots.DEFAULT_IMPLEMENTER);
  slot.candidates[1].provider = "claude";
  const selected = selectCandidate(slot, {
    codex: { state: "RED", available: true },
    claude: { state: "GREEN", available: true },
  }, registry.capability_order);
  assert.equal(selected.model, "sol");
});

test("resource state rejects guessed or unknown enum values", () => {
  assert.match(validateResourceState({ checked_at: null, providers: { codex: { state: "MAYBE", available: true } } }).join("\n"), /invalid state/);
});

test("sensitive and unfinished markers are reported", () => {
  const findings = scanText("\u0074oken=secret\n\u0054ODO later");
  assert.equal(findings.length, 2);
});
```

- [ ] **Step 3: Run tests to verify the import fails**

Run: `npm test`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `scripts/validate-policy-pack.mjs`.

- [ ] **Step 4: Implement the minimal validator API**

Create `scripts/validate-policy-pack.mjs`. It must:

- export the four functions imported by the tests;
- compare candidate capability indexes against `minimum_capability`;
- reject missing/empty candidate fields and any status outside `stable|experimental`;
- accept only `GREEN|YELLOW|RED|UNKNOWN` resource states and boolean `available`;
- filter unavailable, experimental-not-allowed, and below-minimum candidates;
- prefer state buckets in order `GREEN`, `UNKNOWN`, `YELLOW`, `RED`, while preserving registry order inside each bucket;
- report unfinished markers represented by `\u0054ODO`, `\u0054BD`, and `\u0046IXME`, plus credential assignments represented by `\u0074oken=`, `\u0061pi_key=`, private-key headers, and equivalent common names;
- when run directly, parse `policies/MODEL_REGISTRY.yaml`, `runtime/RESOURCE_STATE.example.json`, and `tests/routing-cases.yaml`, then print a count summary and exit 1 on findings.

The direct-run guard must use:

```js
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const findings = await validateRepository(process.cwd());
  if (findings.length > 0) {
    console.error(findings.join("\n"));
    process.exitCode = 1;
  } else {
    console.log("Policy pack validation passed");
  }
}
```

Do not read environment variables other than normal process execution metadata, do not call provider APIs, and never print file contents that match sensitive patterns.

- [ ] **Step 5: Run the focused tests**

Run: `npm test`

Expected: 6 tests pass, 0 fail.

- [ ] **Step 6: Commit the harness**

```powershell
git add package.json package-lock.json scripts/validate-policy-pack.mjs tests/validate-policy-pack.test.mjs
git commit -m "test: add workflow policy validation harness"
```

## Task 2: Make task classification and workflow gates executable

**Files:**

- Modify: `policies/WORKFLOW_POLICY.md`
- Modify: `policies/CONCURRENCY_POLICY.md`
- Modify: `policies/MODEL_ROUTING_POLICY.md`
- Modify: `tests/validate-policy-pack.test.mjs`

- [ ] **Step 1: Add failing policy-document assertions**

Add a test that reads the three policy files and asserts the exact enums and mandatory phrases exist:

```js
test("stable policies expose required executable enums", async () => {
  const workflow = await readFile("policies/WORKFLOW_POLICY.md", "utf8");
  const concurrency = await readFile("policies/CONCURRENCY_POLICY.md", "utf8");
  const routing = await readFile("policies/MODEL_ROUTING_POLICY.md", "utf8");
  for (const phrase of ["verify → classify → route → contract → execute → review → repair or escalate → close", "permission ceiling", "authoritative owner"]) assert.match(workflow, new RegExp(phrase));
  for (const mode of ["SEQUENTIAL", "PARALLEL_INDEPENDENT", "COMPETITIVE_DESIGN", "PARALLEL_SAME_CORE_IMPLEMENTATION"]) assert.match(concurrency, new RegExp(mode));
  for (const dimension of ["risk", "complexity", "context_size", "ambiguity", "change_intensity", "verification_need"]) assert.match(routing, new RegExp(dimension));
});
```

Import `readFile` from `node:fs/promises`.

- [ ] **Step 2: Verify the document test fails**

Run: `npm test -- --test-name-pattern="stable policies"`

Expected: FAIL because the exact lifecycle and classification field names are absent.

- [ ] **Step 3: Rewrite the policy sections from the approved spec**

Make the three documents authoritative for these exact rules:

- `WORKFLOW_POLICY.md`: roles, precedence, new-session verification, lifecycle string, human gates, bounded repair, cross-repo source/target/owner/direction/allowed writes, and reviewer read-only preference.
- `CONCURRENCY_POLICY.md`: default `SEQUENTIAL`; opt-in checklist; `COMPETITIVE_DESIGN` proposal-only; same-core implementation prohibited; same implementation chain stays in one worktree; one integration owner.
- `MODEL_ROUTING_POLICY.md`: six classification fields and allowed values; complete slot decision table; separate discovery/implementation/review slots; candidate selection steps; two-repair escalation; `BLOCKED` when no qualified candidate exists.

Preserve the boundary that these files never hard-code fast-changing model IDs.

- [ ] **Step 4: Run the focused and complete tests**

Run: `npm test -- --test-name-pattern="stable policies"`

Expected: 1 matching test passes.

Run: `npm test`

Expected: all tests pass.

- [ ] **Step 5: Commit stable workflow policies**

```powershell
git add policies/WORKFLOW_POLICY.md policies/CONCURRENCY_POLICY.md policies/MODEL_ROUTING_POLICY.md tests/validate-policy-pack.test.mjs
git commit -m "docs: make workflow and routing gates executable"
```

## Task 3: Migrate the model registry and resource-state schemas

**Files:**

- Modify: `policies/MODEL_REGISTRY.yaml`
- Modify: `policies/RESOURCE_AWARE_ROUTING.md`
- Modify: `runtime/RESOURCE_STATE.example.json`
- Create: `tests/fixtures/invalid-model-registry.yaml`
- Create: `tests/routing-cases.yaml`
- Modify: `tests/validate-policy-pack.test.mjs`
- Modify: `scripts/validate-policy-pack.mjs`

- [ ] **Step 1: Add failing repository-schema tests**

Add tests that parse the real registry and resource example and assert:

```js
test("repository registry satisfies the executable schema", async () => {
  const registry = parse(await readFile("policies/MODEL_REGISTRY.yaml", "utf8"));
  assert.deepEqual(validateRegistry(registry), []);
});

test("resource example satisfies the safe snapshot schema", async () => {
  const state = JSON.parse(await readFile("runtime/RESOURCE_STATE.example.json", "utf8"));
  assert.deepEqual(validateResourceState(state), []);
  assert.equal(state.checked_at, null);
});
```

- [ ] **Step 2: Verify the current schemas fail**

Run: `npm test -- --test-name-pattern="repository registry|resource example"`

Expected: FAIL because the current registry uses singular `fallback` and lacks minimum capability, status, capability labels, repair budget, and resolver metadata.

- [ ] **Step 3: Replace the registry with ordered candidates**

Define top-level `version`, `verified_at`, `capability_order`, optional `resolvers`, and all nine capability slots. Every slot must have `minimum_capability`, `max_repair_attempts`, and non-empty ordered `candidates`; every candidate must have `provider`, `model`, `reasoning`, `capability`, and `status`.

Keep the approved philosophy:

- Luna-first for bounded clear-contract work.
- Sol for strong implementation and structural repair.
- Claude Sonnet for deep reasoning, architecture, auth/RBAC/RLS, and deep review.
- Opus only for exceptional escalation.
- Antigravity live model discovery for long-context discovery, independent review, and regression hunting.

For dynamic Antigravity names, reference a resolver whose command is `agy models`; do not freeze a display name obtained from one machine.

- [ ] **Step 4: Expand the resource policy and safe example**

`RESOURCE_AWARE_ROUTING.md` must define `GREEN`, `YELLOW`, `RED`, `UNKNOWN`, five-minute freshness, critical refresh behavior, state-bucket ordering, and the prohibition on crossing `minimum_capability`.

Each provider entry in `RESOURCE_STATE.example.json` must use this shape with null example values:

```json
{
  "available": null,
  "state": "UNKNOWN",
  "short_window": { "used": null, "reset_at": null },
  "weekly_window": { "used": null, "reset_at": null },
  "source": "UNKNOWN"
}
```

The top level must contain `schema_version` and `checked_at`. Do not add real usage data.

- [ ] **Step 5: Add deterministic routing cases**

Create `tests/routing-cases.yaml` with these named cases and explicit expected outcome:

- `bounded_implementation_all_unknown`: `DEFAULT_IMPLEMENTER`, all candidates `UNKNOWN`, expected first stable registry candidate.
- `auth_contract_requires_deep_reasoner`: high-risk auth/RBAC/RLS, expected `DEEP_REASONER` and human gate.
- `large_cross_repo_with_independent_review`: discovery `LONG_CONTEXT_DISCOVERY`, implementation `STRONG_IMPLEMENTER`, review `INDEPENDENT_REVIEWER`, concurrency `SEQUENTIAL` unless inventory outputs are independent.
- `green_fallback_over_red_primary`: qualified fallback `GREEN`, primary `RED`, expected fallback.
- `no_candidate_meets_minimum`: every available candidate below minimum or unavailable, expected `BLOCKED`.
- `repair_budget_exhausted`: attempt count equals two, expected escalation instead of retry.

Extend `validateRepository` to parse every case, call the reference selector for selection-only cases, and validate the declared multi-stage outcomes for the architecture cases.

- [ ] **Step 6: Add and exercise the invalid fixture**

Create `tests/fixtures/invalid-model-registry.yaml` with a `STRONG_IMPLEMENTER` slot whose only candidate declares `capability: DEFAULT_IMPLEMENTER`. Add a test expecting the exact finding `below minimum capability`.

Run: `npm test`

Expected: all tests pass, including the invalid-fixture rejection and six routing cases.

Run: `npm run validate`

Expected: `Policy pack validation passed`.

- [ ] **Step 7: Commit dynamic routing schemas**

```powershell
git add policies/MODEL_REGISTRY.yaml policies/RESOURCE_AWARE_ROUTING.md runtime/RESOURCE_STATE.example.json tests/fixtures/invalid-model-registry.yaml tests/routing-cases.yaml tests/validate-policy-pack.test.mjs scripts/validate-policy-pack.mjs
git commit -m "feat: add validated model and resource routing schemas"
```

## Task 4: Upgrade execution, handoff, and session templates

**Files:**

- Modify: `templates/ROUTER_EXECUTION_CONTRACT_TEMPLATE.md`
- Modify: `templates/CURRENT_PROJECT_HANDOFF_TEMPLATE.md`
- Modify: `templates/NEW_SESSION_START_TEMPLATE.txt`
- Modify: `tests/validate-policy-pack.test.mjs`

- [ ] **Step 1: Add failing template contract tests**

Add a table-driven test requiring these fields:

```js
const requiredContractFields = [
  "contract_version", "task_id", "authoritative_owner", "implementation_slot",
  "review_slot", "actual_provider", "actual_model", "resource_checked_at",
  "permission_ceiling", "repair_budget", "stop_conditions", "TASK_RESULT", "RESOURCE_STATUS",
];
```

Require the handoff template to include `active_contract`, `resource_snapshot`, `next_gate`, `things_not_to_redo`, and the session template to include `do not guess quota` plus `production_access: false`.

- [ ] **Step 2: Verify template tests fail**

Run: `npm test -- --test-name-pattern="template"`

Expected: FAIL listing absent contract fields.

- [ ] **Step 3: Rewrite all three templates**

The execution contract must contain every required field from the design spec, distinguish preferred slot from actual model, and include the exact structured completion footers. The handoff must preserve current state and point to the active contract rather than duplicating it. The session start template must enforce read order, repo/HEAD/dirty-tree verification, owner confirmation, explicit concurrency, minimum permissions, and `UNKNOWN` quota behavior.

- [ ] **Step 4: Run tests and validate**

Run: `npm test; npm run validate`

Expected: both commands exit 0.

- [ ] **Step 5: Commit templates**

```powershell
git add templates/ROUTER_EXECUTION_CONTRACT_TEMPLATE.md templates/CURRENT_PROJECT_HANDOFF_TEMPLATE.md templates/NEW_SESSION_START_TEMPLATE.txt tests/validate-policy-pack.test.mjs
git commit -m "docs: strengthen execution and handoff contracts"
```

## Task 5: Add benchmark governance and sanitized project-state rules

**Files:**

- Create: `templates/BENCHMARK_RECORD_TEMPLATE.md`
- Create: `templates/REGISTRY_DECISION_NOTE_TEMPLATE.md`
- Modify: `project-handoffs/README.md`
- Modify: `experiments/openusage-windows/README.md`
- Modify: `tests/validate-policy-pack.test.mjs`

- [ ] **Step 1: Add failing governance-template tests**

Require the benchmark template to contain `task_class`, `slot`, `provider`, `model`, `reasoning`, `correctness`, `wall_clock_latency`, `repair_count`, `review_findings`, `review_catch_rate`, `quota_efficiency`, and `confounders`. Require the decision note to contain evidence sample size, old mapping, new mapping, rollback condition, reviewer, approval, and effective date.

- [ ] **Step 2: Verify governance tests fail**

Run: `npm test -- --test-name-pattern="benchmark|decision note"`

Expected: FAIL because both templates do not exist.

- [ ] **Step 3: Create both templates**

Use `UNKNOWN` as the permitted value whenever token/quota data is unavailable. State that a single benchmark cannot promote an experimental model. Require multiple comparable runs, no major regression, and a decision note before changing stable mapping.

- [ ] **Step 4: Constrain project and experimental data**

Update `project-handoffs/README.md` to prohibit real customer/personal data and recommend sanitized examples only. Update `experiments/openusage-windows/README.md` so Windows quota discovery remains optional, local-only, and non-authoritative until independently verified; prohibit storing raw provider responses.

- [ ] **Step 5: Run tests and commit**

Run: `npm test; npm run validate`

Expected: both commands exit 0.

```powershell
git add templates/BENCHMARK_RECORD_TEMPLATE.md templates/REGISTRY_DECISION_NOTE_TEMPLATE.md project-handoffs/README.md experiments/openusage-windows/README.md tests/validate-policy-pack.test.mjs
git commit -m "docs: add benchmark and registry governance"
```

## Task 6: Reverify official commands and record version differences

**Files:**

- Modify: `references/OFFICIAL_COMMANDS.md`
- Modify: `references/SOURCE_NOTES.md`
- Modify: `tests/validate-policy-pack.test.mjs`

- [ ] **Step 1: Capture local command evidence**

Run each command separately and save no credentials or account output:

```powershell
orca --help
orca status --json
orca terminal --help
orca worktree --help
codex --help
claude --help
agy --help
agy models
gh --version
```

Expected on this machine: Orca runtime 1.4.192, Codex CLI 0.151.0, Claude Code 2.1.252, Antigravity CLI 1.1.22, and GitHub CLI 2.92.0. If live output differs, the live output wins and the notes must use the observed versions.

- [ ] **Step 2: Verify against primary upstream sources**

Consult only primary sources linked in `references/OFFICIAL_COMMANDS.md`: Orca repository skill guides, OpenAI help/repository, Anthropic CLI reference, Google Antigravity announcement/codelab, OpenUsage repository, and GitHub CLI manual. Record access date `2026-09-01` and distinguish upstream-supported flags from locally accepted flags.

- [ ] **Step 3: Add a failing stale-command assertion**

Add a test that rejects `--screen`, `approval_policy = "untrusted"`, and `--dangerously-skip-permissions` when presented as defaults. It may allow those strings only inside an explicitly labeled historical or prohibited note.

- [ ] **Step 4: Rewrite command and source references**

Use current Orca JSON/cursor reads, complete worktree IDs, `terminal wait --for tui-idle`, Codex `model_reasoning_effort`, conservative sandbox/approval examples, Claude safe permission modes, and live `agy models` resolution. Add a visible rule that installed `--help` wins before automation.

- [ ] **Step 5: Run validation and commit**

Run: `npm test; npm run validate`

Expected: both commands exit 0 and stale default examples are absent.

```powershell
git add references/OFFICIAL_COMMANDS.md references/SOURCE_NOTES.md tests/validate-policy-pack.test.mjs
git commit -m "docs: reverify official agent CLI commands"
```

## Task 7: Rewrite the skill entry point and five-minute README

**Files:**

- Modify: `skills/orca-multi-agent-dev/SKILL.md`
- Modify: `README.md`
- Modify: `AGENTS.md` only if its read order differs from the final authoritative order
- Modify: `tests/validate-policy-pack.test.mjs`

- [ ] **Step 1: Add failing entry-point tests**

Require both README and skill to contain the authoritative read order, six-stage routing example, `UNKNOWN` behavior, human gate, validation command, and a link to the execution contract template. Require README to distinguish stable workflow, dynamic mapping, runtime snapshot, project handoff, and experimental material.

- [ ] **Step 2: Verify entry-point tests fail**

Run: `npm test -- --test-name-pattern="entry point|quick start"`

Expected: FAIL because the current README has no five-minute procedure or complete example.

- [ ] **Step 3: Rewrite `SKILL.md` as the agent entry point**

Keep it compact and imperative. It must instruct the agent to read the policy chain, verify current project state, classify the task, choose a capability slot, apply fresh resource state without guessing, create the execution contract, dispatch through Orca, review independently when required, and return the two completion footers.

- [ ] **Step 4: Rewrite README**

Include:

1. purpose and non-goals;
2. five-minute quick start;
3. authoritative file map;
4. one end-to-end bounded implementation example;
5. one auth/high-risk human-gate example;
6. one all-`UNKNOWN` quota example;
7. `npm install`, `npm test`, and `npm run validate` commands;
8. privacy/security boundary;
9. contribution rule that mapping changes belong in `MODEL_REGISTRY.yaml`;
10. release/license information.

- [ ] **Step 5: Synchronize AGENTS read order only if necessary**

The final order must remain `SKILL → WORKFLOW_POLICY → CONCURRENCY_POLICY → MODEL_ROUTING_POLICY → RESOURCE_AWARE_ROUTING → OFFICIAL_COMMANDS → Current Project Handoff`. Do not add implementation detail to `AGENTS.md`.

- [ ] **Step 6: Run validation and commit**

Run: `npm test; npm run validate`

Expected: both commands exit 0.

```powershell
git add README.md skills/orca-multi-agent-dev/SKILL.md AGENTS.md tests/validate-policy-pack.test.mjs
git commit -m "docs: add executable workflow quick start"
```

## Task 8: Add public-repository safety files

**Files:**

- Create: `LICENSE`
- Create: `.gitignore`
- Modify: `scripts/validate-policy-pack.mjs`
- Modify: `tests/validate-policy-pack.test.mjs`

- [ ] **Step 1: Add failing repository-safety tests**

Require `LICENSE` to contain `MIT License`, `Copyright (c) 2026 fordissi`, and the standard MIT permission/warranty paragraphs. Require `.gitignore` to include:

```gitignore
node_modules/
runtime/RESOURCE_STATE.json
*.log
.env
.env.*
!.env.example
```

Add repository scanning exclusions for `.git/`, `node_modules/`, the approved design/plan history, and invalid test fixtures; do not exclude normal policy files from sensitive scanning.

- [ ] **Step 2: Verify safety tests fail**

Run: `npm test -- --test-name-pattern="license|gitignore|repository scan"`

Expected: FAIL because the safety files do not exist.

- [ ] **Step 3: Add MIT license and ignore rules**

Use the standard MIT License text and the approved copyright line. Add only generated, local runtime, log, environment, editor, and OS artifacts to `.gitignore`; do not ignore the example resource-state JSON.

- [ ] **Step 4: Run full verification**

Run:

```powershell
npm test
npm run validate
git diff --check
git status --short
```

Expected: tests and validation exit 0; `git diff --check` has no output; status lists only the intended Task 8 files before commit.

- [ ] **Step 5: Commit repository safety files**

```powershell
git add LICENSE .gitignore scripts/validate-policy-pack.mjs tests/validate-policy-pack.test.mjs
git commit -m "chore: prepare policy pack for public release"
```

## Task 9: Perform final policy and release verification

**Files:**

- Modify only files needed to fix findings from the checks below

- [ ] **Step 1: Run automated verification from a clean dependency install**

Use a temporary copy or a clean worktree so dependency cleanup does not delete user files. Run:

```powershell
npm ci
npm test
npm run validate
git diff --check
```

Expected: install exit 0; all tests pass; validator prints `Policy pack validation passed`; whitespace check prints nothing.

- [ ] **Step 2: Run the spec-coverage checklist**

For every heading in `docs/superpowers/specs/2026-09-01-orca-executable-workflow-policy-design.md`, identify the implementing file and test. Confirm all of these are present: classification, slots, overlay, registry, lifecycle, concurrency, gates, benchmark, templates, official commands, privacy, MIT, GitHub release.

Expected: no uncovered requirement.

- [ ] **Step 3: Exercise the six routing fixtures**

Run: `npm run validate`

Expected summary includes six routing cases evaluated and zero failures. Confirm manually that the auth case reaches a human gate and the no-qualified-candidate case returns `BLOCKED`.

- [ ] **Step 4: Review repository contents before publication**

Run:

```powershell
git status --short --branch
git log --oneline --decorate -12
git ls-files
```

Expected: `main` has only intentional commits; no staged, unstaged, or untracked files; tracked files contain no `.env`, runtime real state, logs, credentials, personal/customer handoffs, or dependency directory.

- [ ] **Step 5: Commit verification-only fixes if necessary**

If checks required changes, stage only named files and commit:

```powershell
git commit -m "fix: resolve policy pack verification findings"
```

If no files changed, do not create an empty commit.

## Task 10: Create and verify the public GitHub repository

**Files:**

- No repository file changes expected

- [ ] **Step 1: Confirm publication preconditions**

Run:

```powershell
gh auth status
gh repo view fordissi/ai-dev-orca-workflow-skillpack --json name,owner,visibility,defaultBranchRef,url
git remote -v
git status --short --branch
```

Expected: GitHub authentication is valid; working tree is clean. `gh repo view` should report not found before creation. If the repository already exists, stop and inspect ownership/content rather than overwriting it.

- [ ] **Step 2: Create and push the approved public repository**

Only after confirming the target does not exist, run:

```powershell
gh repo create fordissi/ai-dev-orca-workflow-skillpack --public --source . --remote origin --push
```

Expected: repository is created under `fordissi`, `origin` is added, and local `main` is pushed.

- [ ] **Step 3: Verify remote state**

Run:

```powershell
gh repo view fordissi/ai-dev-orca-workflow-skillpack --json nameWithOwner,visibility,defaultBranchRef,licenseInfo,url
git remote -v
git ls-remote --heads origin main
git status --short --branch
```

Expected:

- `nameWithOwner` is `fordissi/ai-dev-orca-workflow-skillpack`;
- visibility is `PUBLIC`;
- default branch is `main`;
- license is MIT;
- remote `main` commit equals local `HEAD`;
- local branch tracks `origin/main` and the working tree is clean.

- [ ] **Step 4: Record Orca completion metadata**

Run:

```powershell
orca worktree set --worktree active --comment "policy pack validated and published" --workspace-status completed --json
```

Expected: Orca returns `ok: true`, status `completed`, and the final comment.

- [ ] **Step 5: Return the completion footer**

Report the public repository URL, final commit, validation counts, Git status, any provider/resource state still `UNKNOWN`, and this exact structure:

```text
TASK_RESULT
status: PASS | FAIL | BLOCKED
changed_files:
tests:
git_status:
remaining_risks:
human_decisions_required:

RESOURCE_STATUS
checked_at:
provider_states:
source_summary:
```
