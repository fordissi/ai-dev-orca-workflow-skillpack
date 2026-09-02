# Resource-Aware Routing Policy

Version: `0.3`
Status: normative

這份文件是 **resource state、freshness、quota window role（BURST / BUDGET）、conservation pressure、reset proximity / stranded capacity 與候選重排** 的 normative owner。

**Quota 是 routing signal，不是 architecture authority。** 它只能在已達到相同 `minimum_tier` **且相同 capability `stage`** 的候選之間重排順序，永遠不能降低能力門檻、把候選拉到 slot 要求的 stage 之下、把 Stage 3 模型拉進 Stage 1/2 的 slot、改變架構決策，或繞過 human gate。Capability stage、stage admission、slot 與 candidate 演算法屬於 [`MODEL_ROUTING_POLICY.md`](MODEL_ROUTING_POLICY.md)；本文件的 overlay 一律在 stage eligibility **之後**才作用。特別是：「快要 reset 的閒置 BURST 額度」**不得**把 flagship（Stage 3）候選帶進 Stage 1/2 的工作。

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
  "short_window": { "role": "BURST", "used": null, "remaining_ratio": null, "reset_at": null },
  "weekly_window": { "role": "BUDGET", "used": null, "remaining_ratio": null, "reset_at": null },
  "source": "UNKNOWN",
  "remaining_confidence": "UNKNOWN"
}
```

真實 runtime snapshot 的 `available` **必須是 boolean**。只有公開的 `runtime/RESOURCE_STATE.example.json` 可在明確的 example-validation mode（`{ allowExampleNulls: true }`）下使用 `available: null` 搭配 `state: UNKNOWN`。這個例外**不得**套用到真實 routing input——`null` 不能悄悄進入 live routing。

真實的 `runtime/RESOURCE_STATE.json` 已列入 `.gitignore`，不進版控。

## Freshness

Freshness 依**每一筆 provider 或 pool 自己的 `checked_at`** 評估，絕不使用共用的全域 timestamp。

- 未滿 5 分鐘：可重用。
- 超過 5 分鐘：視為 stale。
- Critical routing：必須要求刷新，或明確記錄仍為 `UNKNOWN`。刷新失敗時記 `UNKNOWN`，不沿用過期數值。

## Hierarchical quota windows

**`quota opportunity cost is a routing signal, not capability authority`**
**`short-window opportunity MUST NOT override long-horizon scarcity`**

本節是 window role、conservation pressure、reset proximity、stranded capacity
與 window 聚合的 normative owner。

### 兩種 window role

Quota window 由**角色**決定意義，不由名字決定：

| Role | 例子 | 負責 | 提供的訊號 |
|---|---|---|---|
| `BURST` | 5h、hourly、short rolling window | burst capacity、短期 reset 的利用率 | `stranded_capacity_risk`（**utilization**） |
| `BUDGET` | weekly、monthly、provider 定義的長期上限 | scarcity、conservation、長期預算永續性 | `conservation_pressure`（**scarcity**） |

`BUDGET` 的 resource-governance authority **高於** `BURST`。兩者不是平權訊號，
**不得取 max 之後一視同仁**。

理由很直接：`BURST` 的額度是 use-it-or-lose-it，沒用掉就消失；`BUDGET` 的額度
是接下來整週或整月要用的存量。「五小時窗剩很多、兩小時後 reset」不構成消耗一個
只剩 8% 的週預算的理由。

### 它不是能力概念

兩個訊號都**不得**被表達成 capability tier 或 model class。本 pack 不存在
`SURPLUS` tier、`RESET_SOON` model class，也沒有任何 cheaper/deeper override。
它們是 **resource overlay attribute**，只在 overlay 這一層生效。

因此永遠不能：降低 `minimum_tier`、讓 `CHEAP` 取代 `DEEP`、繞過 human gate、
破壞 reviewer disjointness、把不在該 slot candidate list 的模型拉進來，或改變
`MODEL_REGISTRY.yaml` 的 slot membership。這些不是「應該避免」，而是**結構上做不到**：
重排只在「已經通過全部資格檢查」的候選集合內進行。

即使 Opus 的額度又多又快 reset，只要它不在 `STRONG_IMPLEMENTER` 的 candidate list，
它就不參與該 slot 的選擇。

### 來源欄位（快照存的是事實）

快照只存事實，不存結論。通用寫法：

```yaml
windows:
  - key:                      # 這個 window 的名稱，僅供閱讀
    role:                     # BURST | BUDGET，必填
    remaining_ratio:          # 0..1 的剩餘比例，或 null
    reset_at:                 # ISO timestamp，或 null
