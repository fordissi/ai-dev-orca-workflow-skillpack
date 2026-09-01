# Model Routing Policy

Version: `0.3`
Status: normative

這份文件是 **task classification、capability slot 選擇、candidate 演算法與 escalation** 的 normative owner。

它刻意**不含任何模型名稱**。provider、model ID、reasoning value、fallback 次序與能力標籤全部屬於 [`MODEL_REGISTRY.yaml`](MODEL_REGISTRY.yaml)；即時 quota 狀態屬於 [`RESOURCE_AWARE_ROUTING.md`](RESOURCE_AWARE_ROUTING.md)。模型汰換只改 registry，不改這份文件——只有 workflow 本身改變時才改這裡。

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

另需記錄 architecture involvement 與 security involvement。它們是**升級訊號**，不另建平行的分類系統。

## Capability tier

能力只有一條可比較的四階 ladder：

```text
CHEAP < DEFAULT < STRONG < DEEP
```

**只有這四個值可以互相比較。** Candidate 的 `capability_tier` 與 slot 的 `minimum_tier` 都取自這條 ladder，比較方式是 ladder 上的索引大小。

## Role tags

以下是**正交的 role tag，不參與高低比較**：

```text
ROUTER, IMPLEMENTATION, LONG_CONTEXT_DISCOVERY,
INDEPENDENT_REVIEWER, REGRESSION_HUNTER, ESCALATION
```

Role 與 slot 名稱**永遠不得**被當成 capability tier 來比較。Execution contract 必須同時記錄 `role`、`slot` 與 `minimum_tier` 三者。

## Slot decision table

高風險規則優先於成本規則。

| 條件 | Role | Slot | Minimum tier |
|---|---|---|---|
| 路由、拆解、contract 撰寫與 gate 判定 | `ROUTER` | `ROUTER` | 依 task risk，至少 `DEFAULT` |
| 低風險文件整理、格式化、查找、bounded inventory | `IMPLEMENTATION` | `CHEAP_GENERALIST` | `CHEAP` |
| 規格清楚、局部、可由明確測試驗收的一般實作 | `IMPLEMENTATION` | `DEFAULT_IMPLEMENTER` | `DEFAULT` |
| 跨模組、結構性 bug、複雜 migration、需多次互動的實作 | `IMPLEMENTATION` | `STRONG_IMPLEMENTER` | `STRONG` |
| architecture、contract ambiguity、auth/RBAC/RLS、安全或不可逆決策 | `ROUTER` | `DEEP_REASONER` | `DEEP` |
| 大型 repository、跨 repo inventory、schema/API 大範圍比較 | `LONG_CONTEXT_DISCOVERY` | `LONG_CONTEXT_DISCOVERY` | 由 registry 明定，至少 `DEFAULT` |
| 與實作者不同 provider 或 model family 的獨立檢查 | `INDEPENDENT_REVIEWER` | `INDEPENDENT_REVIEWER` | 依 task risk，至少 `DEFAULT` |
| 測試失敗、回歸、邊界案例、adversarial validation | `REGRESSION_HUNTER` | `REGRESSION_HUNTER` | 依 failure severity，至少 `DEFAULT` |
| 合格候選無法收斂、reviewer disagreement、exceptional risk | `ESCALATION` | `ESCALATION_MODEL` | `DEEP` |

## Discovery、implementation 與 review 分開記錄

同一個 task 若符合多個 slot，**discovery slot、implementation slot 與 review slot 必須分開記錄**，不得合併。

例：大型跨 repo 修改先以 `LONG_CONTEXT_DISCOVERY` 盤點、以 `STRONG_IMPLEMENTER` 實作、再以 `INDEPENDENT_REVIEWER` 複核。**discovery 模型不得預設成為 implementation owner。**

拆分同樣適用於單一 task 內部：若某個步驟本身低風險且可由明確測試驗收，它可以走較低的 slot，即使其所屬 task 整體需要更高的 tier。反之不成立——高風險步驟不得因為所屬 task 整體較低而降級。

## Candidate 選擇演算法

**此演算法由 operational router 執行**，因為它需要讀取 `MODEL_REGISTRY.yaml` 與即時 resource state。Strategic router 只負責指定 `role`、`slot` 與 `minimum_tier`（能力需求），不指名具體模型：它**不得依賴** local registry 或 live quota 的可見性，因此直接指名模型即是猜測。詳見 [`WORKFLOW_POLICY.md`](WORKFLOW_POLICY.md) 的角色切分。

