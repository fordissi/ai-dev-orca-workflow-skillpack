# Orca Multi-Agent Development Skill

Agent 入口。照著做，不要即興。

## 0. 讀取順序

```text
SKILL → WORKFLOW_POLICY → CONCURRENCY_POLICY → MODEL_ROUTING_POLICY
      → MODEL_REGISTRY → RESOURCE_AWARE_ROUTING → OFFICIAL_COMMANDS
      → Current Project Handoff
```

Markdown policy 是 normative；`scripts/` 下的驗證程式只是 conformance checker。
兩者衝突時修程式，不改政策。

## 1. 先確認你是誰

| 你是 | 你做 | 你不做 |
|---|---|---|
| Strategic router（大腦） | 拆解、六維分類、`role`/`slot`/`minimum_tier`、concurrency、gate 判定 | 指名具體模型、宣稱驗證過 repo 狀態 |
| Operational router（Orca） | 驗證 repo、讀 registry、套 overlay、選 candidate、組 dispatch command、bounded control-plane probe | 重新解讀需求、降低 permission ceiling、**在非 bounded probe 範圍內直接做 worker 的工作**（見下一節） |

**Strategic router MUST NOT DEPEND ON direct filesystem access, local registry
visibility, or live quota visibility.** 你若讀不到，就不要假裝讀到了。

## 2. Control plane ≠ workload plane

**你是 Operational Router 時，先問一句：這一步是在 route 這個 task，還是在解它？**
是後者就停下來派工，不要自己做。一次真實 incident：長駐的 Router
（`codex/gpt-5.6-luna/max`）連續跑了約 25 分鐘的 repository 調查、資料核對與
154 個測試的 regression run，全程沒有派工、沒有 dispatch identity attestation。
這正是本節要擋的模式——保留 quota（見 Router capacity reserve）不等於保留了
執行邊界，兩者是不同的失效模式。

**Direct-allowed（bounded control-plane probe）：** `git status`/`rev-parse`、
確認 branch/HEAD/worktree、讀一份 handoff/policy 文件、為了 classification
檢視少量路徑、檢視 resource availability、驗證 worker 結果、dispatch 前一兩個
範圍明確的命令。**缺陷不是「用了工具」，是「調查變成 worker 的量體與時長」。**

**Dispatch-required（worker-shaped，落在既有 slot，不新增 slot 架構）：**

```text
broad discovery         → LONG_CONTEXT_DISCOVERY
implementation          → DEFAULT_IMPLEMENTER / STRONG_IMPLEMENTER
regression / test 執行  → REGRESSION_HUNTER
domain reasoning        → DEEP_REASONER
背景 terminal 做 domain 工作 → 一律違規，與哪個 slot 無關
```

主判準是語意，不是數字：

```text
The Router MUST dispatch when the next material step primarily advances the
domain task rather than routing/validating the task.
```

反覆的大範圍 probe、超出簡短探查應有時間、命令輸出被用來解題而非決定怎麼
route——這些是輔助稽核訊號，會被記錄，但不是唯一判準。

**只有實際的 `ROUTER` slot** 享有 direct-allowed 豁免；`DEEP_REASONER` 也標
`role: ROUTER`，但它是被派工的 worker，不因為 role tag 就變成控制面。

找不到合格 worker（reserve 排除、無 eligible provider、identity 建立不了、
permission 擋下）時，回既有的 `ROUTING_UNAVAILABLE` / `RESOURCE_BLOCKED` /
`PERMISSION_BLOCKED` / human gate——**不是 Router 自己做**。Reserve 排除 Terra
/Sol/一般 Luna worker 後，Router 自己接手同一份工作，額度照樣從同一個 pool
扣掉，這是 `ROUTER_RESERVE_SELF_CONSUMPTION`，同樣禁止。

Human 可以明確要求「這次直接做，不要派工」：記
`router_execution_source: HUMAN_EXPLICIT_OVERRIDE`，綁定 current task id 與
instruction revision；換一個 task 就要重新取得，不延續。

完整語意見 [`WORKFLOW_POLICY.md`](../../policies/WORKFLOW_POLICY.md) 的
Operational Router execution boundary，reserve 交互見
[`RESOURCE_AWARE_ROUTING.md`](../../policies/RESOURCE_AWARE_ROUTING.md) 的
Router capacity reserve。

## 3. 六階段路由

```text
classify -> slot -> overlay -> candidate -> contract -> dispatch
```

