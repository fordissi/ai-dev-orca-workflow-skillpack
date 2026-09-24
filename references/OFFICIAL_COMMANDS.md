# Official / Primary Command Reference

Local `--help` verified: **2026-09-01**; reasoning / dispatch / attestation
section re-verified **2026-09-02** against `codex-cli 0.151.0`,
`Claude Code 2.1.258`, `agy 1.1.23`, `orca 1.4.194`; Antigravity model list
re-verified **2026-09-03** against `agy 1.1.24` — `gemini-3.8-flash-{low,
medium,high}` now resolves and dispatches (see the Antigravity section below).
Orca orchestration re-verified **2026-09-24** against `orca 1.4.209` using the
installed `orca skills get orchestration --full`, local `--help`, and two bounded
live `worker-start` probes (Codex, Antigravity) — see the Orca section.

Provider-native **resource probe** invocations (Codex `/status`, Claude
`/usage`, Antigravity `agy --print "/usage" --output-format json`) — verified
account/session state, quota fields observable, and blockers — live in
[`RESOURCE_PROBES.md`](RESOURCE_PROBES.md); the acquisition precedence,
source-trust rules, and the **provider-native quota probe vs `orca account
list` integration-visibility** separation are in
[`../policies/RESOURCE_AWARE_ROUTING.md`](../policies/RESOURCE_AWARE_ROUTING.md).
`orca account list` is integration evidence only — never a quota source.

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
| Orca runtime | 1.4.209 | `orca status --json` 的 `runtime.appVersion`（2026-09-24 重新驗證 orchestration；原記錄 1.4.192） |
| Codex CLI | 0.151.0 | `codex --version` |
| Claude Code | 2.1.252 | `claude --version` |
| Antigravity CLI | 1.1.24 | `agy --version`（重新驗證 2026-09-03；先前記錄 1.1.22） |
| GitHub CLI | 2.92.0 | `gh --version` |

---

## Orca

**來源優先序**（命令行為衝突時以 installed runtime 為準）：

```text
1. orca skills get orchestration --full     ← 與已安裝版本配對的完整 guide
2. orca orchestration <verb> --help
3. https://www.onorca.dev/docs/cli/orchestration
4. 本 pack 的快取文件（本檔、WORKFLOW_POLICY.md）
```

本節依 **orca 1.4.209**（2026-09-24）重新驗證。Normative 協議（wait / worker_done /
ask / follow-up / recovery）見 [`../policies/WORKFLOW_POLICY.md`](../policies/WORKFLOW_POLICY.md)
的 `ORCA_WORKER_DISPATCH_REQUIRED` 與 *Orca orchestration 協議*；本節只記命令與實測。

### Supervised worker（預設路徑）

```bash
orca status --json
orca orchestration run-create --objective "<objective>" --json
orca orchestration worker-start --spec "<self-contained task>" --worktree current \
  --agent codex --model <model> --effort <effort> --json          # 或 --task <task_id>
orca orchestration check --wait --types "worker_done,escalation,question" --timeout-ms 900000 --json
orca orchestration worker-release --dispatch <dispatch_id> --json   # 結算後三擇一之一
orca orchestration check --ack <delivery_id> --json
```

Task spec 必須自足並寫明 Target / Change / Constraints / Ownership / Observable
acceptance。`--spec` 一次建立 Task 與其 attempt；有相依或重試已知 Task 時用
`task-create` + `worker-start --task <id>`。`worker-start` 只有 `ready` 才 exit 0。

`--help` 明載：`--model` 支援 Claude / Codex / Cursor 的 opaque model id；`--effort`
需要 `--model`；兩者不能與 `--terminal` 併用。

#### Live probe（2026-09-24，orca 1.4.209）

**Codex** — `worker-start --agent codex --model gpt-5.6-luna --effort low`：

```json
"launch": {
  "requested": { "agent": "codex", "model": "gpt-5.6-luna", "effort": "low" },
  "effective": { "agent": "codex", "model": "gpt-5.6-luna", "effort": "low" }
}
```

回條另含 `runId`、`taskId`、`dispatchId`、`state: "ready"`、`stage:
"input_accepted"`、`mode.mode: "terminal"`、`effects[]`（worktree reused、terminal
created、dispatch_input accepted）、`residualResources: []`。worker 送回的
`worker_done` 的 `payload` 是 JSON 字串
`{"taskId":…,"dispatchId":…,"outcome":"succeeded"}`；`check --wait` 收到後
`worker-release` 回 `state: "released"`、`processAction: "closed_agent_terminal"`、
`archive.source: "transcript"`，Task 自動為 `completed`。

