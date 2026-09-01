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
| Operational router（Orca） | 驗證 repo、讀 registry、套 overlay、選 candidate、組 dispatch command | 重新解讀需求、降低 permission ceiling |

**Strategic router MUST NOT DEPEND ON direct filesystem access, local registry
visibility, or live quota visibility.** 你若讀不到，就不要假裝讀到了。

## 2. 六階段路由

```text
classify -> slot -> overlay -> candidate -> contract -> dispatch
```

1. **classify** — 六個維度全填：`risk`、`complexity`、`context_size`、
   `ambiguity`、`change_intensity`、`verification_need`。
2. **slot** — 查 [`MODEL_ROUTING_POLICY.md`](../../policies/MODEL_ROUTING_POLICY.md)
   的 slot 決策表，得出 `role`、`slot`、`minimum_tier`。高風險規則優先於成本規則。
3. **overlay** — 讀 resource state。**讀不到就是 `UNKNOWN`，不准估算。**
   `YELLOW` 與 `UNKNOWN` 同權，依 registry 順序。
4. **candidate** — 依 [`MODEL_REGISTRY.yaml`](../../policies/MODEL_REGISTRY.yaml)
   的 ordered candidates 選出。不得跨越 `minimum_tier`。
5. **contract** — 填
   [`templates/ROUTER_EXECUTION_CONTRACT_TEMPLATE.md`](../../templates/ROUTER_EXECUTION_CONTRACT_TEMPLATE.md)。
   Strategic 半部由大腦填，operational 半部保持 `unresolved` 直到 router 解析。
6. **dispatch** — 逐字命令，**在命令列明確傳入 sandbox 與 approval 旗標**。
   散文式的權限宣告會被 worker 的本機設定靜默覆蓋。

## 3. Concurrency

預設 `SEQUENTIAL`。改為 `PARALLEL_INDEPENDENT` 前，
[`CONCURRENCY_POLICY.md`](../../policies/CONCURRENCY_POLICY.md) 的五項檢查必須全為是。
`COMPETITIVE_DESIGN` 只產 proposal。`PARALLEL_SAME_CORE_IMPLEMENTATION` 永久禁止。

同一條 implementation chain 留在同一 worktree。fresh session 不等於 fresh worktree。

## 4. Review

`verification_need` 為 `independent` 或 `adversarial` 時，reviewer 的 **provider 與
model family 都必須**與 implementer 不同。找不到 disjoint 候選就回 `BLOCKED`，
不得以「同 provider 不同模型」充數。

Reviewer 直接看 filesystem、`git diff` 與測試輸出，不採信 worker 摘要。

## 5. 執行中：等待、權限、max turns

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

## 6. 停止

`BLOCKED` 必須附 reason code：`CONFIG_INVALID`、`ROUTING_UNAVAILABLE`、
`POLICY_BLOCKED`、`RESOURCE_BLOCKED`、`PERMISSION_BLOCKED`。

以下一律回 **human gate**，不因模型能力或 quota 而繞過：ownership ambiguity、
architecture contract change、breaking DB/API、destructive migration、
auth/RBAC/RLS、privileged boundary、production deploy、secrets/security config、
多個長期架構方案。

`failed_repair_count >= max_repair_attempts` 時升級或停止。初次 attempt 不算 repair。

## 7. 回報（Worker → Operational Router）

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

`actual_provider` / `actual_model` / `reasoning_effort` 由 router 寫定，worker 只回填。
讀不到 quota 就整段 `UNKNOWN`——**禁止為了填滿欄位而猜測**。

## 8. Handback（Operational Router → Strategic Router）

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
[`templates/STRATEGIC_RETURN_TEMPLATE.md`](../../templates/STRATEGIC_RETURN_TEMPLATE.md)，
lifecycle 規則見
[`WORKFLOW_POLICY.md`](../../policies/WORKFLOW_POLICY.md) 的 Operational → Strategic handback。

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

## 9. 改動這個 pack 之前

命令範例以本機 `--help` 為準，見
[`OFFICIAL_COMMANDS.md`](../../references/OFFICIAL_COMMANDS.md)。
模型 mapping 只改 [`MODEL_REGISTRY.yaml`](../../policies/MODEL_REGISTRY.yaml)。

```bash
npm test
npm run validate
```

兩者都必須 exit 0。