1. **classify** — 六個維度全填：`risk`、`complexity`、`context_size`、
   `ambiguity`、`change_intensity`、`verification_need`。
2. **slot** — 查 [`MODEL_ROUTING_POLICY.md`](../../policies/MODEL_ROUTING_POLICY.md)
   的 slot 決策表，得出 `role`、`slot`、`minimum_tier`。高風險規則優先於成本規則。
3. **overlay** — 讀 resource state。**讀不到就是 `UNKNOWN`，不准估算。**
   quota facts 先 provider-native probe（Codex `/status`、Claude `/usage`、
   `agy --print "/usage" --output-format json`），再 fallback。
   **`orca account list` 是 integration visibility，不是 quota 來源**——它
   unavailable 不等於 quota 耗盡；分開追蹤 `provider_resource_state` 與
   `orca_integration_state`，成功的 probe 不被 Orca aggregate 覆蓋。
   `YELLOW` 與 `UNKNOWN` 同權，依 registry 順序。
   同一 band、同一 state 之內再看兩個資源訊號，**順序固定：先稀缺，後利用率**。
   - **BUDGET**（weekly / monthly 等長期上限）→ `conservation_pressure`。
     `HIGH` / `CRITICAL` 的候選**降級**。
   - **BURST**（5h / hourly 等短窗）→ `stranded_capacity_risk`。
     `HIGH` **且自身 conservation 為 `NONE`/`LOW`** 才能**提前**。
   **短窗機會不得推翻長期稀缺**：週預算只剩 8% 時，5h 窗剩再多也不提前。
   BUDGET 讀不到就兩邊都不動（不當 healthy，也不當 scarce）。
   任何重排都要記錄被跳過的是誰。它只重排已合格的候選——**不降 `minimum_tier`、
   不換掉 disjoint reviewer、不繞 human gate、不改 slot membership**。
   見 [`RESOURCE_AWARE_ROUTING.md`](../../policies/RESOURCE_AWARE_ROUTING.md)。
4. **candidate** — 依 [`MODEL_REGISTRY.yaml`](../../policies/MODEL_REGISTRY.yaml)
   的 ordered candidates 選出。不得跨越 `minimum_tier`。Autonomous selection 必須
   記錄 `model_selection_source: REGISTRY_AUTONOMOUS`，且選出的完整 identity 必須
   對應該 slot 的 enabled candidate；slot 外模型在 dispatch 前拒絕。
5. **contract** — 填
   [`templates/ROUTER_EXECUTION_CONTRACT_TEMPLATE.md`](../../templates/ROUTER_EXECUTION_CONTRACT_TEMPLATE.md)。
   Strategic 半部由大腦填，operational 半部保持 `unresolved` 直到 router 解析。
6. **contract attestation** — 填入 `EXPECTED_IDENTITY` 與 `ACTUAL_IDENTITY` 的
   `provider`、`model`、`model_family`、`reasoning_effort`。結果只能是
   `DISPATCH_IDENTITY_MATCH`、`DISPATCH_CONTRACT_MISMATCH` 或
   `DISPATCH_IDENTITY_UNVERIFIED`。
7. **dispatch** — 逐字命令，**在命令列明確傳入 model、reasoning、sandbox 與
   approval 旗標**。散文式的權限或模型宣告會被 worker 的本機設定靜默覆蓋。

## 4. Governance tiers

**Governance 強度要跟實際風險成正比，不是跟「碰到 production」成正比。**
`classify` 步驟填六維分類的同時，另外評估四個維度：`DATA_SENSITIVITY`
（LOW/MODERATE/HIGH）、`REVERSIBILITY`（EASY/MODERATE/HARD_IRREVERSIBLE）、
`BLAST_RADIUS`（LOCAL/MODULE/CROSS_SYSTEM_BULK）、`PRIVILEGE_IMPACT`
（NONE/NORMAL/ELEVATED_SECURITY_BOUNDARY）。**取四者中最嚴重的**決定：

```text
G1_LIGHTWEIGHT   implement → focused tests → commit
G2_STANDARD      bounded plan → implementation → tests → independent review → deploy/commit
G3_HIGH_RISK     preflight → explicit human gate → bounded implementation
                 → independent security review → controlled execution → post-validation
```

