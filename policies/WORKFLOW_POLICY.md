# Workflow Policy

Version: `0.3`
Status: normative

這份文件是 stable workflow 的 normative owner：角色、權威順序、生命週期、permission ceiling、bounded repair、human gate 與 cross-repo 規則。它**不含任何模型名稱**；模型與 provider mapping 屬於 [`MODEL_REGISTRY.yaml`](MODEL_REGISTRY.yaml)。

## Precedence

Authoritative read order：

```text
SKILL → WORKFLOW_POLICY → CONCURRENCY_POLICY → MODEL_ROUTING_POLICY
      → MODEL_REGISTRY → RESOURCE_AWARE_ROUTING → OFFICIAL_COMMANDS
      → Current Project Handoff
```

每條規則只有一個 owner。同一規則若出現在多份文件，以下表為準；其他文件只能連結或摘要，不得建立第二份可分歧的定義。

| Owner | 負責 | 不負責 |
|---|---|---|
| `WORKFLOW_POLICY.md` | 角色、precedence、lifecycle、handback、gate、permission、cross-repo | 具體模型名稱 |
| `CONCURRENCY_POLICY.md` | concurrency mode 與啟用條件 | provider 選擇 |
| `MODEL_ROUTING_POLICY.md` | task classification、slot 選擇、candidate 演算法、escalation | 即時 quota 數值 |
| `MODEL_REGISTRY.yaml` | slot 的 ordered candidates、能力下限、repair budget | stable workflow 規則 |
| `RESOURCE_AWARE_ROUTING.md` | resource state、freshness、候選重排 | architecture authority |
| `OFFICIAL_COMMANDS.md` | 經官方文件與本機 `--help` 驗證的命令 | 永久固定的 display name |
| `scripts/` 與 `tests/` | 檢查上述文件的一致性 | 定義或覆寫 policy |
| Current Project Handoff | 單一專案的 state、contract、blocker、next gate | 跨專案通用政策 |

**Markdown policy 是 normative；`scripts/` 下的驗證程式只是 conformance checker。** 當程式行為與政策文字不一致時，修正程式與測試以符合政策；不得反向用程式行為改寫規範。

## Roles

| Role | 權限 | 禁止 |
|---|---|---|
| Strategic router | 需求拆解、task classification、role/slot/`minimum_tier` 指定、concurrency mode、gate 判定 | 代替 human 通過 human gate；宣稱已驗證它讀不到的檔案狀態 |
| Operational router (Orca) | 驗證 repo/HEAD/working tree、讀 registry、套 resource overlay、執行 candidate 演算法、組出 dispatch command、建立/重用 worktree 與 terminal、收斂結果 | 重新解讀需求、改寫 contract、降低 permission ceiling |
| Worker | 在 allowed changes 範圍內實作與驗證 | 擴大範圍、修改驗收標準、commit/push（除非 contract 明示） |
| Reviewer | 獨立檢查 filesystem、git diff 與 tests | 只讀 worker 摘要就判定通過 |
| Human (authoritative owner) | 架構決策、gate 放行、風險承擔 | — |

每個 task 必須有且只有一個 **authoritative owner**。owner 不明確時停止並回 human gate。

Reviewer 預設 read-only，並且**必須直接檢查 filesystem、`git diff` 與測試輸出**，不得僅依 worker 的完成摘要作結論。

### Strategic router 不得依賴檔案系統

**Strategic router MUST NOT DEPEND ON direct filesystem access, local registry visibility, or live quota visibility.**

這是依賴限制，不是能力限制。Strategic router 若剛好能讀檔（例如它本身是本機 agent），可以讀；但整條流程的正確性**不得建立在它讀得到之上**。它可能是網頁版對話這類沒有檔案系統、無法執行命令的介面，流程在該前提下仍須成立。

因此職責如此切分：

| 由 strategic router 產出（純文字，可貼上） | 由 operational router 執行（需檔案系統） |
|---|---|
| 需求拆解與 task 邊界 | 驗證 repo、HEAD、working tree、handoff |
| 六維 task classification | 讀 `MODEL_REGISTRY.yaml` 取 ordered candidates |
| `role`、`slot`、`minimum_tier` | 讀 resource state 並評估 freshness |
| concurrency mode | 執行 candidate 選擇演算法 |
| allowed / prohibited changes | 解析 dynamic model resolver |
| validation commands 與 acceptance criteria | 組出逐字 dispatch command 與 permission 旗標 |
| human gate 判定與停止條件 | 建立/重用 worktree 與 terminal、收斂結果 |

