# Resource-Aware Routing Policy

Version: `0.3`
Status: normative

這份文件是 **resource state、freshness 與候選重排** 的 normative owner。

**Quota 是 routing signal，不是 architecture authority。** 它只能在已達到相同 `minimum_tier` 的候選之間重排順序，永遠不能降低能力門檻、改變架構決策，或繞過 human gate。Slot 與 candidate 演算法屬於 [`MODEL_ROUTING_POLICY.md`](MODEL_ROUTING_POLICY.md)。

## RESOURCE_STATE 是 overlay/cache，不是 source of truth

```text
Provider / runtime quota source
        ↓  讀取並 normalize
RESOURCE_STATE snapshot          ← overlay / cache
        ↓  套用
Operational Router
```

**Router 不生產 quota，只消費它。** `RESOURCE_STATE` 是某個上游來源在某個時間點的
normalize 後快照，它的權威性完全繼承自 `source`——快照本身不是權威。

因此：

- 沒有上游來源時，狀態是 `UNKNOWN`，**不是**「router 認為應該是的值」。
- 快照過期時重新讀取上游，而不是沿用或外推。
- 快照內容可以被丟棄重建；任何**只存在於快照中**的資訊都是錯誤的設計。

## Source types 與 trust

每筆狀態必須宣告 `source`，只允許下列值：

```yaml
resource_sources:
  ORCA_RUNTIME:
    trust: HIGH
    credential_access: NONE
    persistence: MEMORY_ONLY
  USER_STATEMENT:
    trust: MEDIUM
  UNKNOWN:
    trust: NONE
```

| Source | Trust | 說明 |
|---|---|---|
| `ORCA_RUNTIME` | HIGH | 由 Orca runtime 提供的 normalize 後狀態。不需要 credential access；只存在於記憶體，不落地。 |
| `USER_STATEMENT` | MEDIUM | 人工告知，例如「Codex 五小時窗剩約 10%」。可信但無法自動更新，過期後降為 `UNKNOWN`。 |
| `UNKNOWN` | NONE | 沒有可信來源。 |

**`source: UNKNOWN` 時 `state` 必須是 `UNKNOWN`。** 沒有來源卻宣告 `GREEN` /
`YELLOW` / `RED`，就是在猜。

`credential_access: NONE` 與 `persistence: MEMORY_ONLY` 是 `ORCA_RUNTIME` 之所以
可信的原因，也是它的邊界：這條路徑不接觸 credential、不落盤，因此不會把敏感資料
帶進 artifact。任何需要 credential 才能取得的 quota 來源，在通過獨立審查前
不得列為 HIGH trust。

## Never guess

讀不到可靠 usage 時，state 一律為 `UNKNOWN`。**禁止估算、禁止從百分比自行推導 state。**

本政策刻意不規定 provider-specific 的百分比門檻。門檻只能定義在 resource adapter 或範例狀態的版本化 schema 中，且必須註明來源。人工宣告的狀態（例如使用者口頭告知額度吃緊）是合法來源，記為 `source: user statement` 並填上 `checked_at`。

## States

| State | 意義 | 路由行為 |
|---|---|---|
| `GREEN` | 可正常承擔該 provider 適合的工作 | 合格候選中優先選用 |
| `YELLOW` | 需保留資源，只分配明顯有優勢或低風險的工作 | 與 `UNKNOWN` 同權，依 registry 順序 |
| `RED` | 除非沒有其他達到最低能力的候選，否則排除 | 僅在 task 明確允許時使用，並記錄理由 |
| `UNKNOWN` | 沒有可信資訊 | 完全依能力與 registry 順序 |

`YELLOW` 與 `UNKNOWN` **之間不建立優先級**。`UNKNOWN` 不因缺少資料而被懲罰或獎勵——否則系統會獎勵「不去查」或「亂猜」。

## Per-pool granularity

每個 provider，以及**每個可獨立計費或獨立限額的 pool**，各自記錄自己的狀態。

Candidate 透過 registry 中的 `resource_state_key` 指向唯一一筆狀態，例如 `codex` 或 `antigravity.gemini`。**不得以 provider 全域狀態覆蓋多個限額 pool**：Antigravity 的 Gemini 與 non-Gemini pool 必須能分別表示。

每筆狀態記錄：

```json
{
  "checked_at": null,
  "available": null,
  "state": "UNKNOWN",
  "short_window": { "used": null, "reset_at": null },
  "weekly_window": { "used": null, "reset_at": null },
  "source": "UNKNOWN"
}
```

真實 runtime snapshot 的 `available` **必須是 boolean**。只有公開的 `runtime/RESOURCE_STATE.example.json` 可在明確的 example-validation mode（`{ allowExampleNulls: true }`）下使用 `available: null` 搭配 `state: UNKNOWN`。這個例外**不得**套用到真實 routing input——`null` 不能悄悄進入 live routing。

真實的 `runtime/RESOURCE_STATE.json` 已列入 `.gitignore`，不進版控。

## Freshness

Freshness 依**每一筆 provider 或 pool 自己的 `checked_at`** 評估，絕不使用共用的全域 timestamp。

- 未滿 5 分鐘：可重用。
- 超過 5 分鐘：視為 stale。
- Critical routing：必須要求刷新，或明確記錄仍為 `UNKNOWN`。刷新失敗時記 `UNKNOWN`，不沿用過期數值。

## 不保存的內容

Router 保存決策快照與理由，**不保存原始 quota payload**、不保存 token、cookie、帳號識別資料或 provider 的原始回應。

## OpenUsage

OpenUsage 作為 provider quota aggregation 的 reference implementation，**不是 Windows workflow 的前置條件**。其 native app 目前要求 macOS 15+。Windows 上的 quota 自動偵測維持 experimental 與 optional；偵測不到時走 `UNKNOWN` 路徑，流程不因此停擺。
