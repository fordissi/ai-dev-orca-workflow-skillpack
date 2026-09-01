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

## 5. 停止

`BLOCKED` 必須附 reason code：`CONFIG_INVALID`、`ROUTING_UNAVAILABLE`、
`POLICY_BLOCKED`、`RESOURCE_BLOCKED`、`PERMISSION_BLOCKED`。

以下一律回 **human gate**，不因模型能力或 quota 而繞過：ownership ambiguity、
architecture contract change、breaking DB/API、destructive migration、
auth/RBAC/RLS、privileged boundary、production deploy、secrets/security config、
多個長期架構方案。

`failed_repair_count >= max_repair_attempts` 時升級或停止。初次 attempt 不算 repair。

## 6. 回報

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

## 7. 改動這個 pack 之前

命令範例以本機 `--help` 為準，見
[`OFFICIAL_COMMANDS.md`](../../references/OFFICIAL_COMMANDS.md)。
模型 mapping 只改 [`MODEL_REGISTRY.yaml`](../../policies/MODEL_REGISTRY.yaml)。

```bash
npm test
npm run validate
```

兩者都必須 exit 0。
