# Router Execution Contract

Version: `0.3`

這份 contract 分成兩半，**由不同角色填寫，不可混寫**：

| 半部 | 填寫者 | 前提 |
|---|---|---|
| `STRATEGIC CONTRACT` | Strategic router（大腦） | **MUST NOT DEPEND ON** direct filesystem access、local registry visibility 或 live quota visibility |
| `OPERATIONAL RESOLUTION` | Orca operational router | 有檔案系統；讀 registry、驗證 repo 狀態、套 resource overlay |

Strategic router 指定的是**能力需求**（`role` / `slot` / `minimum_tier`），不是具體模型。
`OPERATIONAL RESOLUTION` 的每個欄位在 strategic router 交出 contract 時一律填 `unresolved`；
由 operational router 解析候選後才填入。**Strategic router 自行填寫該半部即是猜測。**

---

## STRATEGIC CONTRACT

```yaml
contract_version: "0.3"
task_id:
why_now:
authoritative_owner:          # 唯一負責人；不明確即停止並回 human gate

target:
  repo:
  worktree_selector:          # 完整 selector，由 operational router 驗證
  branch:
  expected_base_head:         # 期望值；實際值由 operational router 確認

classification:               # 六個維度全部必填
  risk:                       # low | medium | high | critical
  complexity:                 # low | medium | high
  context_size:               # small | medium | large
  ambiguity:                  # low | medium | high
  change_intensity:           # none | localized | structural
  verification_need:          # standard | independent | adversarial
  architecture_involvement:   # true | false
  security_involvement:       # true | false

# Governance tier 的輸入（見 WORKFLOW_POLICY.md 的 Governance tiers）。與上面
# 的六維 classification 及下面的 selected_stage 正交：governance tier 決定
# process 嚴格度（gate、review、fingerprint），不是能力需求，不得互相推導。
# 這四個維度與 hard_triggers 是 strategic router 可從 task 描述本身判斷的
# 事實，不需要檔案系統；實際 tier 判定留給 OPERATIONAL RESOLUTION。
governance_input:
  data_sensitivity:            # LOW | MODERATE | HIGH
  reversibility:               # EASY | MODERATE | HARD_IRREVERSIBLE
  blast_radius:                # LOCAL | MODULE | CROSS_SYSTEM_BULK
  privilege_impact:            # NONE | NORMAL | ELEVATED_SECURITY_BOUNDARY
  hard_triggers:                # 命中 WORKFLOW_POLICY.md Human gates 清單中
                                 # 具名項目時列出，例如 [rls_policy_change]；未命中留空
  exact_payload_approval_needed: false  # true 才需要 fingerprint；不因 G3 本身而自動 true

implementation_role:          # ROUTER | IMPLEMENTATION | LONG_CONTEXT_DISCOVERY | ...
implementation_slot:          # 能力需求，不是模型名稱
selected_stage:               # STAGE_1_DEFAULT | STAGE_2_ADVANCED | STAGE_3_FLAGSHIP
                              # 由 stage admission 判定（MODEL_ROUTING_POLICY.md）；
                              # risk / production / 測試數量不得提高它
minimum_tier:                 # CHEAP | DEFAULT | STRONG | DEEP（與 selected_stage 一致）

# 僅在 selected_stage 為 STAGE_3_FLAGSHIP 時必填。缺這段的 Stage 3 選擇不合法。
flagship_admission:
  escalation_reason:          # 對應 MODEL_ROUTING_POLICY.md 的 Stage 3 admission 清單
  why_stage_2_insufficient:   # 具體理由，不得只寫「風險高」
  prior_stage_2_attempt_failed: # true | false
  human_authorization:       # required_and_provided | not_required | MISSING

# Explicit human model directive (0.6). 只有在 human 於 current instruction
# 明確指名時填寫；否則留空。填了就是 precedence 第 1 層：operational router
# 必須用這個模型，除非 hard execution eligibility 失敗。strategic router
# 平時不指名模型——這裡記的是 HUMAN 的話，不是 strategic router 的選擇。
human_model_directive:        # 例：{ provider: antigravity, model: AUTO_GEMINI, reasoning: low }，或留空

review_role:
review_slot:
review_disjointness_required: # verification_need 為 independent/adversarial 時為 true

discovery_role:               # 不需要 discovery 階段時填 none
discovery_slot:

# 授權旗標。
# allow_red 是 human 的授權決定：operational router 只讀取，不得自行翻轉。
# allow_experimental / experimental_justification 保留供 backward compatibility；
# 0.6 起對 enabled 的 registry 候選沒有 routing 效果（enabled 是唯一 config gate）。
allow_experimental: false     # 保留欄位；對 enabled 候選無效果
experimental_justification:   # 保留欄位（僅 legacy contract）
allow_red: false              # true 才允許在只剩 RED 候選時繼續

concurrency_mode:             # SEQUENTIAL | PARALLEL_INDEPENDENT | COMPETITIVE_DESIGN
integration_owner:            # 任何 mode 下都只能有一個

# Permission ceiling。filesystem read、command execution 與 filesystem write
# 是三種能力，不折疊成一個開關：唯讀 reviewer 仍需執行 git diff / rg / cat。
# 語意由 WORKFLOW_POLICY.md 的「Permission ceiling 的能力分解」定義。
permission_ceiling:           # 意圖上限；實際旗標由 dispatch_command 強制
  filesystem:
    read:                     # true | false
    write:                    # true | false
  command_execution:
    allowed:                  # true | false — 是否可執行任何命令
    mutation:                 # true | false — 是否可執行會改變狀態的命令
    human_approval:           # as_required | never — 核准不擴大 ceiling
  network:
    allowed: false
  database:
    read: false
    write: false
  production_access: false
  may_commit:                 # true | false — 獨立於 command_execution.mutation
  may_push: false

  # Legacy 相容欄位。既有 v0.3 contract 只寫 sandbox / network 字串仍然有效；
  # 上面的分解式欄位若明確寫出則優先。對照表見 WORKFLOW_POLICY.md。
  sandbox:                    # read-only | workspace-write（legacy 簡寫，optional）

# Scoped worker environment provisioning。語意見 WORKFLOW_POLICY.md 的
# "Scoped worker environment provisioning"。這裡只列需求，不放 secret 值。
required_environment_capabilities:  # 清單（專案自訂 id），或 none。不需要時填 none
                                    # 例：[FOUNDATION_DB_READONLY] / [FOUNDATION_DB_PRIVILEGED]
environment_capability_authorization: # required_and_provided | not_required | MISSING
                                    # PRIVILEGED 能力必須是 required_and_provided；
                                    # governance tier（含 G3）本身不授予

# Execution budget。數值是操作指引，不是 parser limit；未填時採 WORKFLOW_POLICY.md
# 的預設。poll_interval 的逾時只代表「重新觀察一次」，不是 worker 的完成期限。
execution_budget:
  poll_interval_ms:           # 預設 60000-120000
  stall_threshold_ms:         # 預設 600000-1200000；deep reasoning 可更長
  hard_execution_ceiling_ms:  # 預設不設；設了就在到達時進 human gate，不自動 FAIL
  max_continuation_attempts: 2  # execution budget 用盡時的續跑上限，不是 repair

authoritative_references:
task:
allowed_changes:
prohibited_changes:
validation_commands:
acceptance_criteria:
stop_conditions:
escalation_policy:
human_gate_required:          # true | false
human_gate_reason:
```

