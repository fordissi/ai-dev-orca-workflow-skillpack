# Official / Primary Command Reference

Verified: 2026-09-01

## Orca
Primary: https://github.com/stablyai/orca/blob/main/skill-guides/orca-cli.md

Fresh agent in active worktree:
```bash
orca terminal create --worktree active --title "<task>" --command "codex" --json
orca terminal wait --terminal <handle> --for tui-idle --timeout-ms 60000 --json
orca terminal send --terminal <handle> --text "<prompt>" --enter --json
```

Custom Codex model/effort:
```bash
orca terminal create --worktree active --title "<task>" --command 'codex -m <model> -c model_reasoning_effort="<effort>"' --json
orca terminal wait --terminal <handle> --for tui-idle --timeout-ms 60000 --json
orca terminal send --terminal <handle> --text "<prompt>" --enter --json
```

Independent worktree built-in agent:
```bash
orca worktree create --name <task-name> --no-parent --agent codex --prompt "<task brief>" --json
```

Custom argv in new worktree:
```bash
orca worktree create --name <task-name> --no-parent --json
orca terminal create --worktree id:<repoId>::<newWorktreePath> --title <task-name> --command 'codex --model <model> -c model_reasoning_effort="<effort>"' --json
orca terminal wait --terminal <handle> --for tui-idle --timeout-ms 60000 --json
orca terminal send --terminal <handle> --text "<task brief>" --enter --json
```

Inspect:
```bash
orca terminal list --worktree <selector> --json
orca terminal show --terminal <handle> --json
orca terminal read --terminal <handle> --json
orca terminal read --terminal <handle> --cursor <cursor> --limit 1000 --json
```

Current primary docs emphasize JSON/cursor reads. Earlier/local builds may expose `--screen`; verify with `orca terminal read --help` before relying on it.

Structured DAG/stateful coordination: use `orca orchestration ...` per https://github.com/stablyai/orca/blob/main/skill-guides/orchestration.md

## OpenAI Codex CLI
Primary: https://help.openai.com/en/articles/11096431 and https://github.com/openai/codex

Model:
```bash
codex -m <model>
codex --model <model>
```
Reasoning config key: `model_reasoning_effort`.

Conservative permissions:
```bash
codex --sandbox read-only --ask-for-approval on-request
```
Workspace implementation:
```bash
codex --sandbox workspace-write --ask-for-approval on-request
```
`approval_policy = "untrusted"` is no longer supported in current Codex versions.

## Claude Code
Official: https://docs.anthropic.com/en/docs/claude-code/cli-usage
```bash
claude --model sonnet
claude --model opus
claude --permission-mode plan
claude -p "query" --output-format json
claude -p --max-turns 3 "query"
```
Do not default to `--dangerously-skip-permissions`.

## Google Antigravity CLI
Official announcement: https://developers.googleblog.com/en/an-important-update-transitioning-gemini-cli-to-antigravity-cli/
Official codelab: https://codelabs.developers.google.com/antigravity-cli-hands-on

Executable: `agy`
```bash
agy models
agy --model "<model name>"
agy -p "<prompt>"
agy --print "<prompt>"
```
Use `agy models` as live model source; do not permanently hard-code display names.

## OpenUsage
Primary: https://github.com/robinebers/openusage
Native app currently requires macOS 15+. Use as quota-discovery reference; do not assume direct Windows install.

## Version Verification Rule
Before automating:
```bash
orca --help
orca terminal --help
orca worktree --help
codex --help
claude --help
agy --help
agy models
```
Installed binary help wins over stale examples.
