# Model Routing Policy

Version: `0.6`
Status: normative

這份文件是 **task classification、capability stage 選擇、human override precedence、autonomous selection logic、evidence non-authority、flagship admission 與 escalation** 的 normative owner。

它刻意**不含任何模型名稱**。provider、model ID、reasoning value、fallback 次序、capability tier 與 capability stage 的**成員關係**全部屬於 [`MODEL_REGISTRY.yaml`](MODEL_REGISTRY.yaml)；即時 quota 狀態屬於 [`RESOURCE_AWARE_ROUTING.md`](RESOURCE_AWARE_ROUTING.md)；精確的 dispatch 命令語法與 reasoning 傳遞屬於 [`../references/OFFICIAL_COMMANDS.md`](../references/OFFICIAL_COMMANDS.md)。模型汰換只改 registry，不改這份文件——只有 workflow 本身改變時才改這裡。

`scripts/` 下的驗證程式是這份文件的 conformance checker，不是它的來源。程式與本文不一致時，修正程式。

## Task classification

Dispatch 前必須評估六個維度，全部為必填：

| 欄位 | 允許值 | 判定重點 |
|---|---|---|
| `risk` | `low` / `medium` / `high` / `critical` | 錯誤的影響範圍與可逆性 |
| `complexity` | `low` / `medium` / `high` | 跨模組程度、狀態空間、推理深度 |
| `context_size` | `small` / `medium` / `large` | 必須同時理解的 repository 或文件範圍 |
| `ambiguity` | `low` / `medium` / `high` | contract 與成功條件是否明確 |
| `change_intensity` | `none` / `localized` / `structural` | 唯讀、局部修改或結構性修改 |
| `verification_need` | `standard` / `independent` / `adversarial` | 一般驗證、獨立複核或邊界案例搜尋 |

另需記錄 `architecture_involvement` 與 `security_involvement`（boolean）。它們是**升級訊號**，不另建平行的分類系統。

### Risk is not capability requirement

**這是硬性不變式：`Risk does not equal capability requirement.`**

Task classification 必須把下面四件事**分開評估**，任何一項都不得推導另一項：

1. **capability difficulty** — 決定 **capability stage**（見下節 Stage admission）。只有 complexity / ambiguity / semantic coupling / structural change / prior failure 這類訊號能提高它。
2. **risk / blast radius** — 決定 **permission ceiling** 的嚴格度、是否需要 independent review、是否進 human gate。**不提高 capability stage。**
3. **verification need** — 決定 reviewer 的 disjointness 與 adversarial 需求。
4. **permission / human-gate requirement** — 決定 sandbox 旗標、`production_access`、`may_commit`、human gate。

具體後果：

- **Production-related 但機械上簡單的 config 驗證**：可以是 `STAGE_1_DEFAULT` capability + 嚴格 read-only permission + independent review + human gate。它**不得**因為「碰到 production」就自動變成 Stage 2/3。
- **Security-sensitive 但機械上簡單的 task**：可以維持 Stage 1/2，搭配更強的 review 與 gate。只有需要**對安全語意本身做推理**（RLS 設計、adversarial security 分析）才提高 stage。
- **高 `risk` 本身**、**「這個 task 很重要」**、**「測試很多」**：都**不是** stage 訊號。

## Registry is user-authoritative configuration

**硬性不變式：`Registry membership and enabled status are human-authoritative configuration, not an AI-generated capability verdict.`**

[`MODEL_REGISTRY.yaml`](MODEL_REGISTRY.yaml) 是**使用者配置**。它代表「這些是我允許這套 workflow 使用的候選模型，以及我希望它們在哪些 stage / role / reasoning 下被使用」。

AI（operational router）**不得**因為自己的下列判斷而讓一個 user-enabled 候選失去 routing 資格：

- 該模型 benchmark 是否夠好；
- 是否做滿 3–5 個 smoke case；
- `evidence_status` 是否足夠；
- AI 認為它是否「值得」stable；
- AI 認為另一個模型比較合理。

只要使用者把模型寫進 registry 並 `enabled: true`（或省略 `enabled`），它就是 **routing eligible**。AI 只能在**真正的 execution impossibility** 時拒絕它（見下方 *Hard execution eligibility*）。

### `enabled` 與 `status`