以下任一為真時**直接鎖定 `G3_HIGH_RISK`**，不看四個維度：auth
provisioning/binding、RLS policy 變更、`SECURITY DEFINER`、`BYPASSRLS`/
`service_role`、destructive production migration、production bulk
master-data mutation、payroll/compensation write path、privilege
escalation/role-grant 變更——**這些就是 [`WORKFLOW_POLICY.md`](../../policies/WORKFLOW_POLICY.md)
Human gates 清單中對應項目的具體化，不是第二份清單。**

**Production 環境本身、測試套件大小、改動檔案數、執行時間、程式碼複雜度**都
**不是**輸入——不會單獨把 tier 推到 `G3_HIGH_RISK`。

**Governance tier 不是 capability stage**，兩者正交：G3 task 範圍夠清楚時仍可
用 Stage 1/2 模型；G1 task 異常模糊時仍可能需要 Stage 3 推理。不得互相推導。

Fingerprint（exact-payload 核准）只在該 task 明確需要 human 核准精確
canonical payload bytes 時才要求，不因為是 G3 就自動要求。Human 可以調高或
調降 process 嚴格度，但**命中 hard trigger 時不得被 override 降級**。

Router 輸出精簡：`governance_tier` / `governance_reasons` / `required_gates`
/ `required_review` / `fingerprint_required`，不必產出冗長的 compliance 文字。
完整語意見 [`WORKFLOW_POLICY.md`](../../policies/WORKFLOW_POLICY.md) 的
Governance tiers。

## 5. Concurrency

預設 `SEQUENTIAL`。改為 `PARALLEL_INDEPENDENT` 前，
[`CONCURRENCY_POLICY.md`](../../policies/CONCURRENCY_POLICY.md) 的五項檢查必須全為是。
`COMPETITIVE_DESIGN` 只產 proposal。`PARALLEL_SAME_CORE_IMPLEMENTATION` 永久禁止。

同一條 implementation chain 留在同一 worktree。fresh session 不等於 fresh worktree。

## 6. Review

`verification_need` 為 `independent` 或 `adversarial` 時，reviewer 的 **provider 與
model family 都必須**與 implementer 不同。找不到 disjoint 候選就回 `BLOCKED`，
不得以「同 provider 不同模型」充數。

Reviewer 直接看 filesystem、`git diff` 與測試輸出，不採信 worker 摘要。
Reviewer 的 generic helper（包括 Superpowers / `requesting-code-review`）不是 model
selection authority；它必須接收已解析的 workflow contract，不能自行挑選未註冊模型。
Current human instruction 才能產生 `HUMAN_EXPLICIT_OVERRIDE`；一次完成工作的
`HUMAN_RETROACTIVE_ACCEPTANCE` 只留在 audit history，不會擴充 registry。

## 7. 執行中：等待、權限、max turns

**慢不是壞。** 輪詢逾時、總執行時間長、terminal 安靜、還沒給結論——四者都不是失敗，
不得回 `BLOCKED`。

```text
poll timeout != task timeout
total runtime != stall duration
slow != blocked
```

`orca terminal wait --timeout-ms 60000` 的逾時只表示「醒來再看一次」，
不表示 worker 只有 60 秒。用 cursor read 看增量輸出判斷有無進展。

| 觀察到 | 狀態 | 做什麼 |
|---|---|---|
| 有新輸出／新 tool call／tests 階段變了 | `ACTIVE` | 繼續等 |
| session 活著但暫時沒輸出 | `QUIET` | 繼續等 |
| 活著且距上次進展達 stall threshold（預設 10-20 分） | `STALLED` | 檢查狀態、讀增量輸出、bounded resume；仍無解才 human gate |
| exit 且有可用結果 | `COMPLETE` | 進 review |
| exit 且 `Reached max turns` | `MAX_TURNS_REACHED` | 在同一條 chain 上 bounded continuation（預設上限 2） |
| exit 但無可用結果 | `PROCESS_EXIT_FAILURE` | 走既有 repair / escalation |
| 到達 hard ceiling 但還活著 | `HARD_EXECUTION_CEILING` | **human gate，不自動 FAIL** |
| session 不可達且無 exit 紀錄 | `ROUTING_UNAVAILABLE` | 交回 human |

**Continuation 不是 repair。** turn budget 用盡不是錯誤結果，不累加
`failed_repair_count`。

### 權限：讀、執行、寫是三件事

`sandbox: read-only` **不等於**「不准執行任何命令」。Reviewer 要跑
`git status`、`git diff`、`git log`、`rg`、`cat`、`Get-Content` 才能做事。

