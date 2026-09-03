# Official / Primary Command Reference

Local `--help` verified: **2026-09-01**; reasoning / dispatch / attestation
section re-verified **2026-09-02** against `codex-cli 0.151.0`,
`Claude Code 2.1.258`, `agy 1.1.23`, `orca 1.4.194`; Antigravity model list
re-verified **2026-09-03** against `agy 1.1.24` — `gemini-3.8-flash-{low,
medium,high}` now resolves and dispatches (see the Antigravity section below).

Provider-native **resource probe** invocations (Codex `/status`, Claude
`/usage`, Antigravity `agy` `/usage`) — verified account/session state, quota
fields observable, and blockers — live in
[`RESOURCE_PROBES.md`](RESOURCE_PROBES.md); the acquisition precedence and
source-trust rules are in
[`../policies/RESOURCE_AWARE_ROUTING.md`](../policies/RESOURCE_AWARE_ROUTING.md).

## Version verification rule

**已安裝的 `--help` 勝過本文件的任何範例。** 自動化之前先跑：

```bash
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
gh repo view --help
gh repo create --help
```

工具未安裝、未登入或無法解析模型時，記 `UNKNOWN` / `BLOCKED`，**不得猜測支援的旗標或 model ID**。

### 本機實測版本（2026-09-01）

| Tool | Version | 來源 |
|---|---|---|
| Orca runtime | 1.4.192 | `orca status --json` 的 `runtime.appVersion` |
| Codex CLI | 0.151.0 | `codex --version` |
| Claude Code | 2.1.252 | `claude --version` |
| Antigravity CLI | 1.1.24 | `agy --version`（重新驗證 2026-09-03；先前記錄 1.1.22） |
| GitHub CLI | 2.92.0 | `gh --version` |

---

## Orca

Primary: https://github.com/stablyai/orca/blob/main/skill-guides/orca-cli.md

在現有 worktree 開新 agent（**不要用 `worktree create`**）：

```bash
orca terminal create --worktree active --title "<task>" --command "codex" --json
orca terminal wait --terminal <handle> --for tui-idle --timeout-ms 60000 --json
orca terminal send --terminal <handle> --text "<prompt>" --enter --json
```

### `--timeout-ms` 是輪詢窗口，不是 worker 的完成期限

`orca terminal wait --timeout-ms 60000` 逾時**只表示「醒來重新觀察一次」**。
它不表示 worker 只有 60 秒可以完成，逾時本身也不是錯誤。Router 收到逾時後應
讀取增量輸出、判斷是否有進展，再決定繼續等待或介入。語意見
[`policies/WORKFLOW_POLICY.md`](../policies/WORKFLOW_POLICY.md) 的
Execution lifecycle semantics。

判斷進展一律用 **cursor read**，因為只有它有歷史；畫面讀取看不到已捲離的輸出，
會把有進展的 session 誤判成安靜：

```bash
orca terminal read --terminal <handle> --cursor <n> --limit 1000 --json
```

cursor 前進、出現新的 stdout/stderr、新的 tool invocation、tests 階段改變，
都是 observable progress。**總執行時間長不是進展的反面**——只有「距離上次進展的
時間」才是 stall 訊號。

非互動式派工（`codex exec` 會自行結束，用 `--for exit`）：

```bash
orca terminal create --worktree active --title "<task>" --command '<command>' --json
orca terminal wait --terminal <handle> --for exit --timeout-ms 600000 --json
orca terminal read --terminal <handle> --json
```

### Dispatch path 與 reasoning 傳遞（實測 2026-09-02，`orca 1.4.194`）

有兩條受支援的 worker 啟動路徑，reasoning 的傳遞方式不同：

**路徑 A — 既有 terminal + `orca orchestration dispatch --inject`。**
`orca orchestration dispatch --task <id> --to <handle> --inject` 只把 task 文字注入
既有 terminal，**不帶任何模型或 reasoning 設定**。因此建立該 terminal 的
`orca terminal create --command "<CLI>"` 中的 `<CLI>` **必須**已包含 `-m <model>` 與
（Codex）`-c 'model_reasoning_effort="<value>"'` 或（Claude）`--effort <level>`。
若既有 terminal 的 provider、model、model family、reasoning effort 不能逐欄證明與
contract 相容，該 terminal 不得重用來宣稱 exact dispatch，結果至少是
`DISPATCH_IDENTITY_UNVERIFIED`。

