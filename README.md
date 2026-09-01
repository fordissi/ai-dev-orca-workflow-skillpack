# AI Dev Workflow Skill Pack

Version: `0.3`
Date: `2026-09-01`
License: MIT

一套可跨專案重用的多 Agent 開發治理框架：**大腦規劃任務類型 → Orca router 分派給
符合規格的模型 → 獨立複核 → human gate。**

它解決的是一個具體問題：當你同時訂閱多個 AI 供應商，如何在不犧牲可靠性、權限邊界
與架構一致性的前提下，把每個任務交給**當下能力足夠且資源可用**的模型——並且在
資訊不足時**保守地停下來，而不是猜**。

## 非目標

- 不是自動 router 應用程式。這裡沒有讀帳號、沒有呼叫 provider API、沒有自動派工。
- 不保證任何 provider 在 Windows 能可靠回報 quota。
- 不會因為某模型便宜或額度多，就把高風險任務降級給能力不足的模型。
- 不預設同一核心實作可以平行進行。

## 五分鐘快速開始

Windows（Git for Windows）先設定一次：

```bash
git config --global core.longpaths true
```

`docs/superpowers/` 下的設計文件檔名較長。若把本 repository clone 到本身已經很深的
父路徑底下，未開啟長路徑支援時 checkout 會以 `Filename too long` 失敗。這是 Git for
Windows 的預設路徑上限，不是 repository 的缺陷；改 clone 到較短路徑也可以。

```bash
npm install
npm test          # conformance tests
npm run validate  # registry / resource / routing cases / 全檔掃描 / 連結檢查
```

兩者都應 exit 0，`npm run validate` 印出 `Policy pack validation passed`。

> **採用前必讀。** 隨附的 `policies/MODEL_REGISTRY.yaml` 反映的是**撰寫這份 pack 的
> 那台主機**在當時觀察到的 CLI 狀態。其中的 provider、model ID 與能力標籤全部標記為
> `evidence_status: provisional`，**不構成任何普遍可用性保證**——Codex 的 model ID
> 尤其如此，因為該 CLI 沒有等同 `agy models` 的權威列表命令。
>
> 第一次派工之前，請對照**你自己**已安裝的 CLI 與訂閱方案重新確認候選是否存在、
> 是否可用，並依實際結果修改 registry。詳見
> [`references/MODEL_EVIDENCE.md`](references/MODEL_EVIDENCE.md) 與
> [`references/SOURCE_NOTES.md`](references/SOURCE_NOTES.md)。

接著：

1. 讀 [`skills/orca-multi-agent-dev/SKILL.md`](skills/orca-multi-agent-dev/SKILL.md)——agent 入口。
2. 複製 [`templates/NEW_SESSION_START_TEMPLATE.txt`](templates/NEW_SESSION_START_TEMPLATE.txt) 開新 session。
3. 用 [`templates/ROUTER_EXECUTION_CONTRACT_TEMPLATE.md`](templates/ROUTER_EXECUTION_CONTRACT_TEMPLATE.md) 寫第一份 contract。

## 五個層次（不要混在一起）

| 層 | 內容 | 檔案 | 變動頻率 |
|---|---|---|---|
| **stable workflow** | 角色、gate、生命週期、權限、concurrency | `policies/WORKFLOW_POLICY.md`、`CONCURRENCY_POLICY.md`、`MODEL_ROUTING_POLICY.md` | 只有流程本身改變時 |
| **dynamic mapping** | provider、model ID、能力層級、fallback 次序 | `policies/MODEL_REGISTRY.yaml` | 模型汰換時 |
| **runtime snapshot** | 當下的 quota / availability | `runtime/RESOURCE_STATE.json`（gitignored），範例見 `.example.json` | 每次讀取 |
| **project handoff** | 單一專案的狀態、contract、blocker | `templates/CURRENT_PROJECT_HANDOFF_TEMPLATE.md` | 每個 session |
| **experimental** | 尚未驗證、不可作為權威輸入 | `experiments/` | 不影響穩定流程 |

**模型換了只改 dynamic mapping，不動 stable workflow。** 這是整個 pack 的核心設計。

## 讀取順序

```text
SKILL → WORKFLOW_POLICY → CONCURRENCY_POLICY → MODEL_ROUTING_POLICY
      → MODEL_REGISTRY → RESOURCE_AWARE_ROUTING → OFFICIAL_COMMANDS
      → Current Project Handoff
```

同一規則只有一個 owner。Markdown policy 是 normative；
`scripts/validate-policy-pack.mjs` 只是 conformance checker，衝突時修程式。

## 角色切分

```text
大腦（可能是網頁版對話，無檔案系統）
        ↓  純文字：分類、role、slot、minimum_tier、concurrency、gate
Orca Operational Router（有檔案系統）
        ↓  讀 registry、套 overlay、選 candidate、組 dispatch command
Worker
        ↓  TASK_RESULT：完整技術輸出
Independent Review
        ↓
Orca Operational Router（整合 repo state、diff、tests、review findings）
        ↓  STRATEGIC_RETURN：compact decision delta，由人複製貼回
Strategic Router / Human Gate
```

回程刻意收斂：完整 evidence 留在 Git 與 review artifact，
[`templates/STRATEGIC_RETURN_TEMPLATE.md`](templates/STRATEGIC_RETURN_TEMPLATE.md)
只回傳足以做下一個決策的 delta，並以 repo / path / commit SHA 指向原文。

**Strategic router MUST NOT DEPEND ON direct filesystem access, local registry
visibility, or live quota visibility.** 因此它指定**能力需求**，不指名模型。

路由六階段：

```text
classify -> slot -> overlay -> candidate -> contract -> dispatch
```