| 欄位 | 語意 |
|---|---|
| `enabled: true \| false` | **Human-authoritative。** `false` = 不要路由到這裡。缺欄位 → 視為 `true`（backward compatible）。這是**唯一**的 config gate。 |
| `status: stable \| experimental` | **Informational evidence metadata。** **不決定 execution eligibility。** `experimental` **不得**阻擋 user-enabled 的模型。 |
| `evidence_status` / `confidence` / `source` / `verified_at` | Informational。協助人類**未來**調整 registry，永遠不是 AI 的 routing gate。 |

`Evidence informs the human; it does not override human registry configuration.`

### `allow_experimental` 重新定義

`allow_experimental` 保留於 contract 中僅為 backward compatibility，**對 enabled 的 registry 候選沒有 routing 效果**。一個 `enabled: true`（或無 `enabled` 欄位）的候選不需要 `allow_experimental` 就可被選中。`allow_red` 不受影響——`RED` 是 resource state，不是 config gate。

### AI 不重排 model quality

AI **不得**：看 benchmark 後重排 registry、因某次任務失敗就永久降級模型、因 smoke case 結果把候選移出、因 evidence 不足標記不可用。AI **可以**：把 observation 記進 [`../references/MODEL_EVIDENCE.md`](../references/MODEL_EVIDENCE.md) 或 decision note。若 AI 認為 registry 應調整，走 `STRATEGIC_RETURN` 提出建議並進 **human gate**——只有 human 能改模型政策。

## Routing precedence（overall）

從 human 意圖到最終候選，precedence 固定為十一層，**下層不得推翻上層**：

```text
1.  latest explicit human model instruction   (pin: provider / model / reasoning)
2.  hard runtime / execution eligibility       (見下節)
3.  required capability stage
4.  functional role compatibility
5.  permission / security compatibility
6.  reviewer disjointness                       (provider AND model family)
7.  user-enabled registry candidates            (enabled: false → 排除)
8.  resource / quota state
9.  Router capacity reserve                     (見下方說明；語意屬 RESOURCE_AWARE_ROUTING.md)
10. provider-specific budget pressure
11. registry role preference / candidate order
```

**Evidence / benchmark 不在這條 chain 裡。** 第 3–11 層由 operational router 以下方 *Candidate 選擇演算法* 執行（該演算法的內部九層是這裡第 3–11 層的展開）。

第 9 層保護的是「承載 active Operational Router 的 resource pool」，不讓自主
（autonomous）的非 Router 派工把它耗盡；current human instruction 的明確 pin
（第 1 層）不受它約束。它**只排除**同一 resource pool 上的自主候選，不改變
capability stage 或 registry membership。門檻、band 定義與排除範圍的唯一 owner
是 [`RESOURCE_AWARE_ROUTING.md`](RESOURCE_AWARE_ROUTING.md) 的 *Router capacity
reserve* 章節，此處不重複。

### Hard execution eligibility

AI 可以且必須檢查、且**只有這些**能讓 AI 拒絕一個 user-enabled 候選：

- provider CLI 是否存在；
- model ID 是否真的能解析 / 呼叫；
- 要求的 reasoning control 是否被 runtime / CLI 支援；
- authentication 是否有效；
- permission ceiling 是否相容；
- runtime 是否能啟動；
- reviewer disjointness 是否可滿足；
- provider / model family identity 是否正確；
- user-requested configuration 是否技術上可實現。

任一項真的不可能 → `CONFIG_INVALID` / `ROUTING_UNAVAILABLE` / `PERMISSION_BLOCKED` 或其他既有正確的 blocked outcome。這是 AI 唯一可以拒絕執行的範圍。

## Human explicit model selection

若 human 在 **current instruction** 明確指定 provider / model（可含 reasoning），例如「Use Gemini 3.7 Flash low」或「Use Terra high」，operational router **必須**使用該模型（precedence 第 1 層），**除非 hard execution eligibility 失敗**。

**不得**因為 quota 不理想、benchmark、`evidence_status`、smoke-case 不足、AI preference 或 registry ranking 而換成其他模型。

- `pinnedCandidate` 若宣稱是 registry selection、但模型不在該 slot 的 candidate list → `CONFIG_INVALID`（技術上不可能，不是 silent substitution）。這不限制下方獨立記錄的 current `HUMAN_EXPLICIT_OVERRIDE`。
- pin 的模型 runtime 不可用 → `ROUTING_UNAVAILABLE`（誠實回報，不換模型）。
- pin 的模型與 implementer 不 disjoint（independent review）→ `POLICY_BLOCKED`（disjointness 是硬 filter，pin 不能覆蓋）。
- pin 的模型被 `enabled: false` → `POLICY_BLOCKED`（`enabled` 是 authoritative；交回 human 決定要 re-enable 或改選）。