**路徑 B — `orca orchestration worker-start`。** 支援：

```bash
orca orchestration worker-start --task <id> --agent codex \
  --model gpt-5.6-luna --effort max --worktree current --json
```

`--help` 明載：`--model` 接受 Claude / Codex / Cursor 的 opaque provider model id；
**`--effort` 需要同時給 `--model`**；`--model` / `--effort` **不能與 `--terminal`
併用**（既有 terminal 走路徑 A）。由 Orca 負責把 `--effort` 轉成各 provider 的實際
機制。「max」對 Codex 的接受度未在本機以此路徑實跑驗證——首次使用時以
`--dry-run` 或事後 attestation 確認。

**不得假設 Orca 會自動把 model 或 effort 傳下去。** 路徑 A 完全不會；路徑 B 只有
在明確傳 `--model` + `--effort` 時才會。`worker-start` 的 null model / effort
結果是 default-fallback risk，不是 exact dispatch。

### Dispatch path classification

| Path | Classification | Condition |
|---|---|---|
| `orca orchestration worker-start` | `EXACT_IDENTITY_PRESERVED` | `--agent`, `--model`, `--effort` 均由 current contract 明確提供，並完成 runtime attestation |
| `orca orchestration dispatch --inject` | `DEFAULT_FALLBACK_RISK` | 只注入 task；只有既有 terminal command 與四欄 identity 都可證明時才可升為 exact |
| `orca terminal create --command` | `EXACT_IDENTITY_PRESERVED` | command 明確包含 provider 支援的 model / reasoning / permission flags；否則 `DEFAULT_FALLBACK_RISK` |
| `orca worktree create --agent` | `DEFAULT_FALLBACK_RISK` | agent-first convenience path 不接收 custom model / effort；必須另建明確 command 或回報 unverified |
| existing terminal + `terminal send` | `DEFAULT_FALLBACK_RISK` | send 只送文字；未證明 terminal identity 不可重用 |
| Codex direct invocation | `EXACT_IDENTITY_PRESERVED` | `-m <model>` 與 `-c 'model_reasoning_effort="<effort>"'` 均明確傳入並完成 attestation；任一省略即 `DEFAULT_FALLBACK_RISK` |
| Claude direct invocation | `EXACT_IDENTITY_PRESERVED` | `--model <model>` 與 `--effort <level>` 均明確傳入並完成 attestation；任一省略即 `DEFAULT_FALLBACK_RISK` |
| Antigravity / `agy` direct invocation | `EXACT_IDENTITY_PRESERVED` | resolver 先得到 exact model，再明確傳入 model / effort 並完成 attestation；否則 `DEFAULT_FALLBACK_RISK` |
| repo-local `orca-multi-agent-dev` skill | `EXACT_IDENTITY_PRESERVED` | 完整遵循 slot → registry → contract → explicit command → attestation；若 caller bypasses any stage 即 `DEFAULT_FALLBACK_RISK` |
| generic subagent / Superpowers reviewer helper | `DEFAULT_FALLBACK_RISK` | helper 不是 registry authority；未接收完整 contract 不得 dispatch |

以上是 launch-path 分類，不是對某次 worker 的成功宣告。只有四欄 runtime identity
完全相同且命令旗標明確時，attestation 才是 `DISPATCH_IDENTITY_MATCH`；任何 runtime
identity 欄位不可觀察時，結果必須是 `DISPATCH_IDENTITY_UNVERIFIED`。
命令層的選擇來源仍須由 workflow contract 記錄為
`model_selection_source`，值只能是
`REGISTRY_AUTONOMOUS`、`HUMAN_EXPLICIT_OVERRIDE` 或
`HUMAN_RETROACTIVE_ACCEPTANCE`；本命令參考不會把 helper 或 CLI default 變成
registry candidate。

