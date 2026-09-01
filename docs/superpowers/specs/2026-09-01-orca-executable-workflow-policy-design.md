# Orca 多模型可執行工作流政策包設計

日期：2026-09-01
狀態：待使用者複核
目標版本：0.3

## 背景

本 repository 要提供一套可跨專案重用的 ChatGPT + Orca 多 Agent 工作流政策。它服務同時訂閱 Codex、Claude 與 Antigravity 等平台的使用者，目標是在不犧牲可靠性、權限邊界或架構一致性的前提下，把工作分配給能力合適且當下資源可用的模型。

目前草稿已建立三層結構：穩定工作流、動態模型路由、專案 handoff，也定義了 strategic router、Orca dispatcher、worker、reviewer 與 human gate。主要缺口是規則仍偏敘述性，尚不能一致地完成任務分類、capability slot 選擇、quota fallback、升級、派工、驗證與 benchmark 回饋。

## 目標

1. 把任務特徵轉成明確的 capability slot，不直接從任務描述猜模型名稱。
2. 用 `MODEL_REGISTRY.yaml` 集中管理快速變動的 provider、model、reasoning 與 fallback mapping。
3. 只用可信的資源狀態調整候選順序；無法取得 quota 時維持 `UNKNOWN`，不估算。
4. 讓每次 Orca 派工都有可檢查的 execution contract、權限上限、驗收條件、停止條件與完成回報。
5. 讓 implementation、independent review、repair 與 escalation 形成有限且可追蹤的閉環。
6. 以低風險 benchmark 的結果調整模型 mapping，不讓短期模型變動污染穩定 workflow。
7. 提供能在五分鐘內理解並手動執行的快速開始與端到端範例。

## 非目標

- 不在本 repository 開發自動讀取帳號、quota 或派工的完整 router 應用程式。
- 不保存 token、cookie、帳號識別資料、客戶資料、quota 原始回應或其他 secrets。
- 不保證任何 provider 都能在 Windows 可靠回報 quota。
- 不讓 Orca 重新解讀需求、改變 architecture contract 或自行降低權限門檻。
- 不因某模型價格較低或額度較多，就把高風險任務降級到能力不足的模型。
- 不預設同一核心實作可以平行進行。

## 系統邊界與權威來源

流程固定為：

```text
Task intake
  → task classification
  → capability slot
  → resource/quota overlay
  → MODEL_REGISTRY candidate selection
  → Orca execution contract
  → worker execution
  → independent review / verification
  → bounded repair or escalation
  → benchmark evidence
```

各層責任如下：

| 層 | 權威內容 | 不負責的內容 |
|---|---|---|
| `WORKFLOW_POLICY.md` | 角色、gate、生命週期、權限與跨 repo 規則 | 具體模型名稱 |
| `CONCURRENCY_POLICY.md` | concurrency mode 與啟用條件 | provider 選擇 |
| `MODEL_ROUTING_POLICY.md` | 任務分類、slot 選擇、repair 與 escalation | 即時 quota 數值 |
| `MODEL_REGISTRY.yaml` | slot 的 ordered candidates、reasoning、能力下限與重試限制 | 穩定 workflow 規則 |
| `RESOURCE_AWARE_ROUTING.md` | resource state、freshness 與候選重排 | architecture authority |
| `OFFICIAL_COMMANDS.md` | 經官方文件及本機 `--help` 驗證的命令 | 永久固定的 provider display name |
| Project handoff | 單一專案的 current state、contracts、blockers 與 next gate | 跨專案通用政策 |

同一規則若出現在多個檔案，以上表所列的 owner 為準；其他檔案只應連結或摘要，不建立第二份可分歧的定義。

## 任務分類

Strategic router 在 dispatch 前評估六個必要維度：

