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

implementation_role:          # ROUTER | IMPLEMENTATION | LONG_CONTEXT_DISCOVERY | ...
implementation_slot:          # 能力需求，不是模型名稱
minimum_tier:                 # CHEAP | DEFAULT | STRONG | DEEP

review_role:
review_slot:
review_disjointness_required: # verification_need 為 independent/adversarial 時為 true

discovery_role:               # 不需要 discovery 階段時填 none
discovery_slot:

# 授權旗標。這兩項是 human 的授權決定，由 strategic contract 載明；
# operational router 只讀取，不得自行決定，也不得為了讓 BLOCKED 變成
# SELECTED 而翻轉它們。預設 false 是正確的。
allow_experimental: false     # true 才允許 status: experimental 的候選
experimental_justification:   # allow_experimental 為 true 時必填，說明為何可接受
allow_red: false              # true 才允許在只剩 RED 候選時繼續

concurrency_mode:             # SEQUENTIAL | PARALLEL_INDEPENDENT | COMPETITIVE_DESIGN
integration_owner:            # 任何 mode 下都只能有一個

permission_ceiling:           # 意圖上限；實際旗標由 dispatch_command 強制
  sandbox:                    # read-only | workspace-write
  network:                    # none | restricted
  production_access: false
  may_commit:                 # true | false
  may_push: false

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

selected_candidate:           # unresolved
  actual_provider:
  actual_model:
  actual_model_family:
  reasoning_effort:

implementer_provider:         # unresolved
implementer_model_family:     # unresolved
reviewer_provider:            # unresolved
reviewer_model_family:        # unresolved
review_disjointness_verified: # unresolved — provider 與 model family 都必須不同

resource_checked_at:          # unresolved — 每個 pool 各自的時間，或 UNKNOWN
resource_overlay_applied:     # unresolved — true | false
fallback_used:                # unresolved — none，或被跳過的候選及原因
selection_reason:             # unresolved — 為何選它、為何跳過前面的候選

max_repair_attempts:          # unresolved — 來自 registry slot
failed_repair_count: 0        # 初次 implementation attempt 不計入

dispatch_command:             # unresolved
  # 逐字命令，且必須在命令列明確傳入 sandbox 與 approval 旗標。
  # 只在上面用散文宣告 permission_ceiling 是不夠的：worker 端的 local CLI
  # 設定會靜默覆蓋未明示的預設值，使實際權限高於 contract 意圖。
```

### Routing evidence 的邊界

`OPERATIONAL RESOLUTION` 是可稽核的 routing evidence，保留上列非敏感欄位即可。

**不得寫入 execution artifact**：原始 quota payload、provider credential、
帳號識別資料、cookie、session identifier、provider conversation ID。
讀不到可靠數值時填 `UNKNOWN`，不猜測。

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

---

## Completion footers

Worker 結束時原樣回傳這兩段。

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