### Runtime attestation（能力與缺口）

Dispatch 後要驗證 worker 實際的 `provider` / `model` / `model_family` /
`reasoning_effort` 是否等於 contract。目前可用與不可用的部分：

- **可用**：Codex interactive session 的 `/status` 面板會印出
  `Model: <id> (reasoning <effort> ...)`。透過
  `orca terminal send --terminal <h> --text "/status"`（注意 shell 的
  `MSYS_NO_PATHCONV=1`，否則 `/status` 會被 Git-Bash 改寫成 Windows 路徑）再
  `orca terminal read` 可取回並比對。
- **可用**：`codex exec` 的結束輸出含 token usage，但**不含 reasoning effort**。
- **未驗證 / 缺口**：`orca orchestration worker-show --dispatch <id> --json` 的
  輸出未經驗證包含 `reasoning_effort`；不得假設它有。
- **缺口**：沒有已驗證的 non-interactive 命令能回報「這個 worker 實際以什麼
  reasoning effort 執行」。

因此 attestation 步驟為 best-effort：能讀到 `/status` 就比對；讀不到就把
`attestation_result` 記為 `DISPATCH_IDENTITY_UNVERIFIED` 並依 `WORKFLOW_POLICY.md` 的
Execution lifecycle semantics 處置，**不得**標為 `ROUTING_UNAVAILABLE`，也**不得**
假裝比對通過。若任一已知欄位不符，則為 `DISPATCH_CONTRACT_MISMATCH`。

值得提出的 upstream feature request：**Expose the launched agent's resolved
provider / model / reasoning-effort in `worker-show --json` and in a
non-interactive per-terminal query.**

### Scoped worker capabilities（觀察到的機制）

實測：新的 Orca worker **不繼承** Router process / user-scope 變數；
`orca orchestration worker-start` 與 `orca terminal create` **沒有**直接的
env injection 旗標；已安裝的 Orca environment recipe 也沒有安全通用的
secret-bearing process-env 注入。可用的 fulfillment mechanism 由 project /
runtime policy 決定——`ENV_INJECTION`（`orca environment ...` /
`orca vm recipe doctor`；`orca --help` 的 Environments / Environment Recipes）
只是其中一種；`CAPABILITY_WRAPPER` / `SECRET_BROKER` / `REMOTE_EXECUTOR` 可以在
worker 從不拿到 credential 的前提下滿足能力。無論哪種，secret **一律**經
approved mechanism 供裝，**不得**在 `dispatch_command` 或 prompt 傳。語意見
[`../policies/WORKFLOW_POLICY.md`](../policies/WORKFLOW_POLICY.md) 的
*Scoped worker capabilities*。

### Worker result recovery（callback transport 失敗）

worker 完成 domain 工作但因環境內沒有 Orca CLI 而送不出 `worker_done` 時，
Operational Router 以 control-plane inspection 回收既有結果，**不 redispatch**：

```bash
orca orchestration worker-show --dispatch <dispatch_id> --json
orca orchestration worker-read --dispatch <dispatch_id> --limit <bounded_n> --json
```

`worker-read` 只用於回收 / 檢視既有結果，`--limit` 必須 bounded；transport 正常時
不得拿它替代 `worker_done`。回收優先序與 `FAILED_RECOVERED` 語意見
[`../policies/WORKFLOW_POLICY.md`](../policies/WORKFLOW_POLICY.md) 的
*Worker result recovery*。

讀取輸出（已於本機驗證）：

```bash
orca terminal read --terminal <handle> --json
orca terminal read --terminal <handle> --cursor <n> --limit 1000 --json
```

`orca terminal read` 在 1.4.192 上確實同時提供 cursor read 與畫面讀取，且 help 明載兩者互斥。
**預設使用 `--json` 搭配 cursor read**：畫面讀取只有當前畫面、沒有歷史，無法分頁。

PROHIBITED: 不要把 `--screen` 當成預設讀取方式；它沒有歷史，會漏掉已捲離畫面的輸出。

新的獨立 worktree：

```bash
orca worktree create --name <task-name> --no-parent --agent <id> --prompt "<task brief>" --json
```

