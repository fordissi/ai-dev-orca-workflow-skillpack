# Benchmark Record

Version: `0.3`

一次低風險、可重現、驗收標準清楚的候選比較。**一筆記錄不能升降 stable mapping**——
它只是 `templates/REGISTRY_DECISION_NOTE_TEMPLATE.md` 的輸入之一。

只在低風險任務上比較。不要用正在進行的高風險工作當 benchmark。

```yaml
record_id:
recorded_at:
recorded_by:

task_class:                   # 例如 bounded_repo_implementation、long_context_discovery
slot:                         # 被測試的 capability slot
minimum_tier:                 # 該 slot 的能力下限

provider:
model:
model_family:
reasoning:                    # 實際使用的 reasoning effort
registry_version:             # 產生此候選的 MODEL_REGISTRY.yaml version

task_description:
acceptance_criteria:          # 必須在執行前寫定，不可事後調整
context_size:                 # 實際餵入的範圍

correctness:                  # pass | fail
acceptance_met:               # true | false
wall_clock_latency:           # 實測時間；未計時填 UNKNOWN
repair_count:                 # 初次 attempt 不計入
escalation_required:          # true | false

review_findings:              # reviewer 實際找到的問題，逐項列出
review_catch_rate:            # 已知植入或已知存在的問題中被抓到的比例；無基準時填 UNKNOWN
reviewer_provider:
reviewer_model_family:        # 必須與被測候選 disjoint，否則此欄記錄不成立

quota_efficiency:             # 沒有可靠數據時填 UNKNOWN，不要估算
tokens_used:                  # 讀不到填 UNKNOWN

environment:
  os:
  cli_version:
  harness:
confounders:                  # 已知會影響比較的差異，例如 context 長度不同、
                              # 網路狀況、快取、當日 provider 狀態。沒有就寫 none，
                              # 但不要因為想不到就留空。

blocked_reason_code:          # 未阻塞填 none
notes:
```

## 記錄規則

- 讀不到的量測值一律填 `UNKNOWN`。**估算出來的數字比缺值更有害**，因為它會被下游當成證據。
- `confounders` 是必填思考項。兩次執行若 context 大小或環境不同，就不是可比較的兩筆。
- reviewer 與被測候選必須 provider 與 model family 都不同，否則 `review_catch_rate` 沒有意義。
- 高風險、不可逆或涉及 architecture/security 的任務不得作為 benchmark 任務。
