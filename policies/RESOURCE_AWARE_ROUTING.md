# Resource-Aware Routing Policy

Version: `0.5`
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

一筆 snapshot 可重用的條件是**兩者同時成立**：

```text
freshness = time freshness  AND  window-generation validity
```

- **Time freshness** — `checked_at` 距 `now` 未滿 **5 分鐘**。超過即 stale。
- **Window-generation validity** — 該 entry 的**每一個** relevant quota window 的 `reset_at` 都仍在 `now` 之後。

### Reset-boundary invalidation（hard invariant）

**`A quota window becomes immediately stale when its reset_at is reached or passed, regardless of checked_at age.`**

例：`checked_at = 13:58`、`reset_at = 14:00`、`now = 14:01`。snapshot 只有 3 分鐘舊，
但那個 window 描述的是**上一個 quota generation**——`RESET_EXPIRED`，MUST NOT reuse。
它**不是**一般的 5 分鐘 freshness reuse，`checked_at < 5m` **不得**蓋過
`reset_at <= now`。

任一 relevant window `RESET_EXPIRED` 時，整筆 entry 需要 refresh：在 refresh 完成前，
該 entry 的 `state` 視為 `UNKNOWN`，且 `conservation_pressure` /
`budget_expiry_opportunity` / `stranded_capacity_risk` 皆為 `UNKNOWN`。

### Refresh-required triggers

下一次**新的 autonomous candidate selection 之前**，operational router 必須先確認每一個
relevant `resource_state_key` 是否仍有效；任一成立即 **refresh required**：

- `checked_at` 超過 freshness TTL；
- 任一 quota window `reset_at <= now`（reset-boundary）；
- provider 回報 rate limit / quota exhausted；
- dispatch 因 quota / rate limit 失敗；
- runtime 回報 resource unavailable；
- 使用者提供了更新的 quota facts。

這些 trigger **不等於** permanent provider failure——它們只表示「下一個 autonomous
routing decision 前需要 refresh」。refresh 完成後才計算 resource state band、
conservation、expiry opportunity、stranded capacity 與 candidate ranking。

**`Autonomous model selection must not use a reset-expired quota window.`**

### Lazy + event-driven，不做背景輪詢

**不新增常駐 daemon，不要求每 5 分鐘背景輪詢所有 provider。** 模型是
**lazy + event-driven**：active worker 照常跑；只有在下一個 routing decision 之前
才確認 resource state 是否仍有效；stale / reset-expired 才 refresh。這讓 skillpack
維持泛用、低成本、無背景依賴。

### Refresh 失敗 → UNKNOWN

需要 refresh 但沒有可信 quota source 時，**不得沿用 reset-expired 數值**。該 entry
的 resource state 變為 `UNKNOWN`，之後套用既有政策——`UNKNOWN` 為中性。

**不猜測 remaining quota、不推算 reset 後的補充百分比、不假設 reset 就等於 100%**，
除非有實際可信 source 這樣回報。`USER_STATEMENT` 說「Claude 剛 reset」可以
**invalidate** 舊 snapshot，但除非同時提供新的 remaining 數字，新的精確百分比仍是
`UNKNOWN`；runtime 能讀到新用量時才從 runtime refresh。

### 與 active worker、continuation 的關係

Quota reset **不得**自動中斷已啟動的健康 worker，也不得把任務 restart 到剛 reset 的
provider 上。Quota re-evaluation 只影響**下一個** dispatch、下一個 independent
reviewer 選擇、以及**需要新的 model-selection 決策的** continuation。語意見
[`WORKFLOW_POLICY.md`](WORKFLOW_POLICY.md) 的 Execution lifecycle semantics。

**Continuation freshness 與 quota freshness 是兩個獨立檢查**：同一個有效 worker 的
continuation **不因為 quota reset 就換模型**；只有 `MAX_TURNS_REACHED` 後需要新
worker、stale continuation 被拒、retry 換 worker、reviewer dispatch、新 task 這類
**新的 routing decision** 才套用本節的 refresh 規則。

## Resource acquisition（provider-native probing）

本節是 **resource acquisition 順序、provider-native probe 語意、`PROVIDER_NATIVE_PROBE`
source trust，與「refresh → acquire → normalize → route」流程** 的 normative owner。
已驗證的各 provider 實際命令記在
[`../references/RESOURCE_PROBES.md`](../references/RESOURCE_PROBES.md)。

### Root gap

