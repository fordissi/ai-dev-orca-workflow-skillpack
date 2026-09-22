# Resource-Aware Routing Policy

Version: `0.9`
Status: normative

這份文件是 **resource state、freshness、quota window role（BURST / BUDGET）、conservation pressure、reset proximity / stranded capacity、Weekly Balance、候選重排，以及 Router capacity reserve** 的 normative owner。

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

Tier 1 的「structured runtime resource source」指的是 **Orca 以唯讀 JSON 暴露的
normalize 後 rate-limit 數值**（目前尚不存在，見
[`../references/OFFICIAL_COMMANDS.md`](../references/OFFICIAL_COMMANDS.md)）。
它**不是** `orca account list` 這類 aggregate / account **visibility** 輸出——後者
是 integration evidence，不是 quota evidence，排在 provider-native probe **之後**
（見下方 *Provider-native quota probe precedence*）。

**不得**從「Orca inventory 沒有 quota 欄位」直接跳到 `UNKNOWN` 而不先考慮受支援的
provider-native probe。

**`Resource ranking happens after required resource acquisition attempts, not
before them.`**

### Provider-native quota probe precedence（vs Orca aggregate / account visibility）

一次 live Router quota check 暴露的 routing/evidence 缺陷：Router 跑了
`orca account list --json`，Orca 回報 Antigravity **unavailable**，Router 就推論
Antigravity 的 **quota** 不可用、不可 dispatch。人工更正後直接跑
`agy --print "/usage" --output-format json --print-timeout 30s`，拿到有效的
provider-native quota：Gemini 週窗與 5h 窗、Claude/GPT pool 週窗與 5h 窗皆
100% remaining。

**Orca integration visibility 與 provider quota availability 不是同一件事。**
必須至少分開追蹤兩個概念，不得合併成單一 status：

| 概念 | 來源 | 值域 |
|---|---|---|
| `provider_resource_state` | provider-native probe → 等價權威 adapter → fresh `USER_STATEMENT` | `AVAILABLE` / `PRESSURED` / `EXHAUSTED` / `UNKNOWN` |
| `orca_integration_state` | `orca account list` 等 Orca aggregate / account 視圖 | `AVAILABLE` / `UNAVAILABLE` / `DEGRADED` / `UNKNOWN` |

quota / resource facts 的取得順序：

```text
1. provider-native probe
   - Codex：原生 status/usage surface（5h/BURST、weekly/BUDGET、remaining、reset）
   - Claude：原生 usage/status surface（session/current window、weekly、remaining/reset、
     approximation caveat）
   - Antigravity：agy --print "/usage" --output-format json --print-timeout <duration>
     （或該安裝版的等價命令）
2. 具備等價權威證據的 provider-specific adapter
3. Orca aggregate / account visibility          ← 只是 integration evidence
4. UNKNOWN
```

**`Orca aggregate / account state MUST NOT override a successful provider-native
probe.`** 一個 provider 可以同時是：

```text
provider_resource_state = AVAILABLE
orca_integration_state  = UNAVAILABLE
```

這是**合法**狀態，不是矛盾。上例的正確解讀是 `provider_quota_state = AVAILABLE` ＋
`orca_integration_visibility = UNAVAILABLE`，**不是** `provider_quota_state =
UNAVAILABLE`。

Probe 失敗時 `provider_resource_state = UNKNOWN`，再看 fallback evidence。
**若只有 Orca integration 說 unavailable，不得把 `UNKNOWN` 轉成 `EXHAUSTED`。**
Orca integration 說 available 可作為 weak fallback evidence（integration 可達），
但不因此得到有信心的 `AVAILABLE` quota 讀數——那仍需要 provider-native 證據。
成功的 provider-native `reset_at` 優先於任何 stale aggregate reset。

### Auth state and exact model capability（第三、四軸）

2026-09-18 hotfix：Orca dispatch 了 `claude --model sonnet-5`（由 display name
「Sonnet 5」推導出的 id），CLI 回 `"sonnet-5" isn't described by this version's model
catalog`，Router 卻把它當成 **Claude provider 不可用**。這是錯的：`claude --model
sonnet` 同時可正常啟動。

在上面兩軸之外，再分開追蹤兩個概念，四者互不覆寫：

| 概念 | 來源 | 值域 |
|---|---|---|
| `provider_auth_state` | provider 自己的 auth status 命令（見 [`OFFICIAL_COMMANDS.md`](../references/OFFICIAL_COMMANDS.md)） | `AUTH_OK` / `AUTH_REQUIRED` / `AUTH_EXPIRED` / `AUTH_INVALID` / `AUTH_UNKNOWN` |
| `exact_model_capability` | registry alias catalog ＋ launch probe，**以 `provider/model` 為 key** | `VERIFIED` / `UNVERIFIED` / `MODEL_UNKNOWN` / `MODEL_UNAVAILABLE` |

Launch failure 分類（`scripts/lib/model-dispatch.mjs` 為可執行的 conformance）：

| Class | 影響範圍 |
|---|---|
| `RESOURCE_EXHAUSTED` | provider resource 軸 |
| `INTEGRATION_UNAVAILABLE` | CLI 不存在 / 不可達（integration 軸） |
| `AUTH_REQUIRED` / `AUTH_EXPIRED` / `AUTH_INVALID` | 僅 auth 軸；需 human 互動登入 |
| `MODEL_UNKNOWN` / `MODEL_UNAVAILABLE` | **僅該 model**；同 provider 其他已驗證 alias 仍可 dispatch |

規則：

- unknown / unsupported model ⇒ `MODEL_UNKNOWN` 或 `MODEL_UNAVAILABLE`，**絕不是**
  `PROVIDER_UNAVAILABLE`。
- 需要互動重新登入 ⇒ `AUTH_*`，**絕不是** `PROVIDER_UNAVAILABLE`，也不改
  `provider_resource_state`。
