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
| `WORKFLOW_POLICY.md` | 角色、precedence、lifecycle、execution lifecycle、continuation freshness、session lifecycle/cleanup、Operational Router execution boundary、**governance tier**、handback、tiered return / handoff profiles、gate、permission ceiling 語意、cross-repo | 具體模型名稱、blocked reason code 語意、Router capacity reserve 的門檻與 band 定義、capability stage |
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
| Operational router (Orca) | 驗證 repo/HEAD/working tree、讀 registry、套 resource overlay、執行 candidate 演算法、組出 dispatch command、建立/重用 worktree 與 terminal、收斂結果、bounded control-plane probe | 重新解讀需求、改寫 contract、降低 permission ceiling、**在非 bounded probe 範圍內直接執行 worker-shaped 工作**（見下方 *Operational Router execution boundary*） |
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

## Operational Router execution boundary

**`Control plane ≠ workload plane.`** 這一節是「Operational Router 何時必須停止
自己調查、改為派工」的 normative owner。它處理的是**執行內容的種類**，與
Execution lifecycle semantics（執行進度觀察）、Router capacity reserve（quota 保護）
是三個不同層次：慢不慢是進度問題，額度夠不夠是資源問題，**這一節管的是「這件事
本來就不該由 Router 自己做」**。

### 核心不變式

```text
The Operational Router is control-plane capacity, not the default workload executor.
```

一次真實 incident：長駐的 Operational Router（`codex / gpt-5.6-luna / reasoning: max`）
在同一個 session 內持續執行數十分鐘的 repository 調查、資料核對與驗證測試，
全程沒有派工、沒有 dispatch identity attestation、也沒有 reviewer——這正是本節要
排除的模式。Router 保留 quota（見 Router capacity reserve）不代表它保留了
**執行邊界**；兩者是分開的失效模式。

### Direct-allowed：bounded control-plane probe

Router 可以直接執行的範圍，僅限於**建立 task state、解析 routing 前提、驗證
handoff/baseline、取得 resource state、驗證 worker/reviewer 結果、綜合下一步**
所需的**小範圍探查**。例子：

- `git status` / `git rev-parse` / 確認 branch、HEAD、worktree 狀態；
- 讀**一份**authoritative handoff 或 policy 文件；
- 為了 classification 檢視少量、有明確目標的路徑；
- 檢視 provider/resource availability；
- 驗證 worker 的結果（reviewer 場景下的 bounded verification）；
- dispatch 前一兩個範圍明確的命令；
- bounded synthesis / evidence confirmation。

**這裡的缺陷從來不是「用了工具」，而是「調查變成 worker 的量體與時長」。**
不得因為新增這一節就反過來理解成 Router 完全不能碰工具。

### Dispatch-required：worker-shaped 訊號

以下任一種**內容**出現時，Router 必須停止直接執行、改為派工到既有 slot——
**不新增平行的 slot 架構**，對應關係見
[`MODEL_ROUTING_POLICY.md`](MODEL_ROUTING_POLICY.md) 的 Slot decision table：

| Worker-shaped 訊號 | 例子 | 對應既有 slot |
|---|---|---|
| Broad discovery | repo-wide 搜尋、跨 repo inventory、大範圍 source archaeology、long-context 證據蒐集 | `LONG_CONTEXT_DISCOVERY` |
| Implementation | 改程式碼、撰寫 migration、refactor、功能實作、修測試 | `DEFAULT_IMPLEMENTER` / `STRONG_IMPLEMENTER`（依 Stage admission） |
| Regression / test execution | 跑大範圍測試、反覆 test-debug 循環、regression hunting | `REGRESSION_HUNTER` |
| Domain reasoning toward a solution | 針對 domain 問題本身做架構/語意推理（非 routing 判斷本身） | `DEEP_REASONER` |
| Long-running investigation | 一連串工具呼叫，其目的是解決 domain task，而不是為了 route 它 | 依內容對應上列其一 |
| Background workload | 由 Router 開一個背景 terminal 繼續做 domain 工作，自己維持 active | **一律違規**，與哪個 slot 無關——見下方 |

**Background workload 是獨立的違規類別。** 即使該背景 terminal 最終會被歸類成
discovery 或 implementation，「Router 自己開背景 terminal 做 domain 工作、自己
維持 active」本身就是 dispatch boundary 違反：那個背景 terminal 本身就應該是
一次帶 contract 的 dispatch，不是 Router 的側路徑。

### Escalation trigger（語意優先，數字只是輔助訊號）

```text
The Router MUST dispatch when the next material step primarily advances the
domain task rather than routing/validating the task.
```

這是判斷的**主要**依據；不得只用「超過 N 次命令」這種脆弱的單一數字規則。以下是
**輔助的稽核訊號**，用來偵測「明明在解 domain task，卻還自稱是 probe」的情況，
本身不是唯一判準：

- 連續的大範圍搜尋反覆執行；
- 直接工作量持續超出一個簡短的 control-plane probe 應有的時間窗；
- 多批命令，且其輸出被用來解決 task 本身，而不是用來決定怎麼 route；
- 背景 terminal 在做 domain 工作；
- 從「驗證狀態」悄悄轉成「尋找解法」。

操作性指引（非 parser hard limit，可由 contract 覆寫）：

```yaml
router_probe_guardrails:
  iteration_count: 3        # 同一批 probe 反覆超過這個次數，視為訊號
  elapsed_ms: 120000         # 單一 control-plane probe 持續超過這個時間，視為訊號
```

任一輔助訊號觸發時，連同語意判斷一起記錄，不得沉默地讓 Router 續做——這是
audit signal，觸發後仍要走下方的分類與派工，不是額外的自動 BLOCKED。

### Router execution class / decision

Contract 與稽核記錄至少表達：

```yaml
router_execution_class:
  # CONTROL_PLANE | WORKER_DISCOVERY | WORKER_IMPLEMENTATION
  # | WORKER_REGRESSION | WORKER_REASONING
router_execution_decision:
  # DIRECT_ALLOWED | DISPATCH_REQUIRED | HUMAN_OVERRIDE
router_execution_source:
  # POLICY_DEFAULT | HUMAN_EXPLICIT_OVERRIDE
```

`router_execution_class` 為 `CONTROL_PLANE` 時，`router_execution_decision`
只能是 `DIRECT_ALLOWED` 或（human override 情境下）`HUMAN_OVERRIDE`。
`router_execution_class` 為任一 `WORKER_*` 時，`router_execution_decision`
只能是 `DISPATCH_REQUIRED`，除非有效的 current human override 存在。
一筆 `WORKER_*` class 卻記 `DIRECT_ALLOWED`、且沒有對應 override 的記錄，
本身就是不合法的 contract 狀態，conformance checker 會標為 finding。

### 只有實際的 ROUTER slot 享有這個豁免

**`role: ROUTER` 這個 role tag 不等於「這是承載 active Operational Router 的
slot」**——`DEEP_REASONER` 也標 `role: ROUTER`（用於 architecture reasoning
dispatch），但它是一次被派工的 worker，不是長駐的控制面。只有 registry 中
名為 `ROUTER` 的 slot 本身、且目前確實是那個長駐 session，才適用本節的
control-plane 豁免。這與 [`RESOURCE_AWARE_ROUTING.md`](RESOURCE_AWARE_ROUTING.md)
Router capacity reserve 的 *Active Router identity* 是同一條規則，這裡不重複。

### Human override

Human 可以明確要求「這次直接在 Router session 做，不要派工」。此時：

```yaml
router_execution_source: HUMAN_EXPLICIT_OVERRIDE
router_reserve_override: true   # 若 Router capacity reserve 當下生效
```

Override 必須綁定 **current task id 與 instruction revision**，與
[`MODEL_ROUTING_POLICY.md`](MODEL_ROUTING_POLICY.md) 的 `HUMAN_EXPLICIT_OVERRIDE`
/ `HUMAN_OVERRIDE_STALE` 是同一套 staleness 語意，不重新定義一份。**不綁定 task
的舊 override 不得延續到下一個 task**；task 一換，override 必須重新取得。

### 找不到合格 worker 時：回既有 blocked/gate 結果，不是自己做

`router_execution_decision: DISPATCH_REQUIRED` 之後，若：

- 找不到 eligible model/provider；
- resource reserve 排除了相關 pool；
- exact dispatch identity 無法確立；
- permission constraint 擋下了 worker；