Refresh 規則知道**怎麼用** quota data，但沒規定**怎麼取得**。Orca runtime 與 worker
inventory 目前不暴露 normalize 後的 quota 欄位，router 因此常常直接退化成
`resource_state = UNKNOWN`——即使 provider 自己的唯讀 CLI（Codex `/status`、
Claude `/usage`、Antigravity `/usage`）interactively 就看得到用量。

**`Lack of quota fields in Orca inventory alone is not sufficient reason to
return UNKNOWN; a supported provider-native read-only probe MUST be attempted
first.`**

### Acquisition precedence

需要 refresh 的每一個 relevant `resource_state_key`，依序嘗試：

```text
1. ORCA / structured runtime resource source   → 有就 normalize 使用
2. provider-native read-only resource probe     → 可用就 attempt
3. fresh USER_STATEMENT                          → 有就 normalize 使用
4. UNKNOWN
```

**不得**從「Orca inventory 沒有 quota 欄位」直接跳到 `UNKNOWN` 而不先考慮受支援的
provider-native probe。

**`Resource ranking happens after required resource acquisition attempts, not
before them.`**

### RESOURCE_PROBE_ADAPTER

Provider probe 的通用抽象，至少產出：

```yaml
provider:
resource_pool:                 # 對應 resource_state_key
probe_method:                  # interactive_tui | ...
probe_command_or_interaction:  # 例如 "/status" / "/usage"
checked_at:
source: PROVIDER_NATIVE_PROBE
source_confidence:             # HIGH | MEDIUM | LOW（identity/parser caveat 時調降）
probe_status:                  # 見下
auth_status:
parse_status:
windows:                       # normalize 後，餵進既有 RESOURCE_STATE model
  - window_role: BURST | BUDGET
    remaining_ratio:           # 或 used_ratio；讀不到填 null
    reset_at:                  # 讀不到填 null
    window_name:
raw_output_persisted: false
```

Adapter **餵進既有的 RESOURCE_STATE model**，不建立平行的 quota-routing 模型。

### Provider-native probe methods

| Provider | 唯讀命令 | 用途 |
|---|---|---|
| Codex | `/status` | 短窗使用率 / 長期 quota / reset（有暴露時） |
| Claude | `/usage` | 5h 短窗 / 週長窗 / reset（有暴露時） |
| Gemini / Antigravity | `/usage` | 同上；實際 executable / session path **由 runtime 探得，不猜** |

Adapter 宣告：`PROBE_SUPPORTED` / `PROBE_UNSUPPORTED` / `PROBE_AUTH_REQUIRED` /
`PROBE_UNAVAILABLE`。若 runtime 與已記錄的 command 不同，**不得**硬寫未驗證的命令列。

### Interactive TUI 是允許的

不要求 provider 提供 JSON quota API。若 provider 只透過 interactive TUI / slash
command 暴露用量，operational router **可以**用 Orca terminal 控制查詢：discover 或
建立 bounded probe terminal → 等 TUI ready → 送唯讀 `/status` 或 `/usage` → bounded
read → 只解析 quota facts → normalize → 依 terminal lifecycle 釋放。TUI-only access
**不等於**「resource information unavailable」。

### Probe outcomes

```text
PROBE_OK  PROBE_AUTH_REQUIRED  PROBE_CLI_MISSING  PROBE_SESSION_UNAVAILABLE
PROBE_PERMISSION_BLOCKED  PROBE_PARSE_FAILED  PROBE_DATA_UNAVAILABLE
PROBE_TIMEOUT  PROBE_IDENTITY_UNCERTAIN
```

只有 `PROBE_OK`（且 entry fresh、通過 source trust invariant、identity 已驗證）才產出
**可用的** `PROVIDER_NATIVE_PROBE` 讀數；其餘一律 fall through 到下一個 tier。

這些是 **resource acquisition outcomes**。它們**不得**自動：disable registry model、
標記 model unqualified、mutate human-authoritative registry config、計為
implementation failure、或累加 `failed_repair_count`。

### 不自動登入

唯讀 probe 允許。**互動式認證 / account 變更不自動允許。** CLI 若要求 login 或
re-auth：不輸入 credential、不自動開 OAuth 核准（除非既有 workflow policy 明確允許）、
不改 account state。回 `PROBE_AUTH_REQUIRED` 並繼續 fallback。人可以稍後自行認證。

### Source trust

| Source | Trust | 說明 |
|---|---|---|
| `ORCA_RUNTIME` | HIGH | Orca runtime 提供的 normalize 後狀態 |
| `PROVIDER_NATIVE_PROBE` | HIGH | provider 自己的 CLU 唯讀輸出，identity 已驗證、parser 成功、`checked_at` 已記 |
| `USER_STATEMENT` | MEDIUM | 人工告知 |
| `UNKNOWN` | NONE | 沒有可信來源 |

