# Strategic Return

Version: `0.3`

`STRATEGIC_RETURN` 是 **operational router → strategic router / human** 的回報格式。
它是一份 **decision packet**，不是執行紀錄。

Handback lifecycle 的 normative owner 是
[`policies/WORKFLOW_POLICY.md`](../policies/WORKFLOW_POLICY.md) 的
*Operational → Strategic handback* 章節。本範本只定義該回報的**欄位規格**，
不重複定義 lifecycle、blocked reason code 語意或 resource state 語意。

## 方向：不可顛倒

| 回報 | 方向 | 產出者 | 內容 |
|---|---|---|---|
| `TASK_RESULT` + `RESOURCE_STATUS` | Worker → Operational router | Worker | 單次執行的完整技術輸出 |
| `STRATEGIC_RETURN` | Operational router → Strategic router / Human | Operational router | 足以做下一個 strategic decision 的 delta |

**Operational router 不得把 worker 的 `TASK_RESULT` 原樣 echo 成 `STRATEGIC_RETURN`。**
Worker 的自述只是輸入之一。Operational router 必須先整合實際 repo state、`git diff` 與
changed files、測試輸出、reviewer findings、contract drift 與 routing evidence，
再自行產出這份回報。反向使用（strategic router 產出 `STRATEGIC_RETURN`，或 worker
直接產出它）是流程錯誤。

## 與 project handoff 的分工

| | 範圍 | 生命週期 |
|---|---|---|
| `STRATEGIC_RETURN` | **單次 task / cycle 的 decision delta** | 一次 routing/execute/review cycle |
| [`CURRENT_PROJECT_HANDOFF_TEMPLATE.md`](CURRENT_PROJECT_HANDOFF_TEMPLATE.md) | **跨 session 的 durable project state** | 專案存續期間 |

兩者不互相取代。若本輪工作改變了 durable project state，operational router 必須：

1. 先更新 current project handoff；
2. 再用 `STRATEGIC_RETURN` 的 `HANDOFF_UPDATE` 指出 handoff 的哪些部分被更新。

`STRATEGIC_RETURN` 不複製 handoff 內容，handoff 也不累積歷次 return。

## Payload

供人直接複製貼回**沒有本機 filesystem 的 strategic router**。

```text
STRATEGIC_RETURN
return_version: "0.3"
task_id:
cycle:                      # 本 task 的第幾次 operational cycle
status:                     # PASS | FAIL | BLOCKED | HUMAN_GATE

CURRENT_STATE:
  repo:
  branch:
  base_head:                # cycle 開始時的 HEAD
  result_head:              # cycle 結束時的 HEAD；未 commit 時填 unchanged
  working_tree:             # clean | dirty: <一行摘要>

WHAT_WAS_DONE:
- <已完成的實質工作，逐條，不含過程敘事>

KEY_FINDINGS:
- <只列會影響下一個 strategic decision 的發現>
- NONE

DECISIONS_MADE_BY_AGENT:
- <嚴格在既有 contract 授權範圍內做出的決定>
- NONE

HUMAN_DECISIONS_REQUIRED:
- <需要 authoritative human 放行的確切決定；status 為 HUMAN_GATE 時不得為 NONE>
- NONE

CONTRACT_DRIFT:
- <被改變的 assumption / contract / schema / acceptance criterion>
- NONE

ARTIFACTS:
- repo:
  path:
  commit:
  section:                  # optional：建議直接查看的段落
- NONE

VERIFICATION:
  tests:                    # 實際執行的命令
  result:                   # PASS | FAIL | NOT_RUN
  review_required:          # standard | independent | adversarial
  reviewer_result:          # PASS | FAIL | NOT_REQUIRED
  disjointness:             # verified | not_required | UNKNOWN

REMAINING_RISKS:
- <未解決且有實質影響的風險>
- NONE

NEXT_RECOMMENDED_GATE:
- <一個具體的下一個 lifecycle gate>

BLOCKED_REASON:
- <canonical reason code> — <一行說明>
- NONE

RESOURCE_SUMMARY:
  actual_provider:          # 僅在 operational router 已解析時填，否則 UNKNOWN
  actual_model:             # 同上
  actual_model_family:      # 同上；runtime 未提供時填 UNKNOWN
  selected_stage:           # STAGE_1_DEFAULT | STAGE_2_ADVANCED | STAGE_3_FLAGSHIP | UNKNOWN
  attestation_result:       # DISPATCH_IDENTITY_MATCH | DISPATCH_IDENTITY_UNVERIFIED |
                            # DISPATCH_CONTRACT_MISMATCH | UNKNOWN
  resource_state:           # GREEN | YELLOW | RED | UNKNOWN

HANDOFF_UPDATE:
- <被更新的 handoff 檔案與段落>
- NONE
```