Worktree metadata 與狀態：

```bash
orca worktree current --json
orca worktree set --worktree active --comment "<text>" --workspace-status in-progress --json
```

`--workspace-status` 的預設 id 為 `todo`、`in-progress`、`in-review`、`completed`。

### 已知限制

`orca terminal stop` 只接受 `--worktree`，**沒有 per-terminal 選項**。在自己的 terminal
所在的 worktree 執行會連自己一起停止。Router 無法只收掉單一 worker terminal；
需要清理時交由人在 Orca UI 關閉該 tab。

### Terminal lifecycle 與 cleanup 的 runtime 邊界

[`policies/WORKFLOW_POLICY.md`](../policies/WORKFLOW_POLICY.md) 的
Session lifecycle and cleanup 定義了 `ACTIVE` / `PARKED` / `SUPERSEDED` /
`STALE` / `FAILED` / `CLOSED` 六個 lifecycle state 與對應的 `CLOSE` / `PARK` /
`KEEP` 動作。這是政策層的分類，**不是** Orca runtime 已提供的能力——兩者要分開看：

**目前已驗證、可用的部分：**

- 用上方 `orca terminal create` / `wait` / `read` / `send` 追蹤單一 terminal 的
  執行狀態（對應 Execution lifecycle semantics 的觀察狀態）。
- 用 `orca worktree set --workspace-status` 記錄整個 worktree 的進度標籤。
- 用 handoff / contract 文件人工記錄 lifecycle state、`human_instruction_revision`、
  `objective_fingerprint`、`permission_scope_fingerprint` 等綁定 metadata——
  Terminal inventory（見 `WORKFLOW_POLICY.md` 的 Terminal inventory 一節）目前
  只能由 operational router 自行維護，因為 Orca **沒有已驗證的 per-terminal
  list/enumerate 介面**。

**目前不存在、需要 upstream 支援的部分：**

- **per-terminal close/kill**：`orca terminal stop` 只有 worktree scope，沒有
  per-terminal 選項。缺少這個能力時，`CLOSE` 動作在多 terminal 的 worktree 中
  無法只由 router 自動完成，必須降級為「標記 lifecycle state 為 `CLOSED` 並
  交由人在 UI 關閉該 tab」，或等到同一 worktree 內其他 terminal 都已安全結束
  後再用 worktree-scope 的 `stop`。
- **terminal list/inventory**：沒有已驗證的命令可列出目前所有
  active/parked terminal 供 router 核對 Terminal inventory。

期望介面（尚不存在，僅記錄需求，不得當成已支援的命令使用）：

```bash
orca terminal stop --terminal <handle> --json   # 尚不存在，per-terminal close/kill
orca terminal list --json                        # 尚不存在，read-only inventory
```

這是值得提出的 upstream feature request：**Expose a per-terminal
close/kill command, and a read-only terminal-list/inventory command, both as
JSON.** 在它們存在之前，**不得**假造這些命令的旗標或行為；`CLOSE` 動作的
實際執行路徑維持上方 Session lifecycle and cleanup 所述的「標記狀態 + 人工
或 worktree-scope 收尾」，不得宣稱已完成 router 無法真正執行的清理。

**Orca 目前沒有 read-only 的 quota / rate-limit CLI 介面。** `orca status --json`
回報 app、runtime、capabilities，但不含 normalize 後的 rate-limit 狀態。因此
`RESOURCE_STATE` 目前只能由 `USER_STATEMENT` 或 `UNKNOWN` 填充，無法自動取得
`ORCA_RUNTIME` 這個 HIGH trust 來源。

理想的上游介面是把 normalize 後的 RateLimitService 狀態以唯讀 JSON 暴露出來，例如：

```bash
orca rate-limits --json          # 尚不存在，僅為期望介面
orca status --json               # 或把 rate limit 併入現有輸出
```

這是值得提出的 upstream feature request：**Expose normalized RateLimitService
state as read-only CLI JSON.** 它符合 `RESOURCE_AWARE_ROUTING.md` 對
`ORCA_RUNTIME` 的信任條件——不需要 credential access、只需記憶體內狀態——
因此能在不觸碰 credential 的前提下讓 routing 拿到可信 quota。