```text
CAN    檢視 repo、執行唯讀命令、看 git history/diff/status、讀 tests/source/docs
CANNOT 改檔案、改 git 狀態、commit、push、動 database、碰 production、改設定
```

命令是否唯讀看**這次實際 invocation**，不看 executable 名稱——`git` 同時有
`git log` 與 `git push`，`git branch` 與 `git branch -d` 也不同。無法判定就 fail closed。

Human 核准一條唯讀命令**不提高 permission ceiling**：核准
`Get-Content migration.sql` 不等於核准寫入。

`PERMISSION_BLOCKED` 只用在**所需操作超出 ceiling** 時。慢、安靜、還沒結論、
max turns 都不是 `PERMISSION_BLOCKED`。

完整語意見 [`WORKFLOW_POLICY.md`](../../policies/WORKFLOW_POLICY.md) 的
Permission ceiling 的能力分解與 Execution lifecycle semantics；命令細節見
[`OFFICIAL_COMMANDS.md`](../../references/OFFICIAL_COMMANDS.md)。

## 8. Continuation 與 session cleanup

**Resume 前先比對 human intent，不是先看 worker 還活著沒。** 一次真實 cycle 曾經
續跑舊 task，即使新的 human instruction 早已要求不同的 task——worker 與 reviewer
都沒錯，錯在 router 續跑前沒有跑這個檢查。

```text
A continuation is valid only against the same still-current human intent
and permission scope.
```

以下情況之前**必須**先跑 continuation eligibility check：resume、
`MAX_TURNS_REACHED` 續跑、retry 同一 worker、reviewer continuation、
parked terminal 重用。比對至少涵蓋：objective、allowed/prohibited changes、
permission ceiling（含 production/network/database）、human gate 狀態、
baseline/HEAD、expected output/next gate。

任一項改變：

```text
CONTINUATION_REJECTED_STALE → 新開 task contract，不得自動 resume
```

沒有 revision fingerprint 的舊 contract 續跑時一律
`LEGACY_CONTINUATION_REQUIRES_FRESH_CONTRACT`，不假設它仍 current。
兩者都**不是** `PERMISSION_BLOCKED` / `ROUTING_UNAVAILABLE`，也不計入
`failed_repair_count`。

Precedence（下層不得覆蓋上層）：

```text
latest human instruction > handoff/state > active contract
> prior NEXT_GATE > cached router context > worker-local state
```

**Session lifecycle：** `ACTIVE` / `PARKED` / `SUPERSEDED` / `STALE` /
`FAILED` / `CLOSED`。`PARKED` **不豁免**上面的 continuation check——續跑
`PARKED` terminal 前一樣要重跑一次。

Cleanup 保守預設：`PASS` 自動 `CLOSE`；`FAIL`/`BLOCKED` 擷取 evidence 後
`CLOSE`（除非有效 retry 仍在）；`SUPERSEDED`/`STALE` 盡快 `CLOSE`；
`HUMAN_GATE` 只在「預期同一 task 續跑 + 無敏感 context + 資源成本可接受」時
`PARK`，否則 `CLOSE`；`ACTIVE` 永不因 elapsed time 單獨關閉。

Unknown/未綁定 terminal（缺 fingerprint）一律 `resumable: false`，**不得只看
title 判斷 task ownership**。

完整語意見 [`WORKFLOW_POLICY.md`](../../policies/WORKFLOW_POLICY.md) 的
Continuation freshness 與 Session lifecycle and cleanup；目前 Orca 沒有
per-terminal close/list 的已驗證命令，實際限制見
[`OFFICIAL_COMMANDS.md`](../../references/OFFICIAL_COMMANDS.md)。

## 9. 停止

`BLOCKED` 必須附 reason code：`CONFIG_INVALID`、`ROUTING_UNAVAILABLE`、
`POLICY_BLOCKED`、`RESOURCE_BLOCKED`、`PERMISSION_BLOCKED`。

以下一律回 **human gate**，不因模型能力或 quota 而繞過：ownership ambiguity、
architecture contract change、breaking DB/API、destructive migration、
auth/RBAC/RLS、privileged boundary、production deploy、secrets/security config、
多個長期架構方案。

`failed_repair_count >= max_repair_attempts` 時升級或停止。初次 attempt 不算 repair。

## 10. 回報（Worker → Operational Router）

Worker / Reviewer 結束時依 `return_profile` 回報（語意見 [`WORKFLOW_POLICY.md`](../../policies/WORKFLOW_POLICY.md) 的 Tiered return and handoff profiles）。收件人是 operational router，不是 strategic router。