**Antigravity** —

| 嘗試 | 結果 |
|---|---|
| `--agent antigravity --model gemini-3.8-flash-low --effort low` | `invalid_argument`：*Agent antigravity does not support launch-time model selection* |
| `--agent gemini --model …` | 同上（`gemini` 是已知 agent id） |
| `--agent agy …` | `agent_unconfigured`（`agy` 不是 agent id） |
| `--agent antigravity`（不帶 model） | 啟動成功、照協議送回 `worker_done`；但 `launch.effective.model = null`，`archive.source: "terminal"`（無 hook transcript） |

結論：`worker-start` 可以跑 Antigravity worker，但**無法表達也無法證明** exact
Antigravity model；exact routing 走 `CUSTOM_DISPATCHED_WORKER`。Support matrix 記在
[`../policies/MODEL_REGISTRY.yaml`](../policies/MODEL_REGISTRY.yaml) 的
`runtime_adapters.<x>.orca_worker_start`。`claude_cli` 依 `--help` 為 supported，
尚未在本機 live probe。

### Custom dispatched worker（`worker-start` 表達不了時）

```bash
orca terminal create --worktree active --title "<task>" --command "agy --model <id> [--effort <e>]" --json
orca terminal wait --terminal <handle> --for tui-idle --timeout-ms 60000 --json   # 只為 TUI ready
orca orchestration task-create --spec "<self-contained task>" --task-title "<title>" --json
orca orchestration dispatch --task <task_id> --to <handle> --inject --json
```

`dispatch --inject` 建立 authoritative 的 Task/Dispatch 並注入 preamble，worker 以
`worker_done` 結算；但 orca 對這條 lane 的 process 資源列顯示 `unsupervised`：
`worker-stop` / `worker-abandon` 不會關掉該 process，settled 的 retain/release 不做
process action——terminal 的收尾由 operator 負責。需要 lifecycle ownership 時用
`worker-start --terminal <handle>`（此時不能帶 `--model`）。`inject_rejected` 表示目標
terminal 沒有被辨識的 agent。

### `--timeout-ms` 是輪詢窗口，不是 worker 的完成期限

`orca terminal wait` 在本 pack 只用於 custom topology 的 **TUI-ready** 等待；worker
completion 一律 `orchestration check --wait`。任何 wait 的逾時都只表示
「醒來重新觀察一次」，不是失敗，也不是 worker 的期限。語意見
[`policies/WORKFLOW_POLICY.md`](../policies/WORKFLOW_POLICY.md) 的
Execution lifecycle semantics。

### Lightweight terminal prompt（不是 worker）

```bash
orca terminal create --worktree active --title "<task>" --command "codex" --json
orca terminal send --terminal <handle> --text "<prompt>" --enter --json
```

沒有 Task、沒有 Dispatch、沒有 `worker_done` 權限。只適用於不屬 Orca worker 的輕量
terminal 操作；拿它充當 Orca worker 是 `LIGHTWEIGHT_TERMINAL_PROMPT_AS_ORCA_WORKER`。

### Dispatch path classification

| Path | Classification | Condition |
|---|---|---|
| `orca orchestration worker-start --agent --model --effort` | `EXACT_IDENTITY_PRESERVED` / `WORKER_START` | runtime 的 `orca_worker_start.launch_model_selection = supported`，且回條 `launch.effective` 與 contract 相符；`launch.requested` 單獨不算 |
| `orca orchestration worker-start --agent antigravity` | `DEFAULT_FALLBACK_RISK` | 不接受 `--model`、`effective.model = null`，只能跑 runtime 預設模型 |
| operator terminal（exact argv）+ TUI ready + `dispatch --inject` | `EXACT_IDENTITY_PRESERVED` / `CUSTOM_DISPATCHED_WORKER` | terminal command 含 provider 支援的 exact model / effort 旗標、inject 被接受、並完成 runtime attestation |
| `orca orchestration dispatch --inject` 到來歷不明的既有 terminal | `DEFAULT_FALLBACK_RISK` | 只注入 task；既有 terminal 的四欄 identity 未證明 |
| `orca worktree create --agent` | `DEFAULT_FALLBACK_RISK` | agent-first convenience path 不接收 custom model / effort；且這是 ownership handoff，不是 supervised worker |
| `terminal create` + `terminal send` | `LIGHTWEIGHT_TERMINAL_PROMPT` | 沒有 Task/Dispatch；不得作為 Orca worker |
| Codex direct invocation | `EXACT_IDENTITY_PRESERVED` | `-m <model>` 與 `-c 'model_reasoning_effort="<effort>"'` 均明確傳入並完成 attestation；任一省略即 `DEFAULT_FALLBACK_RISK` |
| Claude direct invocation | `EXACT_IDENTITY_PRESERVED` | `--model <model>` 與 `--effort <level>` 均明確傳入並完成 attestation；任一省略即 `DEFAULT_FALLBACK_RISK` |
| Antigravity / `agy` direct invocation | `EXACT_IDENTITY_PRESERVED` | resolver 先由 live `agy models` 得到 exact model 與該 model 的 effort mode，再完成 attestation：(A) `ID_SUFFIX` 等可用 effort 的 model 必須明確傳 `--model <id> --effort <受支援值>`；(B) adapter 宣告 effort mode `NONE` 的 model（Antigravity Claude 4.6）必須以 `reasoning_effort: provider_default` 傳 `--model <id>` 且**不得**帶 `--effort`。其他情況（未宣告 `NONE` 卻省略 `--effort`）為 `DEFAULT_FALLBACK_RISK`；`NONE` 卻帶 `--effort` 為 `DISPATCH_CONTRACT_MISMATCH` |
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

