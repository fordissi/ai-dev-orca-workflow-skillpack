# OpenUsage Windows Compatibility Experiment

Status: **optional / experimental / non-authoritative**

這是一個 optional 的基礎設施實驗，**不是穩定流程的前置條件**，也不是任何交付的 blocker。
Windows 上的 quota 自動偵測若無法運作，流程走 `UNKNOWN` 路徑照常進行——
見 `policies/RESOURCE_AWARE_ROUTING.md`。

OpenUsage 是 provider quota aggregation 的 reference implementation。其 native app
目前要求 macOS 15+，因此 Windows 支援本身就是待驗證項目。

## Goal

找出 Codex / Claude / Antigravity 在 Windows 上可安全 machine-read 的 quota snapshot。

## 現況（2026-09-01 調查結果）

問題的範圍已經縮小，不再是「要不要自己寫 provider adapter」：

| Provider | 現況 |
|---|---|
| Claude | 解法已存在於 Orca 內部 |
| Codex | 解法已存在於 Orca 內部 |
| Antigravity | Orca 已有 proxy 基礎，但 integration 尚不完整 |

**真正缺的是 read-only 的 CLI / IPC 暴露介面。** Orca 內部已持有 normalize 後的
rate-limit 狀態，但沒有對外的唯讀讀取路徑，因此 `RESOURCE_STATE` 目前只能靠
`USER_STATEMENT` 或維持 `UNKNOWN`。

期望的上游介面（尚不存在）：

```bash
orca rate-limits --json
```

或把 rate limit 併入既有的 `orca status --json`。Feature request 的一句話說法是
**Expose normalized RateLimitService state as read-only CLI JSON.**

這條路徑之所以是正確方向，是因為它符合 `policies/RESOURCE_AWARE_ROUTING.md` 對
`ORCA_RUNTIME` 這個 HIGH trust source 的條件：`credential_access: NONE`、
`persistence: MEMORY_ONLY`。**在該介面出現之前，不得以需要 credential 的手段
取得 quota 並冒充 HIGH trust。** 自行刮取或代理登入狀態都不符合這個條件。

## Steps

1. 先查官方文件與本機 CLI 的 usage/status 命令。
2. 參考 OpenUsage 的 provider implementation。
3. 優先 local-only、沿用既有登入狀態的讀取方式。
4. Normalize 到 `runtime/RESOURCE_STATE.json` 的 schema，**per-pool 分開記錄**。
5. Cache，未滿五分鐘可重用。
6. 任何失敗一律 `UNKNOWN`。

## 邊界

- **不得輸出或保存 token、cookie、credential、帳號識別資料或 provider 的原始回應。**
  只保存 normalize 後的非敏感狀態。
- 不得為了取得 quota 而繞過 provider 的安全機制。
- **此實驗的產出在通過獨立驗證前是 non-authoritative。** 它不得被當成 routing 的
  權威輸入；未經驗證時 state 維持 `UNKNOWN`。
- 不得從百分比自行推導 `GREEN` / `YELLOW` / `RED`。門檻只能定義在有來源、
  有版本的 adapter schema 中。
- 本目錄不放真實帳號資料，即使是「範例」。