在該介面存在之前，**不得**以任何需要 credential 的方式取得 quota 來冒充 HIGH trust。

Structured DAG / stateful coordination：見
https://github.com/stablyai/orca/blob/main/skill-guides/orchestration.md

---

## OpenAI Codex CLI

Primary: https://help.openai.com/en/articles/11096431 、 https://github.com/openai/codex

模型與 reasoning：

```bash
codex -m <model>
codex --model <model>
codex -c 'model_reasoning_effort="medium"'
```

### Reasoning effort 一律在命令列明確傳入

`provider + model + model_family + reasoning_effort` 是 execution identity（見
[`../policies/MODEL_ROUTING_POLICY.md`](../policies/MODEL_ROUTING_POLICY.md) 的
*Reasoning effort is part of execution identity*）。Codex 的 dispatch **一律**同時
明確傳入 `-m <model>` 與 `-c 'model_reasoning_effort="<value>"'`，即使該值等於 registry
預設。

原因（實測 2026-09-02）：`~/.codex/config.toml` 若含 `model_reasoning_effort = "max"`，
任何**未在命令列明示** effort 的 `codex` / `codex exec` 呼叫都會靜默以 `max` 執行，
與 contract 意圖不符。這是 `ROUTER_DROPPED_REASONING` + `CODEX_LOCAL_CONFIG_OVERRIDE`
兩個問題的組合。`-c` 覆寫優先於 `config.toml`。

Registry 目前使用的 effort 值：`low`、`medium`、`high`、`max`。`max` 已在本機
`config.toml` 出現、且 `/status` 面板會顯示 `reasoning max`，因此視為受支援；其餘值
在自動化前仍以已安裝 CLI 重新確認，**不得猜測未驗證的值**。

逐字範例（non-interactive，contract 由 stdin 餵入）：

```bash
# Luna max（Stage 1 workhorse）
codex exec -m gpt-5.6-luna -c 'model_reasoning_effort="max"' \
  -s workspace-write --ask-for-approval on-request --color never -o <last-message-file> -

# Terra high（Stage 2 advanced）
codex exec -m gpt-5.6-terra -c 'model_reasoning_effort="high"' \
  -s workspace-write --ask-for-approval on-request --color never -o <last-message-file> -

# Sol medium（Stage 3 flagship — 絕不預設 max）
codex exec -m gpt-5.6-sol -c 'model_reasoning_effort="medium"' \
  -s read-only --ask-for-approval on-request --color never -o <last-message-file> -
```

Interactive terminal 啟動時同樣要帶 `-m` 與 `-c model_reasoning_effort`，因為
`orca terminal create --command` 之後的 inject 只送 task 文字，不送模型設定（見下方
Orca 一節）。

非互動式執行（本機驗證可用，contract 由 stdin 餵入）：

```bash
codex exec -m <model> -c 'model_reasoning_effort="<effort>"' \
  -s workspace-write --color never -o <last-message-file> -
```

Sandbox（`-s` / `--sandbox`）可用值：`read-only`、`workspace-write`、`danger-full-access`。
Approval（`-a` / `--ask-for-approval`）含 `on-request`、`never`。

保守權限：

```bash
codex --sandbox read-only --ask-for-approval on-request        # discovery / review
codex --sandbox workspace-write --ask-for-approval on-request  # implementation
```

**`--sandbox read-only` 不是「不得執行命令」。** 它允許執行命令但禁止寫入檔案系統，
這正是 reviewer 需要的組合：`git status`、`git diff`、`rg`、`cat` 都要執行命令才能完成。
`--ask-for-approval on-request` 會讓部分命令逐條要求人工核准；**核准一條唯讀命令
不會提高 permission ceiling**，能力分解見
[`policies/WORKFLOW_POLICY.md`](../policies/WORKFLOW_POLICY.md)。

PROHIBITED: `approval_policy = "untrusted"` 已不再是有效值，不要出現在任何範例中。
PROHIBITED: 不要使用 `--dangerously-bypass-approvals-and-sandbox`，除非外層已有獨立沙箱且經人核准。