一律回既有的 `ROUTING_UNAVAILABLE` / `RESOURCE_BLOCKED` / `PERMISSION_BLOCKED` /
human gate 結果（語意分別由 `MODEL_ROUTING_POLICY.md` 與上方既有章節定義，此處
不重複）。**「Router 自己做」不是這些情況的自動 fallback。** 這與 Router capacity
reserve 的關係見下方一節。

### 與 Router capacity reserve 的交互

Router capacity reserve（[`RESOURCE_AWARE_ROUTING.md`](RESOURCE_AWARE_ROUTING.md)）
保護的是 quota；本節保護的是執行邊界。兩者必須一起看，否則 reserve 可以被繞過：
排除了 Terra / Sol / 一般 Luna worker 卻讓 Luna-max Router 自己吃下同一份工作，
額度依然被同一個 pool 消耗掉，只是換了個名字。這個繞過模式的名稱與完整語意
（`ROUTER_RESERVE_SELF_CONSUMPTION`）由 `RESOURCE_AWARE_ROUTING.md` 定義，
此處只重申：**Router capacity reserve 不得被「Router 自己做被排除的工作」這種
方式繞過。**

### Dispatch 執行方式不變

本節只決定「要不要派工」，**不改變怎麼派工**。一旦判定
`DISPATCH_REQUIRED`：選既有 slot、用既有的 human-authoritative registry、走既有
resource acquisition、套用既有 Router capacity reserve、保留 provider + model +
reasoning、要求 dispatch identity attestation、維持既有的 reviewer disjointness。
**不建立第二條、不受治理的 helper path。**

## Lifecycle

標準生命週期固定為：

```text
verify → classify → route → contract → execute → review → repair or escalate → close
      → handback → session cleanup
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
10. **session cleanup** — 依 handback 結果分類 terminal/session 的 lifecycle state 並執行對應的 PARK / CLOSE / KEEP（見下方 *Session lifecycle and cleanup*）。

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

## Permission ceiling 的能力分解

`filesystem read`、`command execution` 與 `filesystem write` 是**三種不同的能力**，
不得折疊成單一開關。Reviewer 即使完全不改任何檔案，也需要執行
`git status`、`git diff`、`git log`、`rg`、`cat`、`Get-Content` 這類命令才能完成
獨立檢查。把「唯讀」理解成「完全不得執行命令」會使 independent review 無法進行。

Permission ceiling 至少必須能分別表達：

```yaml
permission_ceiling:
  filesystem:
    read: true
    write: false
  command_execution:
    allowed: true
    mutation: false
    human_approval: as_required
  network:
    allowed: false
  database:
    read: false
    write: false
  production_access: false
  may_commit: false
  may_push: false
```

Read-only discovery / review 的預設語意因此是：

| CAN | CANNOT |
|---|---|
| 檢視 repository 內容 | 修改檔案 |
| 執行唯讀 shell command | 修改 git 狀態 |
| 檢視 git history / diff / status | commit、push |
| 讀 tests、source、docs | 變更 database 或 production |
| — | 變更設定 |

### Command classification

命令是否唯讀由**該次實際 invocation 的用途**決定，不由 executable 名稱決定。
`git` 同時包含 `git log` 與 `git push`；把整個 executable 一次放行或一次禁止
都是錯的分界。

一般視為唯讀的例子：`git status`、`git rev-parse`、`git branch`、`git log`、
`git show`、`git diff`、`git grep`、`rg`、`cat`、`type`、`Get-Content`、
directory listing。同一個子命令加上 mutating 旗標（例如 `git branch -d`）即不再唯讀。

**未被分類的命令不因此變成唯讀。** 無法判定時 fail closed，比照需要 mutation 權限。

`may_commit` 與 `may_push` 是**獨立的閘**：即使 `command_execution.mutation` 為 true，
`may_commit: false` 仍然擋下 `git commit`。

### Human approval 不提高 permission ceiling

某些 CLI 在沙箱模式下仍逐條要求人工核准。Human 可以核准唯讀檢查命令；
**核准只是放行一次落在 ceiling 之內的操作，不擴大 ceiling。**
核准 `Get-Content migration.sql` 不等於核准 filesystem write。
被 ceiling 拒絕的操作，不會因為有人按了同意而變成允許——否則 contract 形同虛設。

### Legacy contract 的解讀（backward compatible）

既有 v0.3 contract 寫的是：

```yaml
permission_ceiling:
  sandbox: read-only
  network: none
  production_access: false
```

這些 contract **仍然有效**，不需要立即遷移。分解式欄位是**附加**的，不是取代；
兩者並存時以明確寫出的分解式欄位為準。Legacy 簡寫的權威解讀為：

| Legacy | 解讀 |
|---|---|
| `sandbox: read-only` | filesystem read 允許；filesystem write 禁止；唯讀 command execution 允許（受 provider sandbox / approval 約束）；mutation 禁止 |
| `sandbox: workspace-write` | filesystem read/write 允許；command execution 與 mutation 允許（仍受 `may_commit` / `may_push` 限制） |
| `network: none` | network 禁止 |
| 未載明的 database / production / commit / push | 一律 `false` |

`sandbox` 值無法辨識時 fail closed：所有能力視為未授權。

## Scoped worker capabilities

這一節是 **worker capability 的授予、fulfillment mechanism、secret possession、
preflight、redaction，與 callback transport 失敗後的結果回收** 的 normative owner。
它**不選模型**、不動 `MODEL_REGISTRY.yaml`、不改 governance tier / capacity reserve /
Router–Worker boundary / reviewer disjointness / exact dispatch identity /
callback recovery。

### 觀察到的 runtime 事實

- 新的 Orca worker **不繼承** Router 的 process / user-scope 變數；
- 已安裝的 Orca environment recipe **沒有**安全通用的 secret-bearing process-env
  注入機制；
- **trusted capability wrapper 可以在 worker 從不拿到 credential 的前提下滿足 DB
  能力**——更安全；
- 因此「worker 需要某能力」**不等於**「把某個 secret env 變數注入 worker」。

### Core principle

Worker 只取得**該 task 所需**的 capability。Secret **不得**：嵌進 prompt；以
command-line argument 傳入（違反即 policy violation）；印進 log；出現在
`worker_done`；被所有 worker 全域繼承。

### Capability model

Contract 用一個 **generic** 欄位表達需求：

```yaml
required_capabilities:
  - FOUNDATION_DB_READONLY
  - FOUNDATION_DB_PRIVILEGED
```

一個 **capability 代表對某個 bounded operation 的權限 / 能力**；它**不規定該能力
如何被 fulfil**。名稱是**專案自訂的 capability identifier**。skillpack 擁有**機制**，
不擁有各專案的 secret 值。effective privilege 只有三級：`NONE` / `READONLY` /
`PRIVILEGED`。

> **Deprecated alias。** 前一版的欄位名 `required_environment_capabilities` 仍被接受，
> 但**立即 normalize** 成 `required_capabilities`（`normalizeRequiredCapabilities()`），
> 且**不得**讓新舊兩個欄位各自獨立驅動行為。兩者若同時出現且不一致 →
> `CONFLICTING_CAPABILITY_FIELDS`，fail closed。normalize 後**唯一 owner** 是
> `required_capabilities`。

### Fulfillment mechanisms

`CAPABILITY_FULFILLMENT_MECHANISM` 的允許值：

```text
NONE  ENV_INJECTION  CAPABILITY_WRAPPER  SECRET_BROKER  REMOTE_EXECUTOR
```

**`A capability may be fulfilled by any approved mechanism that satisfies the task's least-privilege and secret-handling requirements.`**
**No mechanism is preferred globally.** 哪些 mechanism 可用由 project / runtime policy 決定。

### Semantic rule

**`The worker's required capability is the authority boundary.`** fulfillment
mechanism 是 implementation detail。例如 `FOUNDATION_DB_READONLY` 可以是：worker
拿到一個 readonly process-env credential；**或** worker 呼叫 trusted readonly
capability wrapper；**或** worker 呼叫 secret broker / remote executor——只要
**effective authority 恰好是 `READONLY`**。**不要求 worker 本身持有 credential。**

### Secret possession

明確欄位：

```yaml
worker_receives_secret: YES | NO
```