### Selection provenance and autonomous registry enforcement

模型選擇必須帶有 `model_selection_source`，且只能是：

```text
REGISTRY_AUTONOMOUS | HUMAN_EXPLICIT_OVERRIDE | HUMAN_RETROACTIVE_ACCEPTANCE
```

`REGISTRY_AUTONOMOUS` 是唯一的 autonomous model source。選定的
`provider` / `model` / `model_family` / `reasoning_effort` 必須逐欄對應指定 slot
中 `enabled`（缺省視為 true）的 registry candidate，並且是在 provider/model-family
disjointness 等 hard filters 通過之後得到的結果。找不到對應 candidate 必須在
dispatch 前回傳 `AUTONOMOUS_CANDIDATE_REJECTED`；resource overlay、Orca default、
Codex local config、既有 terminal、generic reviewer helper 或 Superpowers 都不能
補入 slot 外模型。

`HUMAN_EXPLICIT_OVERRIDE` 表示 current human instruction 明確指定一個 task-local
model。它可以位於一般 slot candidate list 之外，但必須記錄 provider、model、
model_family、reasoning、task id 與 current instruction revision，並仍受 hard
execution、permission 與 reviewer disjointness 約束。這個 override 不得修改
`MODEL_REGISTRY.yaml`，也不得被帶到另一個 task；revision 不一致就是
`HUMAN_OVERRIDE_STALE`。

`HUMAN_RETROACTIVE_ACCEPTANCE` 只可用來記錄一個已完成 dispatch 的歷史裁量。它不會
將實際模型變成 registry candidate，也不能授權新的 autonomous dispatch。一次已接受
的 unregistered reviewer 不構成 registry 變更。

## Capability tier

能力有一條可比較的四階 ladder，保留作為 backward-compatible 的底層：

```text
CHEAP < DEFAULT < STRONG < DEEP
```

**只有這四個值可以互相比較。** Candidate 的 `capability_tier` 與 slot 的 `minimum_tier` 都取自這條 ladder，比較方式是 ladder 上的索引大小。

## Capability stage

`stage` 是 routing 實際推理的能力帶，位於 `capability_tier` **之上**。四個 tier 被 partition 進三個 stage（見 [`MODEL_REGISTRY.yaml`](MODEL_REGISTRY.yaml) 的 `stages` 區塊）：

| Stage | 內含 tier | 代表模型（由 registry 決定，此處僅說明語意） | 用途 |
|---|---|---|---|
| `STAGE_1_DEFAULT` | `CHEAP`, `DEFAULT` | 便宜但能力足夠的高頻主力 | 大多數日常工作 |
| `STAGE_2_ADVANCED` | `STRONG` | advanced peer set | 正常的 escalation tier |
| `STAGE_3_FLAGSHIP` | `DEEP` | flagship escalation resources，非 routine worker | 例外情況 |

`role` 說的是 agent **做什麼**（ROUTER / IMPLEMENTER / DISCOVERY / INDEPENDENT_REVIEWER / REGRESSION_HUNTER / ESCALATION）。`stage` 說的是**需要多少能力**。兩者正交，**不得互相推導**：`INDEPENDENT_REVIEWER` 這個 role 不隱含 Stage 3；一個 Stage 1 的 review task 就用 Stage 1 的 reviewer。

candidate 的 `stage` 必須是包含它 `capability_tier` 的那個 stage。Slot 的 `stage` 是它 admit 的 stage，且必須與它的 `minimum_tier` 一致。

### 與舊命名的相容

Legacy 只寫 `minimum_tier` 的 contract 依下表 deterministic 對應，**不做其他重新解讀**：

| Legacy `minimum_tier` | Stage |
|---|---|
| `CHEAP` / `DEFAULT` | `STAGE_1_DEFAULT` |
| `STRONG` | `STAGE_2_ADVANCED` |
| `DEEP` | `STAGE_3_FLAGSHIP` |

**不得把 legacy `STRONG_IMPLEMENTER` 重新解讀為 Stage 3。** `STRONG` 對應 Stage 2。若某個 legacy contract 依當下 classification 與 slot 語意找不到安全對應，回 `HUMAN_GATE`，不猜測、不做 schema break。

