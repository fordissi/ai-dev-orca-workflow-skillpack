# Orca Multi-Agent Development Skill

## Purpose
使用 Orca 作為 execution / terminal / worktree / orchestration layer，由上層 ChatGPT 充當 PM / Lead Architect / strategic router。

## Strategic vs Operational Routing

### ChatGPT decides
- why this task now
- authoritative contract
- capability slot
- risk
- permission ceiling
- concurrency mode
- acceptance criteria
- review gate
- escalation policy

### Orca Router decides
- reuse or create terminal
- actual model matching capability slot
- quota-aware provider selection
- reasoning effort within policy
- terminal/worktree selector
- dispatch mechanics

Router 不得自行改寫 architecture contract，也不從原始需求自行推導 capability slot。

## Default Concurrency
`SEQUENTIAL`。Parallel 必須明確 opt-in。
允許：`PARALLEL_INDEPENDENT`、`COMPETITIVE_DESIGN`。
預設禁止：`PARALLEL_SAME_CORE_IMPLEMENTATION`。

## Worktree Rule
同一 implementation chain 可共用同一 worktree：implement → review → fix → re-review。
Fresh agent session 不等於必須新 worktree。

## Router Contract Minimum
- repo/worktree
- capability_slot
- preferred/fallback model class
- reasoning effort
- sandbox/permissions
- task
- authoritative references
- allowed changes
- prohibited changes
- validation commands
- acceptance criteria
- stop conditions
- review destination

## Completion Footer
```text
TASK_RESULT
status: PASS | FAIL | BLOCKED
changed_files:
tests:
git_status:
remaining_risks:
human_decisions_required:
```
若 quota machine-readable，再回 RESOURCE_STATUS；否則 UNKNOWN，禁止猜測。