remaining_confidence:         # HIGH | MEDIUM | LOW | UNKNOWN，optional
```

`role` 是必填的，因為只有它說得出這個 window 描述的是哪個時間尺度。
無法判定角色的 window 直接略過——它不是任一 horizon 的證據。

Legacy 具名寫法（見下方 backward compatibility）仍然有效，且可用明確的 `role`
覆寫預設角色：某 provider 的「short window」若實際上是它的長期上限，就直接標
`role: BUDGET`。

`remaining_confidence` **只能調降、不能調升 `source` 所隱含的信任度**：
`ORCA_RUNTIME` 為 `HIGH`、`USER_STATEMENT` 為 `MEDIUM`、`UNKNOWN` 為 `UNKNOWN`。
宣告高於來源信任度的 confidence 是設定錯誤。

### 推導標籤（router 算，快照不存）

由 router 在 routing 當下依本節門檻推導，**不寫進快照**——存進去會產生第二份
會分歧的門檻定義。

```yaml
reset_proximity:              # NEAR | MEDIUM | FAR | UNKNOWN
stranded_capacity_risk:       # HIGH | MEDIUM | LOW | UNKNOWN      ← BURST
conservation_pressure:        # NONE | LOW | MEDIUM | HIGH | CRITICAL | UNKNOWN  ← BUDGET
```

`reset_proximity` 對兩種 role 用同一組門檻：

| 距離 reset | 值 |
|---|---|
| ≤ 6 小時 | `NEAR` |
| > 6 小時且 ≤ 48 小時 | `MEDIUM` |
| > 48 小時 | `FAR` |
| 沒有可信 `reset_at`，或 `reset_at` 已過去 | `UNKNOWN` |

`reset_at` 已經是過去式時是 `UNKNOWN` 而不是 `NEAR`：那筆讀數描述的 window 已經不存在了。

### BURST → stranded_capacity_risk（utilization）

需要**兩個條件同時成立**——剩得多，且快沒時間用：

| `remaining_ratio` \ proximity | `NEAR` | `MEDIUM` | `FAR` | `UNKNOWN` |
|---|---|---|---|---|
| ≥ 0.5 | `HIGH` | `MEDIUM` | `LOW` | `UNKNOWN` |
| ≥ 0.2 且 < 0.5 | `MEDIUM` | `LOW` | `LOW` | `UNKNOWN` |
| < 0.2 | `LOW` | `LOW` | `LOW` | `UNKNOWN` |
| 無可信讀數 | `UNKNOWN` | `UNKNOWN` | `UNKNOWN` | `UNKNOWN` |

多個 `BURST` window 時取**風險最高者**：任一短窗即將浪費掉容量，就是浪費。

### BUDGET → conservation_pressure（scarcity）

**proximity 在這裡的作用與 BURST 相反：越接近 reset，壓力越低。**

| `remaining_ratio` \ proximity | `NEAR` | `MEDIUM` | `FAR` | `UNKNOWN` |
|---|---|---|---|---|
| ≥ 0.5 | `NONE` | `NONE` | `LOW` | `UNKNOWN` |
| ≥ 0.25 且 < 0.5 | `LOW` | `LOW` | `MEDIUM` | `UNKNOWN` |
| ≥ 0.1 且 < 0.25 | `LOW` | `MEDIUM` | `HIGH` | `UNKNOWN` |
| < 0.1 | `MEDIUM` | `HIGH` | `CRITICAL` | `UNKNOWN` |
| 無可信讀數 | `UNKNOWN` | `UNKNOWN` | `UNKNOWN` | `UNKNOWN` |

方向相反是刻意的：週預算只剩 10% 而還有五天要撐，是對這週所有工作的實質限制；
同樣的 10% 若一小時後就重置，幾乎不構成限制，因為稀缺性會在被派工作的時間尺度
內自行解除。

多個 `BUDGET` window 時取**最嚴格者**（`conservation_pressure` 最高者）。
週預算健康不代表月上限沒有見底——任何一個長期 cap 都可能是真正先撞到的瓶頸。
`UNKNOWN` 在此排序中低於所有已知值，因此「沒讀到」永遠不會蓋過「讀到了」。

### 何時兩個訊號一律為 UNKNOWN

以下任一成立時，`stranded_capacity_risk` 與 `conservation_pressure` 皆為 `UNKNOWN`，
不參與重排：

- entry 未通過 source trust invariant；
- `state` 為 `UNKNOWN`——沒有可信 state 就沒有可信的資源讀數；
- 快照超過 freshness 窗（見上節的 5 分鐘規則），或沒有 `checked_at`；
- confidence 低於 `MEDIUM`；
- 該 role 沒有任何帶 `remaining_ratio` 與 `reset_at` 的 window。

**過期的 `remaining_ratio` 比沒有更糟**，因為它看起來像權威讀數。一律重讀上游，不外推。

### 重排規則：scarcity first, utilization second

Registry 順序先決定該 band 的 head。兩個訊號都**只在與 head 相同 resource state
的候選之間**作用：

1. **Conservation 先跑，且只會降級。** `conservation_pressure` 為 `HIGH` 或
   `CRITICAL` 的候選排到其餘候選之後。`MEDIUM` / `LOW` / `NONE` / `UNKNOWN` 皆為中性。
2. **Burst opportunity 後跑，且只會升級。** `stranded_capacity_risk` 為 `HIGH`
   **且該候選自身的 `conservation_pressure` 為 `NONE` 或 `LOW`** 的候選可以提前。
3. 都沒有時維持 registry 順序。

Conservation 表達的是偏好，不是拒絕：若群組內每個候選都在壓力下，該 band 依然
會依 registry 順序選出候選，**不會因此 `BLOCKED`**。

### UNKNOWN 的處理

`UNKNOWN` 不因缺少資料而被懲罰或獎勵：

- **未知的 BUDGET 不得視為 scarce** → 不降級。
- **未知的 BUDGET 不得視為 healthy** → 不給 burst promotion。
- **未知的 BURST 不扣分** → 只是沒有 promotion 可拿。

因此 `UNKNOWN` 的淨效果是「維持 registry 順序」，兩個方向都不動。

這同時避免了兩種失衡：**不查資料的人不會永遠被當成 healthy**（拿不到 promotion），
而**查了資料的人也不會永遠吃虧**——量到健康可以換到 promotion，量到吃緊會被降級，
但那是真話。量測在期望值上是划算的。

### 與 resource state band 的關係

兩個訊號都**不得推翻 `GREEN` / `YELLOW` / `RED` / `UNKNOWN` 的 band 順序**。
一個 conservation 為 `CRITICAL` 的 `GREEN` 候選，仍然排在預算漂亮的 `YELLOW`
候選之前。

「只在與 head 相同 state 的群組內比較」這條限制同時保住兩件事：band 順序不受影響，
且 `YELLOW` 與 `UNKNOWN` 之間**仍然沒有優先級**。

沒有任何候選帶可信的 window 讀數時，選擇結果與本節存在之前**完全相同**。

### Backward compatibility

v0.3 的具名 window 寫法仍然合法，不需要遷移：

| Legacy key | 預設 role |
|---|---|
| `short_window` | `BURST` |
| `weekly_window` | `BUDGET` |

這個對應**只是 legacy compatibility**，不是「weekly 永遠特別」。新 schema 用
`windows` 清單搭配明確 `role`，因此不綁死在 short/weekly 這兩個名字上，
可以表達 5h + weekly、daily + monthly，或未來 provider 的其他 quota 結構。

具名 window 上明確寫出的 `role` 優先於預設對應。

### 記錄

重排實際改變了選擇時，operational router 必須在 routing evidence 中記錄
**被跳過的候選**與造成該結果的標籤（`conservation_pressure` 或
`reset_proximity` + `stranded_capacity_risk`）。未記錄的重排等同不可稽核的重排。

**只記錄標籤，不記錄數值。** `remaining_ratio`、`reset_at` 與任何原始 quota 讀數
都不得寫入 execution artifact——這是本文件「不保存原始 quota payload」規則的延伸。

### 人工輸入的 resource facts

`USER_STATEMENT` 是合法來源（trust `MEDIUM`，足以驅動這兩個訊號）。例如人告知：

```text
Codex  5h 窗已用 41%、約 3h45m 後 reset；週窗已用 78%、約 5d 後 reset
Claude 週窗已用 36%、約 1d12h 後 reset
```

Operational router 將其 normalize 為 facts（Codex BURST 剩約 0.59、BUDGET 剩約
0.22；Claude BUDGET 剩約 0.64）並填上 `checked_at`，再由本節的規則推導標籤與排序。

**人提供的是 resource facts，不是 model-selection instruction。** 「Codex 額度還多」
不等於「用 Codex」；候選排序仍由本節與 `MODEL_ROUTING_POLICY.md` 決定。

## 不保存的內容

Router 保存決策快照與理由，**不保存原始 quota payload**、不保存 token、cookie、帳號識別資料或 provider 的原始回應。

## OpenUsage

OpenUsage 作為 provider quota aggregation 的 reference implementation，**不是 Windows workflow 的前置條件**。其 native app 目前要求 macOS 15+。Windows 上的 quota 自動偵測維持 experimental 與 optional；偵測不到時走 `UNKNOWN` 路徑，流程不因此停擺。