- Auth / model 失敗不寫入 resource snapshot；selection 以 `modelCapability` /
  `providerAuth` 參數把**該 model / 該 provider** 排除於本次選擇之外，quota routing
  不變。全部候選只因 model 失敗而被排除 ⇒ `MODEL_UNAVAILABLE`；只因 auth ⇒
  `AUTH_REQUIRED`（見 MODEL_ROUTING_POLICY 的 blocked reason codes）。

**Pre-dispatch 順序**（任何一步失敗都不建立 worker terminal，也不等 worker timeout）：

```text
1. provider CLI / runtime 存在                → 否：INTEGRATION_UNAVAILABLE
2. provider auth 可用                         → 否：AUTH_*，回傳 reviewed 互動登入命令
3. routing alias → 精確 CLI --model 參數，且可啟動 → 否：MODEL_UNKNOWN / MODEL_UNAVAILABLE
4. resource / quota                           → 否：RESOURCE_EXHAUSTED
5. 建立 worker terminal
```

步驟 3 只接受 registry `resolvers.claude_models.catalog_aliases`（`sonnet` / `opus`
/ `haiku`）或 human 審閱過的 `model_overrides`（behavesAs / modelOverrides 等價物）。
**不得由 display name 推導版本化 model id。**

**Failover**：失敗 class 只記在它所屬的軸上，再以一般 selection 取下一個候選，已嘗試的
`provider/model` 在本 task 內排除，所以同一 model 不會重複 dispatch。同 provider
的另一個 alias 只有在它本來就是同一 slot 的合格候選時才可接手（stage / flagship
guard 不因 failover 放寬）；否則評估下一個已驗證 provider。已知的 model startup
error 不重試、不等 timeout。

**Re-auth recovery**：human 完成互動登入後，只重跑 auth probe（必要時加一次 model
capability probe）；成功即把該 provider 恢復為 `AUTH_OK`，其他軸與其他 provider 的
狀態原樣保留，**不需要重啟 Router**（除非 provider CLI 本身要求）。

Auth probe / launch 輸出可能含 credential：diagnostics 只記 class token 與 reviewed
命令，**不得**記錄、轉述或要求 token / key / secret。

### Burst-aware Router self-accounting

**Router 自己的推理也消耗 quota。** Resource accounting 不得只算 worker，必須包含：

- top-level Router turns
- timer-triggered wakeups
- status re-checks
- worker launches
- review passes

因此 **low-information external waiting 必須消耗約等於零的 LLM reasoning budget**：
外部非同步等待交給 deterministic waiter（見 WORKFLOW_POLICY 的
`NO_LLM_BUSY_POLLING`），Router 只在 terminal signal 時重新進入一次。一次完整的
等待不論輪詢幾次，Router turn 數都不隨 poll 數成長。

在等待期間、且沒有 terminal signal 的 Router 重新進入，一律記為
`NO_LLM_BUSY_POLLING` violation。當該 pool 的 BURST depletion 或 conservation
pressure 為 `HIGH` / `CRITICAL`（接近 Router capacity reserve 的情境）時，同一個
violation 以更高 severity 計——reserve 要保護的正是「還能路由、還能收尾」的控制面
容量，不該花在沒有新資訊的輪詢上。

### Runtime adapters（dispatch target ≠ provider name）

Dispatch target 是 **`runtime_adapter + provider_family + exact_model + effort`**，
不是單一 provider 名稱。Registry `runtime_adapters` 宣告三個 adapter：

| runtime_adapter | registry `provider:` | provider families | model 解析 | effort |
|---|---|---|---|---|
| `codex_cli` | `codex` | openai | pass-through（`-m`） | `-c model_reasoning_effort=` |
| `claude_cli` | `claude` | claude（Sonnet 5 / Opus 5 / Haiku 4.5） | catalog alias | `--effort low…max` |
| `antigravity` | `antigravity` | gemini、claude（Sonnet 4.6 / Opus 4.6 Thinking）、gpt-oss | **live `agy models`** | id 後綴或 `--effort low\|medium\|high` |

- **Antigravity 是多模型 runtime，不是 Gemini provider。** 同一 family 可有多條 runtime
  path（Claude：`claude_cli` 與 `antigravity`）；auth、integration、model capability
  都以 **runtime path** 為單位記錄。一條 path 失敗不代表該 family 全面不可用。
- **沒有已驗證的 direct Gemini adapter**（`direct_adapters_absent: [gemini]`）。
  `provider: gemini` 不得 dispatch ⇒ `INTEGRATION_UNAVAILABLE`，並列出替代 runtime path；
  Gemini 一律經 `antigravity`。
- 各 path 的 quota pool 不同：`antigravity` 的 Gemini ⇒ `antigravity.gemini`，
  Claude / GPT-OSS ⇒ `antigravity.non_gemini`，與 `claude_cli` 的 `claude` pool 無關。
- Reviewer disjointness 仍比對 `provider` **與** `model_family`：經 Antigravity 的
  Claude 候選必須宣告 `claude-*` family，才不會與 `claude_cli` 的 implementer 混過。

**Antigravity capability probe**（pre-dispatch 順序的 Antigravity 版本）：

```text
1. agy runtime 存在                   → 否：INTEGRATION_UNAVAILABLE
2. auth / session 可用                → 否：AUTH_*（agy 無 reviewed 登入命令，交 human）
3. 以 live `agy models` 解析 exact id → 無 catalog：PROBE_REQUIRED；查無：MODEL_UNKNOWN
   （接受 exact id、display name、去掉 effort 的 display name，或 AUTO_GEMINI）
4. effort 是否受支援                  → 否：EFFORT_UNSUPPORTED
   - catalog 有 effort 變體（gemini-3.8-flash-high）：effort 必須是其中之一
     （例：Gemini 3.1 Pro 只有 high|low；GPT-OSS 120B 只有 medium）
   - 單一 id（claude-sonnet-4-6）：effort 由 runtime 固定，**不得**傳 --effort（live 驗證會被拒）；
     要求 low|medium|high ⇒ EFFORT_UNSUPPORTED，只能以 reasoning provider_default dispatch
5. 才 launch
```

