# Orca Executable Workflow Policy Pack Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 將現有 Orca 多模型治理草稿升級為可驗證、可直接派工、能依可靠 quota 狀態選擇合格模型，並可安全發布到公開 GitHub repository 的政策包。

**Architecture:** 穩定流程規則留在 normative Markdown policies，快速變動的 provider/model mapping 集中在 `MODEL_REGISTRY.yaml`，資源快照使用不含敏感資料的 JSON。Node.js 工具只是必須服從 Markdown 的 conformance checker，做 schema、cross-file consistency、deterministic reference cases 與公開內容掃描；它不連接 provider、不讀帳號、不自動派工，因此 repository 仍是政策包而不是 router 應用程式。若工具與政策衝突，修正工具而不是反向覆寫政策。

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
- `references/MODEL_EVIDENCE.md`：外部評測、CLI/model-ID 查核、限制、confidence 與 expiry 的可審核證據。
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
| 六維 task classification、Capability tier 與 orthogonal role/slot 選擇 | Task 2 |
| Resource overlay、`UNKNOWN` 與候選演算法 | Task 3 |
| Model registry schema 與 routing cases | Task 3 |
| Execution lifecycle、contract、repair 與 escalation | Tasks 2 and 4 |
| Concurrency、worktree 與 human gates | Task 2 |
| External evidence basket、local smoke tasks 與 benchmark feedback loop | Task 5 |
| Official command verification | Task 6 |
| Five-minute entry point and file ownership | Task 7 |
| Privacy, MIT License, and public-repository safety | Task 8 |
| End-to-end acceptance and GitHub release | Tasks 9 and 10 |

## Task 1: Add the policy validation harness

**Files:**

- Create: `.gitignore`
- Create: `package.json`
- Create: `package-lock.json`
- Create: `tests/validate-policy-pack.test.mjs`
- Create: `scripts/validate-policy-pack.mjs`

- [ ] **Step 1: Protect local and generated files before installing dependencies**

Create `.gitignore` first, with at least:

```gitignore
node_modules/
runtime/RESOURCE_STATE.json
*.log
.env
.env.*
!.env.example
```

Do not ignore the example resource-state JSON, `docs/superpowers/`, tests, or policy files. The design and plan are intentionally public and must remain inside repository scans.

- [ ] **Step 2: Create the package manifest and audit the dependency**

Use this exact manifest; install resolves and records the current compatible `yaml` release in `package-lock.json`:

```json
{
  "name": "ai-dev-orca-workflow-skillpack",
  "version": "0.3.0",
  "private": true,
  "type": "module",
  "engines": {
    "node": ">=24"
  },
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

Then run: `npm audit --audit-level=high`

Expected: both commands exit 0; `package-lock.json` exists; no unresolved high/critical advisory remains. These commands require network access. If the registry or audit service cannot be reached, record `UNKNOWN`/`BLOCKED` instead of inferring success. If the declared range is no longer installable, consult the official `yaml` package documentation, update only the dependency version, and record the selected version in the commit.

`yaml` is intentionally a development dependency because this private policy repository ships source validation tooling, not a production runtime; `npm ci --omit=dev` is not a supported validation environment.

- [ ] **Step 3: Write failing validator tests**

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
  capability_tier_order: ["CHEAP", "DEFAULT", "STRONG", "DEEP"],
  capability_slots: {
    DEFAULT_IMPLEMENTER: {
      role: "IMPLEMENTATION",
      minimum_tier: "DEFAULT",
      max_repair_attempts: 2,
      candidates: [
        { provider: "codex", resource_state_key: "codex", model: "luna", model_family: "gpt-5.6", reasoning: "medium", capability_tier: "DEFAULT", status: "stable" },
        { provider: "claude", resource_state_key: "claude", model: "sonnet", model_family: "claude-sonnet", reasoning: "high", capability_tier: "STRONG", status: "stable" },
      ],
    },
  },
};

test("registry accepts ordered candidates at or above minimum capability", () => {
  assert.deepEqual(validateRegistry(registry), []);
});

test("registry rejects a fallback below minimum capability", () => {
  const invalid = structuredClone(registry);
  invalid.capability_slots.DEFAULT_IMPLEMENTER.candidates[1].capability_tier = "CHEAP";
  assert.match(validateRegistry(invalid).join("\n"), /below minimum tier/);
});

test("all-UNKNOWN resource state never changes registry order", () => {
  const selected = selectCandidate(registry.capability_slots.DEFAULT_IMPLEMENTER, {
    codex: { state: "UNKNOWN", available: true },
    claude: { state: "UNKNOWN", available: true },
  }, registry.capability_tier_order, { allowExperimental: false, taskRisk: "low" });
  assert.equal(selected.status, "SELECTED");
  assert.equal(selected.candidate.model, "luna");
});

test("UNKNOWN primary is not demoted below a YELLOW fallback", () => {
  const selected = selectCandidate(registry.capability_slots.DEFAULT_IMPLEMENTER, {
    codex: { state: "UNKNOWN", available: true },
    claude: { state: "YELLOW", available: true },
  }, registry.capability_tier_order, { allowExperimental: false, taskRisk: "low" });
  assert.equal(selected.candidate.model, "luna");
});

test("YELLOW resource state is not demoted below UNKNOWN", () => {
  const selected = selectCandidate(registry.capability_slots.DEFAULT_IMPLEMENTER, {
    codex: { state: "YELLOW", available: true },
    claude: { state: "UNKNOWN", available: true },
  }, registry.capability_tier_order, { allowExperimental: false, taskRisk: "low" });
  assert.equal(selected.candidate.model, "luna");
});

test("GREEN candidate is preferred over RED without crossing the minimum", () => {
  const selected = selectCandidate(registry.capability_slots.DEFAULT_IMPLEMENTER, {
    codex: { state: "RED", available: true },
    claude: { state: "GREEN", available: true },
  }, registry.capability_tier_order, { allowExperimental: false, taskRisk: "low" });
  assert.equal(selected.candidate.model, "sonnet");
});

test("high-risk work rejects experimental candidates unless explicitly allowed", () => {
  const slot = structuredClone(registry.capability_slots.DEFAULT_IMPLEMENTER);
  slot.candidates[0].status = "experimental";
  slot.candidates.splice(1);
  const selected = selectCandidate(slot, { codex: { state: "GREEN", available: true } }, registry.capability_tier_order, { allowExperimental: false, taskRisk: "high" });
  assert.equal(selected.status, "BLOCKED");
  assert.equal(typeof selected.reason, "string");
  assert.ok(selected.reason.length > 0);
});

test("independent review excludes the implementer provider and model family", () => {
  const selected = selectCandidate(registry.capability_slots.DEFAULT_IMPLEMENTER, {
    codex: { state: "GREEN", available: true },
    claude: { state: "UNKNOWN", available: true },
  }, registry.capability_tier_order, { allowExperimental: false, taskRisk: "high", excludeProvider: "codex", excludeModelFamily: "gpt-5.6" });
  assert.equal(selected.candidate.provider, "claude");
});

test("resource state rejects guessed or unknown enum values", () => {
  assert.match(validateResourceState({ providers: { codex: { checked_at: null, state: "MAYBE", available: true } } }).join("\n"), /invalid state/);
});

test("sensitive and unfinished markers are reported", () => {
  const findings = scanText("\u0074oken=secret\n\u0054ODO later");
  const patterns = new Set(findings.map(({ pattern }) => pattern));
  assert.ok(patterns.has("credential-assignment"));
  assert.ok(patterns.has("unfinished-marker"));
});
```

- [ ] **Step 4: Run tests to verify the import fails**

Run: `npm test`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `scripts/validate-policy-pack.mjs`.

- [ ] **Step 5: Implement the minimal validator library API**

Create `scripts/validate-policy-pack.mjs`. It must:

- export the four functions imported by the tests;
- compare candidate `capability_tier` indexes against `minimum_tier`; roles and slots are not members of the tier ladder;
- reject missing/empty candidate fields and any status outside `stable|experimental`;
- accept only `GREEN|YELLOW|RED|UNKNOWN` resource states; runtime snapshots require boolean `available`, while an explicit `{ allowExampleNulls: true }` validation option may accept `available: null` only together with `state: UNKNOWN` in the public example;
- accept an options object that expresses task risk, experimental permission, and the implementer's provider/model family;
- resolve resource state through each candidate's `resource_state_key`, not through a provider-wide timestamp when the provider has multiple pools;
- filter unavailable, disallowed experimental, below-minimum, and non-independent reviewer candidates;
- select a qualified `GREEN` candidate first; otherwise treat `YELLOW` and `UNKNOWN` neutrally and preserve registry order; consider `RED` only when policy explicitly permits it;
- return `{ status: "SELECTED", candidate }` on success or `{ status: "BLOCKED", reason }` when no candidate qualifies;
- report unfinished markers represented by `\u0054ODO`, `\u0054BD`, and `\u0046IXME`, credential assignments represented by `\u0074oken=`, `\u0061pi_key=`, private-key headers and equivalent common names, plus defined personal/customer-data markers that are prohibited by repository policy;
- return scanner findings with pattern name and location metadata only; never include the matched text or line content.

At this stage the module is a library only. Do not add the direct-run repository path until Task 3 has migrated the registry and created routing cases. The Markdown policies are normative; this module is a conformance checker and must be corrected whenever it disagrees with policy. Do not read environment variables, call provider APIs, or dispatch work.

- [ ] **Step 6: Run the focused tests**

Run: `npm test`

Expected: all harness tests pass with zero failures.

- [ ] **Step 7: Commit the harness**

```powershell
git add .gitignore package.json package-lock.json scripts/validate-policy-pack.mjs tests/validate-policy-pack.test.mjs
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

- Add assertions for the four-value capability tier ladder, orthogonal role tags, the normative-policy/conformance-checker precedence rule, the `MODEL_REGISTRY` link, and `failed_repair_count >= max_repair_attempts`.

- [ ] **Step 2: Verify the document test fails**

Run: `npm test -- --test-name-pattern=stable`

Expected: FAIL because the exact lifecycle and classification field names are absent.

- [ ] **Step 3: Rewrite the policy sections from the approved spec**

Make the three documents authoritative for these exact rules:

- `WORKFLOW_POLICY.md`: roles, precedence, new-session verification, lifecycle string, human gates, bounded repair, cross-repo source/target/owner/direction/allowed writes, and reviewer read-only preference.
- `CONCURRENCY_POLICY.md`: default `SEQUENTIAL`; opt-in checklist; `COMPETITIVE_DESIGN` proposal-only; same-core implementation prohibited; same implementation chain stays in one worktree; one integration owner.
- `MODEL_ROUTING_POLICY.md`: six classification fields and allowed values; the `CHEAP < DEFAULT < STRONG < DEEP` tier ladder separated from role tags; complete slot decision table; separate discovery/implementation/review slots; candidate selection steps; provider/model-family disjoint independent review; `failed_repair_count >= max_repair_attempts` escalation; `BLOCKED` when no qualified candidate exists; and a link to `MODEL_REGISTRY.yaml` as the dynamic mapping owner.

Delete the existing `Current Philosophy` section and every hard-coded fast-changing model name from the stable policy. Preserve the boundary that model IDs belong only in `MODEL_REGISTRY.yaml`. State that Markdown policy is normative and validator code is only a conformance checker.

- [ ] **Step 4: Run the focused and complete tests**

Run: `npm test -- --test-name-pattern=stable`

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
  assert.deepEqual(validateResourceState(state, { allowExampleNulls: true }), []);
  assert.equal(state.providers.codex.checked_at, null);
  assert.equal(state.providers.antigravity.pools.gemini.checked_at, null);
  assert.equal(state.providers.antigravity.pools.non_gemini.checked_at, null);
});
```

- [ ] **Step 2: Verify the current schemas fail**

Run: `npm test -- --test-name-pattern=repository`

Expected: FAIL because the current registry uses singular `fallback` and lacks minimum capability, status, capability labels, repair budget, and resolver metadata.

- [ ] **Step 3: Replace the registry with ordered candidates**

