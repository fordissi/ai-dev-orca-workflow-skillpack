# OpenUsage Windows Compatibility Experiment

Status: **optional / experimental / non-authoritative**

這是一個 optional 的基礎設施實驗，**不是穩定流程的前置條件**，也不是任何交付的 blocker。
Windows 上的 quota 自動偵測若無法運作，流程走 `UNKNOWN` 路徑照常進行——
見 `policies/RESOURCE_AWARE_ROUTING.md`。

OpenUsage 是 provider quota aggregation 的 reference implementation。其 native app
目前要求 macOS 15+，因此 Windows 支援本身就是待驗證項目。

## Goal

找出 Codex / Claude / Antigravity 在 Windows 上可安全 machine-read 的 quota snapshot。

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