以上任何一項都**不得**合併為 `PROVIDER_UNAVAILABLE`。

執行形式：`separateQuotaEvidence()` in
[`../scripts/validate-policy-pack.mjs`](../scripts/validate-policy-pack.mjs)。
`provider_resource_state` 只由 provider-native 證據設定，Orca aggregate state
沒有任何路徑能改動它（`aggregate_overrode_probe` 結構上恆為 `false`）。

#### Quota availability 不等於 dispatchability

`quota_available` 與 `dispatch_runtime_available` 是**兩個**欄位，不得合併。
`agy /usage` 成功但 Orca 無法啟動 Antigravity worker 時：

```text
quota_available            = YES
dispatch_runtime_available = NO / UNKNOWN
```

quota 充足**不證明**可 dispatch。最終 dispatch 仍需 runtime availability、registry
eligibility、capability/stage fit、Router capacity reserve、reviewer
disjointness、exact dispatch identity——這些檢查一個都不因為 quota resolution
被更正而放寬。Router capacity reserve 讀的仍是 BUDGET window 的原始
`remaining_ratio`，在 corrected quota resolution **之後**照常評估。

#### 人工明確詢問 quota 時

人明確要求「檢查 quota / 剩餘額度 / reset 時間 / provider 可用性 / 資源配置」時，
Router **必須**直接 probe 每一個相關的 provider-native 來源（有支援的話），
**不得**只憑 `orca account list` 回答。

#### Antigravity：三種證據分開

- `agy --print "/usage" --output-format json` ＝ **quota evidence**。
- `agy models` ＝ **model catalog / resolver evidence**（`AUTO_GEMINI` 世代解析）。
- `orca account list` 的 Antigravity visibility ＝ **integration evidence only**。

`agy /usage` 成功時，**不得**從 Orca visibility 失敗推論 quota 耗盡或
dispatch 不合格；改為記 `quota_available = YES` ＋
`dispatch_runtime_available = NO/UNKNOWN`。`AUTO_GEMINI` 的語意不變——
`agy models` → 最新相容世代 → 精確 requested effort；quota probing **不得**寫死
任何 Gemini 世代。世代解析與 quota state 是分開的事實。

#### Quota recommendation 的邊界

`separateQuotaEvidence()` 是**純證據解析**：不回傳 stage、model、provider、
reasoning effort 或任何 registry 欄位，也不改變 `MODEL_REGISTRY.yaml` 的
membership 或人工 requested 的 reasoning effort。quota state 只在既有 overlay
那一層作為 routing signal。

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

derived signal 的分工，**防守優先於進攻**：

- **conservation pressure 是防守的**（長週期 BUDGET 稀缺 → 保留）。
- **burst_depletion_pressure 是防守的**（短窗 BURST 快耗盡、又不會馬上 reset →
  新工作改派他處，讓短窗有時間回補）。
- **pace_pressure 是防守的**（長週期消耗**軌跡**不永續 → 保留）；它是
  **evidence-gated**，單一 snapshot 一律 `UNKNOWN`、無 routing 效果。
- **budget expiry opportunity 是進攻的**（長週期預算剩很多且即將 reset → 在同資格
  候選中優先用掉，以免浪費）。
- **stranded capacity 是進攻的、更短時間尺度的次要最佳化**（BURST 即將 reset 的
  閒置容量）。

三個防守訊號複合成**單一 defensive rank**（見下方 *重排規則*），一次套用，
**不是逐一疊加的 reorder pass**。防守永遠壓過同尺度的進攻：任一進攻 promotion
不得提前一個自身 `conservation_pressure` 為 `HIGH` / `CRITICAL`、或自身
`pace_pressure` 為 `HIGH` / `CRITICAL`（且 `pace_confidence ≥ MEDIUM`）的候選。
`BUDGET 絕對稀缺 > PACE / BURST 軟性壓力`。

### 兩種 window role

Quota window 由**角色**決定意義，不由名字決定：

| Role | 例子 | 負責 | 提供的訊號 |
|---|---|---|---|
| `BURST` | 5h、hourly、short rolling window | burst capacity、短期 reset 的利用率與短窗永續 | `stranded_capacity_risk`（**utilization**）、`burst_depletion_pressure`（**short-horizon scarcity**） |
| `BUDGET` | weekly、monthly、provider 定義的長期上限 | scarcity、conservation、長期預算永續性與**軌跡** | `conservation_pressure`（**scarcity**）、`budget_expiry_opportunity`（**expiry**）、`pace_pressure`（**trajectory, evidence-gated**） |

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
stranded_capacity_risk:       # HIGH | MEDIUM | LOW | UNKNOWN      ← BURST (offensive)
burst_reset_proximity:        # NEAR | MEDIUM | FAR | UNKNOWN      ← BURST，門檻較 reset_proximity 緊
burst_depletion_pressure:     # NONE | LOW | MEDIUM | HIGH | UNKNOWN            ← BURST (defensive)
conservation_pressure:        # NONE | LOW | MEDIUM | HIGH | CRITICAL | UNKNOWN  ← BUDGET (defensive)
budget_expiry_opportunity:    # HIGH | MEDIUM | LOW | UNKNOWN      ← BUDGET (offensive)
pace_pressure:                # NONE | LOW | ELEVATED | HIGH | CRITICAL | UNKNOWN  ← BUDGET trajectory (defensive, evidence-gated)
pace_confidence:              # HIGH | MEDIUM | UNKNOWN
pace_reason:                  # WEEKLY_OVERBURN | PROJECTED_EARLY_EXHAUSTION | <null>
weekly_balance:               # { state, budget_surplus, time_remaining_ratio, actual_remaining_ratio, reset_proximity, reason }
                              #   state: BOOST | PREFER | NORMAL | CONSERVE | STRONG_CONSERVE | RESERVE | CRITICAL_RESERVE | UNKNOWN
                              #   ← BUDGET even-consumption balancing (PRIMARY long-horizon signal, snapshot-sufficient)