Define top-level `version`, `verified_at`, `capability_tier_order: [CHEAP, DEFAULT, STRONG, DEEP]`, optional `resolvers`, and all nine capability slots. Every slot must have an orthogonal `role`, `minimum_tier`, `max_repair_attempts`, and non-empty ordered `candidates`; every candidate must have `provider`, `resource_state_key`, `model`, `model_family`, `reasoning`, `capability_tier`, `status`, and evidence metadata. `resource_state_key` maps the candidate to one independently fresh state entry (for example `codex` or `antigravity.gemini`). Never compare slot or role names as if they were capability tiers.

Keep the approved philosophy:

- Luna-first for bounded clear-contract work.
- Sol for strong implementation and structural repair.
- Claude Sonnet for deep reasoning, architecture, auth/RBAC/RLS, and deep review.
- Opus only for exceptional escalation.
- Antigravity live model discovery for long-context discovery, independent review, and regression hunting.

For dynamic Antigravity names, reference a resolver whose command is `agy models`; do not freeze a display name obtained from one machine.

Reverify the Codex IDs using a live authoritative source or installed model discovery. If an ID cannot be verified, mark it `provisional` with evidence state `UNKNOWN`; do not publish it as a verified stable mapping. A candidate supported only by external evidence remains `status: experimental` until the required local smoke cases and review pass. Record `evidence_scope`, `confidence`, `source`, `verified_at`, and `expires_at` so benchmark evidence cannot be mistaken for provider availability or CLI-ID verification.

- [ ] **Step 4: Expand the resource policy and safe example**

`RESOURCE_AWARE_ROUTING.md` must define `GREEN`, `YELLOW`, `RED`, `UNKNOWN`, per-source five-minute freshness, critical refresh behavior, `GREEN` preference, neutral registry-order treatment of `YELLOW`/`UNKNOWN`, restricted `RED` use, and the prohibition on crossing `minimum_tier`.

Each provider or independently limited pool in `RESOURCE_STATE.example.json` must use this shape with null example values:

```json
{
  "checked_at": null,
  "available": null,
  "state": "UNKNOWN",
  "short_window": { "used": null, "reset_at": null },
  "weekly_window": { "used": null, "reset_at": null },
  "source": "UNKNOWN"
}
```

The top level must contain `schema_version`; freshness is evaluated from each provider/pool's own `checked_at`, never a shared timestamp. Preserve Antigravity's distinct `gemini` and `non_gemini` pools under `providers.antigravity.pools`. Do not add real usage data.

The direct validator must call `validateResourceState(example, { allowExampleNulls: true })` only for `runtime/RESOURCE_STATE.example.json`. A real `runtime/RESOURCE_STATE.json` never gets this option and must use boolean availability; `null` cannot silently enter live routing.

- [ ] **Step 5: Add deterministic routing cases**

Create `tests/routing-cases.yaml` with these named cases and explicit expected outcome:

- `bounded_implementation_all_unknown`: `DEFAULT_IMPLEMENTER`, all candidates `UNKNOWN`, expected first stable registry candidate.
- `yellow_primary_unknown_fallback`: primary `YELLOW`, fallback `UNKNOWN`, expected primary by registry order.
- `unknown_primary_yellow_fallback`: primary `UNKNOWN`, fallback `YELLOW`, expected primary by registry order.
- `auth_contract_requires_deep_reasoner`: high-risk auth/RBAC/RLS, expected `DEEP_REASONER` and human gate.
- `large_cross_repo_with_independent_review`: discovery `LONG_CONTEXT_DISCOVERY`, implementation `STRONG_IMPLEMENTER`, review `INDEPENDENT_REVIEWER`, concurrency `SEQUENTIAL` unless inventory outputs are independent.
- `green_fallback_over_red_primary`: qualified fallback `GREEN`, primary `RED`, expected fallback.
- `independent_reviewer_is_disjoint`: expected reviewer provider and model family both differ from the selected implementer.
- `no_candidate_meets_minimum`: every available candidate below minimum or unavailable, expected `BLOCKED`.
- `experimental_high_risk_is_blocked`: experimental-only candidates on high-risk production work, expected `BLOCKED` unless a human explicitly allows the experiment.
- `repair_budget_exhausted`: `failed_repair_count >= max_repair_attempts`, expected escalation instead of retry; the initial implementation attempt is not counted as a repair.

