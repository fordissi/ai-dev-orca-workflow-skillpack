# Current Project Handoff

Version: `0.3`

Handoff 記錄**單一專案的當前狀態**，不重複 contract 內容，也不放跨專案通用政策。
Active contract 用指向的方式引用，避免產生第二份會分歧的副本。

Handoff 與 `STRATEGIC_RETURN` 角色不同，不得互相取代：

| | 範圍 | 生命週期 |
|---|---|---|
| **CURRENT_PROJECT_HANDOFF** | 跨 session 的 durable project state | 專案存續期間 |
| [**STRATEGIC_RETURN**](STRATEGIC_RETURN_TEMPLATE.md) | 單次 task / cycle 的 decision delta | 一次 routing/execute/review cycle |

本輪工作改變 durable project state 時，operational router 先更新這份 handoff，
再於 `STRATEGIC_RETURN` 的 `HANDOFF_UPDATE` 指出哪些部分被更新。
Handoff 不累積歷次 `STRATEGIC_RETURN` 的全文。

不得放入客戶資料、個人資料、credential、原始 quota payload 或 provider
conversation ID。讀不到的值填 `UNKNOWN`。

```yaml
handoff_version: "0.3"
written_at:
written_by:

objective:

repository:
  repo:
  worktree_selector:
  branch:
  head:

completed_work:
current_implementation_state:
tests_and_verification_passed:
known_failures_and_open_findings:

authoritative_documents:        # precedence 鏈，不在此重述其內容
architecture_decisions_made:
human_decisions_made:
decisions_pending:

active_contract:                # 指向，不複製
  contract_version:
  task_id:
  location:
  strategic_contract_complete:  # true | false
  operational_resolution_complete:  # true | false | unresolved
  blocked_reason_code:          # 無阻塞時填 none
  human_instruction_revision:   # 指向 contract 的 continuation_binding，讓新
                                 # session 不必重算即可比對；語意見
                                 # policies/WORKFLOW_POLICY.md 的
                                 # Continuation freshness

resource_snapshot:              # 每個 provider 或獨立限額 pool 各自一筆
  # provider_or_pool:
  #   state:        # GREEN | YELLOW | RED | UNKNOWN
  #   checked_at:   # 該 pool 自己的時間，或 UNKNOWN
  #   source:       # 例如 user statement；不放原始 payload

scope_boundaries:
contracts_not_to_change_casually:
known_stale_docs:
current_dirty_or_untracked_state:
blockers:

next_gate:                      # 下一個需要人為放行的點
  gate:
  owner:
  what_is_being_asked:
  evidence_to_present:

next_recommended_task:
acceptance_criteria:
risks:

things_not_to_redo:             # 明列已完成且已驗證、不要重做的工作

suggested_first_read_order:
```

## NEXT SESSION STARTING INSTRUCTION

接手時先回答：Current State / Next Gate / Remaining Blockers / Authoritative
Contracts。`authoritative_owner` 確認前不 dispatch implementation。

「fresh session」不等於「fresh worktree」：同一條 implementation chain 留在同一
worktree。