resource_pressure_rank:       # CLEAR | SOFT_PRESSURED | BUDGET_SCARCE  ← 防守訊號複合後的 rank
```

`reset_proximity` 對 `stranded_capacity_risk` 與 `conservation_pressure` 用同一組門檻：

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

### BURST → burst_depletion_pressure（scarcity, NEW_WORK 防守）

`stranded_capacity_risk` 的**防守鏡像**，形狀相反：需要**剩得少，且短時間內不會
回補**。近 reset 的短窗即使快耗盡也幾乎不構成問題，因為它會在被派工作的時間尺度
內自行回滿——所以 proximity 在這裡**減低**壓力，與 `conservation_pressure` 同向、
與 `stranded_capacity_risk` 反向。它**永不到 `CRITICAL`**：一個 5h 窗不是長週期的
存續風險。

`burst_reset_proximity` 用**比 `reset_proximity` 更緊的門檻**，因為短窗對「近」的
感受不同於週窗：

| 距離 reset | `burst_reset_proximity` |
|---|---|
| ≤ 30 分鐘 | `NEAR`（幾乎立刻回補） |
| > 30 分鐘且 ≤ 3 小時 | `MEDIUM` |
| > 3 小時 | `FAR` |
| 沒有可信 `reset_at`，或已過去 | `UNKNOWN` |

| `remaining_ratio` \ `burst_reset_proximity` | `NEAR` | `MEDIUM` | `FAR` | `UNKNOWN` |
|---|---|---|---|---|
| ≥ 0.5 | `NONE` | `NONE` | `NONE` | `UNKNOWN` |
| ≥ 0.25 且 < 0.5 | `NONE` | `NONE` | `LOW` | `UNKNOWN` |
| ≥ 0.1 且 < 0.25 | `NONE` | `LOW` | `MEDIUM` | `UNKNOWN` |
| < 0.1 | `LOW` | `MEDIUM` | `HIGH` | `UNKNOWN` |
| 無可信讀數 | `UNKNOWN` | `UNKNOWN` | `UNKNOWN` | `UNKNOWN` |

多個 `BURST` window 時取**壓力最高者**。

**Scope（硬性）：**

- **只降級，不排除。** `burst_depletion_pressure` 只會把候選排到同 rank 之後，
  永遠不使 provider `unavailable`、不產生 blocked code。
- **只作用於 NEW_WORK。** 不中斷健康的 `CONTINUATION` / 同一 worker 的 `RETRY` /
  `REVIEW` continuation / `CRITICAL_REPAIR`（見 [`WORKFLOW_POLICY.md`](WORKFLOW_POLICY.md)
  的 continuation 規則）。
- **ROUTER slot 豁免。** 承載 active Router 的 `ROUTER` slot 的候選不受
  `burst_depletion_pressure` 影響——control-plane 由 Router capacity reserve
  保護，不由這個訊號。
- **從屬於 BUDGET 絕對稀缺。** 自身 `conservation_pressure` 為 `HIGH` / `CRITICAL`
  的候選已在 `BUDGET_SCARCE` rank，`burst_depletion_pressure` 不再另外加碼。
- **`UNKNOWN` 中性。** 讀不到短窗或 proximity → 不降級。
- **不降 `minimum_tier` / `stage`、不繞 human gate、不破壞 disjointness、不改
  registry。**

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

### Long-horizon pace / trajectory（evidence-gated）

`pace_pressure` 回答一個 `conservation_pressure` 回答不了的問題：**以觀察到的消耗
速率，這個 pool 會不會在 reset 之前就把長週期額度用到見底？** 一個 BUDGET window
可以「絕對剩餘還很多」（`conservation_pressure` 低）但「軌跡不永續」
（`pace_pressure` 高）。

**單一 snapshot 不足以安全計算軌跡。** 因此：

- **不得**推導 `window_start = reset_at - 7d`。
- **不得**假設「weekly」＝固定七天 generation。
- provider 可能提前 reset、額外發放額度、改變 `reset_at`、切換 quota generation。
- 只有一筆觀察時：`pace_pressure = UNKNOWN`、`pace_confidence = UNKNOWN`，
  **無 routing 效果**。

**Evidence 階層：**

| `pace_confidence` | 條件 |
|---|---|
| `HIGH` | provider 明確暴露 `generation_id` / `generation_start` / explicit reset event（目前無任何 CLI 提供 → `OUTSIDE_REPOSITORY`） |
| `MEDIUM` | 無 generation metadata，但多筆（預設 ≥ 3）看似同一 generation、間隔足夠、且無 reset discontinuity 的觀察，足以估出 burn velocity |
| `UNKNOWN` | 只有一筆 snapshot、continuity 建立不了、`reset_at` 有實質變動、`remaining_ratio` 向上跳、confidence 不足、或可能已跨 generation |

**計算方向（非 elapsed-window ratio）：** 用 **observed burn velocity + remaining
capacity + time until reset** 推 `projected_exhaustion_at`，與 `reset_at` 比較。
`elapsed_fraction = elapsed / 7d` **不是**權威輸入（早窗不穩、且假設固定 generation
start）。velocity 讀不到 → `PACE = UNKNOWN`，不猜。

**門檻（versioned，不是隱性政策真理）：** 最少觀察數、最短觀察總跨度、
`reset_at` 同 generation 容差、向上跳判定比例等，定義於 conformance checker 的
`PACE_EVIDENCE` 常數，可由 operator 透過 `paceConfig` 覆寫。

**Scope（與 `burst_depletion_pressure` 相同）：** 只降級不排除；只作用於
NEW_WORK；ROUTER slot 豁免；從屬於 BUDGET 絕對稀缺；`pace_confidence` 為
`UNKNOWN` 時完全中性；不降 `minimum_tier` / `stage`；`PACE_CRITICAL` **不**
使 provider 全域 unavailable——軌跡壓力代表**永續性**，不代表**能力不足**。

**`pace_reason` 是 label，不是 state。** `WEEKLY_OVERBURN` 是 `pace_pressure` 為
`HIGH` / `CRITICAL` 時附帶的原因標籤；不另設 `DAILY_OVERBURN` / `MONTHLY_OVERBURN`
——window role 已分辨 horizon。

### Weekly Balance（BUDGET 均衡消耗，snapshot-sufficient）

`weekly_balance` 是**長週期 subscription 額度均衡消耗的 PRIMARY 訊號**：在**已具
能力與資格**的候選之間，把 weekly（BUDGET）額度**隨時間平均用掉**。它同時看
**剩多少**與**離 reset 還有多久**，因此**單一可信 snapshot 就足夠**——不需要
PACE 的觀察序列。

一個帶可信 `remaining_ratio`、`reset_at` 與 `window_minutes` 的 BUDGET window：

```text
time_remaining_ratio = clamp((reset_at - now) / (window_minutes * 60000), 0, 1)
budget_surplus       = remaining_ratio - time_remaining_ratio
```

```text
budget_surplus > 0  → 消耗比時間慢 → 未用滿的機會 → 積極優先此 provider
budget_surplus < 0  → 消耗比時間快 → 保守 → 新工作改派他處
```

`window_minutes` **只是均衡用的名目 horizon**。**不得**推導
`generation_start = reset_at - window`，**不得**宣稱 weekly 是固定週期，
**不產生** generation metadata——generation continuity 仍由 PACE 規則管。

**Balance 分帶（versioned，operator 可配置）：**

| `budget_surplus` | `weekly_balance.state` |
|---|---|
| ≥ +0.20 | `BOOST` |
| +0.05 .. +0.20 | `PREFER` |
| −0.05 .. +0.05 | `NORMAL` |
| −0.20 .. −0.05 | `CONSERVE` |
| ≤ −0.20 | `STRONG_CONSERVE` |

**Reserve floor（絕對剩餘仍重要）：** `remaining_ratio < 0.15` → `RESERVE`；
`< 0.05` → `CRITICAL_RESERVE`。兩者**覆蓋** `BOOST` / `PREFER`——即使 reset 很近，
也不把最後一點額度燒在任意工作上。這與既有的 **Router capacity reserve**
（控制面保護）是**不同機制**，不改寫後者。

**Expiry 對齊：** `reset ≤ 24h 且 surplus ≥ +0.10` → 至少 `PREFER`；
`reset ≤ 12h 且 remaining_ratio ≥ 0.20 且非 reserve` → `BOOST`。近 reset 的
未用額度不用就沒價值。

**Hysteresis：** 兩候選的 `budget_surplus` 差 `< 0.10` → 不因 balance 重排
（維持 registry / 現行順序）；`≥ 0.10` 才可重排已合格候選。避免因微小差異而
provider 抖動。

**多個 BUDGET window：** 取**最保守**（`budget_surplus` 最低）者；reserve floor
取**最低** `remaining_ratio`——任一 cap 都可能先見底。

**Scope（與 `burst_depletion_pressure` / `pace_pressure` 相同）：**
只重排、只降級、**不排除**；只作用於 NEW_WORK；**ROUTER slot 豁免**（其 pool
由 Router capacity reserve 保護）；`STRONG_CONSERVE` / `RESERVE` /
`CRITICAL_RESERVE` 複合進 `SOFT_PRESSURED`，**永不到 `BUDGET_SCARCE`**——絕對
稀缺仍由 `conservation_pressure` 擁有，且**壓過** weekly balance。不降
`minimum_tier` / `stage`、不繞 human gate、不破壞 reviewer disjointness、
不動 registry。

**與 BURST / PACE 的關係：** weekly 問「工作**大致**該去哪」；BURST 問「**現在**
能不能用這個 provider」。weekly `BOOST` **不得**推翻同 provider 的 acute
`burst_depletion_pressure = HIGH`（5h 窗 reset 後會自動回到可用）。PACE 仍是
additive 早期預警：weekly `NORMAL` 但觀察到嚴重 overburn 時 PACE 可降級。
weekly balance **不需要** PACE。

**UNKNOWN 中性：** `remaining_ratio` / `reset_at` / `window_minutes` 任一
缺失或不可信、或 snapshot stale → `weekly_balance = UNKNOWN`，**不估算**，
退回既有 BUDGET 行為與 registry 順序。

**門檻**定義於 conformance checker 的 `WEEKLY_BALANCE` 常數，operator 可透過
`weeklyBalanceConfig` 覆寫；**不自我調參**（見
[`../references/ROUTING_TELEMETRY.md`](../references/ROUTING_TELEMETRY.md)）。
`weekly_balance.state` 是寫進 routing evidence 的 label；`budget_surplus` 等
數值不進 execution artifact。

### Generation continuity

軌跡證據在下列任一情況**必須失效並回到 `pace_pressure = UNKNOWN`**（不跨界沿用
velocity、**絕不算出負 burn**）：

- `reset_at` 有實質變動（超過 versioned 容差）——relative-duration window
  （`reset_at_source = RELATIVE_PROVIDER_DURATION`）比較的是「隱含剩餘時長是否
  隨經過時間等比縮短」，不是 `reset_at` 是否不變；
- 相鄰兩筆之間 `remaining_ratio` **向上跳**超過門檻 → `QUOTA_GENERATION_CHANGED`
  或等值的 evidence reset（提前 reset、額度發放），不是負消耗；
- 觀察序列內任一 window 已越過 reset boundary；
- 觀察數不足、或總跨度太短、不足以排除中間發生過未觀察到的 reset；
- 任一筆 `remaining_confidence` 低於 `MEDIUM`，或 `source` 信任等級改變。

### 何時 defensive 訊號一律為 UNKNOWN

以下任一成立時，`stranded_capacity_risk`、`conservation_pressure`、
`budget_expiry_opportunity` 與 `burst_depletion_pressure` 皆為 `UNKNOWN`，
不參與重排（`pace_pressure` 另依上方 evidence 階層，單 snapshot 時亦為
`UNKNOWN`）：

- entry 未通過 source trust invariant；
- `state` 為 `UNKNOWN`——沒有可信 state 就沒有可信的資源讀數；
- 快照超過 freshness 窗（見上節的 5 分鐘規則），或沒有 `checked_at`；
- confidence 低於 `MEDIUM`；
- 該 role 沒有任何帶 `remaining_ratio` 與 `reset_at` 的 window。

**過期的 `remaining_ratio` 比沒有更糟**，因為它看起來像權威讀數。一律重讀上游，不外推。

### 重排規則：scarcity first, utilization second

Registry 順序先決定該 band 的 head。所有訊號都**只在與 head 相同 resource state
的候選之間**作用。順序固定為 **unified defensive composition，然後 utilization
promotion**：

**Step 1 — 複合 defensive rank（一次分組，取代逐一疊加的 reorder pass）。**
每個候選依三個防守訊號落入一個 `resource_pressure_rank`：

| rank | 條件 |
|---|---|
| `CLEAR` | `conservation_pressure` 非 `HIGH`/`CRITICAL`、`burst_depletion_pressure` 非 `HIGH`、非「confident acute PACE」、且 `weekly_balance.state` 非 `STRONG_CONSERVE`/`RESERVE`/`CRITICAL_RESERVE` |
| `SOFT_PRESSURED` | 非 `BUDGET_SCARCE`，且（`burst_depletion_pressure` 為 `HIGH` **或** confident acute PACE **或** `weekly_balance.state` ∈ {`STRONG_CONSERVE`, `RESERVE`, `CRITICAL_RESERVE`}） |
| `BUDGET_SCARCE` | `conservation_pressure` 為 `HIGH` 或 `CRITICAL` |

候選依 `CLEAR → SOFT_PRESSURED → BUDGET_SCARCE` 排序；同 rank 內維持 registry
順序（model-role preference 是同 rank 內的最後 tie-break）。**`BUDGET 絕對稀缺 >
PACE / BURST / weekly-balance 軟性壓力`**：軟性壓力的候選不會被排到一個 BUDGET
稀缺的候選之後。降級是偏好不是拒絕：群組內全部候選都在壓力下時，該 band 仍依
registry 順序在最嚴重 rank 內選出候選，**不會 `BLOCKED`**。

**Step 2 — Weekly Balance（PRIMARY 長週期均衡，只重排已合格候選）。**
在同 rank 群組內：若某候選的 `weekly_balance.state` 比 registry-order head 更好
（rank 更高）**且** `budget_surplus` 差 `≥ hysteresis`（預設 0.10）、且該候選自身
非 `BUDGET_SCARCE` / `burst_depletion_pressure = HIGH` / confident acute PACE /
自身 `RESERVE`/`CRITICAL_RESERVE`，則提前。head 或該候選缺 `budget_surplus`
（`UNKNOWN`）時不比較——中性。這一步在下面兩個 opportunity promotion **之前**。

**Step 3 — BUDGET expiry opportunity（進攻，只升級）。**
`budget_expiry_opportunity` 為 `HIGH`、**且該候選自身 `conservation_pressure` 不是
`HIGH`/`CRITICAL`、且自身不是 confident acute PACE** 的候選可以提前。這一步在
burst opportunity 之前。

**Step 4 — BURST stranded opportunity（進攻，只升級）。**
僅在 weekly balance 與 expiry 都沒有移動選擇時：`stranded_capacity_risk` 為
`HIGH`、**且該候選自身 `conservation_pressure` 為 `NONE`/`LOW`、
`burst_depletion_pressure` 不是 `HIGH`、且自身不是 confident acute PACE** 的
候選可以提前。

**Step 5 —** 都沒有時維持 registry 順序。

`BUDGET scarcity MUST override BUDGET expiry opportunity`：週預算只剩 8%、reset
為 `FAR` 時，即使其他訊號有 opportunity，仍應 conserve。同理 promotion 不得救回一個
`burst_depletion_pressure = HIGH` 或 confident `pace_pressure ∈ {HIGH, CRITICAL}`
的候選。

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
**被跳過的候選**與造成該結果的標籤：

- defensive 造成的降級：`conservation_demotion`（head 為 `BUDGET_SCARCE`）、
  `burst_depletion_demotion`（head 為 `burst_depletion_pressure = HIGH`）、
  `pace_demotion`（head 為 confident acute PACE）、`weekly_balance_demotion`
  （head 為 `weekly_balance.state` ∈ {`STRONG_CONSERVE`, `RESERVE`,
  `CRITICAL_RESERVE`} 且非上述三者）——可同時出現多個，每個都要記
  `over: <被排到後面的候選>`；另記 pick 的 `resource_pressure_rank`。
- 均衡 / 進攻造成的提前：`weekly_balance_promotion`（同 rank 內較佳 balance 的
  候選提前）、`expiry_promotion` 或 `stranded_promotion`；weekly balance 先，
  expiry 與 stranded 互斥（expiry 優先）。

未記錄的重排等同不可稽核的重排。

**只記錄標籤，不記錄數值。** `remaining_ratio`、`reset_at`、burn velocity、
`pace_ratio` 與任何原始 quota 讀數都不得寫入 execution artifact——這是本文件
「不保存原始 quota payload」規則的延伸。粗粒度 bucket 的量化持久化只允許在
選用的、gitignored 的 operational telemetry 層（見
[`../references/ROUTING_TELEMETRY.md`](../references/ROUTING_TELEMETRY.md)），
不進 routing evidence，且 routing **不同步讀取 telemetry、不自我調參**。

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

## Router capacity reserve

**`Control-plane capacity has priority over optional workload capacity.`**

本節是 **Router capacity reserve**——保護「承載 active Operational Router 的
resource pool」不被自主（autonomous）的非 Router 派工提前耗盡——的 normative
owner。這是 **resource routing 政策**，不改變 [`MODEL_REGISTRY.yaml`](MODEL_REGISTRY.yaml)
的 candidate membership，也不改變 [`MODEL_ROUTING_POLICY.md`](MODEL_ROUTING_POLICY.md)
的 capability stage。

### 動機

Router 是 control-plane capacity：task classification、slot selection、resource
acquisition、model dispatch、continuation decision、reviewer routing、human gate、
recovery / handoff synthesis 全部依賴它持續可用。若它所在 provider 的長期
（BUDGET）quota 被 Terra / Sol / 一般 Luna worker 派工積極消耗，workflow 可能在
還沒做完 routing、驗證、恢復與 handoff 之前，就先把 Router 自己的額度用完。

### Active Router identity

```text
active_router_resource = MODEL_REGISTRY.capability_slots.ROUTER 目前選中的
                          candidate 的 provider / resource_state_key