`PROVIDER_NATIVE_PROBE` **不得**被標成 `ORCA_RUNTIME`——provenance 要明確。identity
未證實時以 `PROBE_IDENTITY_UNCERTAIN` 處理（不產出可用讀數），或退而以
`remaining_confidence` 調降；`remaining_confidence` 一律只能**調降**不能調升 source
所隱含的信任度。

### Account / pool identity

Resource facts 只有屬於**實際用來 dispatch 的 account/pool** 才有用。Probe 應盡量
capture 或驗證：provider、managed account identity / account selector、
`resource_state_key`、subscription pool。同一 provider 有多個 managed account 時，
**不得**把 Account A 的 quota 套到 Account B。無法證明 identity → `PROBE_IDENTITY_UNCERTAIN`，
不作為 HIGH-confidence routing data，依 precedence fallback。

### Parsing / normalization

保守解析。**只 normalize 直接可見的欄位。** 永遠不推斷：只看到 reset time 就補
remaining、reset = 100%、從 5h 窗推週窗（或反向）、從模糊散文推 `reset_at`、從進度條
推精確百分比（除非 parser 明確可靠）。部分欄位可見時存 partial facts（例如 BURST 的
`remaining_ratio` + `reset_at` 已知，BUDGET 的 `remaining_ratio` 仍 `UNKNOWN`）；
既有 routing policy 只消費已知欄位。

#### Relative refresh durations

有些 provider（實測 Antigravity `agy /usage`）在**已消耗的** window 上印的是**相對
倒數**，例如 `Refreshes in 160h 46m`，而不是絕對時間。這是合法的 provider-native
reset 證據，normalize 為：

```text
remaining_ratio    = 由百分比解析（"98.81%" → 0.9881）
reset_in           = 解析後的 provider duration（"160h 46m"）
reset_at           = checked_at + reset_in
reset_at_source    = RELATIVE_PROVIDER_DURATION   （provenance；不得謊稱 provider 給了絕對時間戳）
```

解析保守：支援 `<h>h <m>m`；只有 hours 或只有 minutes 時，能安全解析才收；其餘
（無法解析的措辭、負值、非數字）→ `reset_at` `UNKNOWN`，**絕不 invent**。

一個 window 帶著可解析的相對 refresh duration 時，其 `reset_at` 一經導出即與任何其他
`reset_at` 等價，因此該 window（BUDGET）**可以**參與 `conservation_pressure`、
`budget_expiry_opportunity` 與 `reset_proximity`。

沒有倒數的 window（例如 `100.00% / Quota available`）：`remaining_ratio = 1.0`、
`availability = AVAILABLE`、`reset_at = UNKNOWN`——**不推斷 reset time**。它仍可用
observed ratio 參與排序，但 reset-dependent 的機會訊號（`stranded_capacity_risk`、
`reset_proximity`）對它維持 `UNKNOWN`。這只是**觀察到的行為**（全額可用的短窗**可能**
省略倒數），**不**編成「usage 為 0% 時 Antigravity 一定隱藏 reset time」的硬規則；
日後若探到短窗也有倒數，用同一套相對時間邏輯解析。

### Relevant providers only

保留 lazy / event-driven 行為：**只 probe 與當前 routing decision 相關的
provider/pool**。三個 Stage 2 候選的 snapshot 都要 refresh → probe 這三個；Codex
state 仍 fresh → 不 probe Codex；某 provider 不在該 slot 候選內 → 不為了完整性而
probe。Reviewer 選擇時：**先套 reviewer disjointness，再** probe 剩下的
reviewer-eligible provider/pool。

### Probe budget

Probe 本身不得變成主要 orchestration 成本：short readiness timeout、bounded output
read、bounded parse、**不無限重試**。每個 relevant provider 每次 routing decision
**一次正常 probe**；只有 transient TUI readiness 失敗才 optional 一次 bounded retry。
仍不可用 → `UNKNOWN`。

### Terminal hygiene

Dedicated resource probe terminal 走 lifecycle：
`RESOURCE_PROBE_START → READY → OBSERVED → COMPLETE → RELEASED`。probe terminal
**不是** worker / reviewer / implementation task / continuation，唯讀觀察 scope。
不得因為 probe 完成就關閉既有的 ACTIVE implementation / reviewer terminal；也不得
留下一堆 stale「Claude usage」「Codex status」terminal。**不得**把 `/usage` /
`/status` 注入到 busy 的 ACTIVE implementation worker——可能干擾它的 task / TUI state
時，改建 dedicated probe terminal。terminal 生命週期的 runtime 邊界見
[`WORKFLOW_POLICY.md`](WORKFLOW_POLICY.md) 的 Session lifecycle and cleanup。