## Stage admission

### Stage 1 — 預設

`STAGE_1_DEFAULT` 是**大多數 task 的預設**。除非有具體證據顯示 Stage 1 不足，否則就用 Stage 1。

例：bounded implementation、清楚的 contract、一般 refactor、test-backed repair、documentation、repo inspection、ordinary reviewer task、routine router operation。

### Stage 2 admission

需要**至少一個** advanced signal：

- `complexity == high`
- `ambiguity == high`（substantial contract ambiguity）
- `change_intensity == structural`（cross-module / 結構性）
- `architecture_involvement == true`（architecture reasoning）
- `security_involvement == true` **且** `complexity != low` 或 `ambiguity != low`（安全/RLS 語意推理，不只是「碰到安全設定」）
- `verification_need == adversarial`
- high semantic coupling
- **Stage 1 attempt 已失敗**

`risk` 單獨不足以進 Stage 2。

### Stage 3 admission

需要**例外證據**，其中之一：

- **Stage 2 failed to converge**（`prior_stage == STAGE_2` 且失敗）
- qualified reviewer 之間**無法在 Stage 2 解決的分歧**
- **major irreversible architectural decision** 且帶 **material ambiguity**（`irreversible == true` 且 `ambiguity == high`）
- **adversarial security analysis**（`security_involvement == true` 且 `verification_need == adversarial`）
- 例外困難的 multi-stage agentic execution
- 例外的 production incident 分析
- **explicit human authorization** for flagship use

Stage 3 必須是**罕見**的。

### 不會提高 stage 的訊號（明確）

- **高 `risk` 本身** → 不進 Stage 3，通常也不進 Stage 2。
- **production-related 本身** → 不進 Stage 3。
- **測試數量多 / task 重要** → 不進 Stage 3。

## Role tags

以下是**正交的 role tag，不參與高低比較**：

```text
ROUTER, IMPLEMENTATION, LONG_CONTEXT_DISCOVERY,
INDEPENDENT_REVIEWER, REGRESSION_HUNTER, ESCALATION
```

Role 與 slot 名稱**永遠不得**被當成 capability tier 或 capability stage 來比較。Execution contract 必須同時記錄 `role`、`slot`、`selected_stage` 與 `minimum_tier`。

## Slot decision table

高風險規則優先於成本規則。每一列同時給出 role、stage 與 slot。

| 條件 | Role | Stage | Slot | Minimum tier |
|---|---|---|---|---|
| 路由、拆解、contract 撰寫與 gate 判定 | `ROUTER` | `STAGE_1_DEFAULT` | `ROUTER` | `DEFAULT` |
| 低風險文件整理、格式化、查找、bounded inventory | `IMPLEMENTATION` | `STAGE_1_DEFAULT` | `CHEAP_GENERALIST` | `CHEAP` |
| 規格清楚、局部、可由明確測試驗收的一般實作 | `IMPLEMENTATION` | `STAGE_1_DEFAULT` | `DEFAULT_IMPLEMENTER` | `DEFAULT` |
| 跨模組、結構性 bug、複雜 migration、需多次互動的實作（Stage 2 signal 成立） | `IMPLEMENTATION` | `STAGE_2_ADVANCED` | `STRONG_IMPLEMENTER` | `STRONG` |
| architecture reasoning、contract ambiguity、security/RLS 語意、hard debugging（Stage 2 signal 成立，但**非** irreversible+ambiguous） | `ROUTER` | `STAGE_2_ADVANCED` | `DEEP_REASONER` | `STRONG` |
| 大型 repository、跨 repo inventory、schema/API 大範圍比較 | `LONG_CONTEXT_DISCOVERY` | `STAGE_1_DEFAULT` | `LONG_CONTEXT_DISCOVERY` | `DEFAULT` |
| 與實作者不同 provider 與 model family 的獨立檢查 | `INDEPENDENT_REVIEWER` | 依 task capability difficulty（見 Stage admission） | `INDEPENDENT_REVIEWER` | `DEFAULT` |
| 測試失敗、回歸、邊界案例、adversarial validation | `REGRESSION_HUNTER` | 依 failure 難度，預設 `STAGE_1_DEFAULT` | `REGRESSION_HUNTER` | `DEFAULT` |
| Stage 2 無法收斂、reviewer disagreement、irreversible+ambiguous、adversarial security、exceptional risk、human-authorized flagship | `ESCALATION` | `STAGE_3_FLAGSHIP` | `ESCALATION_MODEL` | `DEEP` |

