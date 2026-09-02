# Model Evidence

Version: `0.3`

這份文件記錄 `MODEL_REGISTRY.yaml` 中 capability tier 所依據的外部證據，以及該證據**不能**支撐的結論。

## 兩條硬規則

1. **外部 benchmark 只能建立 `evidence_status: provisional`。** 通過本機 smoke cases 與獨立 review 之前，不得升為 stable mapping。
2. **沒有任何公開 benchmark 測量我們實際派工的東西。** 我們派的是「CLI + harness + 模型 + permission 設定」的組合；leaderboard 測的是裸模型。這個落差是所有下列證據共同的 methodology limitation，不是個別項目的瑕疵。

外部證據不足以判定的項目，一律另以本機 smoke case 建立，每個實際的 provider/CLI/model mapping 需要 3–5 個代表性案例：

- CLI harness 行為與失敗模式
- permission 與 sandbox 旗標的實際遵從度
- subscription availability 與 quota efficiency
- review catch rate

## 證據籃

### E1 — SciCode（Artificial Analysis leaderboard）

```yaml
id: E1
source_url: https://artificialanalysis.ai/evaluations/scicode
accessed_at: "2026-09-01"
scope: scientific_python_code_generation
what_it_measures: >-
  288 test-set subproblems derived from 80 laboratory problems across 16
  scientific sub-fields. Scored as subproblem accuracy: the share of
  subproblems whose generated code passes the test cases. Evaluations are
  run independently by Artificial Analysis.
methodology_limitation: >-
  Single-shot scientific Python generation with no CLI, no tool use, no
  repository context and no permission boundary. It therefore cannot support
  any claim about implementation slots in this pack. The page also does NOT
  report with-background and no-background results separately, contrary to
  what the design spec assumed - so that split cannot be read off this
  source.
confidence: low
evidence_status: provisional
expires_at: "2026-12-01"
supports_tier_claim_for: []
```

### E2 — SciCode-Verified（defect-corrected SciCode）

```yaml
id: E2
source_url: https://arxiv.org/html/2608.04975v1
accessed_at: "2026-09-01"
scope: scientific_python_code_generation_corrected
what_it_measures: >-
  An audit of all 65 SciCode test problems that identified 263 defects.
  Correctable defects were fixed and one problem that could not be made
  verifiable was excluded. The corrected set is SciCode-Verified.
methodology_limitation: >-
  Same task shape as E1, so the same CLI/tool/permission gap applies. Its
  value here is negative rather than positive: it shows the raw SciCode
  leaderboard understated models because of benchmark defects, which is why
  the raw leaderboard is treated as historical reference only.
confidence: medium
evidence_status: provisional
expires_at: "2026-12-01"
supports_tier_claim_for: []
```

### E3 — Terminal-Bench 2.1 / coding agent index

```yaml
id: E3
source_url: https://www.morphllm.com/ai-coding-agent
accessed_at: "2026-09-01"
scope: terminal_and_repo_implementation
what_it_measures: >-
  Terminal-Bench evaluates agents on 89 hand-crafted human-verified tasks,
  each attempted 5 times, across scientific computing, software engineering,
  machine learning, security, system administration and data science.
observed_at_access_time: >-
  As of August 2026 the aggregator reported GPT-5.6 Sol at xhigh effort
  leading Terminal-Bench 2.1 at 89.5%, with Claude Opus 5 at max effort at
  89.1%. Recorded as an observation only.
methodology_limitation: >-
  This URL is a secondary aggregator, not the Terminal-Bench primary
  leaderboard, so the figures are second-hand and the primary source must be
  re-checked before any mapping change. Scores are also reported at specific
  reasoning-effort settings that may not match the effort this pack
  dispatches. No luna figure was found at access time.
confidence: low
evidence_status: provisional
expires_at: "2026-12-01"
supports_tier_claim_for: []
open_action: >-
  Locate and record the Terminal-Bench primary leaderboard URL before this
  evidence is used to justify any tier change.
```