每個列表欄位無內容時填 `NONE`，不得留空——留空無法區分「沒有」與「沒查」。
讀不到的值填 `UNKNOWN`，不猜測。

### Status 的語意

| Status | 意義 | 必要條件 |
|---|---|---|
| `PASS` | 本 cycle 的 acceptance criteria 全部滿足且已驗證 | `VERIFICATION` 不得為 `NOT_RUN` |
| `FAIL` | 已執行但未達成 acceptance criteria | `KEY_FINDINGS` 必須說明失敗點 |
| `BLOCKED` | 無法在現有授權或資源下繼續 | `BLOCKED_REASON` 必須帶 canonical reason code |
| `HUMAN_GATE` | 停在需要人為決策的點 | `HUMAN_DECISIONS_REQUIRED` 必須列出確切待決事項 |

Continuation freshness 判定為 `CONTINUATION_REJECTED_STALE` 或
`LEGACY_CONTINUATION_REQUIRES_FRESH_CONTRACT` 時（定義見
[`policies/WORKFLOW_POLICY.md`](../policies/WORKFLOW_POLICY.md) 的
Continuation freshness），回報為 `status: HUMAN_GATE`，並在 `CONTRACT_DRIFT`
中列出 continuation eligibility check 找到的變更欄位——這是 lifecycle outcome，
不是 `BLOCKED_REASON` 的 canonical reason code，本範本不為它新增欄位。

`BLOCKED_REASON` 使用的 reason code 名稱為：

```text
CONFIG_INVALID | ROUTING_UNAVAILABLE | POLICY_BLOCKED
RESOURCE_BLOCKED | PERMISSION_BLOCKED
```

**這些 code 的語意由
[`policies/MODEL_ROUTING_POLICY.md`](../policies/MODEL_ROUTING_POLICY.md)
的 Blocked reason codes 章節定義，那裡是唯一的 owner。** 本範本只列出名稱供填寫。

`resource_state` 的 `GREEN` / `YELLOW` / `RED` / `UNKNOWN` 語意由
[`policies/RESOURCE_AWARE_ROUTING.md`](../policies/RESOURCE_AWARE_ROUTING.md) 定義。

## Compact by default, expandable by reference

正常情況下 `STRATEGIC_RETURN` 應該是 compact summary。操作上的目標大約是：

```text
500-1500 tokens
```

這是 human-readable operational guideline，**不是 hard parser limit**。沒有任何檢查
程式會因為超出而拒絕這份回報；超出只代表該改用 reference 而不是 inline。

資訊量超過此範圍時，優先放：

```text
repo
commit SHA
artifact path
relevant section
```

**不要把完整 design document、完整 report 或完整 diff inline 回傳。**
Strategic router 可以依 repo / path / commit 自行讀取需要的 authoritative artifact，
或請 human 代為取出。

證據的權威來源分層如下，`STRATEGIC_RETURN` 位於最上層而非最下層：

```text
Git / repository artifacts     完整、可稽核的 evidence
Operational router             完整 worker / reviewer / filesystem context
STRATEGIC_RETURN               compact decision-relevant delta
```

## Evidence escalation

下列情況需要**更多 evidence**——但仍優先用 artifact reference（repo / path /
commit / section），只有在缺少原文會使 human decision 無法安全進行時才 inline，
且 inline 的範圍限於必要片段：

- architecture contract ambiguity
- privileged boundary decision
- auth / RBAC / RLS
- destructive 或 breaking 的 DB / API implication
- implementer 與 reviewer 判斷不一致
- 測試失敗且失敗原因無法安全摘要
- human decision 取決於確切的 design alternatives
- contract drift
- 非預期的 production-state 發現

這些情況多數同時屬於 `policies/WORKFLOW_POLICY.md` 的 human gate 清單；
escalation 提高的是 evidence 密度，**不是**繞過 gate 的理由。

## 不得回傳

`STRATEGIC_RETURN` 會被貼進外部對話介面，因此邊界比 repository 內部更嚴：

- 完整 terminal transcript 或 worker 逐字輸出
- 完整 `git diff`，除非缺少它就無法安全做出 human decision
- 原始 quota payload
- credential、帳號識別資料、cookie、session identifier
- provider conversation ID
- 客戶資料或個人資料

需要這些內容才能判斷時，回傳的是**指向它的 reference**，不是內容本身。