**與上游 guide 的一處刻意差異：** orca guide 建議「只有使用者指名模型時才傳
`--model`，否則讓 worker 用使用者的 agent 預設」。本 pack 一律傳 exact model，因為
`MODEL_REGISTRY.yaml` 是使用者權威設定——routing 選出的 candidate 就是使用者指名的
模型；省略 `--model` 會讓 local config 靜默決定模型（見 Codex 的 local-config 覆蓋）。

### Runtime attestation（能力與缺口）

Dispatch 後要驗證 worker 實際的 `provider` / `model` / `model_family` /
`reasoning_effort` 是否等於 contract。

- **可用（supervised worker）**：`worker-start` 回條的 `launch.effective`
  （orca 1.4.209 live probe 已驗證於 Codex）。這是 `WORKER_START` 的 attestation
  證據；**永遠不得**只憑 `launch.requested` 宣稱模型或 effort。
- **不可用**：Antigravity 經 `worker-start` 時 `launch.effective.model = null`。
- **可用（custom / direct）**：Codex interactive session 的 `/status` 面板會印出
  `Model: <id> (reasoning <effort> ...)`；以 `orca orchestration worker-read
  --dispatch <id> --source auto` 或 `orca terminal read` 取回比對（注意 Git-Bash 的
  `MSYS_NO_PATHCONV=1`）。`codex exec` 的結束輸出含 token usage，但不含 effort。

讀不到就把 `attestation_result` 記為 `DISPATCH_IDENTITY_UNVERIFIED` 並依
`WORKFLOW_POLICY.md` 處置，**不得**標為 `ROUTING_UNAVAILABLE`，也**不得**假裝比對
通過。若任一已知欄位不符，則為 `DISPATCH_CONTRACT_MISMATCH`。