Extend `validateRepository` to parse every case, call the conformance selector for selection-only cases, and validate the declared multi-stage outcomes for the architecture cases. The policy Markdown remains normative if code and prose disagree.

- [ ] **Step 6: Add and exercise the invalid fixture**

Create `tests/fixtures/invalid-model-registry.yaml` with a `STRONG_IMPLEMENTER` slot whose only candidate declares `capability_tier: DEFAULT` below `minimum_tier: STRONG`. Add a test expecting the exact finding `below minimum tier`.

Add the direct-run entry point now that every input exists. It must validate the registry, per-pool resource example, routing cases, internal schema relationships, and every publishable working-tree text file. Exclude `.git/`, `node_modules/`, binary/generated artifacts, and explicitly invalid fixtures where appropriate; do not exclude `docs/superpowers/`. Sensitive findings may contain path, line number, and pattern name only—never matched text.

Historical or prohibited command examples must use an explicit `PROHIBITED:` marker. Tests should use escaped literals so the repository scanner does not flag its own source. The direct-run guard must use `pathToFileURL(process.argv[1]).href`, print only redacted findings, and exit nonzero on any failure. It must not read provider accounts, call provider APIs, or dispatch work.

Run: `npm test`

Expected: all tests pass, including the invalid-fixture rejection and all ten routing cases.

Run: `npm run validate`

Expected: `Policy pack validation passed`.

- [ ] **Step 7: Commit schema migration, then routing conformance cases**

```powershell
git add policies/MODEL_REGISTRY.yaml policies/RESOURCE_AWARE_ROUTING.md runtime/RESOURCE_STATE.example.json tests/fixtures/invalid-model-registry.yaml tests/validate-policy-pack.test.mjs scripts/validate-policy-pack.mjs
git commit -m "feat: migrate model and resource routing schemas"
git add tests/routing-cases.yaml tests/validate-policy-pack.test.mjs scripts/validate-policy-pack.mjs
git commit -m "test: add routing policy conformance cases"
```