---

## OPERATIONAL RESOLUTION

由 operational router 填寫。未解析前每一欄都是 `unresolved`。

```yaml
verification:                 # lifecycle 的 verify 階段，strategic router 不執行
  repo_head_actual:           # unresolved
  working_tree_clean:         # unresolved
  worktree_confirmed:         # unresolved
  handoff_read:               # unresolved

registry_version:             # unresolved — 來自 MODEL_REGISTRY.yaml 的 version
capability_slot:              # unresolved — 實際解析的 slot
minimum_tier_satisfied:       # unresolved — true 時才可派工

selected_stage:               # unresolved — STAGE_1_DEFAULT | STAGE_2_ADVANCED | STAGE_3_FLAGSHIP
stage_admission_reason:       # unresolved — 為何是這個 stage（advanced signal / exceptional evidence / default）

selection_mode:               # unresolved — human_pinned | autonomous
                              # human_pinned 時 candidate 直接來自 human_model_directive，
                              # 未經 quota / preference 排序；只驗 hard execution eligibility

model_selection_source:       # unresolved — REGISTRY_AUTONOMOUS | HUMAN_EXPLICIT_OVERRIDE |
                              # HUMAN_RETROACTIVE_ACCEPTANCE（後者只可記錄歷史，不可 dispatch）
registry_candidate:           # unresolved；REGISTRY_AUTONOMOUS 必須可回指指定 slot 的 enabled candidate
  slot:
  enabled:
  provider:
  model:
  model_family:
  reasoning:

selected_candidate:           # unresolved
  actual_provider:
  actual_model:
  actual_model_family:
  reasoning_effort:            # registry 預設，或有 task 證據時調整後的值；絕不預設 max（Luna 例外）

# provider + model + model_family + reasoning_effort 是 execution identity。
# dispatch_command 必須明確傳入 provider 支援的 model 與 reasoning（Codex：-m 與
# -c model_reasoning_effort；Claude / Antigravity：--model 與 --effort）。不得依賴
# local config、Orca default、既有 terminal 或 generic helper。
expected_runtime_identity:    # unresolved
  provider:
  model:
  model_family:
  reasoning_effort:

attestation:                  # dispatch 後比對；語意見 WORKFLOW_POLICY.md
  method:                     # unresolved — /status | worker-show | none
  observed_provider:          # unresolved，或 UNVERIFIED
  observed_model:             # unresolved，或 UNVERIFIED
  observed_model_family:      # unresolved，或 UNVERIFIED
  observed_reasoning_effort:  # unresolved，或 UNVERIFIED
  attestation_result:         # unresolved — DISPATCH_IDENTITY_MATCH |
                              # DISPATCH_IDENTITY_UNVERIFIED | DISPATCH_CONTRACT_MISMATCH

# 僅在 selected_stage 為 STAGE_3_FLAGSHIP 時必填（由 operational router 從
# strategic contract 的 flagship_admission 複製 + 補實際判定）。
flagship_admission:           # unresolved
  escalation_reason:
  why_stage_2_insufficient:
  prior_stage_2_attempt_failed:
  human_authorization:        # required_and_provided | not_required | MISSING

implementer_provider:         # unresolved
implementer_model_family:     # unresolved
reviewer_provider:            # unresolved
reviewer_model_family:        # unresolved
review_disjointness_verified: # unresolved — provider 與 model family 都必須不同

resource_checked_at:          # unresolved — 每個 pool 各自的時間，或 UNKNOWN
resource_overlay_applied:     # unresolved — true | false

# Resource acquisition evidence（每個需要 refresh 的 relevant resource_state_key
# 一筆）。語意見 policies/RESOURCE_AWARE_ROUTING.md 的 Resource acquisition。
# compact 即可；不得 inline 原始 /usage / /status transcript（除非明確要求 debug）。
resource_acquisition:         # unresolved — 清單，或 none（無 key 需要 refresh 時）
  - provider:
    account_or_pool:           # opaque identifier，不寫 email / secret
    refresh_required:          # true | false
    acquisition_source:        # ORCA_RUNTIME | PROVIDER_NATIVE_PROBE | USER_STATEMENT | UNKNOWN
    probe_method:              # interactive_tui | none
    probe_status:              # PROBE_OK | PROBE_AUTH_REQUIRED | PROBE_CLI_MISSING
                               # | PROBE_SESSION_UNAVAILABLE | PROBE_PERMISSION_BLOCKED
                               # | PROBE_PARSE_FAILED | PROBE_DATA_UNAVAILABLE
                               # | PROBE_TIMEOUT | PROBE_IDENTITY_UNCERTAIN | none
    checked_at:
    windows_observed:          # 例：[BURST, BUDGET]，或 partial
    fallback_used:             # true | false
    final_resource_state:      # GREEN | YELLOW | RED | UNKNOWN

# 三個資源訊號。只記標籤，不記數值：remaining_ratio、reset_at 與任何
# 原始 quota 讀數都不得寫進 artifact。語意見
# policies/RESOURCE_AWARE_ROUTING.md 的 Hierarchical quota windows。
# 順序固定：conservation（防守）→ budget expiry（進攻）→ burst utilization。
resource_signals:
  refresh_required:           # unresolved — true 表示某 resource_state_key 在本次
                              # selection 前需要 refresh（checked_at 超過 TTL、任一
                              # window reset_at <= now、或 event-driven invalidation）。
                              # 未 refresh 前該 entry 視為 UNKNOWN。語意見
                              # policies/RESOURCE_AWARE_ROUTING.md 的 Freshness。
  conservation:               # 長期 BUDGET window：稀缺（防守）
    conservation_pressure:    # unresolved — NONE | LOW | MEDIUM | HIGH | CRITICAL | UNKNOWN
    budget_reset_proximity:   # unresolved — NEAR | MEDIUM | FAR | UNKNOWN
    conservation_demotion:    # none，或因長期預算吃緊而被降級的候選
    budget_expiry_opportunity:# unresolved — HIGH | MEDIUM | LOW | UNKNOWN（進攻：剩很多且快 reset）
    expiry_promotion:         # none，或因 BUDGET 即將 reset、剩餘充足而被提前的候選
  opportunity:                # 短期 BURST window：利用率
    reset_proximity:          # unresolved — NEAR | MEDIUM | FAR | UNKNOWN
    stranded_capacity_risk:   # unresolved — HIGH | MEDIUM | LOW | UNKNOWN
    stranded_promotion:       # none，或被此訊號跳過的候選；提前必須記錄（與 expiry_promotion 互斥）

fallback_used:                # unresolved — none，或被跳過的候選及原因
selection_reason:             # unresolved — 為何選它、為何跳過前面的候選

max_repair_attempts:          # unresolved — 來自 registry slot
failed_repair_count: 0        # 初次 implementation attempt 不計入；continuation 也不計入

execution_state:              # unresolved — 最後一次輪詢的觀察狀態
  # ACTIVE | QUIET | STALLED | COMPLETE | MAX_TURNS_REACHED
  # | PROCESS_EXIT_FAILURE | HARD_EXECUTION_CEILING
  # | PERMISSION_BLOCKED | ROUTING_UNAVAILABLE
  state:                      # unresolved
  last_progress_at:           # unresolved，或 UNKNOWN
  total_elapsed_ms:           # unresolved — 總時長本身不構成失敗
  continuation_count: 0       # execution budget 用盡而續跑的次數

# Continuation freshness binding。resume / MAX_TURNS 後續跑 / retry 同一 worker /
# reviewer continuation / parked terminal 重用之前，都必須先用這組欄位重新
# 跑一次 continuation eligibility check。語意見 policies/WORKFLOW_POLICY.md
# 的 Continuation freshness。只存 fingerprint，不存原始 human message。
continuation_binding:
  human_instruction_revision:  # unresolved — 全部 execution-relevant 欄位的雜湊
  objective_fingerprint:       # unresolved — objective/scope/expected-output 子集的雜湊
  permission_scope_fingerprint: # unresolved — permission_ceiling 子集的雜湊
  authoritative_baseline:      # unresolved — 等同 target.{repo,branch,expected_base_head}
  last_checked_at:             # unresolved，或 UNKNOWN

# Session lifecycle。承載本次工作的 terminal/session 狀態，與 execution_state
# 是不同層次：execution_state 問「這次執行是否正常進行」，這裡問「這個
# terminal 接下來該 PARK、CLOSE 還是 KEEP」。語意見 policies/WORKFLOW_POLICY.md
# 的 Session lifecycle and cleanup。
session_lifecycle:
  terminal_id:                 # unresolved
  title:                       # 建議 <project>:<task-short-id>:<role>:<state>，
                                # 不得含 credential、PII、完整 prompt
  lifecycle_state:             # unresolved — ACTIVE | PARKED | SUPERSEDED | STALE | FAILED | CLOSED
  cleanup_action:               # unresolved — KEEP | PARK | CLOSE
  resumable:                   # unresolved — 缺任一 continuation_binding 欄位時一律 false

# Router execution boundary。決定這一步是 Router 自己執行的 bounded
# control-plane probe，還是必須派工。語意見 policies/WORKFLOW_POLICY.md
# 的 Operational Router execution boundary。只有實際的 ROUTER slot 適用
# CONTROL_PLANE / DIRECT_ALLOWED；DEEP_REASONER 等其他標 role: ROUTER 的
# slot 是被派工的 worker，不適用。
router_execution:
  router_execution_class:      # unresolved — CONTROL_PLANE | WORKER_DISCOVERY
                                # | WORKER_IMPLEMENTATION | WORKER_REGRESSION
                                # | WORKER_REASONING
  router_execution_decision:   # unresolved — DIRECT_ALLOWED | DISPATCH_REQUIRED
                                # | HUMAN_OVERRIDE
  router_execution_source:     # unresolved — POLICY_DEFAULT | HUMAN_EXPLICIT_OVERRIDE
  dispatch_slot:                # unresolved，或 none — DISPATCH_REQUIRED 時對應到
                                # 既有 slot（見 MODEL_ROUTING_POLICY.md 的 Slot
                                # decision table），不建立新 slot 架構
  human_override:               # unresolved，或 none — 綁定 task_id/instruction_revision，
                                # 語意同 MODEL_ROUTING_POLICY.md 的 HUMAN_EXPLICIT_OVERRIDE
                                # / HUMAN_OVERRIDE_STALE

# Governance tier 的判定結果。輸入見上方 STRATEGIC CONTRACT 的
# governance_input；判定與 process 形狀由 WORKFLOW_POLICY.md 的
# Governance tiers 定義，此處不重複。
governance_resolution:
  governance_tier:              # unresolved — G1_LIGHTWEIGHT | G2_STANDARD | G3_HIGH_RISK
  governance_reasons:           # unresolved — 簡短列出驅動判定的維度或 hard trigger
  required_gates:                # unresolved — [] 或 [HUMAN_GATE]
  required_review:              # unresolved — OPTIONAL | INDEPENDENT | INDEPENDENT_SECURITY
  fingerprint_required:          # unresolved
  hard_trigger_fired:           # unresolved，或 none
  governance_source:            # unresolved — POLICY_DEFAULT | HUMAN_EXPLICIT_OVERRIDE
  human_override:                # unresolved，或 none — 綁定 task_id/instruction_revision；
                                 # 命中 hard trigger 時不得用來把 governance_tier 降級

# Scoped worker environment provisioning 的解析。語意見 policies/WORKFLOW_POLICY.md
# 的 "Scoped worker environment provisioning"。只記標籤/結果，不記 secret 值，
# 不記 credential-bearing URL。
environment_provisioning:
  mechanism:                   # unresolved — orca_environment_recipe | setup_hook | none
  resolved_capabilities:        # unresolved — [] 或 專案自訂 id 清單
  granted_level:               # unresolved — NONE | READONLY | PRIVILEGED
  outcome:                     # unresolved — CAPABILITY_GRANTED | AUTHORIZATION_REQUIRED
                                # | PRIVILEGE_LEVEL_MISMATCH | ENVIRONMENT_CAPABILITY_UNAVAILABLE
  preflight:
    capability_present:        # unresolved — PRESENT | ABSENT
    target_identity:           # unresolved — TARGET_MATCH | TARGET_MISMATCH | NOT_APPLICABLE
    ca_config:                 # unresolved — PRESENT | ABSENT | NOT_REQUIRED
    tls:                       # unresolved — TLS_OK | TLS_FAILED | NOT_CHECKED
    privilege_level_matches:   # unresolved — true | false
  router_local_env_counts:     # 一律 false — Router process-local env 不是 worker capability
  redaction_verified:          # unresolved — true（diagnostics 只含允許 token，無 credential URL）

# Callback transport 與 result recovery。worker 完成但送不出 worker_done 時的
# 回收路徑。語意見 WORKFLOW_POLICY.md 的 Worker result recovery。
callback_transport:            # unresolved — OK | FAILED_RECOVERED | FAILED_UNRECOVERED
result_recovery:               # 僅在 callback_transport != OK 時填
  recovery_tier_used:          # unresolved — WORKER_DONE | WORKER_READ
                                # | ORCHESTRATION_EVIDENCE | HUMAN_GATE
  worker_read_bounded_limit:   # unresolved — 用於 worker-read --limit 的 bounded n
  duplicate_dispatch_avoided:  # 一律 true — 不因 worker_done 失敗就重派或重跑已完成工作
  recovered_output_sanitized:  # unresolved — true（併入 evidence/handoff 前已 sanitize）

dispatch_command:             # unresolved
  # 逐字命令，且必須在命令列明確傳入 model、reasoning、sandbox 與 approval 旗標。
  # **不得**在命令列傳入 secret / connection string / credential-bearing URL——
  # 環境能力一律經 trusted setup 機制供裝。
  # 只在上面用散文宣告 permission_ceiling 是不夠的：worker 端的 local CLI
  # 設定會靜默覆蓋未明示的預設值，使實際權限高於 contract 意圖。
```