### E4 — AA-LCR（Artificial Analysis Long Context Reasoning）

```yaml
id: E4
source_url: https://artificialanalysis.ai/evaluations/artificial-analysis-long-context-reasoning
accessed_at: "2026-09-01"
scope: long_context_reasoning
what_it_measures: >-
  100 hard text-based questions requiring reasoning across multiple real
  documents totalling roughly 100k input tokens, spanning 7 document
  categories. Answers cannot be retrieved directly and must be inferred.
  Pass/fail grading judged by another language model.
methodology_limitation: >-
  Document reasoning, not repository discovery. It does not measure code
  navigation, symbol resolution or cross-repo inventory, which is what the
  LONG_CONTEXT_DISCOVERY slot actually does. LLM-judged pass/fail also
  introduces judge variance. At access time the reported leaders were models
  that are not candidates in this registry.
confidence: low
evidence_status: provisional
expires_at: "2026-12-01"
supports_tier_claim_for: []
announcement_url: https://artificialanalysis.ai/articles/announcing-aa-lcr
```

### E5 — 本機 smoke cases

```yaml
id: E5
source_url: local
accessed_at: "2026-09-01"
scope: local_cli_dispatch_and_compliance
what_it_measures: >-
  Real dispatches through this pack's own contract and permission ceiling.
cases_passed:
  - contract: T2S1-policy-document-assertions
    provider: codex
    model: gpt-5.6-luna
    reasoning: medium
    slot: DEFAULT_IMPLEMENTER
    result: PASS on the first attempt, zero repairs
    tokens: 30040
    notes: >-
      Stayed inside the allowed-changes list, produced the required failing
      test, did not edit policy documents to turn its own test green, and
      correctly reported UNKNOWN rather than guessing its own model identity.
methodology_limitation: >-
  One case, not the 3-5 required. A single bounded task cannot establish a
  capability tier and cannot speak to failure modes under ambiguity.
confidence: low
evidence_status: provisional
expires_at: "2026-12-01"
supports_tier_claim_for: []
```

## 目前的證據結論

**沒有任何 candidate 的 capability tier 目前由外部 benchmark 支撐。** 註冊表中的 tier 是依已核准的設計哲學指派的工作假設，全部標記 `evidence_status: provisional`。

要把任何 mapping 升為 stable，需要：

1. 該 provider/CLI/model 組合通過 3–5 個本機 smoke case；
2. 多次可比較的執行結果一致，且無重大回歸；
3. 一份依 `templates/REGISTRY_DECISION_NOTE_TEMPLATE.md` 撰寫的 decision note。

單一 leaderboard 不足以取代上述任何一項。

### E6 — 本機 Gemini 3.7 Flash 部分 qualification（2026-09-02）

```yaml
id: E6
source_url: local
accessed_at: "2026-09-02"
scope: antigravity_gemini_flash_local_qualification
what_it_measures: >-
  Smallest-appropriate local qualification of antigravity / AUTO_GEMINI for
  the target roles (Stage 1 alternative, long-context discovery, regression
  hunter, independent reviewer, Stage 2 quota fallback at high reasoning),
  per PART G of the 2026-09-02 three-stage instruction.
cases_run:
  - check: live resolver returns Gemini 3.7 Flash family
    method: "agy models"
    result: PASS
    detail: "gemini-3.7-flash-high | -medium | -low listed"
  - check: low-reasoning path works
    method: "agy -p ... --model gemini-3.7-flash-low"
    result: PASS
    detail: "coherent, followed an exact 3-line output format"
  - check: provider / model-family identity for reviewer disjointness
    method: "asked the model to state its own family/provider"
    result: PASS
    detail: "reported Gemini / Google - resolves correctly for disjointness"
  - check: stable output / reporting
    result: PASS
  - check: high-reasoning repo-discovery path
    method: "agy -p ... --model gemini-3.7-flash-high [--mode plan]"
    result: BLOCKED
    detail: >-
      headless mode auto-denies any tool needing the 'command' permission
      ("a tool required the 'command' permission that headless mode cannot
      prompt for"), so no file read happened. --mode plan does not lift it.
  - check: read-only reviewer behaviour
    result: NOT_RUN
    detail: blocked by the same headless permission wall
  - check: permission compliance
    result: NOT_ASSESSABLE
    detail: denies-closed before doing anything; cannot observe compliance
methodology_limitation: >-
  4 of the ~8 target checks pass; the reviewer / discovery / permission-
  compliance checks could not be completed on the non-interactive path
  without an approval-bypass flag, which would defeat the read-only
  compliance check. The interactive path is known to work (per-call
  approval) but that is not the smallest process and was not exercised as a
  formal smoke case.
confidence: low
evidence_status: provisional
expires_at: "2026-12-01"
supports_tier_claim_for: []
blocker: >-
  agy headless / print mode fail-closes on read tools. To qualify Gemini for
  the reviewer / discovery roles, either the pack's non-interactive dispatch
  path needs a scoped permissions.allow allow-rule, or the qualification must
  run through the interactive per-call-approval path. Until then AUTO_GEMINI
  stays status: experimental in MODEL_REGISTRY.yaml.
```