一個 capability 可以在 `worker_receives_secret: NO` 的情況下**成功 fulfil**——這是
**first-class 的有效 outcome**（例：`FOUNDATION_DB_READONLY` + `CAPABILITY_WRAPPER`
+ `worker_receives_secret: NO` → `CAPABILITY_FULFILLED`）。`ENV_INJECTION` 預設
`YES`；wrapper / broker / executor 預設 `NO`；明確值優先。

### Governance interaction

**Capability 不選模型。** dispatch 前：

1. Router 正常分類 task；
2. 解析 governance tier；
3. `normalizeRequiredCapabilities` → `required_capabilities`；
4. 驗證 task-established need（見下）與 authorization；
5. 選 / 檢查一個可用的 fulfillment mechanism；
6. 進 domain 執行前跑 preflight；
7. 任一步失敗 **fail-closed**。

`G3`（`G3_HIGH_RISK`）**不自動**等於特權能力——task 必須**具體地**需要它；沒有
task-established need 時，即使 governance tier 高、authorization 齊備，也只給
`NONE`。`PRIVILEGED` 一律需要 current task 上的明確、task-bound authorization
（`environment_capability_authorization: required_and_provided`），staleness 語意同
`MODEL_ROUTING_POLICY.md` 的 `HUMAN_EXPLICIT_OVERRIDE` / `HUMAN_OVERRIDE_STALE`。

| 情境 | capability |
|---|---|
| discovery / reviewer | 通常 `NONE` |
| read-only hosted validation | `FOUNDATION_DB_READONLY` |
| 明確授權的受控執行 | `FOUNDATION_DB_PRIVILEGED` |

### Capability wrapper

`CAPABILITY_WRAPPER` 是合法 fulfillment mechanism。trusted wrapper **可以**：從
trusted store 取 secret、把 secret 留在 wrapper / child-process 記憶體、只暴露
**allowlisted** 的 operation surface、回傳 sanitized 結果、讓呼叫端 worker 看不到
credential。

Wrapper **不得**變成 arbitrary-command tunnel。對 DB wrapper：**不隱含 arbitrary
SQL**；approved actions / functions 必須 allowlisted；privilege level 必須 bounded；
target identity 必須驗證；secret-bearing diagnostics 必須 sanitize。surface 非
allowlist-only 時 → `CAPABILITY_PREFLIGHT_FAILED`。

### Environment injection

`ENV_INJECTION` 在 runtime 真的能安全支援時仍受支援，但：
**Router local env presence is not capability fulfillment.**
user / global env inheritance 不是 authority；env injection 只是**一種
mechanism**，不是 capability 的定義；不得 command-line / prompt 注入 secret；
**缺少 env-injection 支援 ≠ capability 不可能**
——若另有 approved mechanism（wrapper / broker / executor）可用，就用它。

### Redaction

Worker diagnostics **永遠不 echo** credential-bearing URL。對 secret-bearing
capability，log 只能輸出下列 token 之一：

```text
PRESENT  ABSENT  TARGET_MATCH  TARGET_MISMATCH  TLS_OK  TLS_FAILED
```

底層命令若在 stderr 帶出 connection string，回傳 evidence 前必須先 sanitize。

### Preflight

worker 進入 domain 執行**之前**：

- 驗證 capability `PRESENT`（透過所選 mechanism）；
- 適用時驗證預期 target identity（`TARGET_MATCH`）；
- 適用時驗證 CA 設定存在；
- 驗證 **effective privilege 恰好等於** required（不多不少）。

任一不成立 → 對應 fail-closed outcome（`CAPABILITY_UNAVAILABLE` /
`CAPABILITY_PREFLIGHT_FAILED` / `TARGET_MISMATCH` / `PRIVILEGE_LEVEL_MISMATCH` /
`AUTHORIZATION_REQUIRED`），且**不得** fallback 到：舊 endpoint、直連 IPv6
endpoint、另一組 credential、local approximation、或更寬的 privilege。`READONLY`
請求不得被悄悄升成 `PRIVILEGED`；`PRIVILEGED` 請求不得被 `READONLY` 悄悄取代——
不符即 `PRIVILEGE_LEVEL_MISMATCH`，fail-closed。

### Worker result recovery（callback transport 失敗）

worker 完成 domain 工作、但因 worker 環境內沒有 Orca CLI 而**無法送 `worker_done`**
時，**不得自動 redispatch**。Operational Router 可以把結果回收當作 **control-plane
work**（屬於 *Operational Router execution boundary* 的 bounded probe），使用：

```bash
orca orchestration worker-show --dispatch <dispatch_id> --json
orca orchestration worker-read --dispatch <dispatch_id> --limit <bounded_n> --json
```

`worker-read` **只**用於回收 / 檢視既有 worker 結果；transport 正常時**不得**拿它
當 `worker_done` 的替代品。

回收優先序：

```text
1. valid worker_done
2. observed completed worker state + bounded worker-read result
3. terminal / orchestration evidence
4. 狀態仍不明確 → HUMAN_GATE
```

回收成功時 `callback_transport = FAILED_RECOVERED`。**不得**：

- 只因 `worker_done` 失敗就 spawn 重複 worker；
- 重跑已完成的 implementation / review 工作；
- 把 callback transport 失敗當成 domain-task 失敗。

回收到的輸出若含 secret 或 credential-bearing diagnostics，**併入 Router evidence /
handoff 前先 sanitize**。

### Lifecycle

只把 capability 授予**需要它的**那個 worker / task。**不得**把長駐 Router session
的 env / wrapper / broker session 當作授權來源。**不得**要求未來所有 worker 都
繼承同一組 secret 或共用同一個 wrapper session。

### Interruption / recovery

worker 因中斷而重啟時：**重新解析** `required_capabilities`、**重新解析**可用的
fulfillment mechanism、**重新建立** capability access。**不假設**：舊 env state、
舊 wrapper process、舊 secret broker session、舊 remote executor session、舊
terminal——**prior capability state 不具權威**。

### Reviewers

Independent reviewer **不因為要重現 validation** 就取得任何 sensitive capability；
預設檢視 **sanitized** validation evidence。只有在 review 本身**真的需要直接使用
該 capability** 時才明確宣告
`review_requires_direct_capability: true`（不綁死在 database / env 術語）並經
authorization。

## Execution lifecycle semantics

這一節是 **dispatch 之後、close 之前**的等待、停滯與續跑語意的 normative owner。
它處理的是**執行過程的觀察狀態**，與 candidate 選擇無關。

### 核心不變式

```text
poll timeout != task timeout
total runtime != stall duration
slow != blocked
```

`orca terminal wait --timeout-ms 60000` 這類命令若由 router 用於輪詢，該逾時
**只表示「醒來重新觀察一次狀態」**，不表示「worker 只有 60 秒可以完成」。
把 polling window 當成 task budget 是誤讀，會把正常的長時間工作判成失敗。

模型執行時間長本身**不是** failure、**不是** permission blocker、**不是**
routing failure。architecture review、long-context discovery、deep reasoning
與大型 repository audit 本來就可能需要較長 wall-clock runtime。

### Execution states

| State | 意義 | 動作 |
|---|---|---|
| `ACTIVE` | 上次輪詢後有可觀察的進展 | 繼續等待 |
| `QUIET` | session 仍存活，暫時沒有新輸出 | 繼續等待 |
| `STALLED` | session 存活，且達到 stall threshold 仍無可觀察進展 | bounded intervention |
| `COMPLETE` | process 結束且有可用結果 | 進 review / close |
| `MAX_TURNS_REACHED` | execution budget 用盡而結束，非錯誤結果 | bounded continuation |
| `PROCESS_EXIT_FAILURE` | process 結束但無可用結果 | 既有 repair / escalation 路徑 |
| `HARD_EXECUTION_CEILING` | 達到安全上限而 session 仍活著 | human gate |
| `PERMISSION_BLOCKED` | 所需操作超出 permission ceiling | 交回 human |
| `ROUTING_UNAVAILABLE` | session 已不可達且未留下結束紀錄 | 交回 human 或重新路由 |
| `DISPATCH_CONTRACT_MISMATCH` | worker 實際的 provider/model/model_family/reasoning_effort 與 contract 不符 | 見下方 *Dispatch contract attestation* |

