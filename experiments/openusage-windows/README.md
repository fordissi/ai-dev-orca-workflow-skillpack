# OpenUsage Windows Compatibility Experiment

Optional infrastructure experiment，不是 Company Platform blocker。

Goal：找出 Codex/Claude/Antigravity 在 Windows 可安全 machine-read 的 quota snapshot。

Steps：
1. 先查官方/local CLI usage/status。
2. 參考 OpenUsage provider implementation。
3. 優先 local-only、既有登入狀態。
4. normalize 到 RESOURCE_STATE。
5. cache。
6. failure → UNKNOWN。

禁止輸出 token/cookie/secret；禁止為了 quota 繞過 provider security。