### E7 / E8 — DataCamp comparison articles (human-supplied, provisional only)

```yaml
id: E7
source: "DataCamp: Claude Opus 5 vs GPT-5.6 Sol"
accessed_at: "2026-09-02"
scope: flagship_model_comparison
what_it_measures: secondary comparison article, human-supplied
methodology_limitation: >-
  Secondary benchmark journalism. Not a primary leaderboard, not a
  measurement of "CLI + harness + permissions + model". May inform the Sol
  vs Opus Stage 3 role-preference discussion; may NOT prove stable routing.
confidence: low
evidence_status: provisional
supports_tier_claim_for: []

id: E8
source: "DataCamp: GPT-5.6 Terra vs Claude Sonnet 5"
accessed_at: "2026-09-02"
scope: advanced_model_comparison
methodology_limitation: same class as E7 - secondary, model-only, provisional
confidence: low
evidence_status: provisional
supports_tier_claim_for: []
```

## 2026-09-02：三階段重構後的 status 狀態

`MODEL_REGISTRY.yaml` 0.5 的實際 `status`：

- `codex / gpt-5.6-terra` → `STRONG_IMPLEMENTER` / `DEEP_REASONER` / reviewer，
  `status: stable`（human decision 0.4，未撤回），`stage: STAGE_2_ADVANCED`。
  本機從未派工——**REMAINING RISK**，rollback 條件見 decision note。
- `codex / gpt-5.6-sol` → `ESCALATION_MODEL` 唯一 Codex 候選，`capability_tier: DEEP`，
  `stage: STAGE_3_FLAGSHIP`，**預設 reasoning 由 forced 值降為 `medium`**。
  外部佐證 E3 + E7；本機 smoke 待補。
- `antigravity / AUTO_GEMINI`（所有出現處）→ **由 0.4 的 `stable` 退回
  `status: experimental`**。理由：PART G 要求真實本機 qualification，E6 只完成 4/8
  項，reviewer/discovery/permission 檢查被 `agy` headless 權限牆擋住。未通過前
  只有 `allow_experimental: true` 的 contract 能路由到它。

這些條目全部保留 `evidence_status: provisional`。三階段重構的理由、涵蓋不到的部分與
rollback 條件見
[`policies/registry-decisions/2026-09-02-three-stage-routing.md`](../policies/registry-decisions/2026-09-02-three-stage-routing.md)
與
[`policies/registry-decisions/2026-09-02-rebalance-implementer-tiers.md`](../policies/registry-decisions/2026-09-02-rebalance-implementer-tiers.md)。

**待辦：** 補齊 Terra / Sol 的 3–5 個本機 smoke case（記入 E5）；解除 E6 的
`agy` headless 權限 blocker 後完成 Gemini qualification。`next_revalidation_due: 2026-10-02`。