## 三個端到端範例

### A. 規格清楚的局部實作

分類 `risk=low, complexity=low, context_size=small, ambiguity=low,
change_intensity=localized, verification_need=standard`
→ slot `DEFAULT_IMPLEMENTER`，`minimum_tier: DEFAULT`
→ overlay 後依 registry 順序選第一個合格候選
→ contract 寫死 allowed changes 與驗收條件
→ dispatch 時明確傳 `--sandbox workspace-write`
→ reviewer 直接看 `git diff` 與測試輸出。

### B. auth / 架構變更（必經 human gate）

分類 `risk=critical, ambiguity=high, change_intensity=structural,
verification_need=independent`
→ slot `DEEP_REASONER`，`minimum_tier: DEEP`
→ **quota 緊張不能降低這個門檻**
→ auth/RBAC/RLS 屬於不可繞過的 **human gate**，先回人決策
→ reviewer 的 provider 與 model family 都必須與 implementer 不同；
找不到 disjoint 候選就回 `BLOCKED`。

### C. 完全讀不到 quota

所有 provider 的 state 都是 `UNKNOWN`
→ **不估算、不假設充足也不假設不足**
→ 完全依能力門檻與 registry 順序選擇
→ contract 的 `RESOURCE_STATUS` 記 `UNKNOWN`，不填假數字。

`UNKNOWN` 既不被懲罰也不被獎勵——否則系統會獎勵「不去查」或「亂猜」。

## 停止條件

`BLOCKED` 必須附 reason code：`CONFIG_INVALID`、`ROUTING_UNAVAILABLE`、
`POLICY_BLOCKED`、`RESOURCE_BLOCKED`、`PERMISSION_BLOCKED`。

不得為了繞過阻塞而降低 `minimum_tier`、放棄 independent review 的 disjointness、
或提高權限。

**慢不是阻塞。** 輪詢逾時、總執行時間長、terminal 安靜、還沒給結論、
`Reached max turns`——都不是 `BLOCKED`：

```text
poll timeout != task timeout
total runtime != stall duration
slow != blocked
```

只有「session 仍活著且距上次可觀察進展超過 stall threshold」才進 stall 處理，
而 stall 處理買到的是一次檢查，不是判決。turn budget 用盡走 bounded continuation，
不算一次失敗的 repair。到達 hard ceiling 而 worker 仍在跑時交人決定，不自動 FAIL。

同樣地，`sandbox: read-only` **不等於**不准執行任何命令：`filesystem read`、
`command execution` 與 `filesystem write` 是三種能力。Reviewer 要能跑
`git diff`、`rg`、`cat` 才做得了獨立複核；它不能做的是寫入、commit、push、
動 database 與碰 production。人核准一條唯讀命令**不會提高 permission ceiling**。

兩者的完整語意見 [`policies/WORKFLOW_POLICY.md`](policies/WORKFLOW_POLICY.md) 的
Execution lifecycle semantics 與 Permission ceiling 的能力分解。

## 隱私與安全邊界

這個 repository 不存放 project secrets、個人資料、客戶資料、credential、
原始 quota payload 或 provider conversation ID。

`npm run validate` 會掃描所有可發布檔案，只輸出 path、行號與 pattern 名稱，
**永不回顯命中內容**。

Git history 本身是公開產物：commit message 不放 private AI session URL、
本機 harness 或 session identifier、provider conversation ID。詳見
[`policies/WORKFLOW_POLICY.md`](policies/WORKFLOW_POLICY.md) 的
public repository commit policy。

## 貢獻規則

- **模型 mapping 變更只改 [`policies/MODEL_REGISTRY.yaml`](policies/MODEL_REGISTRY.yaml)**，
  並附一份 [`templates/REGISTRY_DECISION_NOTE_TEMPLATE.md`](templates/REGISTRY_DECISION_NOTE_TEMPLATE.md)。
  單一 benchmark 結果不足以升降 stable mapping。
- 命令變更必須以官方文件與本機 `--help` 重新驗證，記入
  [`references/SOURCE_NOTES.md`](references/SOURCE_NOTES.md)。
- 證據等級與其限制記在 [`references/MODEL_EVIDENCE.md`](references/MODEL_EVIDENCE.md)。
- 送出前 `npm test` 與 `npm run validate` 都要 exit 0。

## 檔案索引

| 路徑 | 責任 |
|---|---|
| `skills/orca-multi-agent-dev/SKILL.md` | agent 入口 |
| `policies/WORKFLOW_POLICY.md` | 角色、precedence、lifecycle、gate、權限、commit policy |
| `policies/CONCURRENCY_POLICY.md` | concurrency mode 與啟用條件 |
| `policies/MODEL_ROUTING_POLICY.md` | 分類、slot、candidate 演算法、escalation |
| `policies/MODEL_REGISTRY.yaml` | ordered candidates 與能力標籤 |
| `policies/RESOURCE_AWARE_ROUTING.md` | resource state、freshness、候選重排 |
| `references/OFFICIAL_COMMANDS.md` | 已驗證的 CLI 命令 |
| `references/SOURCE_NOTES.md` | 查核方式與日期 |
| `references/MODEL_EVIDENCE.md` | 外部證據及其限制 |
| `templates/` | contract、strategic return、handoff、session、benchmark、decision note |
| `runtime/RESOURCE_STATE.example.json` | 安全的 resource snapshot 範例 |
| `scripts/validate-policy-pack.mjs` | conformance checker |
| `tests/` | 政策一致性測試、routing cases 與 execution cases |
| `docs/superpowers/` | 刻意公開的設計規格與實作計畫 |
| `experiments/` | optional、non-authoritative |