### 重要：本機設定會靜默覆蓋

`~/.codex/config.toml` 的 `model`、`sandbox_mode` 與 `approval_policy` 會在命令列
未明示時生效。派工時**必須在命令列明確傳入** `-m` 與 `-s`，否則實際使用的模型與權限
可能與 contract 意圖不符。這是 `WORKFLOW_POLICY.md` 要求 `dispatch_command` 逐字記錄的原因。

### Model ID

`gpt-5.6-luna`、`gpt-5.6-sol`、`gpt-5.6-terra` 出現在已安裝 CLI 的本機 global state 中。
這是 **provisional-local** 佐證，不是權威的 model discovery endpoint——Codex CLI 未提供
等同 `agy models` 的列表命令。維持 `evidence_status: provisional`，見
`references/MODEL_EVIDENCE.md`。

---

## Claude Code

Official: https://docs.anthropic.com/en/docs/claude-code/cli-usage

```bash
claude --model sonnet
claude --model opus
claude --permission-mode plan
claude -p "query" --output-format json
claude -p --max-turns 3 "query"
```

### Reasoning effort（Claude Code）

`Claude Code 2.1.258` 的 `--help` 列出 `--effort <level>`，本機實測可用值：
`low`、`medium`、`high`、`xhigh`、`max`。這是 **session-level effort**，是這個 CLI
暴露出來的機制——不是原始 API 的 `reasoning_effort` 參數，但它就是 dispatch 時可控的
旋鈕。

```bash
claude --model sonnet --effort high     # Stage 2 advanced
claude --model opus   --effort medium   # Stage 3 flagship 預設；有 task 證據才 --effort high
```

Registry 對 Claude 候選的 `reasoning:` 值直接對應此旗標；`provider_default` 表示
「不傳 `--effort`，用 CLI 預設」，僅用於不需要精確控制的 discovery fallback。
**不得**假裝 Claude 的 effort 名稱與 Codex 的 `model_reasoning_effort` 值語意等價——
兩者各自以自己 CLI 支援的方式表達，registry 分別記錄。

`--permission-mode` 本機實測可用值：`acceptEdits`、`auto`、`bypassPermissions`、
`manual`、`dontAsk`、`plan`。

Discovery 與 review 用 `plan`；需要人確認每一步時用 `manual`。

`--max-turns` 設的是**回合預算**。用盡時 session 以 `Reached max turns` 結束，
這是 execution budget exhaustion，**不是錯誤結果、不是 timeout、不是 permission
denial、也不是 routing failure**。可恢復時在同一條 chain 上 bounded continuation，
不重跑整輪 discovery；分類與續跑上限見
[`policies/WORKFLOW_POLICY.md`](../policies/WORKFLOW_POLICY.md) 的
Execution lifecycle semantics。

`--permission-mode plan` 同樣不等於禁止執行唯讀命令；它限制的是變更，不是檢查。

PROHIBITED: 不要把 `--dangerously-skip-permissions` 或 `--permission-mode bypassPermissions`
當成預設；兩者都會關閉權限檢查。

---

## Google Antigravity CLI

Official announcement: https://developers.googleblog.com/en/an-important-update-transitioning-gemini-cli-to-antigravity-cli/
Official codelab: https://codelabs.developers.google.com/antigravity-cli-hands-on

Executable：`agy`

```bash
agy models
agy --model "<model id>"
agy --effort "<low|medium|high>"
agy -p "<prompt>"
agy --print "<prompt>"
```

**一律以 `agy models` 作為 live model source，不得永久寫死 display name。**

### Reasoning effort（Antigravity / Gemini）

實測 2026-09-02，`agy 1.1.23`；model list 重新實測 2026-09-03，`agy 1.1.24`：

- Effort 同時以**兩種方式**表達：model id 內嵌（`agy models` 目前列出
  `gemini-3.8-flash-{high,medium,low}`、`gemini-3.7-flash-{high,medium,low}`、
  `gemini-3.6-flash-{high,medium,low}`、`gemini-3.1-pro-{high,low}` 等家族，
  由新到舊排列）以及 session 旗標 `--effort low|medium|high`。
