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
| `WORKFLOW_POLICY.md` | 角色、precedence、lifecycle、execution lifecycle、continuation freshness、session lifecycle/cleanup、handback、gate、permission ceiling 語意、cross-repo | 具體模型名稱、blocked reason code 語意 |
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
| `DISPATCH_CONTRACT_MISMATCH` | worker 實際的 provider/model/reasoning_effort 與 contract 不符 | 見下方 *Dispatch contract attestation* |

**這些是觀察狀態，不是 blocked reason code。** 其中 `PERMISSION_BLOCKED` 與
`ROUTING_UNAVAILABLE` 是唯二會交棒給 canonical blocked reason code 的出口，
其語意由 [`MODEL_ROUTING_POLICY.md`](MODEL_ROUTING_POLICY.md) 的
Blocked reason codes 章節定義，此處不重複。`DISPATCH_CONTRACT_MISMATCH`
**不是** `ROUTING_UNAVAILABLE`，也不是任何 blocked reason code。

### Dispatch contract attestation

`provider + model + reasoning_effort` 是 execution identity（owner：
[`MODEL_ROUTING_POLICY.md`](MODEL_ROUTING_POLICY.md)）。Dispatch 後，operational
router 應做一次 best-effort attestation：比對 contract 的
`expected_runtime_identity`（`provider` / `model` / `reasoning_effort`）與
runtime 實際值。取值方式與能力缺口見
[`../references/OFFICIAL_COMMANDS.md`](../references/OFFICIAL_COMMANDS.md) 的
*Runtime attestation*。

| attestation_result | 意義 | 動作 |
|---|---|---|
| `MATCH` | 三者一致 | 正常繼續 |
| `UNVERIFIED` | runtime 未提供可讀取的實際值 | 記錄；依 task 風險決定是否要求人工確認，不阻塞低風險工作 |
| `DISPATCH_CONTRACT_MISMATCH` | 任一欄位不符（例：contract `Sol medium`，實際 `Sol max`） | 見下 |

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
  lifecycle_state:                  # 上方六個 state 之一
  human_instruction_revision:       # 綁定值
  objective_fingerprint:            # 綁定值
  permission_scope_fingerprint:     # 綁定值
  last_activity_at:
  resumable:                        # true | false
```

**Unknown 或未綁定（缺少上述 fingerprint 欄位）的 terminal，`resumable` 一律為
`false`。不得只靠 terminal title 推斷 task ownership**——title 是給人看的提示，
不是可信的綁定資料。

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