### Routing evidence 的邊界

`OPERATIONAL RESOLUTION` 是可稽核的 routing evidence，保留上列非敏感欄位即可。

**不得寫入 execution artifact**：原始 quota payload、provider credential、
帳號識別資料、cookie、session identifier、provider conversation ID。
讀不到可靠數值時填 `UNKNOWN`，不猜測。

`resource_signals` 同樣受此限制：只寫 `NEAR` / `HIGH` / `CRITICAL` 這類**標籤**，
**不寫 `remaining_ratio` 的數值或 `reset_at` 的時間戳**。標籤足以稽核一次重排，
數值則是帳號用量資料。

`continuation_binding` 的三個 fingerprint 只對 objective、scope、permission ceiling
等 execution-relevant 欄位做 canonicalization 再雜湊，**不得寫入完整 human
message 或任何 PII**；`session_lifecycle.title` 同樣不得含 credential、PII 或
完整 prompt。

`router_execution.router_execution_class` 為任一 `WORKER_*` 時，
`router_execution_decision` 只能是 `DISPATCH_REQUIRED`，除非
`human_override` 存在且通過 task_id / instruction_revision 綁定驗證；
這個組合的合法性由 conformance checker 驗證，見下方測試。

---

## Blocked reason codes

`BLOCKED` 必須附一個 reason code：

