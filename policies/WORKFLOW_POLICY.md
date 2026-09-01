# Workflow Policy

## Roles
- ChatGPT：PM / Lead Architect / strategic router
- Orca Router：operational dispatcher only
- Worker：bounded execution
- Reviewer：prefer read-only; inspect filesystem/git diff/tests directly

## New Session
依序載入：Skill/Workflow → Model Routing → Resource Routing → Current Project Handoff。
先回 Current State / Next Gate / Remaining Blockers / Authoritative Contracts；owner 確認前不 dispatch implementation。

## Human Gates
以下預設回 human：ownership ambiguity、architecture contract change、breaking DB/API、destructive migration、auth/RBAC/RLS、privileged boundary、production deploy、secrets/security config、長期架構多方案。

## Cross-repo
必須明確 source repo / target repo / authoritative owner / migration direction / allowed writes。