**Candidate 選擇屬於 operational router，不屬於 strategic router。** Strategic router 指定的是能力需求（`role`、`slot`、`minimum_tier`），不是具體模型。它不得依賴 registry 與即時 resource state 的可見性，因此直接指名模型即是猜測。

同理，`dispatch_command` 在 strategic contract 中維持 **unresolved**，由 operational router 在解析候選後填入。

Operational router 回傳 `BLOCKED` 時，交還給 strategic router 或 human 重新決策，不得自行放寬 `minimum_tier` 或 independent review 的 disjointness。

Strategic router 也不執行 lifecycle 的 `verify` 階段——它不得依賴自己能確認 HEAD 或 working tree。該階段一律由 operational router 執行並回報。

## Lifecycle

標準生命週期固定為：

```text
verify → classify → route → contract → execute → review → repair or escalate → close
      → handback
```

1. **verify** — 確認 repo、HEAD、working tree 乾淨度、current handoff 與既有 authoritative contract。
2. **classify** — 依 `MODEL_ROUTING_POLICY.md` 的六個維度分類。
3. **route** — 選 role、slot、`minimum_tier`，套用 resource overlay 後選出 candidate。
4. **contract** — 產生可直接下發的 execution contract（見下節）。
5. **execute** — worker 只執行 contract。
6. **review** — 依 `verification_need` 決定一般驗證、independent review 或 adversarial validation。
7. **repair or escalate** — 在 repair budget 內修補；超出則升級或進 human gate。
8. **close** — 回傳完成 footer，更新 handoff 與 worktree metadata。
9. **handback** — operational router 產出 `STRATEGIC_RETURN`，把本輪的 decision delta 交還 strategic router 或 human（見下方 *Operational → Strategic handback*）。

## New session verification

Fresh agent session 接手前必須先回答：Current State / Next Gate / Remaining Blockers / Authoritative Contracts。owner 確認前不得 dispatch implementation。

「fresh session」不等於「fresh worktree」。同一條 implementation chain 留在同一 worktree（見 `CONCURRENCY_POLICY.md`）。

## Execution contract 與 permission ceiling

每次派工前建立 execution contract，內容規格見 `templates/ROUTER_EXECUTION_CONTRACT_TEMPLATE.md`。

派工權限採最小必要原則：

- discovery 與 review 預設 read-only；
- implementation 只給 workspace write；
- network 預設關閉；
- `production_access` 預設 `false`。

**permission ceiling 必須以逐字的 dispatch command 表達，並在該命令中明確傳入 sandbox 與 approval 旗標。** 只在 contract 裡用散文宣告權限意圖是不足的：worker 端的 local CLI 設定（例如全域 `sandbox_mode` 或 `approval_policy`）會靜默覆蓋未明示的預設值，使實際權限高於 contract 意圖。Router 必須假設 worker 的本機設定是不可信的，並在命令列上覆寫。

命令範例一律不得預設危險權限旗標。

## Bounded repair

初次 implementation attempt 不計入 repair。失敗的修補累加 `failed_repair_count`，上限由 slot 的 `max_repair_attempts` 決定（預設 2）。達到上限時升級 slot 或進 human gate，不得無限重試。詳細條件見 `MODEL_ROUTING_POLICY.md`。

Repair 必須交回**單一** implementation owner，不得同時派給多個 worker。

## Completion reporting

Worker 結束時回傳 `TASK_RESULT` 與 `RESOURCE_STATUS` 兩段結構化 footer。

**Provider、model、model family 與 reasoning effort 由 router 記錄，不由 worker 自行判定。** Worker 通常無法可靠地內省自己正在以哪個模型執行；要求它自報等於誘導它猜測。這些欄位必須由 router 在 contract 中寫定，worker 只能原樣回填；contract 未載明時填 `UNKNOWN`。

`RESOURCE_STATUS` 可以整段為 `UNKNOWN`。Worker 不得為了填滿 footer 而猜測 quota 數值。

## Operational → Strategic handback