```text
CONFIG_INVALID | ROUTING_UNAVAILABLE | POLICY_BLOCKED
RESOURCE_BLOCKED | PERMISSION_BLOCKED
```

**這些 code 的語意由 [`policies/MODEL_ROUTING_POLICY.md`](../policies/MODEL_ROUTING_POLICY.md)
的 Blocked reason codes 章節定義，那裡是唯一的 owner。** 本範本只列出名稱供填寫，
不重複定義它們的意義——第二份定義遲早會分歧。

不得為了讓 `BLOCKED` 變成 `SELECTED` 而降低 `minimum_tier`、放棄 independent review
的 disjointness、提高權限，或自行翻轉 `allow_experimental` / `allow_red`。

執行過程的觀察狀態（`ACTIVE` / `QUIET` / `STALLED` / `MAX_TURNS_REACHED` 等）
記在 `execution_state`，**不是 reason code**。慢、安靜、尚無結論或 turn budget 用盡
都不得填成 `PERMISSION_BLOCKED` 或 `ROUTING_UNAVAILABLE`；語意見
[`policies/WORKFLOW_POLICY.md`](../policies/WORKFLOW_POLICY.md) 的
Execution lifecycle semantics 與 routing policy 的 Blocked reason codes。

---

## Completion footers（Worker → Operational router）