**這些是觀察狀態，不是 blocked reason code。** 其中 `PERMISSION_BLOCKED` 與
`ROUTING_UNAVAILABLE` 是唯二會交棒給 canonical blocked reason code 的出口，
其語意由 [`MODEL_ROUTING_POLICY.md`](MODEL_ROUTING_POLICY.md) 的
Blocked reason codes 章節定義，此處不重複。`DISPATCH_CONTRACT_MISMATCH`
**不是** `ROUTING_UNAVAILABLE`，也不是任何 blocked reason code。

### Dispatch contract attestation

`provider + model + model_family + reasoning_effort` 是 execution identity（owner：
[`MODEL_ROUTING_POLICY.md`](MODEL_ROUTING_POLICY.md)）。Dispatch 後，operational
router 必須記錄並比對：

```yaml
EXPECTED_IDENTITY:
  provider:
  model:
  model_family:
  reasoning_effort:

ACTUAL_IDENTITY:
  provider:
  model:
  model_family:
  reasoning_effort:
```

比對方式與能力缺口見
[`../references/OFFICIAL_COMMANDS.md`](../references/OFFICIAL_COMMANDS.md) 的
*Runtime attestation*。

| attestation_result | 意義 | 動作 |
|---|---|---|
| `DISPATCH_IDENTITY_MATCH` | 四者一致，且 provider 支援的 model / reasoning 旗標已明確寫入實際 launch command | 正常繼續 |
| `DISPATCH_IDENTITY_UNVERIFIED` | runtime 未提供完整可讀取的實際值，或 provider-specific launch contract 無法驗證 | 不得宣稱 exact dispatch；依 task 風險進人工確認或停止 |
| `DISPATCH_CONTRACT_MISMATCH` | 任一欄位不符，或已知 launch command 省略/改寫了選定的 model / reasoning（例：contract `Sol medium`，實際 `Sol max`） | 見下 |

`ACTUAL_IDENTITY` 只要有一個可觀察欄位已知與 `EXPECTED_IDENTITY` 不同，結果就是
`DISPATCH_CONTRACT_MISMATCH`，即使其他欄位仍未知。只有完全相同的四個欄位才能是
`DISPATCH_IDENTITY_MATCH`；不可用 `MATCH`、`PASS` 或 worker 自報取代這三個結果。

### Selection provenance and no silent defaults

每一次正式 dispatch 都必須記錄 `model_selection_source`：

| source | 意義 |
|---|---|
| `REGISTRY_AUTONOMOUS` | operational router 在指定 slot、disjointness 與 resource filters 後，從 `MODEL_REGISTRY.yaml` 的 enabled candidate 選出 |
| `HUMAN_EXPLICIT_OVERRIDE` | current human instruction 明確指定 task-local provider / model / reasoning；必須綁定 task id 與 instruction revision |
| `HUMAN_RETROACTIVE_ACCEPTANCE` | 只記錄已完成工作的歷史接受；不得授權新的 dispatch 或改變 registry |

`REGISTRY_AUTONOMOUS` 若無法指向指定 slot 中的 enabled candidate，必須在 dispatch
前拒絕為 `AUTONOMOUS_CANDIDATE_REJECTED`。不得以 Orca default、Codex local
config、既有 terminal、generic reviewer helper、Superpowers 或環境預設值補上
model / reasoning。

`HUMAN_EXPLICIT_OVERRIDE` 可以使用不在一般 slot candidate list 的模型，但只能
適用於 current task，且仍須通過 hard execution、permission 與 reviewer
disjointness 檢查；它不得寫回 `MODEL_REGISTRY.yaml`。過期、未綁定 current
instruction 的 override 必須視為 `HUMAN_OVERRIDE_STALE`。

`HUMAN_RETROACTIVE_ACCEPTANCE` 不是 `HUMAN_EXPLICIT_OVERRIDE` 的替代寫法；本次
Foundation 的已接受 `gpt-5.5 high` review 屬於前者的歷史紀錄，不是未來 autonomous
candidate。

`DISPATCH_CONTRACT_MISMATCH` 的安全處置：

- 若 runtime 支援安全中斷單一 worker，**停止或避免它繼續高成本工作**；
- 若 runtime 無法安全停止單一 terminal（見下方 *Session lifecycle and cleanup*
  的 Runtime capability 邊界），**立即回報 mismatch 並進 `HUMAN_GATE` 或
  bounded recovery**，依既有 lifecycle 政策；
- **永不假裝 worker 符合 contract**，也不因為 model id 對得上就忽略 reasoning
  effort 不符；
- 這是 lifecycle outcome，不計入 `failed_repair_count`。

### ACTIVE：什麼算 observable progress

以下任一項都是進展：terminal output cursor 前進、新的 stdout / stderr、
新的 tool invocation、filesystem read、git inspection、tests 階段改變、
agent/runtime 狀態改變、reviewer 進入下一個 audit section、有意義的進度訊息。

只要出現進展就把 `last_progress_at` 更新為現在並繼續等待。
**不得因為 total elapsed time 偏長而 BLOCK。**

### QUIET：不是失敗

Process / session 仍活著但暫時沒有新輸出。繼續輪詢即可。QUIET 不隨總執行時間
延長而變成 STALLED——只有「距離上次進展的時間」會。

### STALLED：只買到一次檢查，不是判決

只有在 **session 仍活著 且 距離上次可觀察進展已達 stall threshold** 時才進入
suspected stall。STALL **不得**映射為 `PERMISSION_BLOCKED`，也**不得**直接映射為
`ROUTING_UNAVAILABLE`。

Bounded intervention 依序為：

1. 檢視目前 process / session 狀態；
2. 讀取增量 terminal output（cursor read，不是畫面讀取）；
3. optional 的非破壞性 status / nudge；
4. 若執行環境支援，bounded resume / retry；
5. 仍無法解除 → human gate 或明確的 execution failure 分類。

### Timing guidance

可調整的操作指引，**不是 parser hard limit**。重點是語意分離，不是特定數字。

```yaml
poll_interval:
  normal: 60-120 seconds

stall_threshold:
  default: 10-20 minutes
  deep_reasoning: 可以更長

hard_execution_ceiling:
  預設不設；需要時設得高，且到達時交人決定
```

Contract 可覆寫這些值。未載明時採預設區間的中值。

### Hard execution ceiling

到達 ceiling 而 worker 仍在活動時，**不得直接 FAIL**。高風險或 deep 任務一律回
human gate，並附：

```text
total_elapsed:
last_progress_at:
current_state:
current_activity:

options:
- continue waiting
- terminate
- reroute
```

### Max turns 與 bounded continuation

`Reached max turns` 這類 execution-budget exhaustion 與 wall-clock timeout、
stall、permission denial、routing failure **完全不同**：它表示回合數用完，
不表示工作失敗。

Operational router 先判斷 partial work / context 是否可恢復。可恢復時
**優先在同一 task、同一 review chain 上續跑**，不重新開始整輪 discovery。
**不得**把它分類成 `PERMISSION_BLOCKED` 或 `ROUTING_UNAVAILABLE`。

Continuation 必須有界：

```text
initial attempt → continuation 1 → continuation 2 → escalate / human gate
```

`max_continuation_attempts` 預設為 2，可由 strategic contract 覆寫。
**不得建立無限 continuation。**

### Execution state machine

```text
dispatch
  ↓
ACTIVE
  ↓
poll
  ├─ progress → ACTIVE → 繼續
  │
  ├─ 無輸出但 process 存活 → QUIET
  │        └─ 達 stall threshold？ 否 → 繼續 ／ 是 → STALLED → bounded intervention
  │
  ├─ permission request
  │        └─ 在 ceiling 內？ 是 → 依政策放行 ／ 否 → PERMISSION_BLOCKED
  │
  ├─ process exit
  │        ├─ 有可用結果 → COMPLETE → review / close
  │        ├─ max turns → MAX_TURNS_REACHED → bounded continuation
  │        └─ 其他失敗 → PROCESS_EXIT_FAILURE → repair / escalation
  │
  └─ hard execution ceiling → HARD_EXECUTION_CEILING → human gate
```

輪詢命令與增量讀取的實作方式見
[`references/OFFICIAL_COMMANDS.md`](../references/OFFICIAL_COMMANDS.md)，
本節不記錄具體旗標。

## Continuation freshness