值得提出的 upstream feature request：**Report `launch.effective` model/effort for
agents that do not accept launch-time model selection (e.g. Antigravity), from the
agent's own configured model.**（runtime 已宣告 `git.antigravity-configured-model.v1`
capability，但 orchestration 回條尚未反映。）

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
orca orchestration worker-list --run <run_id> --include-remote --json
orca orchestration worker-show --dispatch <dispatch_id> --json
orca orchestration worker-read --dispatch <dispatch_id> --source auto --limit <bounded_n> --json
```

`--source auto` 在有 hook transcript 時讀 transcript（Codex probe：`transcript`），否則回
帶 `fallbackReason` 的 terminal 輸出（Antigravity probe：`terminal`）；回傳的 cursor
綁定該 source，遇到 `source_changed` 須不帶舊 cursor 重讀。release 後輸出已封存，仍可
用 `worker-read` 讀取——不要只為了看輸出而保留 terminal。

`worker-read` 只用於回收 / 檢視既有結果，`--limit` 必須 bounded；transport 正常時
不得拿它替代 `worker_done`。回收優先序與 `FAILED_RECOVERED` 語意見
[`../policies/WORKFLOW_POLICY.md`](../policies/WORKFLOW_POLICY.md) 的
*Worker result recovery*。

Custom / lightweight terminal 的讀取輸出（已於本機驗證）：

```bash
orca terminal read --terminal <handle> --json
orca terminal read --terminal <handle> --cursor <n> --limit 1000 --json
```

`orca terminal read` 自 1.4.192 起同時提供 cursor read 與畫面讀取，且 help 明載兩者互斥。
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

### Terminal lifecycle、inventory 與 cleanup（orca 1.4.209）

[`policies/WORKFLOW_POLICY.md`](../policies/WORKFLOW_POLICY.md) 的
Session lifecycle and cleanup 定義了 `ACTIVE` / `PARKED` / `SUPERSEDED` /
`STALE` / `FAILED` / `CLOSED` 六個 lifecycle state 與 `CLOSE` / `PARK` / `KEEP`
動作。先前記為「尚不存在」的 per-terminal close 與 inventory，在 1.4.209 都已提供；
**用哪一個取決於 terminal 歸誰**：

| Terminal 歸屬 | Inventory | 收尾 |
|---|---|---|
| `WORKER_START`（supervised） | `orca orchestration worker-list --run <run_id> [--include-remote] --json`；`--terminal-state reclaimable` 列出仍欠決定者 | 結算後三擇一：reuse（`worker-start --task <next> --terminal <handle>`）、`worker-retain --dispatch <id>`、`worker-release --dispatch <id>`。**不得**以 `terminal close` 代替 release；回條 `release_pending` / `release_unknown` 時照回條處置 |
| `CUSTOM_DISPATCHED_WORKER`（operator-owned） | `worker-list` 顯示該 lane 為 `unsupervised`；terminal 本身用 `orca terminal list --json` | 已接受的 `worker_done` 之後，由 operator `orca terminal close --terminal <handle> [--tab] --json`（`worker-release` 對它不做 process action） |
| `LIGHTWEIGHT_TERMINAL_PROMPT` / 其他 operator terminal | `orca terminal list [--worktree <sel>] --json` | `orca terminal close --terminal <handle> [--tab] --json` |

```bash
orca terminal list --json                                   # live Orca-managed terminals
orca terminal close --terminal <handle> --json              # 單一 pane/session
orca terminal close --terminal <handle> --tab --json        # 整個 tab
orca terminal close --worktree <selector> --all --json      # 整個 workspace（破壞性）
```

`--worktree <sel> --all` 會停掉該 workspace 的**所有** terminal process 並移除 resume
紀錄——在自己所在的 worktree 執行會連 coordinator 一起關掉；只在確定整個 workspace
都該收時使用。需要之後續用的 terminal 與 agent session 用 workspace Sleep，不用 close。
先前版本的 `orca terminal stop`（只有 worktree scope）已不在 1.4.209 的命令清單中。

仍由 operational router 以 handoff / contract 記錄的 binding metadata：
`human_instruction_revision`、`objective_fingerprint`、`permission_scope_fingerprint`
（見 `WORKFLOW_POLICY.md` 的 Terminal inventory）；`terminal list` 與 `worker-list`
提供 live inventory，但不提供這些 fingerprint。

**Orca 目前沒有 read-only 的 quota / rate-limit CLI 介面。** `orca status --json`
回報 app、runtime、capabilities，但不含 normalize 後的 rate-limit 狀態。因此
`RESOURCE_STATE` 目前只能由 provider-native probe、`USER_STATEMENT` 或 `UNKNOWN`
填充，無法自動取得 `ORCA_RUNTIME` 這個 HIGH trust 來源。

**`orca account list --json` 不是 quota 來源。** 它回報 Orca 對某個 provider
integration 的 **visibility**（看得到 / 能不能啟動），不含任何 quota 數值。
它 unavailable **不等於** 該 provider 的 quota 耗盡或不可 dispatch——先跑
provider-native probe（Codex `/status`、Claude `/usage`、
`agy --print "/usage" --output-format json`）。分開追蹤
`provider_resource_state` 與 `orca_integration_state`，語意見
[`../policies/RESOURCE_AWARE_ROUTING.md`](../policies/RESOURCE_AWARE_ROUTING.md)
的 *Provider-native quota probe precedence*。

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

Structured DAG / stateful coordination：以 `orca skills get orchestration --full`
（與已安裝版本配對）為準；上游網頁版：https://www.onorca.dev/docs/cli/orchestration

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
claude --model haiku
claude --permission-mode plan
claude -p "query" --output-format json
claude -p --max-turns 3 "query"
```

### Model aliases（Claude Code）

2026-09-18 本機（Claude Code 2.1.276）互動 model picker：`Sonnet → Sonnet 5`、
`Opus → Opus 5`、`Haiku → Haiku 4.5`。`--model` **只傳 catalog alias**：

| Routing intent | `--model` |
|---|---|
| routine / default | `sonnet` |
| complex / high-quality | `opus` |
| quick / cheap | `haiku` |