`auth / RBAC / RLS` 與其他不可逆決策：**它們是 human gate 觸發條件（見 [`WORKFLOW_POLICY.md`](WORKFLOW_POLICY.md)），不自動等於 Stage 3。** 先回 human；capability stage 仍依 Stage admission 判定。

## Discovery、implementation 與 review 分開記錄

同一個 task 若符合多個 slot，**discovery slot、implementation slot 與 review slot 必須分開記錄**，不得合併。每個 slot 各自跑一次 Stage admission。

例：大型跨 repo 修改先以 `LONG_CONTEXT_DISCOVERY`（Stage 1）盤點、以 `STRONG_IMPLEMENTER`（Stage 2）實作、再以 `INDEPENDENT_REVIEWER`（Stage 依 review 難度）複核。**discovery 模型不得預設成為 implementation owner。**

拆分同樣適用於單一 task 內部：低風險且可由明確測試驗收的步驟可以走較低的 stage，即使其所屬 task 整體較高。反之不成立——Stage 2/3 的步驟不得因為所屬 task 整體較低而降級。

## Model-role preferences（tie-break only）

以下是 **tie-break preference，不是硬能力規則**，只在候選已通過 eligibility / tier / stage / disjointness / resource 全部檢查後，作為 registry order 之前的最後一層排序。

| 模型家族語意 | 偏好於 |
|---|---|
| Luna | Router、routine implementation、bounded repair、一般 repo 工作、tests/docs、disjoint 時的 ordinary review |
| Gemini Flash | quota relief、long-context discovery、broad repo inspection、regression hunting、qualified 時的 independent review、Stage 1 low-effort 替代、Stage 2 high-effort 的緊急替代（Codex/Claude budget 吃緊時） |
| Terra | advanced implementation、difficult code reasoning、跨模組技術工作、difficult structured review |
| Sonnet 5 | architecture、contracts、security reasoning、difficult independent review、semantic ambiguity |
| Sol | 極重 terminal 的實作、長多步 agentic execution、difficult structural repair、flagship-level execution |
| Opus 5 | novel reasoning、architecture disputes、deep design review、difficult semantic/security adjudication、flagship-level review/reasoning |

**不得**把 Gemini Flash 當成自動具備 flagship 能力。**不得**因為 implementer 是 Claude 就自動把 reviewer 升成 Sol。若唯一剩下的 disjoint stable candidate 相對 task 需求過強，優先設法讓另一個合適的 provider/model 具備資格，而不是預設用 flagship。

## Candidate 選擇演算法

**此演算法由 operational router 執行**，因為它需要讀 `MODEL_REGISTRY.yaml` 與即時 resource state。Strategic router 只指定 `role`、`slot`、`selected_stage` 與 `minimum_tier`（能力需求），不指名具體模型。

輸入：slot、`minimum_tier`、`selected_stage`、registry 的 ordered candidates、resource state snapshot、task context、（optional）role-preference 清單。

排序優先級固定為九層，**下層永遠不能推翻上層**：

```text
0. explicit human model pin       (見上方 Human explicit model selection；命中且通過 hard eligibility 即直接選中)
1. policy eligibility            (enabled: false → 排除；allow_red；minimum capability tier)
2. required capability stage     (candidate.stage 索引 >= slot.stage；flagship 只在 required stage 為 STAGE_3 時可入)
3. security / permission constraints
4. independent-review disjointness   (provider AND model family)
5. availability / resource state band
接著（只在第 1–5 層都已滿足的候選之間）：
6. Router capacity reserve       (只排除承載 active Router 的 resource pool 上的自主非 Router 候選；不作用於已通過第 0 層的 pin)
7. long-horizon conservation     (BUDGET scarcity — 防守；並含 BUDGET expiry opportunity — 進攻)
8. short-horizon opportunity      (BURST stranded capacity)
9. registry preference
```

第 2 層是新的硬門檻：**quota、burst opportunity 或 model-role preference 都不能把候選拉低到 slot 要求的 stage 之下，也不能把 Stage 3 模型拉進 Stage 1/2 的 slot。** 「快要 reset 的閒置額度」不得把 flagship 模型帶進 Stage 1/2。`minimum capability tier` 併入第 1 層：stage 已隱含 tier 下限，額外的 tier 檢查只是 fail-closed 的第二道。