Worker 的 `TASK_RESULT` 只到 operational router 為止。**一個 routing / execute /
review cycle 結束後，operational router 必須產出一份 `STRATEGIC_RETURN`**，交還
strategic router 或 human。欄位規格見
[`templates/STRATEGIC_RETURN_TEMPLATE.md`](../templates/STRATEGIC_RETURN_TEMPLATE.md)；
本節是這條 handback lifecycle 規則的 normative owner。

證據分層固定為：

```text
Worker            → 完整技術輸出
Operational router → 檢視 filesystem / git diff / tests / review
STRATEGIC_RETURN   → compact decision-relevant delta
Human 複製貼上     → Strategic router
```

規則：

- **Operational router 不得把 worker 的 `TASK_RESULT` 原樣 echo 成 `STRATEGIC_RETURN`。**
  它必須先整合實際 repo state、`git diff` 與 changed files、測試輸出、reviewer
  findings、contract drift、routing evidence 與 remaining risks，再自行產出回報。
- **Strategic router 不得依賴 worker transcript 才能理解本輪結果。** 這與「strategic
  router 不得依賴檔案系統」是同一條依賴限制的延伸。
- **完整 technical evidence 留在 repo / worktree / tests / review artifact**，
  由 `STRATEGIC_RETURN` 以 repo、path、commit SHA 指向，而非複製回傳。
- `STRATEGIC_RETURN` 是 **decision packet，不是完整執行紀錄**。預設 compact；
  超出時改用 artifact reference，不 inline 完整 design、report 或 diff。
- `status: HUMAN_GATE` 時**必須清楚說明 human 要決定什麼**，不得只標記需要決策。
- `status: BLOCKED` 時必須使用既有的 canonical blocked reason code；其語意由
  `MODEL_ROUTING_POLICY.md` 的 Blocked reason codes 章節定義，此處不重複。
- **發生 contract drift 時不得靜默進入下一個 implementation task。** drift 必須在
  `STRATEGIC_RETURN` 中明列，並由 strategic router 或 human 重新確認 contract。
- Fresh strategic decision 的依據是 **`STRATEGIC_RETURN` 加上它所引用的
  authoritative artifact**，不是 worker self-summary。

`STRATEGIC_RETURN` 與 current project handoff 不互相取代：前者是**單次 cycle 的
decision delta**，後者是**跨 session 的 durable project state**。本輪工作若改變
durable state，operational router 先更新 handoff，再於 `STRATEGIC_RETURN` 指出
handoff 的哪些部分被更新。

## Human gates

以下情況一律回 human，**不因模型能力或 quota 狀態而自動繞過**：

- ownership ambiguity
- architecture contract change
- breaking DB/API change
- destructive migration
- auth / RBAC / RLS
- privileged boundary change
- production deploy
- secrets 或 security config
- 同時存在多個長期架構方案

## Dispatch cost

跨 provider 派工本身有成本：撰寫 contract、建立 terminal、獨立複核、收斂結果。**當這些開銷明顯大於直接執行該工作時，不派工。**

派工在下列情況才划算：工作需要與實作者不同的獨立視角（independent review、regression hunting）、需要不同的能力層級、上下文量超出當前 session、或工作本身耗時足以攤平開銷。單純為了「用掉便宜模型」而派出瑣碎步驟是淨損失。

## Cross-repo

跨 repo 工作必須明確載明：source repo、target repo、authoritative owner、migration direction、allowed writes。五項缺一即停止並回 human gate。

## Security 與資料邊界

本 repository 是可重用的政策包，不存放 project secrets、個人資料或客戶資料。所有 command automation 在發布前以官方 upstream 文件與本機 `--help` 重新驗證；兩者不一致時以實際安裝版本為執行依據並記錄差異。

### Public repository commit policy

預計公開發布的 repository，其 Git history 本身就是公開產物。Commit message 與 trailer 一律遵守：

- **不放 private AI session URL。**
- **不放本機 harness 或 session identifier。**
- **不放 provider conversation ID。**
- `Co-Authored-By` 為 optional，不是必要項。
- **不得僅為了 AI attribution 而改寫本來有效的歷史。**
- Commit message 保留 technical rationale、scope 與 verification 即可。

工具或 harness 的預設 trailer 慣例若與本節衝突，以本節為準：attribution 的價值低於公開歷史中不出現營運資料。