### Provider independence

**`The provider/model running the Operational Router does not restrict which provider-native resource adapters may be queried.`** Codex Luna router 仍可
invoke / reuse Claude、Codex、Antigravity 的 CLI 做唯讀 resource inspection。
Resource probing 是 infrastructure observation，不是 task reasoning——**reviewer
provider/model-family disjointness 不套用到 resource probe。**

### Security / privacy

Probe 不得暴露 auth token、API key、cookie、account secret、完整 credential path、
或無關的對話 / task 內容。只持久化 routing 所需的 normalize 後 resource facts。
**不預設持久化完整 raw TUI transcript**（bounded transient inspection 允許）。輸出含
account email / name 時，避免把非必要 PII 寫進 `RESOURCE_STATE`，優先用 opaque
account/pool identifier。

### Pre-dispatch flow

```text
NEW AUTONOMOUS ROUTING DECISION
  → identify eligible candidate providers/pools
  → check resource snapshot validity（TTL + reset generation + not invalidated）
  → for each stale / reset-expired / invalidated relevant resource_state_key:
        attempt acquisition precedence: 1 structured → 2 probe → 3 user statement → 4 UNKNOWN
  → normalize RESOURCE_STATE
  → THEN compute: state band / BUDGET conservation / BUDGET expiry opportunity / BURST stranded capacity
  → candidate ranking
  → dispatch
```

成功 probe 之後：set 新的 `checked_at`、更新 observed windows、清掉該 entry 的
acquisition-time invalidation、重算 derived signals。**不得 fabricate 沒觀察到的
window。**

### USER_STATEMENT 互動

「Claude just reset」這類 fresh user statement 仍是合法 fallback，會 invalidate 舊
facts。**若此時 provider-native probe 可以跑，先 probe**；probe 成功就用觀察到的
facts；probe 跑不了，user statement 可以確立 reset event，但精確 remaining ratio
仍是 `UNKNOWN`，除非使用者也提供了數字。

### UNKNOWN 仍是中性

`UNKNOWN` quota **本身不是 hard routing blocker**。quota 為 `UNKNOWN` 的候選只要
runtime available、registry enabled、stage eligible、permission compatible、
reviewer disjointness 滿足、且沒有已知的 hard resource block，仍可被選中。
**不得**僅因 quota 為 `UNKNOWN` 就產出 `RESOURCE_BLOCKED`。已知的 provider
unavailable / 已知 exhausted 狀態仍照既有政策作用。

## Hierarchical quota windows

**`quota opportunity cost is a routing signal, not capability authority`**
**`short-window opportunity MUST NOT override long-horizon scarcity`**
**`BUDGET scarcity MUST override BUDGET expiry opportunity`**

本節是 window role、conservation pressure、budget expiry opportunity、reset
proximity、stranded capacity 與 window 聚合的 normative owner。

三個 derived signal 的分工：**conservation pressure 是防守的**（長週期預算稀缺 →
保留），**budget expiry opportunity 是進攻的**（長週期預算剩很多且即將 reset →
在同資格候選中優先用掉，以免浪費），**stranded capacity 是更短時間尺度的次要
最佳化**（BURST 即將 reset 的閒置容量）。防守永遠壓過同尺度的進攻：
`budget_expiry_opportunity` 不得讓一個自身 `conservation_pressure` 為 `HIGH` /
`CRITICAL` 的候選被提前。

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
conservation_pressure:        # NONE | LOW | MEDIUM | HIGH | CRITICAL | UNKNOWN  ← BUDGET (defensive)
budget_expiry_opportunity:    # HIGH | MEDIUM | LOW | UNKNOWN      ← BUDGET (offensive)
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

### BUDGET → budget_expiry_opportunity（expiry opportunity）

`conservation_pressure` 的進攻鏡像，形狀**完全相反**：需要**剩得多，且快沒時間用**
——長週期 quota 剩很多、又即將 reset，就是「快浪費掉」的容量，值得在同 stage、同資格
候選中優先用掉。