**預設（INTERNAL_COMPACT）：** 一般成功之內部執行採用精簡格式：

```text
STATUS: PASS
ARTIFACT: <commit/result/reference>
VALIDATION: PASS
EXCEPTIONS: NONE
```

clean PASS 下**不需重複輸出**已由合約與測試保證之機器不變式（例如 `secret_in_git: NO`、`worker_receives_secret: NO` 等）。
若非 clean happy path（`STATUS` 為 `HUMAN_GATE`、`BLOCKED`、`RETRYABLE`，或有例外/偏差），**自動展開**並附：`reason_code`、`evidence`、`unresolved_state`、`required_next_action`。

**詳細 / 稽核（AUDIT_FULL / Legacy 相容）：** 明確要求完整技術輸出或稽核時採用：

```text
TASK_RESULT
status: PASS | FAIL | BLOCKED
blocked_reason_code:
actual_provider:
actual_model:
actual_model_family:
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

`actual_provider` / `actual_model` / `actual_model_family` / `reasoning_effort` 由 router
寫定並以 attestation 比對，worker 只回填。無法觀察時填 `UNKNOWN`，不能宣稱
`DISPATCH_IDENTITY_MATCH`。
讀不到 quota 就整段 `UNKNOWN`——**禁止為了填滿欄位而猜測**。

## 11. Handback（Operational Router → Strategic Router）

回報鏈固定為：

```text
worker result
→ operational verification/review
→ router synthesis
→ STRATEGIC_RETURN
→ human / strategic router
```

`TASK_RESULT` 是 **worker → operational router**。
`STRATEGIC_RETURN` 是 **operational router → strategic router / human**。方向不可顛倒。

**Operational router 不能把 worker 的 `TASK_RESULT` 原樣 echo 回 strategic layer。**
先整合以下各項，再產出 `STRATEGIC_RETURN`：

- actual repo state（HEAD、working tree）
- `git diff` 與 changed files
- tests
- reviewer findings
- contract drift
- routing evidence
- remaining risks

格式見
[`templates/STRATEGIC_RETURN_TEMPLATE.md`](../../templates/STRATEGIC_RETURN_TEMPLATE.md)（實作 `EXTERNAL_HANDOFF` profile），
lifecycle 規則與 profile 語意見
[`WORKFLOW_POLICY.md`](../../policies/WORKFLOW_POLICY.md) 的 Operational → Strategic handback 與 Tiered return and handoff profiles。這是跨軟體邊界的 context-serialization 契約，使外部大腦在無檔案系統與 transcript 下仍能接續推理。僅在明確稽核要求時採用 `AUDIT_FULL`。

```text
STRATEGIC_RETURN
task_id:
status: PASS | FAIL | BLOCKED | HUMAN_GATE
CURRENT_STATE:      # repo / branch / base_head / result_head / working_tree
WHAT_WAS_DONE:
KEY_FINDINGS:
DECISIONS_MADE_BY_AGENT:
HUMAN_DECISIONS_REQUIRED:
CONTRACT_DRIFT:
ARTIFACTS:          # repo / path / commit SHA / section
VERIFICATION:
REMAINING_RISKS:
NEXT_RECOMMENDED_GATE:
BLOCKED_REASON:
RESOURCE_SUMMARY:   # 已解析的 provider/model；state 只填 GREEN|YELLOW|RED|UNKNOWN
HANDOFF_UPDATE:
```

預設 compact（約 500-1500 tokens 的操作指引，不是 hard limit）。放不下就回
repo + commit SHA + artifact path + 段落，**不要 inline 完整 transcript、完整 diff
或完整 design 文件**。不回傳原始 quota payload、credential、session identifier 或
provider conversation ID。

`STRATEGIC_RETURN` 是單次 cycle 的 decision delta；跨 session 的 durable state 屬於
current project handoff。改到 durable state 時先更新 handoff，再用 `HANDOFF_UPDATE`
指出改了哪裡。

## 12. 改動這個 pack 之前

命令範例以本機 `--help` 為準，見
[`OFFICIAL_COMMANDS.md`](../../references/OFFICIAL_COMMANDS.md)。
模型 mapping 只改 [`MODEL_REGISTRY.yaml`](../../policies/MODEL_REGISTRY.yaml)。

```bash
npm test
npm run validate
```

兩者都必須 exit 0。