輸入：slot、`minimum_tier`、registry 的 ordered candidates、resource state snapshot、task context。

排序優先級固定為七層，**下層永遠不能推翻上層**：

```text
1. policy eligibility
2. minimum capability tier
3. security / permission constraints
4. independent-review disjointness
5. availability / resource state
6. long-horizon conservation（BUDGET scarcity）
7. short-horizon opportunity（BURST stranded capacity）
8. registry preference
```

第 6、7 層只在前五層都已滿足的候選之間比較，且**第 6 層優先於第 7 層**——
scarcity first, utilization second。它們是 routing signal，不是 capability
authority：無法讓不合格的候選變得合格，也無法改變 architecture authority 或
human gate。window role、conservation pressure、stranded capacity 的推導規則、
門檻與可重排的範圍由
[`RESOURCE_AWARE_ROUTING.md`](RESOURCE_AWARE_ROUTING.md) 的
Hierarchical quota windows 章節定義，此處不重複。

1. 從指定 slot 讀取 registry 的 ordered `candidates`（順序具有意義）。
2. 檢查每個候選的 resource entry 是否通過 **source trust invariant**（見
   [`RESOURCE_AWARE_ROUTING.md`](RESOURCE_AWARE_ROUTING.md)）：沒有宣告 `source`、
   `source` 不在允許集合、或 `source: UNKNOWN` 卻宣告非 `UNKNOWN` 的 state，
   一律 **fail closed**——該候選不具資格，且其宣告的 state 不予採信。
   **不得把不可信的 `GREEN` 悄悄正規化成可用資格**，也不得只降級為 `UNKNOWN`
   後讓它照 registry 順序勝出。
   完全沒有 entry 是另一回事：那是「沒有讀數」，視為 `UNKNOWN`，正常參與排序。
3. 移除下列候選：
   - `available` 為 false；
   - `status: experimental` 且 `allow_experimental` 未為 true；
   - `capability_tier` 在 ladder 上低於 slot 的 `minimum_tier`；
   - 進行 independent review 時，與 implementer **相同 provider 或相同 model family** 的候選。
4. 若存在合格的 `GREEN` 候選，依 registry 順序取第一個。
5. 否則在 `YELLOW` 與 `UNKNOWN` 之間**維持 registry 順序**取第一個合格候選。`YELLOW` 與 `UNKNOWN` 之間不建立優先級；`UNKNOWN` 不因缺少資料而被懲罰或獎勵。
6. 上述任一 band 內部的先後，先由 registry 順序決定 head。`RESOURCE_AWARE_ROUTING.md` 的兩個資源訊號**只能在與 head 相同 resource state 的候選之間**作用，且順序固定為先 conservation、後 opportunity：長期預算吃緊的候選先被降級，之後才輪到短窗機會把候選提前。沒有可用訊號時維持 registry 順序。任何重排都必須記入 routing evidence。
7. `RED` 只在沒有任何非 `RED` 合格候選、且 `allow_red` 為 true 時使用，並在 contract 中記錄理由。
8. 沒有合格候選時，**不得跨越 `minimum_tier`，也不得放棄 independent review 的 disjointness**。回傳 `{status: BLOCKED, code, reason}` 並進 human gate。
9. 成功時回傳 `{status: SELECTED, candidate}`。Router 保存此次決策快照與理由，但不保存原始 quota payload。

Resource overlay **只能在達到相同 `minimum_tier` 的候選之間重排**。它不能把需要 `DEEP` 的任務改派給 `CHEAP` 候選，也不能改變 architecture authority。 這對 resource state、conservation pressure 與 stranded capacity 一體適用：**quota opportunity cost 是 routing signal，不是 capability authority**，且 **short-window opportunity 不得推翻 long-horizon scarcity。**

### 授權旗標歸屬

`allow_experimental` 與 `allow_red` 是 **human 在 strategic contract 中的授權決定**，
兩者預設為 `false`。`allow_experimental` 為 true 時必須同時載明
`experimental_justification`。

**Operational router 只讀取這兩個值，不得自行決定，也不得為了把 `BLOCKED` 變成
`SELECTED` 而翻轉它們。** 需要授權時交回 human gate。這條規則存在的理由是：
若 router 能自行放寬，能力下限與 experimental 隔離就形同虛設。

## Blocked reason codes