| 維度 | 建議值 | 判定重點 |
|---|---|---|
| risk | low / medium / high / critical | 錯誤的影響與可逆性 |
| complexity | low / medium / high | 跨模組程度、狀態空間與推理深度 |
| context_size | small / medium / large | 必須同時理解的 repository／文件範圍 |
| ambiguity | low / medium / high | contract 與成功條件是否明確 |
| change_intensity | none / localized / structural | 唯讀、局部修改或結構性修改 |
| verification_need | standard / independent / adversarial | 一般驗證、獨立複核或邊界案例搜尋 |

分類結果還要記錄 architecture/security involvement 與預期 repair 次數，但它們是升級訊號，不另建平行的分類系統。

## Capability slot 選擇

依下列優先順序選擇最低但足夠的 slot；高風險規則優先於成本規則：

| 條件 | Slot |
|---|---|
| 路由、拆解、execution contract 與 gate 判定 | `ROUTER` |
| 低風險文件整理、格式化、查找與 bounded inventory | `CHEAP_GENERALIST` |
| 規格清楚、局部、可由明確測試驗收的一般實作 | `DEFAULT_IMPLEMENTER` |
| 跨模組、結構性 bug、複雜 migration 或多次互動的實作 | `STRONG_IMPLEMENTER` |
| architecture、contract ambiguity、auth/RBAC/RLS、安全或不可逆決策 | `DEEP_REASONER` |
| 大型 repository、跨 repo inventory、schema/API 大範圍比較 | `LONG_CONTEXT_DISCOVERY` |
| 與實作者不同 provider／model family 的獨立檢查 | `INDEPENDENT_REVIEWER` |
| 測試失敗、回歸、邊界案例或 adversarial validation | `REGRESSION_HUNTER` |
| 合格候選無法收斂、reviewer disagreement 或 exceptional risk | `ESCALATION_MODEL` |

若同時符合多個 slot，implementation slot 與 verification slot 分開記錄。例如大型跨 repo 修改可以用 `LONG_CONTEXT_DISCOVERY` 先盤點、`STRONG_IMPLEMENTER` 實作，再用 `INDEPENDENT_REVIEWER` 複核；不應把 discovery 模型默認為 implementation owner。

## Resource overlay 與候選演算法

### Resource state

每個 provider 分別記錄 short rolling window、weekly window、reset timestamp、availability、source 與 `checked_at`。穩定政策只接受四種彙總狀態：

- `GREEN`：可正常承擔該 provider 適合的工作。
- `YELLOW`：保留部分資源，只分配 provider 明顯有優勢或低風險的工作。
- `RED`：除非沒有其他達到最低能力的候選，否則排除。
- `UNKNOWN`：沒有可信資訊；完全依能力與 registry 順序，不把未知當充足或不足。

快取未滿五分鐘可重用；超過五分鐘視為 stale。Critical routing 必須要求刷新或明確記錄仍為 `UNKNOWN`。本政策不自行規定 provider-specific 百分比門檻；門檻只可在 resource adapter 或範例狀態的版本化 schema 中定義，且要有來源。

### 候選選擇

1. 從指定 capability slot 讀取 ordered `primary` + `fallbacks`。
2. 移除 unavailable、experimental 未獲准、或低於 `minimum_capability` 的候選。
3. 若有 `GREEN` 候選，維持 registry 的能力順序選第一個合格者。
4. 若只有 `YELLOW`／`UNKNOWN`，先維持能力門檻，再依 registry 順序選擇；`UNKNOWN` 不因缺少資料被懲罰或獎勵。
5. `RED` 只在沒有非 `RED` 合格候選且任務允許時使用，並在 contract 中記錄理由。
6. 沒有合格候選時，不跨越能力下限；回報 `BLOCKED` 或進 human gate。
7. Router 保存此次決策快照與理由，但不保存原始 quota payload。

Resource overlay 只能在相同或更高能力的候選之間重排，不能把 `DEEP_REASONER` 任務改派到 `CHEAP_GENERALIST`。

## Model registry schema

`MODEL_REGISTRY.yaml` 將成為唯一的動態 mapping owner。每個 slot 至少包含：