這一節是 **continuation eligibility**（是否可以續跑既有 worker/reviewer/session）的
normative owner，與上方 Execution lifecycle semantics 是不同層次的問題：那一節回答
「這次執行是否還在正常進行」，這一節回答「即使正常進行，現在還可不可以續跑它」。

**Continuation freshness 與 quota freshness 是兩個獨立檢查。** 同一個有效 worker 的
continuation **不因為 quota reset 就換模型**。只有在需要**新的 routing decision** 時
（`MAX_TURNS_REACHED` 後需要新 worker、stale continuation 被拒、retry 換 worker、
reviewer dispatch、新 task），才在 candidate selection 之前套用
[`RESOURCE_AWARE_ROUTING.md`](RESOURCE_AWARE_ROUTING.md) 的 reset-aware
resource refresh。兩者不得混為一談。

### 核心不變式

```text
A continuation is valid only against the same still-current human intent
and permission scope.
```

一次真實 cycle 曾發生：human 已提出新的 read-only discovery task，Operational
Router 卻誤續跑了舊的 implementation/canonicalization continuation chain。Worker
與 reviewer 都正確遵守了它們各自收到的（舊）contract——問題出在 router 續跑前
沒有比對「現在的 human intent」與「這條 continuation 綁定的 intent」是否仍然一致。

### Continuation binding

每個可續跑的 task/continuation 必須至少綁定：

```yaml
continuation_binding:
  task_id:
  human_instruction_revision:      # 見下方「revision 機制」
  objective_fingerprint:
  permission_scope_fingerprint:
  authoritative_baseline:          # repo / branch / base_head，或等價的 current-state marker
```

這是**可續跑性的必要條件**，不是完整 contract 的替代品：完整 contract 內容仍在
`templates/ROUTER_EXECUTION_CONTRACT_TEMPLATE.md` 定義的欄位中，這裡只記錄「續跑前
要拿什麼來比對」。

### Revision / fingerprint 機制

**低成本、deterministic，不保存完整 human message。** Fingerprint 只對
execution-relevant 的 contract 欄位做 canonicalization 再雜湊，至少涵蓋：

```text
objective
allowed_changes
prohibited_changes
expected_output（acceptance criteria / next gate）
authoritative baseline（repo / branch / base_head）
permission_ceiling（含 filesystem / command_execution / network / database /
                    production_access / may_commit / may_push 的分解欄位）
human_gate 狀態
```

`human_instruction_revision` 是這整組欄位的雜湊；`objective_fingerprint` 與
`permission_scope_fingerprint` 是其中兩個子集各自的雜湊，用來在比對時指出**哪一塊**
改變了，而不只是「整體不一樣」。**不得把 PII 或完整 transcript 寫進這些欄位或任何
task metadata**——canonicalization 只挑選上述欄位，其餘欄位（含任何原始使用者訊息）
對 fingerprint 不可見；加入一個與這些欄位無關的巨大欄位不會改變雜湊值。

### Latest-human-instruction precedence

以下優先級是正式規則，**下層不得覆蓋上層**：

```text
1. latest explicit human instruction
2. current authoritative project handoff/state
3. active strategic contract
4. prior NEXT_GATE
5. cached router/session context
6. worker-local continuation state
```

**Stale NEXT_GATE 或 cached continuation 不得推翻更新的 explicit human
instruction。** 下層只能在上層完全沒有指定某個欄位時，補上該欄位的預設值——這是
「補空缺」，不是「覆寫」。

### Continuation eligibility check

以下情況之前，**必須**先跑這個檢查：

- resume；
- `MAX_TURNS_REACHED` 之後的 continuation；
- retry 同一個 worker；
- reviewer continuation；
- parked terminal 的重用。

檢查方式：把依上述優先級解析出的「目前 human intent」與這條 continuation 綁定的
fingerprint/facts 比對，至少檢查：

```text
objective changed?
allowed changes changed?
prohibited changes changed?
permission ceiling changed?
production / network / database permission changed?
human gate state changed?
authoritative baseline / HEAD changed materially?
requested output / next gate changed?
```

任一項 materially changed：

```text
outcome: CONTINUATION_REJECTED_STALE
action:  NEW TASK CONTRACT REQUIRED
```

**不得自動 resume 舊的 worker/session。**

#### 允許 continuation 的例子

- 輪詢同一個仍在執行的 worker；
- 同一個 reviewer 在 `MAX_TURNS_REACHED` 後續跑；
- bounded continuation 且 human intent 未變；
- human 說「continue the same review」且沒有更動任何欄位；
- human 說「wait longer」而未改變範圍。

#### 必須開新 task 的例子

- implementation → read-only discovery；
- `workspace-write` → `read-only`；
- production access 被收回；
- objective 從 fixture repair 變成 DB principal discovery；
- 新的 authoritative HEAD/baseline 使既有 contract 的假設失效；
- human 明確表示「不要續跑先前的 task」；
- human 更動了 expected output 或 next gate。

### Stale continuation 的處置

`CONTINUATION_REJECTED_STALE`（或 backward-compatibility 情境下的
`LEGACY_CONTINUATION_REQUIRES_FRESH_CONTRACT`，見下）是 **lifecycle outcome，
不是 blocked reason code**。**不得**標為 `PERMISSION_BLOCKED`、
`ROUTING_UNAVAILABLE` 或 `PROCESS_EXIT_FAILURE`——這三者描述的是完全不同的失敗
原因，把 scope drift 塞進其中任何一個都會讓上層誤判該等待、該調整權限，還是該找人。

判定為 stale 後：

1. 停止/拒絕該次 resume；
2. 保留既有 evidence（見下方 Session lifecycle and cleanup）；
3. 把原 session 標為 `SUPERSEDED` 或 `STALE`；
4. 建立新的 task contract；
5. 只在確認目前 human instruction 後才 dispatch。

Stale continuation 與 repair 的關係由 [`MODEL_ROUTING_POLICY.md`](MODEL_ROUTING_POLICY.md)
的 Escalation 章節定義，`failed_repair_count` 的計數規則只有那裡一個 owner，
此處不重述。

### Backward compatibility

沒有 revision fingerprint 的既有 task contract**對它的初次 execution 仍然有效**——
這條規則只影響 resume/continuation，不影響 initial execution。

但續跑一個沒有 freshness metadata 的舊 task 時：

```text
outcome: LEGACY_CONTINUATION_REQUIRES_FRESH_CONTRACT
```

**不得靜默假設它仍然 current。** 這與 `CONTINUATION_REJECTED_STALE` 是同一組
lifecycle outcome、不同的判定原因：前者是「無法判斷」，後者是「判斷後確認已變」，
兩者處置方式相同（見上方 Stale continuation 的處置）。

## Bounded repair

初次 implementation attempt 不計入 repair。失敗的修補累加 `failed_repair_count`，上限由 slot 的 `max_repair_attempts` 決定（預設 2）。達到上限時升級 slot 或進 human gate，不得無限重試。詳細條件見 `MODEL_ROUTING_POLICY.md`。

Repair 必須交回**單一** implementation owner，不得同時派給多個 worker。

**Repair 與 continuation 是兩件事。** Repair 修的是錯誤的結果；continuation 續的是沒有錯誤、只是 execution budget 用盡的執行（見上方 Execution lifecycle semantics）。把續跑算成 repair 會讓 turn budget 偏小的 slot 憑空耗盡 repair 預算。`failed_repair_count` 的計數規則由 [`MODEL_ROUTING_POLICY.md`](MODEL_ROUTING_POLICY.md) 的 Escalation 章節定義，此處不重複。

## Completion reporting

Worker 結束時依 `return_profile` 回傳結果。一般成功之內部執行預設為 `INTERNAL_COMPACT`；需要詳細狀態或稽核時採用 `AUDIT_FULL` 或既有 `TASK_RESULT` 與 `RESOURCE_STATUS` 兩段結構化 footer。

**Provider、model、model family 與 reasoning effort 由 router 記錄，不由 worker 自行判定。** Worker 通常無法可靠地內省自己正在以哪個模型執行；要求它自報等於誘導它猜測。這些欄位必須由 router 在 contract 中寫定並以 attestation 比對；contract 或 runtime 未載明時填 `UNKNOWN`，不得假裝 exact match。

`RESOURCE_STATUS` 可以整段為 `UNKNOWN`。Worker 不得為了填滿 footer 而猜測 quota 數值。