第 6 層是一個 **exclusion**，不是 reorder，與第 1、2、4 層同性質：只在候選的 resource pool 與 active Router 目前所在的 resource pool相同、且該 slot 本身不是 `ROUTER` slot 時才評估；命中即整個排除該候選，不進入第 7、8 層的排序。門檻、band 定義由 [`RESOURCE_AWARE_ROUTING.md`](RESOURCE_AWARE_ROUTING.md) 的 *Router capacity reserve* 定義，此處不重複。

第 7、8 層只在前六層都已滿足的候選之間比較，且**第 7 層優先於第 8 層**——scarcity first, utilization second。第 7 層內部順序為 **conservation（降級）→ BUDGET expiry opportunity（升級）**：`BUDGET scarcity MUST override BUDGET expiry opportunity`，因此 expiry promotion 只作用於自身 `conservation_pressure` 不是 `HIGH` / `CRITICAL` 的候選。**Model-role preference 是第 9 層的一部分**：在 registry order 之前、所有資源訊號之後，作為最後一層 tie-break。三個資源訊號（`conservation_pressure`、`budget_expiry_opportunity`、`stranded_capacity_risk`）的推導矩陣、門檻與可重排範圍由 [`RESOURCE_AWARE_ROUTING.md`](RESOURCE_AWARE_ROUTING.md) 定義，此處不重複。

1. 若 contract 帶 explicit human model pin：先確認該 model 在此 slot 的 candidate list（否則 `CONFIG_INVALID`），再走第 2–3 步的 hard eligibility（**不含第 6 層 Router capacity reserve**——human pin 排在 reserve 之前，見上）；通過即直接回傳該候選（不進 band / reserve / conservation / opportunity / preference 排序），否則以該候選自身的失敗原因回傳對應 blocked code。
2. 從指定 slot 讀取 registry 的 ordered `candidates`（順序具有意義），並檢查每個候選的 resource entry 是否通過 **source trust invariant**（見 [`RESOURCE_AWARE_ROUTING.md`](RESOURCE_AWARE_ROUTING.md)）：沒有宣告 `source`、`source` 不在允許集合、或 `source: UNKNOWN` 卻宣告非 `UNKNOWN` 的 state，一律 **fail closed**。完全沒有 entry 是「沒有讀數」，視為 `UNKNOWN`，正常參與排序。
3. 移除下列候選：
   - `enabled` 為 `false`（human-authoritative；**唯一的 config gate**。`status` / `evidence_status` 不在此列）；
   - `available` 為 false；
   - `stage` 在 stage 順序上低於 slot 的 `stage`；
   - `capability_tier` 在 ladder 上低於 slot 的 `minimum_tier`；
   - 進行 independent review 時，與 implementer **相同 provider 或相同 model family** 的候選；
   - 該 slot 不是 `ROUTER` slot，且候選的 resource pool 與 active Router 目前所在的 resource pool 相同、該 pool 的 Router capacity reserve band 不是 `NORMAL`——除非此候選正是通過第 0 層 pin 選中的候選。
4. 若存在合格的 `GREEN` 候選，進入 band 內排序；否則在 `YELLOW` 與 `UNKNOWN` 之間**維持 registry 順序**；再否則（且 `allow_red` 為 true）才用 `RED`。`YELLOW` 與 `UNKNOWN` 之間不建立優先級。
5. Band 內排序：先由 registry 順序決定 head。`RESOURCE_AWARE_ROUTING.md` 的三個資源訊號只在與 head 相同 resource state 的候選之間作用，順序固定為先 conservation、後 opportunity——精確為 conservation 降級（`HIGH`/`CRITICAL`）→ BUDGET expiry 升級（`budget_expiry_opportunity` 為 `HIGH` 且自身 conservation 非 `HIGH`/`CRITICAL`）→ BURST 升級（`HIGH` stranded 且自身 conservation 為 `NONE`/`LOW`，且 expiry 未先移動選擇）。
6. **Model-role preference tie-break**（第 9 層）：在第 5 步的結果上，若 caller 提供 role-preference 清單，把 `model` 命中清單的候選（依清單順序）穩定地排到前面——但 opportunity 的 promotion（第 8 層）仍優先於此。都沒有 preference 時維持 registry 順序。
7. 任何重排或排除都必須記入 routing evidence（見下方 Flagship admission 與 `RESOURCE_AWARE_ROUTING.md` 的記錄規則）。**只記標籤，不記數值。**
8. 成功時回傳 `{status: SELECTED, candidate, selected_stage, ...}`。
9. 沒有合格候選時，**不得跨越 `minimum_tier` 或 `stage`，也不得放棄 independent review 的 disjointness**。回傳 `{status: BLOCKED, code, reason}` 並進 human gate——這同樣是「Router capacity reserve 排除到剩下沒有候選」時的正確結果，不得為了避免它而靜默耗用 reserve。