- **2026-09-03 新增：`gemini-3.8-flash-low` 與 `-high` 已實測可直接 dispatch**
  （`agy -p "<prompt>" --model gemini-3.8-flash-<effort>`），回應正確自報
  `Gemini 3.8 Flash` / `Google Gemini`。3.7 家族仍在清單中、仍可解析，未被移除。
- Registry 的 `AUTO_GEMINI` **依 `agy models` 當下的即時清單解析**，不寫死任何一個
  版本字串——`reasoning: low` 解析到清單中對應 effort 的 Gemini Flash 家族 entry，
  `reasoning: high` 同理。這代表 3.7 → 3.8 的世代更新**不需要修改
  `MODEL_REGISTRY.yaml` 的任何 `model:` 欄位**：`AUTO_GEMINI` 本來就會在下一次
  dispatch 時解析到當下清單最新的家族。dispatch 時仍要傳明確的已解析 model id，
  或 `--model <family> --effort <level>`，不得假設哪個版本永遠是清單第一名。
- **2026-09-03 起清單同時列出多個世代**（`3.8` / `3.7` / `3.6` / `3.1`），
  過去只有單一世代時「符合 effort 的 entry」不會有歧義；現在必須明確規則：
  `agy models` 依觀察是新到舊排列，**取符合該 effort 的第一筆（即當下最新世代）**。
  不得任意選到舊世代，也不得因為清單變長就整段退化成 `UNKNOWN`。
- `agy -p`（headless / print mode）**對需要 `command` 權限的工具 fail closed**：
  實測任何在 headless 下要讀檔的呼叫都被 auto-deny（訊息：*"a tool required the
  'command' permission that headless mode cannot prompt for"*）。因此 read-only
  reviewer / repo discovery 這類 dispatch **無法**只靠 `agy -p` 完成，需要 interactive
  per-call 核准，或事先在 `settings.json` 的 `permissions.allow` 放 scoped allow-rule。
  用 approval-bypass 旗標可以繞過，但那對 read-only 合規驗證沒有意義。這是 Gemini
  目前在本 pack 維持 `status: experimental` 的具體 blocker，記於
  [`MODEL_EVIDENCE.md`](MODEL_EVIDENCE.md)。
- `agy --mode plan` 是 read-only 模式，但**不解除**上述 headless 權限限制。

### 重要：Antigravity 會提供非 Gemini 模型

2026-09-01 本機 `agy models` 同時列出 Gemini 與其他家族的模型（包含 Claude 家族與
開源模型）。因此：

- `provider: antigravity` **不等於** `model_family: gemini`；
- independent review 的 disjointness **必須同時比對 provider 與 model family**，
  只比 provider 會讓「不同 provider 但同一模型家族」的組合矇混過關；
- registry 中 `AUTO_GEMINI` 的 resolver 必須解析到 Gemini 家族的 ID，
  解析結果若不屬於宣告的 `model_family`，該候選即為 `CONFIG_INVALID`。

---

## GitHub CLI

Manual: https://cli.github.com/manual/gh_repo_create 、 https://cli.github.com/manual/

```bash
gh --version
gh auth status
gh repo view <owner>/<repo> --json name,owner,visibility,defaultBranchRef,url
gh repo create <owner>/<repo> --public --source . --remote origin --push
```

`gh repo create` 語法為 `gh repo create [<name>] [flags]`；省略 `OWNER/` 時預設為
已登入使用者。`--source` 指定本機來源目錄，`--remote` 指定 remote 名稱，`--push`
推送既有 commit。以上旗標已對照官方 manual 與本機 `--help`，兩者一致。

**不要在任何 artifact 中記錄 `gh auth status` 的 token 欄位。** 只記錄「認證有效」
這個事實。

---

## OpenUsage

Primary: https://github.com/robinebers/openusage

Native app 目前要求 macOS 15+。作為 quota discovery 的參考實作，**不得假設可直接在
Windows 安裝**，也不是穩定流程的前置條件。見 `experiments/openusage-windows/README.md`。
