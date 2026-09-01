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

**此演算法由 operational router 執行**，因為它需要讀取 `MODEL_REGISTRY.yaml` 與即時 resource state。Strategic router 只負責指定 `role`、`slot` 與 `minimum_tier`（能力需求），不指名具體模型——它可能沒有檔案系統存取權，直接指名模型即是猜測。詳見 [`WORKFLOW_POLICY.md`](WORKFLOW_POLICY.md) 的角色切分。

輸入：slot、`minimum_tier`、registry 的 ordered candidates、resource state snapshot、task context。

1. 從指定 slot 讀取 registry 的 ordered `candidates`（順序具有意義）。
2. 移除下列候選：
   - `available` 為 false；
   - `status: experimental` 且 task context 未明確允許 experimental；
   - `capability_tier` 在 ladder 上低於 slot 的 `minimum_tier`；
   - 進行 independent review 時，與 implementer **相同 provider 或相同 model family** 的候選。
3. 若存在合格的 `GREEN` 候選，依 registry 順序取第一個。
4. 否則在 `YELLOW` 與 `UNKNOWN` 之間**維持 registry 順序**取第一個合格候選。`YELLOW` 與 `UNKNOWN` 之間不建立優先級；`UNKNOWN` 不因缺少資料而被懲罰或獎勵。
5. `RED` 只在沒有任何非 `RED` 合格候選、且 task 明確允許時使用，並在 contract 中記錄理由。
6. 沒有合格候選時，**不得跨越 `minimum_tier`，也不得放棄 independent review 的 disjointness**。回傳 `{status: BLOCKED, reason}` 並進 human gate。
7. 成功時回傳 `{status: SELECTED, candidate}`。Router 保存此次決策快照與理由，但不保存原始 quota payload。

Resource overlay **只能在達到相同 `minimum_tier` 的候選之間重排**。它不能把需要 `DEEP` 的任務改派給 `CHEAP` 候選，也不能改變 architecture authority。

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

## 新模型

新模型先進 `status: experimental` mapping，只在低風險、可重現、驗收標準清楚的任務上比較 correctness、latency、repair count、review catch rate 與 quota efficiency。

單次結果不能升降 stable mapping；需要多次一致結果、沒有重大回歸，並保留 decision note。這些調整只改 `MODEL_REGISTRY.yaml`，不改 stable workflow。
