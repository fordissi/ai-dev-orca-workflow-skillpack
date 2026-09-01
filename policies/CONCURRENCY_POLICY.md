# Concurrency Policy

Version: `0.3`
Status: normative

**Concurrency is opt-in, not default.** 這份文件是 concurrency mode 與其啟用條件的 normative owner。它不決定 provider 或模型選擇（見 [`MODEL_ROUTING_POLICY.md`](MODEL_ROUTING_POLICY.md)）。

## Modes

### SEQUENTIAL — 預設

所有工作預設為 `SEQUENTIAL`。用於 core schema、auth、shared contract、相同核心檔案、有依賴鏈的步驟，以及需求仍在收斂的階段。

任何一項啟用檢查不明確時，回到 `SEQUENTIAL`。

### PARALLEL_INDEPENDENT

只用於 outputs 真正獨立的工作，例如 unrelated repo discovery、彼此不相干的 tests、docs audit、read-only inventory。

### COMPETITIVE_DESIGN

多個 agent **只產出 proposal，不同時 implementation**。方案選定後只保留單一 implementation owner，其餘 proposal 關閉。

### PARALLEL_SAME_CORE_IMPLEMENTATION

**永久禁止。** Worktree 只能隔離 checkout，不能解決語意衝突、重複實作或錯誤需求。同一核心實作永遠只有一個 owner。

## 啟用檢查

改用 `PARALLEL_INDEPENDENT` 前，五項必須全部為「是」：

1. outputs 真正獨立？
2. merge 的語意成本低？
3. 節省的時間大於 review 與 merge 的成本？
4. 重複消耗的 quota 可接受？
5. 只有一個 integration owner？

任一項不確定即維持 `SEQUENTIAL`。

## Integration owner

任何 concurrency mode 下，整併結果的 **integration owner 只能有一個**。平行產出的成果由該 owner 收斂；不得由多個 worker 各自 merge。

## Worktree

Worktree 用於隔離 checkout 與保留 implementation chain，**它不解決語意衝突**。

同一條 implementation chain 的 implement → review → fix → re-review 必須留在同一 worktree。Fresh agent session 可以接手同一 worktree，但必須先讀 handoff、contract 與現況；「fresh session」不等於「fresh worktree」。

## 與 dispatch cost 的關係

平行化會放大派工開銷。啟用檢查第 3 項須連同 `WORKFLOW_POLICY.md` 的 Dispatch cost 一併評估：若單一步驟本來就不值得派工，把它平行化只會讓淨損失變大。
