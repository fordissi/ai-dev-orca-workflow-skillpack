# Verification Notes

這份文件記錄 `OFFICIAL_COMMANDS.md` 每一項的**查核方式與查核日期**，並明確區分
「本機 `--help` 實測」與「上游文件查核」——兩者不同，不可互相冒充。

規則：**兩者不一致時，以實際安裝版本為執行依據，並在此記錄差異。**

## 查核狀態總表

| 項目 | 本機 `--help` 實測 | 上游文件查核 | 備註 |
|---|---|---|---|
| Orca CLI | 2026-09-01（本 session） | 2026-09-01（前次 session 記錄，本 session 未重新抓取） | 版本 1.4.192 |
| Codex CLI | 2026-09-01（本 session） | 2026-09-01（前次 session 記錄，本 session 未重新抓取） | 版本 0.151.0 |
| Claude Code | 2026-09-01（本 session） | 2026-09-01（前次 session 記錄，本 session 未重新抓取） | 版本 2.1.252 |
| Antigravity CLI | 2026-09-01（本 session） | 2026-09-01（前次 session 記錄，本 session 未重新抓取） | 版本 1.1.22 |
| GitHub CLI | 2026-09-01（本 session） | **2026-09-01（本 session 實際抓取 manual）** | 版本 2.92.0 |
| OpenUsage | 不適用（未安裝） | 2026-09-01（前次 session 記錄） | macOS 15+ |

上游欄位標記「前次 session 記錄」者，代表本次未重新抓取原始網頁。這些項目的執行依據
是本機 `--help` 實測；上游 URL 保留供下次重新查核。**不得把前次的查核日期當成本次的。**

## 本 session 實測發現（2026-09-01）

### Orca 1.4.192

- `terminal read` 同時提供 `--cursor` / `--limit` 與畫面讀取，help 明載兩者互斥。
  畫面讀取沒有歷史、無法分頁，因此預設用 cursor read。
- `terminal wait --for` 接受 `exit` 與 `tui-idle`。`codex exec` 這類非互動式命令用 `exit`。
- `terminal send` 具 `--text`、`--enter`、`--interrupt`。
- `worktree create` 具 `--name`、`--no-parent`、`--agent`、`--prompt`、`--base-branch` 等。
- `worktree set` 具 `--comment`、`--workspace-status`，狀態 id 預設為
  `todo` / `in-progress` / `in-review` / `completed`。
- **差異與限制**：`terminal stop` 只接受 `--worktree`，沒有 per-terminal 選項。
  已寫入 `OFFICIAL_COMMANDS.md` 的已知限制。

### Codex CLI 0.151.0

- `exec` 子命令可非互動執行；prompt 可由 stdin 以 `-` 讀入。
- `-s` / `--sandbox` 值為 `read-only`、`workspace-write`、`danger-full-access`。
- `-a` / `--ask-for-approval` 含 `on-request`、`never`。
- **重要差異**：本機 `~/.codex/config.toml` 的 `model`、`sandbox_mode`、
  `approval_policy` 會在命令列未明示時生效，可能使實際權限高於 contract 意圖。
  因此 `WORKFLOW_POLICY.md` 要求 permission ceiling 以逐字 `dispatch_command` 表達。
- Codex CLI **沒有**等同 `agy models` 的 model 列表命令。`gpt-5.6-*` 的 ID 只有
  本機 global state 佐證，維持 provisional。

### Claude Code 2.1.252

- `--permission-mode` 實測可用值：`acceptEdits`、`auto`、`bypassPermissions`、
  `manual`、`dontAsk`、`plan`。前次記錄只提到 `plan`，本次補齊完整清單。
- `--model`、`-p` / `--print`、`--output-format`、`--max-turns` 皆存在。

### Antigravity CLI 1.1.22

- `agy models` 實際執行成功並回傳 live 清單。
- **重大發現**：清單同時包含 Gemini 家族與**其他家族**的模型（Claude 家族與開源模型）。
  這推翻了「provider 等於 model family」的隱含假設，也證實 independent review 必須
  同時比對 provider 與 model family。已寫入 `OFFICIAL_COMMANDS.md`。
- 因此 registry 的 `AUTO_GEMINI` resolver 解析結果必須落在宣告的 `model_family` 內，
  否則該候選為 `CONFIG_INVALID`。

### GitHub CLI 2.92.0

- 本 session 實際抓取 https://cli.github.com/manual/gh_repo_create。
- 官方語法 `gh repo create [<name>] [flags]`；省略 `OWNER/` 時預設為已登入使用者。
- `--public`、`--source`、`--remote`、`--push` 官方 manual 與本機 `--help` 一致，無差異。
- `gh auth status` 確認認證有效。**其 token 欄位未記錄於任何 artifact。**

## 已移除的過時內容

前一版把下列項目寫在一般說明性文字中，讀者難以區分「這是建議」還是「這是警告」：

PROHIBITED: `--screen` 作為預設讀取方式（無歷史、無法分頁）
PROHIBITED: `approval_policy = "untrusted"`（已非有效值）
PROHIBITED: `--dangerously-skip-permissions` 與 `bypassPermissions` 作為預設權限模式

這些現在一律以行首 `PROHIBITED:` 標記。該標記同時是機器可讀的約定：
`scripts/validate-policy-pack.mjs` 的 repository scanner 會跳過這些行，
測試也據此把「刻意記錄的反面範例」與「誤留的過時預設」分開。
