# Concurrency Policy

**Concurrency is opt-in, not default.**

## SEQUENTIAL — default
用於 core schema/auth/shared contracts、相同核心檔案、依賴鏈、需求仍在收斂。

## PARALLEL_INDEPENDENT
只用於真正獨立工作，例如 unrelated repo discovery、獨立 tests、docs audit、read-only inventory。

## COMPETITIVE_DESIGN
多 Agent 只產 proposal，不同時 implementation。選定方案後只保留單一 implementation owner。

## PARALLEL_SAME_CORE_IMPLEMENTATION
預設禁止。Worktree 只能隔離檔案，不能解決語意衝突、重複實作或錯誤需求。

## Gate
平行前確認：outputs independent? merge semantic cost low? latency saving > review/merge cost? duplicated quota acceptable? one implementation owner? 任一不清楚即 sequential。