## Tiered return and handoff profiles

這一節是 **return / handoff profiles（`return_profile`）** 的 normative owner。
工作流在不同通訊邊界上具有不同的脈絡需求：

1. **Worker / Reviewer → Orca Operational Router**：內部執行回報，預設 `INTERNAL_COMPACT`。
2. **Orca Router 內部 synthesis / recovery**：控制面整合與驗證。
3. **Orca Operational Router → Human / external Strategic Router（例如 ChatGPT web）**：外部 handback，預設 `EXTERNAL_HANDOFF`。

### 核心不變式

```text
The return profile controls reporting detail only.
```

`return_profile` **絕不改變**：
- authority 或授權邊界
- allowed operations 與 permission ceiling
- Governance Tier
- capability resolution 與 effective privilege
- privilege level
- model selection 與 candidate ranking
- reasoning effort
- reviewer disjointness 與 requirements
- human gates
- validation requirements
- callback recovery

### 三個語意 Profiles

| Profile | 目的與邊界 | 預設場景 | 內容重點 |
|---|---|---|---|
| `INTERNAL_COMPACT` | Worker / Reviewer → Operational Router | 一般成功之內部派工 | 僅保留 orchestration 所需之最小資訊。Happy-path 格式：`STATUS: PASS`、`ARTIFACT: <commit/result>`、`VALIDATION: PASS`、`EXCEPTIONS: NONE`。已由 contract/tests 驗證之不變式（`secret_in_git: NO`、`secret_in_logs: NO`、`secret_in_argv: NO`、`router_env_dependency: NO`、`worker_receives_secret: NO`、重複的 `target_match`）在 clean PASS 下**不需重複輸出**。 |
| `EXTERNAL_HANDOFF` | Operational Router → Human / external Strategic Router | 跨執行環境 handback | **Context-serialization boundary**。外部 Strategic Router 沒有本機檔案系統、terminal transcript 或 Orca 狀態，因此必須保存足夠資訊以在另一環境安全接續推理。格式涵蓋：`STATUS`、`CURRENT_STATE`（變更範疇與 authoritative repo 狀態）、`KEY_EVIDENCE`（驗證事實）、`DECISIONS`、`BOUNDARIES`（關鍵安全/權威邊界事實）、`ARTIFACT`（commit/result/reference）、`NOT_DONE`（刻意未執行之操作）、`NEXT_GATE`（下一個決策點）、`DISPATCH`。避免 redundant aliases（不重複 `target_match`、`target`、`database_target`）。 |
| `AUDIT_FULL` | 深度稽核、高風險證據、或明確人工要求 | 高風險 / 例外調查 | 保留完整結構化輸出與所有診斷細節。僅在 G3 證據確實需要完整細節、security/Auth/RLS/payroll/特權操作/破壞性操作需要詳細證據、發生政策偏差、除錯調查，或 human 明確要求時使用。不得僅因技術複雜而預設為 `AUDIT_FULL`。 |

### 預設 Profile 選擇（Deterministic Rules）

- **Worker / Reviewer → Router**：預設 `INTERNAL_COMPACT`。
- **Router → Human / external Strategic Router**：預設 `EXTERNAL_HANDOFF`。
- **明確要求或政策需要詳細稽核**：`AUDIT_FULL`。
- `G1_LIGHTWEIGHT` 成功回傳**絕不預設** `AUDIT_FULL`。
- `G3_HIGH_RISK` 任務若機器驗證已足夠，內部成功回傳**不自動強制全量冗長輸出**（維持 `INTERNAL_COMPACT`；僅在 external handoff 呈現重要 boundary 證據，或在明確 audit 要求時採用 `AUDIT_FULL`）。
- 未指定 `return_profile` 時，依邊界自動 deterministically 解析為對應預設值，不使 legacy caller 失效。

### Exception Expansion（例外自動展開）

`INTERNAL_COMPACT` 在執行**非 clean happy path** 時**必須自動展開**，不得隱藏任何實質失敗或政策偏差資訊。
觸發展開的情境包括：
- `STATUS` 為 `HUMAN_GATE`、`BLOCKED`、`RETRYABLE`
- 發生 policy exception 或 security-relevant deviation
- capability failure（例如 `CAPABILITY_UNAVAILABLE`、`PRIVILEGE_LEVEL_MISMATCH`）
- dispatch identity mismatch（`DISPATCH_CONTRACT_MISMATCH`）
- partial validation（validation 未完全通過）
- unexpected mutation
- stale 或 ambiguous evidence
- callback recovery ambiguity

展開時**必須包含**：
- `reason_code`
- `evidence`
- `unresolved_state`
- `required_next_action`

**Worker 不得透過指定精簡 profile 試圖壓制或隱藏 material exception 或 policy violation。** Runtime 與通訊邊界掌握最低必要資訊層級。

### External Handoff 必備資訊（9 項判準）

外部 handback（`EXTERNAL_HANDOFF`）必須使外部 Strategic Router 能直接回答以下 9 個問題，無需讀取 transcript：
1. **Did the task succeed?**（`STATUS`）
2. **What is now authoritative?**（`CURRENT_STATE` + `ARTIFACT`）
3. **What changed?**（`CURRENT_STATE` 變更摘要）
4. **What important invariants were actually proven?**（`KEY_EVIDENCE`）
5. **Was any privileged / production mutation performed?**（`BOUNDARIES`）
6. **What was explicitly NOT performed?**（`NOT_DONE`）
7. **Is evidence fresh or uncertain?**（`KEY_EVIDENCE` 中的 freshness）
8. **What commit/result should future work anchor to?**（`ARTIFACT`）
9. **What is the next human gate or next safe action?**（`NEXT_GATE`）

敏感 capability 執行時，`EXTERNAL_HANDOFF` 呈現實質邊界證據（例如使用的 capability wrapper、`worker_receives_secret: NO`、`privileged_operation_performed: NO`、`target_match: PASS`），而不需列出無關的內部細節或重複別名。

### Human Action vs Human Gate

- `HUMAN_ACTION`：操作性步驟（例如在互動式 prompt 本機輸入暫時性 credential），**本身不代表權威轉移或核准**。
- `HUMAN_GATE`：在權限提升、特權執行、不可逆操作或政策規定決策前的**明確放行核准**。

### State / Reason Model

高階狀態正規化為：`PASS`、`RETRYABLE`、`HUMAN_GATE`、`BLOCKED`。
具體狀況以 `reason_code` 表達，避免頂層狀態過度膨脹：
- `STATUS: HUMAN_GATE` + `reason_code: AUTHORIZATION_REQUIRED`
- `STATUS: BLOCKED` + `reason_code: CAPABILITY_UNAVAILABLE`
- `STATUS: RETRYABLE` + `reason_code: CALLBACK_TRANSPORT_FAILURE`
既有 externally consumed reason code enums 保持相容。

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

## Session lifecycle and cleanup

這一節是 **terminal/session lifecycle state 與 cleanup 語意**的 normative owner。
它接在 handback 之後：`STRATEGIC_RETURN` 決定了「這輪工作的結果是什麼」，這一節決定
「承載這輪工作的 terminal/session 接下來該怎麼處置」。

長期累積未關閉的 terminal 會放大：stale continuation risk、wrong-session resume
risk、operator 困惑、process/資源累積、殘留的 env/credential context。Cleanup 因此
是既有 lifecycle 的必要延伸，不是額外的、可省略的清潔工。

### Session lifecycle states

| State | 意義 | 可否 resume |
|---|---|---|
| `ACTIVE` | task 正在執行 | 是，前提是通過 continuation freshness check |
| `PARKED` | 在 human gate 暫留 | 是，**但仍須先通過 continuation freshness check** |
| `SUPERSEDED` | 更新的 human instruction / task 已取代它 | 否，永不 resume |
| `STALE` | continuation fingerprint/revision 不符 | 否，永不 resume |
| `FAILED` | process/task 以無法使用的結果結束 | 否；保留至 evidence 擷取完成 |
| `CLOSED` | terminal/process 已刻意清理 | 否 |

**`PARKED` 不豁免 continuation freshness check。** `PARKED` 只表示這個 terminal
被保留下來，不表示目前的 human intent 仍與它綁定的 intent 相符——這兩件事必須分開
判斷。續跑 `PARKED` session 前仍要跑上方 Continuation freshness 的完整檢查；檢查
結果為 stale 時，即使該 session 是 `PARKED`，也一樣不得 resume，並依 Stale
continuation 的處置轉為 `STALE` 或 `SUPERSEDED`。