Worker 結束時原樣回傳這兩段。它們的收件人是 operational router，不是 strategic router。

```text
TASK_RESULT
status: PASS | FAIL | BLOCKED
blocked_reason_code:
actual_provider:
actual_model:
reasoning_effort:
attempt_count:
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

`actual_provider`、`actual_model`、`actual_model_family` 與 `reasoning_effort`
**由 router 在 `OPERATIONAL RESOLUTION` 中寫定，worker 只原樣回填**。
Worker 通常無法可靠內省自己以哪個模型執行；要求它自報等於誘導它猜測。
Contract 未載明時填 `UNKNOWN`。

`RESOURCE_STATUS` 可整段為 `UNKNOWN`。Worker 不得為了填滿 footer 而猜測 quota 數值。

## Operational cycle 的結束（Operational router → Strategic router）

Completion of an operational cycle MUST produce a
`STRATEGIC_RETURN` following
[`templates/STRATEGIC_RETURN_TEMPLATE.md`](STRATEGIC_RETURN_TEMPLATE.md).

方向不可顛倒：

| 回報 | 方向 |
|---|---|
| `TASK_RESULT` / `RESOURCE_STATUS` | Worker → Operational router |
| `STRATEGIC_RETURN` | Operational router → Strategic router / Human |

本範本不重複定義 `STRATEGIC_RETURN` 的欄位；欄位規格屬於上述範本，
handback lifecycle 規則屬於
[`policies/WORKFLOW_POLICY.md`](../policies/WORKFLOW_POLICY.md)。
Operational router 不得把 worker 的 `TASK_RESULT` 原樣 echo 成 `STRATEGIC_RETURN`。