| `remaining_ratio` \ proximity | `NEAR` | `MEDIUM` | `FAR` | `UNKNOWN` |
|---|---|---|---|---|
| ≥ 0.5 | `HIGH` | `MEDIUM` | `LOW` | `UNKNOWN` |
| ≥ 0.25 且 < 0.5 | `MEDIUM` | `LOW` | `LOW` | `UNKNOWN` |
| ≥ 0.1 且 < 0.25 | `LOW` | `LOW` | `LOW` | `UNKNOWN` |
| < 0.1 | `LOW` | `LOW` | `LOW` | `UNKNOWN` |
| 無可信讀數 | `UNKNOWN` | `UNKNOWN` | `UNKNOWN` | `UNKNOWN` |

低於 0.25 一律不高於 `LOW`：**剩沒多少就沒什麼可浪費**，不為了用光最後幾 % 而建立
強烈 preference——那時決策由 scarcity（防守）主導，不由 expiry（進攻）。

**Aggregation（保守）：** 多個 `BUDGET` window 時，`budget_expiry_opportunity`
取**最高者**（任一近 reset 的長窗剩很多，就是有容量要浪費）；但它**只有在該候選
自身的 `conservation_pressure` 不是 `HIGH` / `CRITICAL` 時**才會影響排序。因此
「weekly 剩 60% 、4h 後 reset」＋「monthly 剩 8% 、20d 後 reset」時，monthly 的
`CRITICAL` scarcity 壓過 weekly 的 expiry opportunity——不得因 weekly 即將 reset
而消耗已經很稀缺的 monthly budget。

### 何時三個訊號一律為 UNKNOWN

以下任一成立時，`stranded_capacity_risk`、`conservation_pressure` 與
`budget_expiry_opportunity` 皆為 `UNKNOWN`，不參與重排：

- entry 未通過 source trust invariant；
- `state` 為 `UNKNOWN`——沒有可信 state 就沒有可信的資源讀數；
- 快照超過 freshness 窗（見上節的 5 分鐘規則），或沒有 `checked_at`；
- confidence 低於 `MEDIUM`；
- 該 role 沒有任何帶 `remaining_ratio` 與 `reset_at` 的 window。

**過期的 `remaining_ratio` 比沒有更糟**，因為它看起來像權威讀數。一律重讀上游，不外推。

### 重排規則：scarcity first, utilization second

Registry 順序先決定該 band 的 head。三個訊號都**只在與 head 相同 resource state
的候選之間**作用，順序固定：

1. **Conservation 先跑，且只會降級。** `conservation_pressure` 為 `HIGH` 或
   `CRITICAL` 的候選排到其餘候選之後。`MEDIUM` / `LOW` / `NONE` / `UNKNOWN` 皆為中性。
2. **BUDGET expiry opportunity 次跑，且只會升級。** `budget_expiry_opportunity`
   為 `HIGH` **且該候選自身的 `conservation_pressure` 不是 `HIGH` / `CRITICAL`** 的
   候選可以提前。這一步在 burst opportunity 之前——長週期 expiry 比短窗 stranded
   更值得優化。
3. **Burst opportunity 最後跑，且只會升級。** 僅在 expiry 沒有移動選擇時：
   `stranded_capacity_risk` 為 `HIGH` **且該候選自身的 `conservation_pressure` 為
   `NONE` 或 `LOW`** 的候選可以提前。
4. 都沒有時維持 registry 順序。

`BUDGET scarcity MUST override BUDGET expiry opportunity`：週預算只剩 8%、reset
為 `FAR` 時，即使其他訊號有 opportunity，仍應 conserve。

Conservation 表達的是偏好，不是拒絕：若群組內每個候選都在壓力下，該 band 依然
會依 registry 順序選出候選，**不會因此 `BLOCKED`**。

### UNKNOWN 的處理

`UNKNOWN` 不因缺少資料而被懲罰或獎勵：

- **未知的 BUDGET 不得視為 scarce** → 不降級。
- **未知的 BUDGET 不得視為 healthy** → 不給 burst promotion，也**不給 expiry promotion**。
- **未知的 BURST 不扣分** → 只是沒有 promotion 可拿。
- `budget_expiry_opportunity` 為 `UNKNOWN`（讀不到 remaining 或 reset）→ 不影響排序。

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
**被跳過的候選**與造成該結果的標籤（`conservation_pressure`、
`budget_reset_proximity` + `budget_expiry_opportunity`，或
`reset_proximity` + `stranded_capacity_risk`）。未記錄的重排等同不可稽核的重排。
expiry 造成的提前記為 `expiry_promotion`，burst 造成的記為 `stranded_promotion`，
兩者互斥（expiry 優先）。

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