### Cleanup rules（依 handback 結果）

| Handback / 狀態 | Cleanup action | 條件 |
|---|---|---|
| `PASS` / `COMPLETE` | `CLOSE`（自動） | output/evidence 已擷取、commit/result 參照已記錄、`STRATEGIC_RETURN` 已產出 |
| `FAIL` / `BLOCKED` | `CLOSE` | evidence 已擷取，且沒有仍有效的 explicit retry；否則 `KEEP` |
| `SUPERSEDED` / `STALE` | `CLOSE`（盡快，evidence 擷取後即可） | — |
| `HUMAN_GATE` | `PARK` 或 `CLOSE`（見下） | 見 PARK/CLOSE 判準 |
| `ACTIVE` | `KEEP` | **不因 elapsed wall-clock time 單獨關閉**，與 Execution lifecycle semantics 的 progress-aware waiting 一致 |
| `MAX_TURNS_REACHED` | `KEEP`，僅限 bounded continuation 仍有效時 | continuation budget 用盡則依 Execution lifecycle semantics 走 human gate，再套用 `HUMAN_GATE` 這一列 |

**Cleanup 不改變 git 或 worktree 狀態，也不計入 `failed_repair_count`。** 它只處置
承載工作的 terminal/session，不觸碰工作本身留下的 repo 證據；那些證據就是
Cleanup 動作發生前必須先擷取的東西。

### `HUMAN_GATE` 的 PARK / CLOSE 判準

兩種允許的模式：

**A. PARK** — 僅在以下**全部**成立時：
- 預期就是同一個 task 會被續跑；
- 沒有敏感的暫時 credential/session 疑慮；
- 資源成本可接受。

**B. CLOSE**（保守預設，以下任一成立即優先 CLOSE）：
- human 的下一個回應很可能改變 task contract；
- task 可以輕易從 repo artifact 重建/續跑；
- session 帶有 secrets 或暫時性 DB connection；
- terminal 累積量已偏高。

### Terminal inventory

Dispatch 新 task 前，operational router 應檢視現有 active/parked terminal
inventory。至少追蹤：

```yaml
terminal_inventory_entry:
  terminal_id:
  title:
  task_id:
  role:
  provider:
  model:
  model_family:
  reasoning_effort:
  lifecycle_state:                  # 上方六個 state 之一
  human_instruction_revision:       # 綁定值
  objective_fingerprint:            # 綁定值
  permission_scope_fingerprint:     # 綁定值
  last_activity_at:
  resumable:                        # true | false
```

**Unknown 或未綁定（缺少上述 fingerprint 欄位）的 terminal，`resumable` 一律為
`false`。即使 terminal 可 resumable，若 provider、model、model family 或 reasoning
effort 任一項無法證明與新 contract 相容，也不得重用來宣稱 exact dispatch。不得只
靠 terminal title、provider 或 role 推斷 task ownership 或 identity**——title 是給人
看的提示，不是可信的綁定資料。

### Terminal naming

建議 deterministic 命名：

```text
<project>:<task-short-id>:<role>:<state>
```

例如：

```text
company-platform:d13d-readonly-discovery:reviewer:ACTIVE
```

**不得**在標題中放入 credential、PII、完整 prompt，或 provider session secret
identifier。

### Resource-probe terminals

`RESOURCE_PROBE` terminal 是一種**唯讀觀察** scope 的短命 terminal，用來對 provider
CLI 送 `/status` / `/usage` 取得 quota facts。它**不是** worker / reviewer /
implementation task / continuation，走
`RESOURCE_PROBE_START → READY → OBSERVED → COMPLETE → RELEASED`，觀察後即依上方
cleanup 規則釋放。**不得**因為 probe 完成就關閉既有的 ACTIVE implementation /
reviewer terminal；也**不得**把 `/status` / `/usage` 注入到 busy 的 ACTIVE worker
（可能干擾其 TUI state 時改建 dedicated probe terminal）。probe 的取得順序、budget
與 identity 規則由
[`RESOURCE_AWARE_ROUTING.md`](RESOURCE_AWARE_ROUTING.md) 的 Resource acquisition
章節定義，此處不重複。

### Automatic cleanup policy（保守預設）

```text
PASS / COMPLETE       → handback 後自動 CLOSE
FAIL / BLOCKED        → evidence 擷取後 CLOSE，除非仍有有效的 explicit retry
SUPERSEDED / STALE    → 自動 CLOSE
HUMAN_GATE            → 預期原 task 續跑時 PARK，否則 CLOSE
ACTIVE                → 永不自動 CLOSE
MAX_TURNS_REACHED     → bounded continuation 仍有效才保留
```

**不得只以 elapsed wall-clock time 判斷是否關閉 `ACTIVE` session。** 這條規則必須
與 Execution lifecycle semantics 的 progress-aware waiting 語意相容——那裡已經
定義「慢不是 blocked」，這裡延伸為「慢也不是該關閉的理由」。

**Quota reset 不中斷健康的 `ACTIVE` worker。** 某個 provider 的 quota window 在
worker 執行期間 reset，**不得**因此停止該 worker 或把任務 restart 到剛 reset 的
provider 上。Quota re-evaluation（見
[`RESOURCE_AWARE_ROUTING.md`](RESOURCE_AWARE_ROUTING.md) 的
Reset-aware resource refresh）只影響**下一個** dispatch、下一個 independent
reviewer 選擇，以及需要**新的 model-selection 決策**的 continuation——不影響
已經在跑的健康 worker。

### 資源與安全衛生（不是安全邊界本身）

Cleanup 的動機包括：避免 stale session 被誤重用、降低 process/RAM 累積、減少
開啟的 shell 數量、降低殘留 env variable 的曝露面、降低殘留的 DB/network session
狀態、減少 operator UI 的雜亂。

**但 cleanup 本身不構成安全邊界。** Provider sandbox 與 credential policy 才是
權威邊界；cleanup 只是降低「累積帶來的額外風險」，不能替代或削弱既有的 permission
ceiling（見上方 Permission ceiling 的能力分解）與 credential 政策。

### Runtime capability 邊界

`CLOSE` 這個動作要求「關閉單一 terminal」，但目前已驗證的 Orca 命令集**沒有這個
能力**：`orca terminal stop` 只接受 `--worktree`，會連 router 自己的 terminal 一起
停掉，也沒有已驗證的 per-terminal close/list 命令。這是 runtime 的能力缺口，
不是本節政策設計的缺口——**本節不假造不存在的 runtime 行為**。

在該缺口補上之前，`CLOSE` 的實際執行路徑是：operational router 先完成上述分類
與 evidence 擷取，把該 terminal 標記為 `CLOSED`（lifecycle state，記在 inventory
與 handoff 中），再視情況交由人在 Orca UI 手動關閉該 tab，或等待同一 worktree 內
其他 terminal 也都可安全停止後，使用 worktree-scope 的 `orca terminal stop`。
精確的 upstream 需求記在
[`references/OFFICIAL_COMMANDS.md`](../references/OFFICIAL_COMMANDS.md)。

## Human gates

以下情況一律回 human，**不因模型能力或 quota 狀態而自動繞過**：

- ownership ambiguity
- architecture contract change
- breaking DB/API change
- destructive migration
- auth / RBAC / RLS（含 auth provisioning/binding、RLS policy 變更）
- privileged boundary change（含 `SECURITY DEFINER`、`BYPASSRLS` / `service_role`、privilege escalation 或 role-grant 變更）
- production deploy
- secrets 或 security config
- production bulk master-data mutation（大量、跨系統的正式環境資料異動）
- payroll / compensation write path
- 同時存在多個長期架構方案

**這份清單本身就是唯一的 owner。** 下方 Governance tiers 的 hard trigger 清單
直接引用這裡的項目，不重新定義一份會分歧的清單。

## Governance tiers

