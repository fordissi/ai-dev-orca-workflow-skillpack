# Official / Primary Command Reference

Local `--help` verified: **2026-09-01**

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
| Antigravity CLI | 1.1.22 | `agy --version` |
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

非互動式派工（`codex exec` 會自行結束，用 `--for exit`）：

```bash
orca terminal create --worktree active --title "<task>" --command '<command>' --json
orca terminal wait --terminal <handle> --for exit --timeout-ms 600000 --json
orca terminal read --terminal <handle> --json
```

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

`--permission-mode` 本機實測可用值：`acceptEdits`、`auto`、`bypassPermissions`、
`manual`、`dontAsk`、`plan`。

Discovery 與 review 用 `plan`；需要人確認每一步時用 `manual`。

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
agy -p "<prompt>"
agy --print "<prompt>"
```

**一律以 `agy models` 作為 live model source，不得永久寫死 display name。**

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