```yaml
capability_slots:
  DEFAULT_IMPLEMENTER:
    minimum_capability: DEFAULT_IMPLEMENTER
    max_repair_attempts: 2
    candidates:
      - provider: codex
        model: gpt-5.6-luna
        reasoning: medium
        status: stable
      - provider: codex
        model: gpt-5.6-sol
        reasoning: medium
        status: stable
```

Schema 規則：

- `candidates` 的順序具有意義，取代目前單數 `fallback` 欄位。
- `status` 只允許 `stable` 或 `experimental`；experimental candidate 不能接高風險 production work。
- 動態名稱使用明確 resolver，例如 Antigravity 的 live `agy models`，不永久硬編 display name。
- provider-specific model ID、reasoning value 與 discovery command 只放在 registry 或官方命令參考。
- mapping 變更只修改 registry 與驗證日期；除非 workflow 本身改變，不修改穩定政策。
- YAML 必須通過語法與必要欄位驗證，並檢查每個 fallback 仍達到 slot 的 `minimum_capability`。

## Execution contract 與執行生命週期

每次派工前建立一份可直接傳給 worker 的 contract，至少包含：

- `contract_version`、task ID、why now。
- repo、完整 worktree selector、branch、authoritative owner。
- 六維 task classification、implementation slot、review slot、concurrency mode。
- 實際 provider/model/reasoning、fallback 次序、resource state snapshot 與選擇理由。
- sandbox、approval policy、network、production access 與 permission ceiling。
- authoritative references、allowed changes、prohibited changes。
- validation commands、acceptance criteria、review destination。
- repair budget、stop conditions、human gate 與 escalation policy。

標準生命週期：

1. Router 驗證 repo、HEAD、working tree、handoff 與 authoritative contracts。
2. Router 選 slot、resource overlay、candidate 與 concurrency mode。
3. Orca 建立或重用正確 terminal/worktree，只執行 contract，不改寫需求。
4. Worker 在允許範圍內實作與驗證，回傳結構化 footer。
5. Reviewer 優先以唯讀方式直接檢查 filesystem、diff 與 tests，不只閱讀 worker 摘要。
6. 通過則結束；失敗則在 repair budget 內交回單一 implementation owner。
7. 兩次 repair 失敗、architecture/security 問題、ownership conflict、reviewer disagreement 或不可逆風險會升級 slot 或進 human gate。

完成 footer 擴充為：

```text
TASK_RESULT
status: PASS | FAIL | BLOCKED
actual_provider:
actual_model:
reasoning_effort:
attempt_count:
changed_files:
tests:
git_status:
remaining_risks:
human_decisions_required:

RESOURCE_STATUS
checked_at:
provider_states:
source_summary:
```

`RESOURCE_STATUS` 可為 `UNKNOWN`；worker 不得為了填滿 footer 猜測數值。

## Concurrency 與 worktree

預設為 `SEQUENTIAL`。只有 outputs 真正獨立、merge semantic cost 低、節省時間大於 review／merge 成本、重複 quota 可接受且只有一個 integration owner 時，才可改用 `PARALLEL_INDEPENDENT`。

`COMPETITIVE_DESIGN` 只產 proposal；方案選定後只保留一個 implementation owner。`PARALLEL_SAME_CORE_IMPLEMENTATION` 保持禁止。Worktree 用於隔離 checkout 和保留 implementation chain；它不解決語意衝突。

同一條 implementation chain 的 implement → review → fix → re-review 應留在同一 worktree。Fresh agent session 可以接手，但必須先讀 handoff、contract 與現況，不可把「fresh session」誤解成「fresh worktree」。

## Human gates 與安全

以下情況不因模型能力或 quota 狀態而自動繞過：ownership ambiguity、architecture contract change、breaking DB/API、destructive migration、auth/RBAC/RLS、privileged boundary、production deploy、secrets/security config，以及存在多個長期架構方案。

派工權限採最小必要原則：discovery/review 預設 read-only；implementation 只給 workspace write；production access 預設 false。命令範例不能預設危險權限旗標。所有 command automation 在發布前以官方 upstream 文件與本機 `--help` 再驗證，若兩者不同，以實際安裝版本為執行依據並記錄差異。

