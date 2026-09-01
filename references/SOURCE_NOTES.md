# Verification Notes — 2026-09-01

Orca：已核對 stablyai/orca `skill-guides/orca-cli.md` 與 `orchestration.md`。重要修正：current primary docs 以 `terminal read --json`/cursor read 為主；`--screen` 視版本/local build 驗證。Custom Codex model/effort 用 explicit terminal command。

Codex：已核對 OpenAI Help、安全指引與 current config schema。`approval_policy=untrusted` 已不支援；保守替代為 read-only + on-request。

Claude：已核對 Anthropic CLI reference 的 `--model`、`--permission-mode`、`-p/--print`、`--output-format`、`--max-turns`。

Antigravity：已核對 Google 2026 遷移公告與 codelab。consumer terminal workflow 已轉 Antigravity CLI；`agy models`、`agy --model`、print mode 有官方範例。

OpenUsage：已核對 repo/provider docs。native app 要 macOS 15+；可作 Codex/Claude/Antigravity quota provider 邏輯參考。