`npm run validate` is intentionally introduced only here; Tasks 1–2 use `npm test` because the legacy registry and missing routing-case file are not yet valid inputs.

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
  "contract_version", "task_id", "authoritative_owner", "implementation_role", "implementation_slot", "minimum_tier",
  "review_role", "review_slot", "actual_provider", "actual_model", "actual_model_family", "resource_checked_at",
  "implementer_provider", "implementer_model_family", "reviewer_provider", "reviewer_model_family",
  "permission_ceiling", "max_repair_attempts", "failed_repair_count",
  "stop_conditions", "TASK_RESULT", "RESOURCE_STATUS",
];
```

Require the handoff template to include `active_contract`, `resource_snapshot`, `next_gate`, `things_not_to_redo`, and the session template to include `do not guess quota` plus `production_access: false`.

- [ ] **Step 2: Verify template tests fail**

Run: `npm test -- --test-name-pattern=template`

Expected: FAIL listing absent contract fields.

- [ ] **Step 3: Rewrite all three templates**

The execution contract must contain every required field from the design spec, distinguish preferred slot from actual model, and include the exact structured completion footers. The handoff must preserve current state and point to the active contract rather than duplicating it. The session start template must enforce read order, repo/HEAD/dirty-tree verification, owner confirmation, explicit concurrency, minimum permissions, and `UNKNOWN` quota behavior.

- [ ] **Step 4: Run tests and validate**

Run:

```powershell
npm test
if ($LASTEXITCODE -ne 0) { throw "npm test failed" }
npm run validate
if ($LASTEXITCODE -ne 0) { throw "validation failed" }
```

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
- Create: `references/MODEL_EVIDENCE.md`
- Modify: `project-handoffs/README.md`
- Modify: `experiments/openusage-windows/README.md`
- Modify: `tests/validate-policy-pack.test.mjs`

- [ ] **Step 1: Add failing governance-template tests**

Require the benchmark template to contain `task_class`, `slot`, `provider`, `model`, `reasoning`, `correctness`, `wall_clock_latency`, `repair_count`, `review_findings`, `review_catch_rate`, `quota_efficiency`, and `confounders`. Require the decision note to contain evidence sample size, old mapping, new mapping, rollback condition, reviewer, approval, and effective date.

- [ ] **Step 2: Verify governance tests fail**

Run: `npm test -- --test-name-pattern=benchmark`

Expected: FAIL because both templates do not exist.

- [ ] **Step 3: Create both templates**

Use `UNKNOWN` as the permitted value whenever token/quota data is unavailable. State that a single benchmark cannot promote an experimental model. Require multiple comparable runs, no major regression, and a decision note before changing stable mapping.

Create `references/MODEL_EVIDENCE.md` and record an initial external evidence basket: Artificial Analysis SciCode methodology/results, SciCode-Verified corrections, Terminal-Bench/Coding Agent Index, and Artificial Analysis long-context reasoning. Record source URL, access date, scope, methodology limitation, confidence, and expiry. SciCode alone is not sufficient for routing because it is Python scientific code generation without the local CLI/tool workflow; external evidence remains provisional until each actual CLI/provider/model mapping passes 3–5 representative local smoke tasks.

- [ ] **Step 4: Constrain project and experimental data**

Update `project-handoffs/README.md` to prohibit real customer/personal data and recommend sanitized examples only. Update `experiments/openusage-windows/README.md` so Windows quota discovery remains optional, local-only, and non-authoritative until independently verified; prohibit storing raw provider responses.

- [ ] **Step 5: Run tests and commit**

Run:

```powershell
npm test
if ($LASTEXITCODE -ne 0) { throw "npm test failed" }
npm run validate
if ($LASTEXITCODE -ne 0) { throw "validation failed" }
```

Expected: both commands exit 0.

```powershell
git add templates/BENCHMARK_RECORD_TEMPLATE.md templates/REGISTRY_DECISION_NOTE_TEMPLATE.md references/MODEL_EVIDENCE.md project-handoffs/README.md experiments/openusage-windows/README.md tests/validate-policy-pack.test.mjs
git commit -m "docs: add benchmark and registry governance"
```

## Task 6: Reverify official commands and record version differences

**Files:**

- Modify: `references/OFFICIAL_COMMANDS.md`
- Modify: `references/SOURCE_NOTES.md`
- Modify: `policies/MODEL_REGISTRY.yaml` only when live verification changes evidence/status
- Modify: `scripts/validate-policy-pack.mjs`
- Modify: `tests/validate-policy-pack.test.mjs`

- [ ] **Step 1: Capture local command evidence**

Run each command separately and save no credentials or account output:

```powershell
orca --help
orca status --json
orca terminal --help
orca worktree --help
orca worktree set --help
codex --help
claude --help
agy --help
agy models
gh --version
gh --help
gh repo view --help
gh repo create --help
```

Expected on this machine: Orca runtime 1.4.192, Codex CLI 0.151.0, Claude Code 2.1.252, Antigravity CLI 1.1.22, and GitHub CLI 2.92.0. If live output differs, the live output wins and the notes must use the observed versions. If a tool is missing, unauthenticated, or cannot resolve models, record `UNKNOWN`/`BLOCKED`; never guess supported flags or model IDs.

- [ ] **Step 2: Verify against primary upstream sources**

Consult only primary sources linked in `references/OFFICIAL_COMMANDS.md`: Orca repository skill guides, OpenAI help/repository, Anthropic CLI reference, Google Antigravity announcement/codelab, OpenUsage repository, and GitHub CLI manual. Add a GitHub CLI section and links before treating `gh` as verified. Record access date `2026-09-01` and distinguish upstream-supported flags from locally accepted flags.

- [ ] **Step 3: Add a failing stale-command assertion**

PROHIBITED: `--screen`, `approval_policy = "untrusted"`, and `--dangerously-skip-permissions` must not be presented as defaults.

Add a test that rejects the prohibited strings above when presented as defaults. Historical or prohibited occurrences are mechanically allowed only on lines beginning with `PROHIBITED:`. Escape the literals inside test source so the scanner does not report its own test. Do not globally exclude `tests/` from sensitive scanning.

- [ ] **Step 4: Rewrite command and source references**

Use current Orca JSON/cursor reads, complete worktree IDs, `terminal wait --for tui-idle`, verified `orca status` and `orca worktree set` syntax, Codex `model_reasoning_effort`, conservative sandbox/approval examples, Claude safe permission modes, live `agy models` resolution, and verified `gh repo view/create` syntax. Add a visible rule that installed `--help` wins before automation.

Reverify every Codex model ID in `MODEL_REGISTRY.yaml`. If the installed CLI and official sources do not offer an authoritative model discovery path, mark the ID provisional with `UNKNOWN` evidence and a revalidation cadence rather than asserting that it is current.

- [ ] **Step 5: Run validation and commit**

Run:

```powershell
npm test
if ($LASTEXITCODE -ne 0) { throw "npm test failed" }
npm run validate
if ($LASTEXITCODE -ne 0) { throw "validation failed" }
```

Expected: both commands exit 0 and stale default examples are absent.

```powershell
git add references/OFFICIAL_COMMANDS.md references/SOURCE_NOTES.md policies/MODEL_REGISTRY.yaml scripts/validate-policy-pack.mjs tests/validate-policy-pack.test.mjs
git commit -m "docs: reverify official agent CLI commands"
```

## Task 7: Rewrite the skill entry point and five-minute README

**Files:**

- Modify: `skills/orca-multi-agent-dev/SKILL.md`
- Modify: `README.md`
- Modify: `AGENTS.md` only if its read order differs from the final authoritative order
- Modify: `scripts/validate-policy-pack.mjs`
- Modify: `tests/validate-policy-pack.test.mjs`

- [ ] **Step 1: Add failing entry-point tests**

Require both README and skill to contain the authoritative read order, six-stage routing example, `UNKNOWN` behavior, human gate, validation command, and a link to the execution contract template. Require README to distinguish stable workflow, dynamic mapping, runtime snapshot, project handoff, and experimental material. Add an internal Markdown-link checker and a failing fixture/assertion proving broken repository-relative links are rejected.

- [ ] **Step 2: Verify entry-point tests fail**

Run: `npm test -- --test-name-pattern=entry`

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

The final order must remain `SKILL → WORKFLOW_POLICY → CONCURRENCY_POLICY → MODEL_ROUTING_POLICY → MODEL_REGISTRY → RESOURCE_AWARE_ROUTING → OFFICIAL_COMMANDS → Current Project Handoff`. Do not add implementation detail to `AGENTS.md`.

- [ ] **Step 6: Run validation and commit**

Run:

```powershell
npm test
if ($LASTEXITCODE -ne 0) { throw "npm test failed" }
npm run validate
if ($LASTEXITCODE -ne 0) { throw "validation failed" }
```

Expected: both commands exit 0.

```powershell
git add README.md skills/orca-multi-agent-dev/SKILL.md AGENTS.md scripts/validate-policy-pack.mjs tests/validate-policy-pack.test.mjs
git commit -m "docs: add executable workflow quick start"
```

## Task 8: Add public-repository safety files

**Files:**

- Create: `LICENSE`
- Modify: `scripts/validate-policy-pack.mjs`
- Modify: `tests/validate-policy-pack.test.mjs`

- [ ] **Step 1: Add failing repository-safety tests**

Require `LICENSE` to contain `MIT License`, `Copyright (c) 2026 fordissi`, and the standard MIT permission/warranty paragraphs. Assert that `.gitignore`, created before dependency installation in Task 1, still protects dependencies, runtime state, logs, and environment files.

Require the repository scanner to cover every publishable working-tree text file, including `docs/superpowers/specs/` and `docs/superpowers/plans/`. Exclusions are limited to `.git/`, `node_modules/`, binary/generated artifacts, and explicitly invalid fixtures where their expected invalidity would otherwise be reported. Findings expose path, line, and pattern name only.

Add a `--history` validation mode that enumerates every reachable Git revision and scans committed text content before the first public push. It must never echo matched content. Add a test repository/fixture proving a sensitive pattern in an older revision fails even when absent from `HEAD`.

- [ ] **Step 2: Verify safety tests fail**

Run: `npm test -- --test-name-pattern=repository`

Expected: FAIL because the safety files do not exist.

- [ ] **Step 3: Add the MIT license and document the public design history**

Use the standard MIT License text and the approved copyright line. Document that the internal spec and implementation plan are deliberately part of the public artifact and are therefore scanned, linked, and reviewed like normal policy files.

- [ ] **Step 4: Run full verification**

Run:

```powershell
npm test
if ($LASTEXITCODE -ne 0) { throw "npm test failed" }
npm run validate
if ($LASTEXITCODE -ne 0) { throw "validation failed" }
git diff --check
if ($LASTEXITCODE -ne 0) { throw "git diff check failed" }
git status --short
```

Expected: tests and validation exit 0; `git diff --check` has no output; status lists only the intended Task 8 files before commit.

- [ ] **Step 5: Commit repository safety files**

```powershell
git add LICENSE scripts/validate-policy-pack.mjs tests/validate-policy-pack.test.mjs
git commit -m "chore: prepare policy pack for public release"
```

## Task 9: Perform final policy and release verification

**Files:**

- Modify only files needed to fix findings from the checks below

- [ ] **Step 1: Run automated verification from a clean dependency install**

Use a temporary copy or a clean worktree so dependency cleanup does not delete user files. Run:

```powershell
npm ci
if ($LASTEXITCODE -ne 0) { throw "npm ci failed" }
npm audit --audit-level=high
if ($LASTEXITCODE -ne 0) { throw "npm audit failed" }
npm test
if ($LASTEXITCODE -ne 0) { throw "npm test failed" }
npm run validate
if ($LASTEXITCODE -ne 0) { throw "validation failed" }
npm run validate -- --history
if ($LASTEXITCODE -ne 0) { throw "history validation failed" }
git diff --check
if ($LASTEXITCODE -ne 0) { throw "git diff check failed" }
```

Expected: install and audit exit 0; all tests pass; working-tree and all-reachable-history validators print `Policy pack validation passed`; whitespace check prints nothing. If the audit network is unavailable, publication is `BLOCKED` rather than assumed safe.

- [ ] **Step 2: Run the spec-coverage checklist**

For every heading in `docs/superpowers/specs/2026-09-01-orca-executable-workflow-policy-design.md`, identify the implementing file and test. Confirm all of these are present: classification, slots, overlay, registry, lifecycle, concurrency, gates, benchmark, templates, official commands, privacy, MIT, GitHub release.

Expected: no uncovered requirement.

- [ ] **Step 3: Exercise all routing fixtures**

Run: `npm run validate`

Expected summary includes ten routing cases evaluated and zero failures. Confirm manually that `YELLOW` versus `UNKNOWN` preserves registry order, the auth case reaches a human gate, independent review is provider/model-family disjoint, and the no-qualified-candidate case returns `{ status: "BLOCKED", reason }`.

- [ ] **Step 4: Review repository contents before publication**

Run:

```powershell
git status --short --branch
git log --oneline --decorate -12
git ls-files
npm run validate -- --history
```

Expected: `main` has only intentional commits; no staged, unstaged, or untracked files; tracked files and every reachable revision contain no `.env`, runtime real state, logs, credentials, personal/customer handoffs, dependency directory, unlabeled stale commands, or unfinished placeholders. Specs and plans are present intentionally and pass the same scan.

If history validation fails, do not assume a new cleanup commit removes the exposure. Classify the finding without printing its content. Any secret, personal, or customer data immediately blocks publication and requires a human-approved history purge and credential rotation where applicable. For non-sensitive stale commands or placeholders in the unpublished local history, present a proposed squash/rewrite boundary for explicit approval; never rewrite history silently.

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
npm run validate -- --history
```

Expected: GitHub authentication is valid; working tree is clean; all reachable history passes the redacted repository scan. `gh repo view` should report not found before creation. If the repository already exists, stop and inspect ownership/content rather than overwriting it. The `gh` and Orca subcommands used here must already have passed Task 6 local-help and primary-source verification.

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