`claude --model sonnet-5` 會被當成 custom model 並回
`"sonnet-5" isn't described by this version's model catalog`——這是
`MODEL_UNKNOWN`，不是 provider 不可用。版本化 id 只有在 registry
`resolvers.claude_models.model_overrides` 有 human 審閱過的對應時才可 dispatch；
**不得由 display name 推導**。

### Authentication（pre-dispatch auth probe）

本機 `--help` 驗證（Claude Code 2.1.276、codex 同日）：

```bash
claude auth status --json   # 非互動 probe；讀 loggedIn，不讀／不記錄任何 credential 欄位
claude auth login           # reviewed 互動登入命令：交給 human 執行，Router 不代跑
codex login status          # 非互動 probe
codex login                 # reviewed 互動登入命令
```

`agy` 的 `--help` 沒有 login / auth 子命令：Antigravity 沒有 reviewed 登入命令，
auth 失敗時回報 `AUTH_*` 並交 human，不猜命令。

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
agy --print "/usage" --output-format json --print-timeout <duration>   # quota probe
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
- **例外（實測 2026-09-04）：`agy --print "/usage" --output-format json
  --print-timeout <duration>` 可在 headless 下回傳有效 quota**——`command` 權限的
  fail-close 擋的是 headless dispatch 要用的 file/command 工具，不擋 `/usage`
  這個 slash command 本身。因此 quota probe 首選這個 headless 形式，
  `orca terminal` interactive 路徑作 fallback。這**不改變** reviewer /
  repo-discovery dispatch 仍受上一點限制的事實，也不改變 Gemini 的
  `status: experimental`。
- `agy --mode plan` 是 read-only 模式，但**不解除**上述 headless 權限限制。

### 重要：Antigravity 會提供非 Gemini 模型

2026-09-01 本機 `agy models` 同時列出 Gemini 與其他家族的模型（包含 Claude 家族與
開源模型）。因此：

- `provider: antigravity` **不等於** `model_family: gemini`；
- independent review 的 disjointness **必須同時比對 provider 與 model family**，
  只比 provider 會讓「不同 provider 但同一模型家族」的組合矇混過關；
- registry 中 `AUTO_GEMINI` 的 resolver 必須解析到 Gemini 家族的 ID，
  解析結果若不屬於宣告的 `model_family`，該候選即為 `CONFIG_INVALID`。

### Runtime model catalog（實測 2026-09-18）

`agy models` 每行 `<id>\t<display>`，與互動 `/model` picker 一致：

| Picker display | id(s) | provider family | effort |
|---|---|---|---|
| Gemini 3.8 / 3.7 / 3.6 Flash | `gemini-3.x-flash-{high,medium,low}` | gemini | id 後綴 |
| Gemini 3.1 Pro | `gemini-3.1-pro-{high,low}` | gemini | id 後綴（**無 medium**） |
| Claude Sonnet 4.6 (Thinking) | `claude-sonnet-4-6` | claude | **不接受 `--effort`**（live 驗證） |
| Claude Opus 4.6 (Thinking) | `claude-opus-4-6-thinking` | claude | 不接受 `--effort`（同形，未 probe） |
| GPT-OSS 120B (Medium) | `gpt-oss-120b-medium` | gpt-oss | 僅 medium |

Antigravity 視為**多模型 runtime adapter**（registry `runtime_adapters.antigravity`），
不是 Gemini provider。上表只是觀察紀錄；dispatch 時一律以當下 `agy models` 解析。
**Live probe（2026-09-18，`agy 1.2.6`，`claude-sonnet-4-6`）**：`--effort low|medium|high`
三者皆在 launch 前被拒（`invalid model selection (...): --effort is not supported for
model "claude-sonnet-4-6"`，0 tokens）；**不帶 `--effort`** 則 `SUCCESS`。所以單一 id 的
Claude entry effort 由 runtime 固定，dispatch 不得傳 `--effort`，registry 以
`reasoning: provider_default` 表示（`unsuffixed_model_effort: none`）。注意：被拒時
process **exit code 仍為 0**，JSON `status` 為 `ERROR`——launch probe 必須讀
`status`，不得只看 exit code。`claude-opus-4-6-thinking` 同形但未 probe。
`agy --help` 沒有 login / auth 子命令。

**Live probe（2026-09-18，`agy 1.2.6`，Router 目標 Gemini 3.8 Flash / medium）**：
`agy -p "<prompt>" --model gemini-3.8-flash-medium --effort medium --output-format json`
回 `"status":"SUCCESS"`，無 auth 提示、無 error。Gemini 的 id 後綴＋`--effort` 契約自
`1.1.24` 起未變。

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