Resource overlay **只能在達到相同 `minimum_tier`、相同 `stage` 的候選之間重排**。它不能把需要 Stage 2 的任務改派給 Stage 1 候選，不能改變 architecture authority，也不能繞過 human gate。

### 授權旗標歸屬

`allow_red` 是 **human 在 strategic contract 中的授權決定**，預設 `false`：`RED` 候選只有在 `allow_red` 為 true 時才會被選。**Operational router 只讀取它，不得自行翻轉。**

`allow_experimental`（與 `experimental_justification`）在 contract schema 中保留供 backward compatibility，但如上方 *`allow_experimental` 重新定義* 所述，**對 enabled 的 registry 候選沒有 routing 效果**——`enabled` 已是唯一的 config gate。舊 contract 帶著它不會出錯，也不需要它。

## Flagship admission

任何選中 `stage: STAGE_3_FLAGSHIP` slot 的 routing 決策，**必須**在 routing evidence 中記錄一段 flagship admission：

```yaml
flagship_admission:
  escalation_reason:            # 對應 Stage 3 admission 清單中的哪一項
  why_stage_2_insufficient:     # 具體說明，不得只寫「風險高」
  prior_stage_2_attempt_failed: # true | false
  human_authorization:          # required_and_provided | not_required | MISSING
```

**沒有 flagship admission 的 Stage 3 選擇不合法**，conformance checker 會將其標為 finding。這是對「Sol and Opus are flagship escalation resources, not routine workers」的機械保障。不設全域百分比上限，但**每一次 flagship 使用的理由都必須可稽核**。

## Reasoning effort is part of execution identity

```text
provider + model + model_family + reasoning_effort is the execution identity.
```

`reasoning_effort` 與 provider、model、model family 同等，是 dispatch 必須明確傳遞的欄位，不是可省略的細節。Registry 的 `reasoning:` 是該候選的**預設** effort；只有在 task evidence 支持時才可調高（例如 Stage 3 從 `medium` 調到 `high`），且**不得**把任何模型預設為 `max`（Luna 例外，由 registry 明確指定）。

**Codex dispatch 一律在命令列明確傳入 reasoning，永不繼承 local config。** 本機 `~/.codex/config.toml` 的 `model_reasoning_effort` 會靜默覆蓋未明示的值（實測：local config 設 `max` 會把 registry 的 `medium` 靜默提升成 `max`）。精確語法、各 provider 的機制差異與 runtime attestation 由 [`../references/OFFICIAL_COMMANDS.md`](../references/OFFICIAL_COMMANDS.md) 定義。

Dispatch 前後的 contract attestation（expected vs actual 的 `provider` / `model` /
`model_family` / `reasoning_effort` 比對）與
`DISPATCH_IDENTITY_MATCH` / `DISPATCH_IDENTITY_UNVERIFIED` /
`DISPATCH_CONTRACT_MISMATCH` 的處置，語意由 [`WORKFLOW_POLICY.md`](WORKFLOW_POLICY.md)
的 Execution lifecycle semantics 定義。它**不是** `ROUTING_UNAVAILABLE`。

## Blocked reason codes

`BLOCKED` 必須附一個 reason code：

| Code | 意義 | 誰能解除 |
|---|---|---|
| `CONFIG_INVALID` | slot、`capability_tier_order`、`stages` 或 `minimum_tier` 本身不符 schema | 修設定 |
| `ROUTING_UNAVAILABLE` | 存在**只差可用性**的候選——provider 恢復後即合格 | 等待或補候選 |
| `POLICY_BLOCKED` | 所有候選都被政策排除（experimental 未授權、低於 `minimum_tier` 或 `stage`、與 implementer 不 disjoint） | 只有 human 能決定 |
| `RESOURCE_BLOCKED` | 有合格候選但全為 `RED`，且本 task 不允許 `RED` | 等待重置或 human 明確放行 |
| `PERMISSION_BLOCKED` | 完成任務所需權限超出 permission ceiling | human 調整 ceiling 或改做法 |

