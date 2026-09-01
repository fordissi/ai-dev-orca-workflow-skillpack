# Registry Decision Note

Version: `0.3`

修改 `MODEL_REGISTRY.yaml` 的 mapping、capability tier 或 status 時，必須附一份 decision note。

**A single benchmark run is never sufficient to change a stable mapping.**
單一 benchmark 結果不能升降 stable mapping——一次好成績可能來自任務選擇、
context 長度、當日 provider 狀態或運氣。需要多次可比較的執行、沒有重大回歸，
並保留本記錄。

```yaml
note_id:
written_at:
written_by:
registry_version_before:
registry_version_after:

change_type:                  # promote | demote | add_candidate | remove_candidate
                              # | reorder | status_change | tier_change
slot:

old_mapping:                  # 變更前的完整 candidate 條目
  provider:
  model:
  model_family:
  capability_tier:
  status:
  evidence_status:
  position_in_candidates:

new_mapping:                  # 變更後的完整 candidate 條目
  provider:
  model:
  model_family:
  capability_tier:
  status:
  evidence_status:
  position_in_candidates:

evidence_sample_size:         # 可比較的執行次數。少於 3 次不得動 stable mapping。
benchmark_record_ids:         # 引用的 BENCHMARK_RECORD 記錄
external_evidence_ids:        # 引用的 references/MODEL_EVIDENCE.md 條目
local_smoke_cases_passed:     # 該 provider/CLI/model 組合通過的本機案例數
regressions_observed:         # 沒有就寫 none，但必須實際檢查過

rationale:                    # 為何這個變更是對的，而不只是「分數比較高」
what_this_evidence_cannot_show:   # 誠實列出證據涵蓋不到的部分

rollback_condition:           # 什麼情況下要退回 old_mapping。必須可觀察、可判定，
                              # 例如「連續兩次 bounded implementation 出現
                              # repair_count >= 2」。不可寫「表現變差」這種不可判定的條件。
rollback_owner:

reviewer:                     # 獨立於提出變更者
reviewer_provider:
reviewer_verdict:             # agree | disagree | agree_with_conditions
reviewer_conditions:

approval:                     # 核准此變更的 human
approval_recorded_at:
effective_date:               # mapping 生效日
next_revalidation_due:
```

## 規則

- `evidence_sample_size` 少於 3 次可比較執行時，只能改動 `experimental` candidate，不得改動 stable mapping。
- 從 `experimental` 升為 `stable` 另需該組合通過 3–5 個本機 smoke case，見 `references/MODEL_EVIDENCE.md`。
- `rollback_condition` 必須是可觀察、可判定的條件。寫不出來就代表這個變更還沒準備好。
- reviewer 必須與提出變更者 disjoint。
- 只改 registry 與驗證日期。**除非 workflow 本身改變，不得順手修改 stable policy。**