```

這個身分**由 ROUTER slot 目前實際選中的候選決定**，不得在 stable policy 文字或程式
中寫死成任何特定 provider/model。author host 目前的 registry 把它解析為
Codex / `gpt-5.6-luna`（`reasoning: max`），但 reserve 語意必須與 provider/model
無關：human 若日後把 Router 換成別的 provider，reserve 保護的對象自動跟著換，
不需要改這份文件或驗證程式。

`role: ROUTER` 這個 role tag 會出現在**不只一個** slot 上（例如 `DEEP_REASONER`
也標 `role: ROUTER`，用於 architecture reasoning dispatch）——**它不等於「這是
承載 active Router 的 slot」**。只有 registry 中名為 `ROUTER` 的 slot 本身，才是
本節保護的對象；`DEEP_REASONER` 這類同樣標 `ROUTER` role 的其他 slot，屬於「非
Router 的自主派工」，一樣受 reserve 約束。

### Reserve bands

固定用**該 resource pool 的長期 BUDGET window 的 `remaining_ratio`**判斷，
**不與 reset proximity 交叉**——不像 `conservation_pressure`，這裡只看剩多少，
不看多快 reset。理由：control-plane capacity 的保護基準是「還剩多少」，不是
「多快補回來」。

| Band | 條件 | 行為 |
|---|---|---|
| `NORMAL` | `remaining_ratio > 0.15` | 既有 routing 行為不變 |
| `ROUTER_RESERVE` | `remaining_ratio <= 0.15` | 對**同一 resource pool** 的自主非 Router 派工排除；優先改用其他 eligible provider |
| `ROUTER_CRITICAL_RESERVE` | `remaining_ratio <= 0.10` | 同上，語氣更強：預設保留給 Router；沒有替代方案時回既有的 `HUMAN_GATE` / `RESOURCE_BLOCKED` / `ROUTING_UNAVAILABLE`，不得靜默耗用 reserve |
| `ROUTER_EMERGENCY_RESERVE` | `remaining_ratio <= 0.05` | 同一機制，最嚴格：只允許最低限度的 Router/control-plane 使用 |

**三個門檻是同一個排除機制的嚴重程度分級，不是三種不同的邏輯。** 一旦
`remaining_ratio <= 0.15`，該 resource pool 上的自主非 Router 候選一律被排除；
band 名稱只用於稽核與說明「排除得多嚴重」。`remaining_ratio` 讀不到
（`UNKNOWN`）時**不觸發任何 reserve band**——見下方 UNKNOWN 一節。

`ROUTER_RESERVE` 起，**不得為了留在同一 provider 而降低 task capability**（例如
把 Stage 2 工作降到 Stage 1 candidate）。應該做的是改選其他 eligible provider；
找不到才回既有的 blocked / human gate 結果——這與其他 hard eligibility filter
（`enabled: false`、stage、disjointness）耗盡候選後的既有行為完全一致，本節
不另建新的 blocked 語意。

多個 BUDGET window 時，取**最嚴格者**（remaining_ratio 最低、對應 band 最嚴重的
那個）——與 `conservation_pressure` 的聚合規則一致：任一長期 cap 都可能是真正
先撞到的瓶頸。**只看 BUDGET window，不得只憑短期 BURST（例如 5 小時窗）觸發**：
BURST 剩多少與 Router 的長期存續能力無關。

### 排除範圍：只作用於同一 resource pool、只排除非 Router 派工

Reserve 是一個 **exclusion 條件**，與 `enabled: false`、stage 不符、disjointness
違反同一層評估，**不是**重排（reorder）：

- 只在候選的 `resource_state_key` 與 active Router 的 `resource_state_key`
  相同時才評估；其他 resource pool 完全不受影響。
- **永遠不排除 ROUTER slot 自身**：Router 繼續使用自己的 pool，不因為自己的
  reserve band 而被排除出局——保護的是它，不是禁止它。
- 只排除**自主（autonomous）**派工；current human instruction 明確指名的
  candidate（見下方 Human override）不受影響。

因此它與既有的資源訊號分工清楚：`conservation_pressure` / `budget_expiry_opportunity`
/ `stranded_capacity_risk` 在**已合格**的候選之間重排；Router capacity reserve
決定某個候選**在特定 resource pool 上是否夠格**。兩者讀的都是 BUDGET/BURST
window，但語意不同、產生的效果也不同——一個排序，一個排除。

### Human override

`current` human instruction 仍可明確要求使用被 reserve 排除的 provider/model
（例如「用 Terra」），即使 reserve 目前生效中。這是既有 human explicit model
selection 機制（見 `MODEL_ROUTING_POLICY.md` 的 *Human explicit model selection*）
的直接延伸，**不是**另一個新的 override 通道：human pin 本來就排在整條 routing
precedence 的最上層，Router capacity reserve 排在它之後，pin 自然生效。

記錄方式沿用既有欄位：

```yaml
model_selection_source: HUMAN_EXPLICIT_OVERRIDE
router_reserve_override: true      # 僅在此次 override 實際使用了被保留的 pool 時記 true
```

`router_reserve_override` 只是額外的稽核標籤，**不是**新的授權機制——真正的授權
仍是 `HUMAN_EXPLICIT_OVERRIDE` 本身既有的 task id / instruction revision 綁定
（見 `MODEL_ROUTING_POLICY.md` 的 *Selection provenance*）。override 是
**task-local** 的：它不修改 `MODEL_REGISTRY.yaml`，也不解除未來 task 的 reserve；
下一個 task 若沒有自己的 current override，reserve 照常評估。一個 task 之前的
override 帶到後續 task 上，是既有的 `HUMAN_OVERRIDE_STALE` 情況，語意由
`MODEL_ROUTING_POLICY.md` 定義，此處不重複。

### Self-consumption：`ROUTER_RESERVE_SELF_CONSUMPTION`

**`Router Capacity Reserve MUST NOT be defeated by the Router simply doing the
worker task itself.`**

Reserve 排除的是「自主非 Router 派工對同一 pool 的消耗」，不是「這份工作」——如果
Router 排除了 Terra / Sol / 一般 Luna worker，卻自己（同一個 Luna-max Router
session）接手執行同一份 worker-shaped 工作，額度仍然從同一個被保護的 pool 扣掉，
只是換了名字繼續消耗，reserve 形同虛設。這個繞過模式的名稱是
`ROUTER_RESERVE_SELF_CONSUMPTION`。

判定與處置：

- 某段工作依 [`WORKFLOW_POLICY.md`](WORKFLOW_POLICY.md) 的 *Operational Router
  execution boundary* 被歸類為 worker-shaped（`router_execution_class` 為任一
  `WORKER_*`），且該工作原本會落在目前處於 reserve band 的 pool 上時，
  Router **不得**改為自己直接執行來規避排除。
- 這與 Human override 不同：Human override 是 human 在 current instruction
  明確授權的例外，會記 `router_execution_source: HUMAN_EXPLICIT_OVERRIDE` 且
  綁定 task id / instruction revision；`ROUTER_RESERVE_SELF_CONSUMPTION` 是
  **沒有這個授權**、Router 自行決定繞過的情況，屬於違規，不是合法路徑。
- 找不到 eligible 的替代 provider/pool 時，正確結果是既有的
  `ROUTING_UNAVAILABLE` / `RESOURCE_BLOCKED` / `PERMISSION_BLOCKED` / human
  gate（哪一個由既有規則決定，此處不重複），**不是**「Router 自己做」。
- Execution class 的判定、control-plane probe 與 worker-shaped 工作的邊界，
  唯一 owner 是 `WORKFLOW_POLICY.md` 的 *Operational Router execution
  boundary*，本節不重複定義，只重申它與 reserve 的交互不得被繞過。

### 與既有 band / UNKNOWN 語意的關係

Router capacity reserve 讀的是 BUDGET window 的原始 `remaining_ratio`，門檻與
`conservation_pressure` 不同、且不與 proximity 交叉，因此是**獨立的訊號**，
但仍遵守既有的 fail-closed / neutral 慣例：

- 讀不到可信的 BUDGET remaining_ratio（entry 未過 source trust invariant、
  `state` 為 `UNKNOWN`、entry stale 或 reset-expired、confidence 低於
  `MEDIUM`、或該 pool 沒有任何 BUDGET window）→ band 為 `UNKNOWN`，**不觸發任何
  reserve 行為**。**不得因為讀不到就假設它是 healthy，也不得假設它是 scarce
  而預先啟動 reserve。**
- Weekly reset generation 已過期時，依既有 *Reset-boundary invalidation* 規則
  先 refresh；refresh 完成前該 entry 視為 `UNKNOWN`，reserve 判定同樣套用
  UNKNOWN 的中性處理。
- Reserve 的排除**不跨越** `GREEN` / `YELLOW` / `RED` / `UNKNOWN` 的 resource
  state band——它是額外的一層排除條件，不是替代 band 邏輯。
- Reserve 不影響 reviewer disjointness：disjointness 是更早一層的 hard filter，
  reserve 只在 disjointness 已經滿足的候選集合中進一步排除，兩者互不放寬對方。

### 記錄

Reserve 造成的排除，其理由已隨既有的 rejected-candidate 機制自然出現在
`ROUTING_UNAVAILABLE` / `POLICY_BLOCKED` 的 `reason` 字串中（標明
`router capacity reserve (<band>)`），不需要另建一份平行的排除記錄。
`router_reserve_override` 是唯一需要額外記錄的新欄位，且**只記標籤（band 名稱
與 boolean），不記 `remaining_ratio` 的數值**——與本文件其餘資源訊號的記錄慣例
一致。

## 不保存的內容

Router 保存決策快照與理由，**不保存原始 quota payload**、不保存 token、cookie、帳號識別資料或 provider 的原始回應。

## OpenUsage

OpenUsage 作為 provider quota aggregation 的 reference implementation，**不是 Windows workflow 的前置條件**。其 native app 目前要求 macOS 15+。Windows 上的 quota 自動偵測維持 experimental 與 optional；偵測不到時走 `UNKNOWN` 路徑，流程不因此停擺。
