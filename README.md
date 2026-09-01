# AI Dev Workflow Skill Pack

Version: `0.2-draft`  
Date: `2026-09-01`

這是一套可跨專案重用的 ChatGPT + Orca 多 Agent 開發治理框架。

它把資訊拆成三層：
1. **Stable workflow**：ChatGPT / Router / Worker / worktree / human gate / orchestration。
2. **Dynamic routing**：模型能力、CP 值、quota、provider availability、fallback。
3. **Project state**：每個專案自己的 Current Project Handoff。

核心：
```text
ChatGPT (Strategic Router / Lead Architect)
        ↓
Execution Contract
        ↓
Orca Operational Router
        ↓
Worker(s)
        ↓
Independent Review / Verification
        ↓
Human Gate
```

**Concurrency is opt-in, not default.**

閱讀順序：
1. `skills/orca-multi-agent-dev/SKILL.md`
2. `policies/WORKFLOW_POLICY.md`
3. `policies/CONCURRENCY_POLICY.md`
4. `policies/MODEL_ROUTING_POLICY.md`
5. `policies/RESOURCE_AWARE_ROUTING.md`
6. `references/OFFICIAL_COMMANDS.md`
7. Current Project Handoff

GitHub repo 是 authoritative source；SKILL.md 是 agent 入口。