## Benchmark 回饋閉環

新增 benchmark 記錄範本，每次只在低風險、可重現、驗收標準清楚的任務比較候選。至少記錄：

- task class、slot、provider/model/reasoning 與版本日期。
- correctness／acceptance pass。
- wall-clock latency。
- repair count 與是否需要 escalation。
- reviewer findings 與 review catch rate。
- token 或 quota efficiency；無可靠資料時填 `UNKNOWN`。
- context size、環境差異及已知 confounders。

單次結果不能直接升降 stable mapping。Registry 調整需要多次一致結果、沒有重大回歸，並保留 decision note。Workflow 只有在流程本身被證明需要改變時才更新。

## 文件與範本變更

實作階段預計：

- 強化 `README.md`：責任分層、五分鐘快速開始、端到端路由例子及檔案索引。
- 修訂四份 policy，使分類、候選選擇、升級、concurrency 與 gate 可直接執行。
- 遷移 `MODEL_REGISTRY.yaml` 至 ordered candidates schema。
- 擴充 `RESOURCE_STATE.example.json` 的 timestamp、availability、reset 與 source 欄位，但不放真實帳號資料。
- 擴充 execution contract、current handoff 與 session start 範本。
- 新增 benchmark record template 與 registry decision note template。
- 依重新驗證結果修訂 `OFFICIAL_COMMANDS.md` 與 `SOURCE_NOTES.md`。
- 新增 MIT `LICENSE` 與適合此純政策 repository 的 `.gitignore`。
- 保持 `project-handoffs/` 只放無敏感資料的範例或說明，不提交真實客戶 handoff。

## 驗證與驗收

發布前必須完成：

1. YAML 與 JSON 可解析，schema 必要欄位完整。
2. Markdown 內部連結、閱讀順序與 authoritative owner 一致。
3. 全 repository 掃描 secrets、個資、客戶資料、未完成 placeholder 與過時命令。
4. `orca`、`codex`、`claude`、`agy` 範例逐項對照官方來源及本機 `--help`；未安裝或無法驗證者明確標記，不猜測。
5. 至少以三個 table-driven 案例驗證 routing：低風險一般實作、高風險 auth/architecture、大型跨 repo discovery + independent review。
6. 驗證 `GREEN`、`YELLOW`、`RED`、全 `UNKNOWN`、沒有合格候選等 resource cases。
7. 驗證 repair budget 到期會升級或停止，不會無限重試。
8. Git diff 只包含核准範圍，working tree 在提交後乾淨。
9. 建立公開 GitHub repository 後，以 GitHub API 或 `gh repo view` 核對 owner、visibility、default branch、license 與最新 commit。

完成定義：新使用者只依 README、政策、registry 與範本，即可對範例任務產生一致的 slot、candidate、execution contract、review gate 與停止條件；遇到未知 quota 或能力不足時會保守且可解釋地停止，而非猜測。

## 發布順序

1. 先提交本設計規格，等待使用者複核。
2. 複核通過後建立詳細 implementation plan。
3. 依 plan 修改政策、registry、runtime example、範本與 README。
4. 執行語法、連結、敏感資訊、路由案例與 CLI 驗證。
5. 提交 implementation；在推送前再次檢查 diff、歷史與 clean tree。
6. 使用已核准的名稱建立公開 GitHub repository，加入 MIT License 並推送 `main`。
7. 從遠端核對 repository 狀態，回報任何仍為 `UNKNOWN` 的 provider／quota 能力。

## 已核准的決策

- 採「可執行政策包」，不只做最小文件修補，也不開發完整自動 router。
- repository 名稱為 `ai-dev-orca-workflow-skillpack`。
- GitHub visibility 為 public。
- License 為 MIT。
- quota 用來重排合格候選，不能改變 architecture authority 或最低能力門檻。
- Windows quota 自動偵測維持 experimental／optional，不成為穩定流程前置條件。