`BLOCKED` 必須附一個 reason code。理由是「不能做」與「做不到」需要不同處置，
把兩者混成一個 `BLOCKED` 會讓上層無法判斷該等待、該補設定，還是該找人決策。

| Code | 意義 | 誰能解除 |
|---|---|---|
| `CONFIG_INVALID` | slot、`capability_tier_order` 或 `minimum_tier` 本身不符 schema | 修設定 |
| `ROUTING_UNAVAILABLE` | 存在**只差可用性**的候選——provider 恢復後即合格 | 等待或補候選 |
| `POLICY_BLOCKED` | 所有候選都被政策排除（experimental 接高風險、低於 `minimum_tier`、與 implementer 不 disjoint） | 只有 human 能決定 |
| `RESOURCE_BLOCKED` | 有合格候選但全為 `RED`，且本 task 不允許 `RED` | 等待重置或 human 明確放行 |
| `PERMISSION_BLOCKED` | 完成任務所需權限超出 permission ceiling | human 調整 ceiling 或改做法 |

判定規則：只要存在**唯一失敗原因是 unavailable** 的候選，就是 `ROUTING_UNAVAILABLE`；
否則為 `POLICY_BLOCKED`。因此候選的每個條件都必須完整評估，不得短路——
短路會讓「等一下就好」與「政策就是不允許」變得無法區分。

`PERMISSION_BLOCKED` 不由 candidate 選擇產生，它發生在 permission ceiling 的比對階段，
由 operational router 在組 `dispatch_command` 時判定。

**不得為了把 `BLOCKED` 變成 `SELECTED` 而降低 `minimum_tier`、放棄 disjointness 或提高權限。**

### Execution state 不是 blocked reason code

執行過程的觀察狀態（`ACTIVE` / `QUIET` / `STALLED` / `MAX_TURNS_REACHED` 等）由
[`WORKFLOW_POLICY.md`](WORKFLOW_POLICY.md) 的 Execution lifecycle semantics 定義，
**它們不是 reason code，也不會自動變成 reason code。**

以下一律**不得**標為 `PERMISSION_BLOCKED`：

- 模型執行時間長；
- polling window 逾時；
- 尚未產出最終結論；
- terminal 暫時沒有輸出；
- 長時間推理；
- `Reached max turns` 等 execution budget 用盡。

`PERMISSION_BLOCKED` 只在**完成任務所需的操作超出 permission ceiling** 時使用，
例如：reviewer 必須讀 repo 但 ceiling 不允許任何讀取路徑、implementation 必須寫入
但 ceiling 為唯讀、task 明確需要 network 但 network 已關閉。

同理，`ROUTING_UNAVAILABLE` 指的是候選**只差可用性**；session 仍在執行、只是慢或安靜，
不屬於此碼。execution budget 用盡也不屬於此碼——它走 bounded continuation。

## Independent review 的 disjointness

當 `verification_need` 為 `independent` 或 `adversarial` 時，reviewer 的 provider 與 model family **都必須**與 implementer 不同。

找不到 disjoint 候選時回傳 `BLOCKED`，交由 human 決定要等待、放寬條件或改用其他驗證方式。**不得**以「同 provider 不同模型」充當 independent review。

## Escalation

升級或停止的條件：

- `failed_repair_count >= max_repair_attempts`（`max_repair_attempts` 由 slot 在 registry 中定義，預設 2）；
- 出現 architecture 或 security 問題；
- ownership conflict；
- reviewer disagreement；
- 不可逆風險。

**初次 implementation attempt 不計入 `failed_repair_count`。** 達到上限時升級 slot 或進 human gate，不得無限重試。Repair 必須交回單一 implementation owner。

**Continuation 也不計入 `failed_repair_count`。** 因 execution budget 用盡（例如 `Reached max turns`）而續跑同一條 chain，並不是一次失敗的修補；它由自己的 `max_continuation_attempts` 限制，定義見 [`WORKFLOW_POLICY.md`](WORKFLOW_POLICY.md) 的 Execution lifecycle semantics。只有產生錯誤結果後的修補才累加 `failed_repair_count`。

## 新模型

新模型先進 `status: experimental` mapping，只在低風險、可重現、驗收標準清楚的任務上比較 correctness、latency、repair count、review catch rate 與 quota efficiency。

單次結果不能升降 stable mapping；需要多次一致結果、沒有重大回歸，並保留 decision note。這些調整只改 `MODEL_REGISTRY.yaml`，不改 stable workflow。