判定規則：只要存在**唯一失敗原因是 unavailable** 的候選，就是 `ROUTING_UNAVAILABLE`；否則為 `POLICY_BLOCKED`。候選的每個條件都必須完整評估，不得短路。

`PERMISSION_BLOCKED` 不由 candidate 選擇產生，發生在 permission ceiling 的比對階段。

### Execution state 不是 blocked reason code

執行過程的觀察狀態（`ACTIVE` / `QUIET` / `STALLED` / `MAX_TURNS_REACHED` / `DISPATCH_CONTRACT_MISMATCH` 等）由 [`WORKFLOW_POLICY.md`](WORKFLOW_POLICY.md) 的 Execution lifecycle semantics 定義，**它們不是 reason code**。

以下一律**不得**標為 `PERMISSION_BLOCKED` 或 `ROUTING_UNAVAILABLE`：模型執行時間長、polling window 逾時、尚未產出最終結論、terminal 暫時無輸出、長時間推理、`Reached max turns`、reasoning-effort mismatch。

## Independent review 的 disjointness

當 `verification_need` 為 `independent` 或 `adversarial` 時，reviewer 的 provider 與 model family **都必須**與 implementer 不同。這是 resource optimization **之前**的硬 eligibility filter，quota 不能推翻它。

「不同 provider 但同一 model family」（例如透過 Antigravity 取用的 Claude 家族模型，對上 Claude 實作者）**仍算 share**，一樣排除。

找不到 disjoint 候選時回傳 `BLOCKED`，交由 human 決定。**不得**以「同 provider 不同模型」充當 independent review。

Reviewer 的 capability stage 依 task 需求（見 Stage admission），不因 role 名稱而預設 Stage 3。

## Escalation

升級或停止的條件：

- `failed_repair_count >= max_repair_attempts`（由 slot 定義，預設 2）；
- 出現 architecture 或 security 問題；
- ownership conflict；
- reviewer disagreement；
- 不可逆風險。

**初次 implementation attempt 不計入 `failed_repair_count`。** **Continuation 也不計入 `failed_repair_count`。** **Stale continuation 同樣不計入 `failed_repair_count`。**

Stage escalation 一律逐級：`STAGE_1 → STAGE_2 → STAGE_3 / human gate`，不得從 Stage 1 直接跳 Stage 3，除非 Stage 3 admission 的例外證據獨立成立（例如 human-authorized flagship）。到達上限時升級 stage 或進 human gate，不得無限重試。Repair 必須交回單一 implementation owner。

### Execution failure vs task-quality failure

兩者處置不同，**不得混淆**：

| 類型 | 例子 | 處置 |
|---|---|---|
| **Execution failure** | model ID 不存在、CLI 不支援要求的 reasoning、authentication 失敗、runtime crash | 可標 runtime unavailable / `CONFIG_INVALID` / `ROUTING_UNAVAILABLE` |
| **Task-quality failure** | 模型第一次 implementation 做錯、review 沒抓到 bug、需要 repair | 正常 `failed_repair_count` / escalation 流程 |

Task-quality failure **不得**造成把模型標 `experimental`、把 `enabled` 改成 `false`、或從 registry 移除。AI 可以在 `MODEL_EVIDENCE.md` 或 decision note 記錄 observation（例如「Terra 在兩次 migration task 需要多次 repair」），並可在 `STRATEGIC_RETURN` 中**建議** registry 調整——但實際修改只由 human 決定。

## 新模型 / registry 演進

registry 是使用者配置。加入或移除模型、改 `enabled`、改 `stage` / `reasoning` / candidate order 都是 **human 的決定**，只改 [`MODEL_REGISTRY.yaml`](MODEL_REGISTRY.yaml)，不改 stable workflow。

Smoke case 仍有價值——用來驗證 invocation、permission、reasoning propagation、runtime compatibility，並記錄模型實際表現——但**不是**「做滿 3–5 次之前不能使用」的門檻，`evidence_status: provisional` 也**不**造成 routing exclusion。`status: experimental → stable` 是 human 依累積 evidence 做的 **informational** 標籤更新，不影響已 `enabled` 候選的 eligibility。