**`Governance intensity must be proportional to actual task risk, not to
production-relatedness alone.`** 這一節把上方 Human gates 的觸發條件、既有的
risk / verification_need 分類，收斂成三個具名的治理強度等級，決定預設的
workflow 形狀（要不要 preflight、要不要 mandatory human gate、要不要
independent review、要不要 exact-payload fingerprint）。它**不是**新的
task classification 系統：既有的六維分類（[`MODEL_ROUTING_POLICY.md`](MODEL_ROUTING_POLICY.md)）
與 Stage admission 完全不變，這裡只是把「risk / blast radius 決定 gate 嚴格度」
這個既有原則（見該文件的 *Risk is not capability requirement*）落成三個具體
等級。

### 三個等級

| Tier | 典型例子 | 預設 workflow |
|---|---|---|
| `G1_LIGHTWEIGHT` | UI/文字/排版變更、報表與 dashboard、非敏感的 derived view、文件、獨立 bug fix、低風險 config、可逆的前端行為 | implement → focused tests → commit。Independent review 除非其他政策要求，否則 optional。無 mandatory human gate、無 fingerprint、無強制 preflight。 |
| `G2_STANDARD` | employee master-data 邏輯、performance、attendance、workflow/case/task 邏輯、一般 schema 演進、一般 API、non-destructive migration、非特權 credential 的整合 | bounded plan → implementation → tests → independent review → deploy/commit。Human gate 只在 ambiguity、production mutation，或其他既有政策要求時才需要。預設無 fingerprint。 |
| `G3_HIGH_RISK` | payroll/compensation、auth/identity binding、RLS、`SECURITY DEFINER`、`BYPASSRLS`/`service_role`、privilege grant/role membership、destructive schema 變更、production bulk import、不可逆異動、security-boundary 變更、大量 employee/account 變更 | preflight → explicit human gate → bounded implementation → independent security review → controlled execution → post-validation。**Exact-payload fingerprint 只在該 task 明確需要 human 核准精確 canonical payload bytes 時才要求，不因為是 G3 就自動需要。** |

### 分類維度

至少評估四個維度，各自三階：

| 維度 | 值 |
|---|---|
| `DATA_SENSITIVITY` | `LOW` / `MODERATE` / `HIGH` |
| `REVERSIBILITY` | `EASY` / `MODERATE` / `HARD_IRREVERSIBLE`（即 HARD / IRREVERSIBLE） |
| `BLAST_RADIUS` | `LOCAL` / `MODULE` / `CROSS_SYSTEM_BULK`（即 CROSS_SYSTEM / BULK） |
| `PRIVILEGE_IMPACT` | `NONE` / `NORMAL` / `ELEVATED_SECURITY_BOUNDARY`（即 ELEVATED / SECURITY_BOUNDARY） |

**判定方式是語意分級，不是數字加總**：四個維度各自對應到三個嚴重程度
（0/1/2），**取四者中最嚴重的那個**決定 tier——最嚴重為 0（全部落在
`LOW`/`EASY`/`LOCAL`/`NONE`）→ `G1_LIGHTWEIGHT`；最嚴重為 1（任一維度到
`MODERATE`/`MODULE`/`NORMAL`）→ `G2_STANDARD`；最嚴重為 2（任一維度到
`HIGH`/`HARD_IRREVERSIBLE`/`CROSS_SYSTEM_BULK`/`ELEVATED_SECURITY_BOUNDARY`）
→ `G3_HIGH_RISK`。這對應到本節建議的語意映射：G1 是「大致上四個維度都在最輕
等級」；G2 是「sensitivity 到 moderate 或 module-level impact，但仍 bounded/
reversible、沒有重大 security-boundary 變更」；G3 是「任一維度出現強烈的
high sensitivity、hard irreversibility、bulk/cross-system impact，或
elevated/security-boundary 的權限變更」。

讀不到或無法辨識的維度值**不得視為最輕等級**——這與 quota `UNKNOWN` 的中性
處理不同：治理分級的不確定性是安全相關的不確定性，預設當作至少 `MODERATE`
等級（severity 1），不假設它是安全的。

### Hard triggers：直接鎖定 G3

以下任一為真時，**不論四個維度的計算結果，一律 `G3_HIGH_RISK`**：

- auth provisioning / binding
- RLS policy 變更
- `SECURITY DEFINER`
- `BYPASSRLS` / `service_role`
- destructive production migration
- production bulk master-data mutation
- payroll / compensation write path
- privilege escalation / role-grant 變更

**這組 hard trigger 就是上方 Human gates 清單中對應項目的具體化，不是第二份
清單。** 語意由 Human gates 一節唯一定義；這裡只是為了讓 Router 能程式化辨識
而列出對應的判定旗標。

### 不會單獨造成 G3 的訊號

以下**不得**單獨把 tier 推到 `G3_HIGH_RISK`：

- production 環境本身；
- 測試套件很大；
- 改動的檔案很多；
- 執行時間很長；
- 程式碼很複雜，但沒有敏感或不可逆的實際影響。

**Production-relatedness 本身不自動等於 G3。** 一個機械上簡單、可逆、無敏感
資料影響的 production config 變更可以維持 `G1_LIGHTWEIGHT`。一個複雜但可逆、
非敏感的 refactor 最多因為 blast radius 落在 `MODULE` 而到 `G2_STANDARD`，
不會因為複雜度本身被推到 `G3_HIGH_RISK`。

### 與既有機制的關係

**Governance tier 不是 capability stage。** 兩者正交，理由與
[`MODEL_ROUTING_POLICY.md`](MODEL_ROUTING_POLICY.md) 的
*Risk is not capability requirement* 完全一致：`G3_HIGH_RISK` 的 task 若範圍
明確，仍可能由 `STAGE_1_DEFAULT` / `STAGE_2_ADVANCED` 的模型完成；`G1_LIGHTWEIGHT`
的 task 若異常模糊，仍可能需要 `STAGE_3_FLAGSHIP` 的推理能力。**不得互相推導**：
tier 高不代表要調高 stage，stage 高也不代表 tier 一定高。

本節產出的 `required_gates` / `required_review` 是**額外**的下限，不取代既有
規則——`verification_need` 為 `independent`/`adversarial`、Router capacity
reserve、Router/Worker execution boundary、reviewer disjointness、exact
dispatch identity attestation 全部照舊、不因 governance tier 而放寬或改寫。
兩邊都要求時，取較嚴格者。

### Router 輸出

```yaml
governance_tier:         # G1_LIGHTWEIGHT | G2_STANDARD | G3_HIGH_RISK
governance_reasons:      # 簡短列出驅動判定的維度或 hard trigger
required_gates:          # [] 或 ["HUMAN_GATE"]
required_review:         # OPTIONAL | INDEPENDENT | INDEPENDENT_SECURITY
fingerprint_required:    # true | false — 只在該 task 明確需要 exact-payload
                         # 核准時為 true，不因為 G3 本身而自動 true
```

**Router 只需要簡短說明 tier 判定依據，不必產出冗長的 compliance 文字。**

### Human override

Human 可以明確調高或調降 process 嚴格度（例如「這個 G2 task 我要當 G3 處理」
或「這個 dimension-computed G2 task 我明確承擔責任降級處理」），綁定 current
task id 與 instruction revision——與本文件其他 override（continuation、
Router execution、model pin）同一套 staleness 語意，此處不重複定義。

**Security hard constraint 不可被 override 降級。** 任一 hard trigger 成立時，
override 只能維持或無意義地「調高」`G3_HIGH_RISK`，**不得**把它降到
`G2_STANDARD` 或 `G1_LIGHTWEIGHT`——這與 `allow_experimental` / `allow_red`
不能被 operational router 自行翻轉是同一種設計理由：human 的授權範圍不包含
解除安全邊界本身。

## Dispatch cost

跨 provider 派工本身有成本：撰寫 contract、建立 terminal、獨立複核、收斂結果。**當這些開銷明顯大於直接執行該工作時，不派工。**

派工在下列情況才划算：工作需要與實作者不同的獨立視角（independent review、regression hunting）、需要不同的能力層級、上下文量超出當前 session、或工作本身耗時足以攤平開銷。單純為了「用掉便宜模型」而派出瑣碎步驟是淨損失。

**這一節談的是「值不值得為了獨立視角或不同能力層級而多開一次派工」，不是「Router
自己做算不算派工」。** 判斷內容是否為 worker-shaped、Router 是否必須停止直接執行，
由上方 *Operational Router execution boundary* 的既有規則決定，此處不因為開銷考量
而放寬——省下派工開銷不是 Router 自己承接 worker-shaped 工作的理由。

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
