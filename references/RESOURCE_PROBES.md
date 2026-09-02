# Provider-Native Resource Probes

Verified against the authoring host on **2026-09-02** (baseline commit
`587d29b`). Re-verify against your own installed CLIs and accounts before
relying on any invocation here — this file records what was *observed*, not a
guarantee.

Normative rules (acquisition precedence, source trust, pre-dispatch flow,
UNKNOWN semantics, terminal hygiene) live in
[`../policies/RESOURCE_AWARE_ROUTING.md`](../policies/RESOURCE_AWARE_ROUTING.md),
*Resource acquisition* section. This file is the **verified invocation
reference** only. It is resource-interface qualification, not model-quality
benchmarking.

## Why this layer exists

Orca runtime / worker inventory does not expose normalized quota fields
(`orca status --json` reports app / runtime / capabilities, not rate-limit
state). Without this layer the router degrades straight to
`resource_state = UNKNOWN` even though each provider's own read-only CLI
command *does* expose current usage. `RESOURCE_AWARE_ROUTING.md` now requires a
supported provider-native probe to be attempted before falling to UNKNOWN.

## Acquisition precedence (summary)

```
1. ORCA_RUNTIME              structured trusted runtime data (not available today)
2. PROVIDER_NATIVE_PROBE     this file
3. USER_STATEMENT            fresh human-supplied facts
4. UNKNOWN                   neutral, never a block
```

## Driving an interactive TUI probe through Orca

The probe commands below are interactive slash commands, not flags. The
operational router drives them with Orca terminal control:

```bash
orca terminal create --worktree active --title "RESOURCE_PROBE <provider>" --command "<cli>" --json
orca terminal wait   --terminal <handle> --for tui-idle --timeout-ms 60000 --json
orca terminal send   --terminal <handle> --text "/status"  --json     # or /usage
orca terminal send   --terminal <handle> --enter --json
orca terminal read   --terminal <handle> --screen --json              # bounded read
orca terminal close  --terminal <handle> --tab --json                 # release (per lifecycle)
```

- On Git-Bash / MSYS shells prefix `orca terminal send` with
  `MSYS_NO_PATHCONV=1` (and `MSYS2_ARG_CONV_EXCL='*'`), or `/status` is
  rewritten to a Windows path before Orca receives it.
- `orca terminal close --terminal <handle> --tab` (verified on `orca 1.4.194`)
  closes one probe tab without touching other terminals. A `RESOURCE_PROBE`
  terminal is read-only and observational — never a worker, reviewer or
  continuation.
- Prefer reusing an existing healthy provider terminal only when its provider
  identity is known, it is not an ACTIVE task, and sending `/status` or
  `/usage` cannot alter that task's TUI state. Otherwise create a dedicated
  short-lived probe terminal.

## Codex

- **Executable:** `codex` (`codex-cli 0.151.0`). On PATH: yes.
- **Session:** authenticated (Plus tier) — no login prompt.
- **Command:** `/status` (interactive).
- **Probe result 2026-09-02:** `PROBE_OK`.
- **Quota fields observed:** both windows, each with a percentage bar and a
  reset time:
  - `5h limit: [....] 90% left (resets 18:38)`  → BURST, `remaining_ratio`
    parseable, `reset_at` parseable (local time).
  - `Weekly limit: [....] 37% left (resets 10:39 on 7 Sep)` → BUDGET,
    `remaining_ratio` + `reset_at` parseable.
  - Also prints model, permissions, account tier, session id.
- **Blocker:** none. `codex exec` (non-interactive) output does not include
  rate-limit info, so the interactive `/status` path is the probe.

## Claude

- **Executable:** `claude` (`Claude Code 2.1.258`). On PATH: yes.
- **Session:** authenticated (Claude Pro) — no login prompt.
- **Command:** `/usage` (interactive). `--help` shows no non-interactive
  `usage` subcommand.
- **Probe result 2026-09-02:** `PROBE_OK` with a confidence caveat.
- **Quota fields observed:**
  - `Current session  [....] 42% used  Resets 1:49pm (Asia/Taipei)` → BURST
    (5h rolling), `used`/`remaining_ratio` + `reset_at` parseable.
  - `Current week (all models)  [.] 5% used  Resets Sep 3, 3:59am (Asia/Taipei)`
    → BUDGET, parseable.
  - The panel states the numbers are *"approximate, based on local sessions on
    this machine — does not include other devices or claude.ai"*. Record this
    as `remaining_confidence: MEDIUM`, not HIGH.
- **Blocker:** none for the interactive path; the machine-local approximation
  caveat lowers confidence.

## Antigravity (Gemini family — the live path)

- **Executable:** `agy` (`Antigravity CLI 1.1.24`) at
  `~/AppData/Local/agy/bin/agy`. On PATH after adding that dir.
- **Session:** authenticated (Google AI Pro) — no login prompt.
- **Command:** `/usage` (interactive).
- **Probe result 2026-09-02:** `PROBE_OK` for ratios; `reset_at` UNKNOWN.
- **Quota fields observed:** two independently-limited pools, each with a
  weekly and a 5-hour limit as a *remaining* percentage — **no reset
  timestamps in the panel**:
  - pool `GEMINI MODELS` (Gemini Flash, Gemini Pro) → maps to
    `resource_state_key: antigravity.gemini`.
  - pool `CLAUDE AND GPT MODELS` (Claude Opus, Claude Sonnet, GPT-OSS) → maps
    to `resource_state_key: antigravity.non_gemini`.
  - Normalize each as: `role: BURST` / `role: BUDGET`, `remaining_ratio`
    parseable, `reset_at: null` (not observed → stays UNKNOWN, no value
    invented).
- **Blocker:** `agy -p` / print (headless) mode fail-closes on any tool that
  needs the `command` permission (*"a tool required the 'command' permission
  that headless mode cannot prompt for"*), so a headless probe cannot read
  `/usage`. The **interactive** path via `orca terminal` works. Record a
  headless attempt as `PROBE_PERMISSION_BLOCKED` and fall through to the
  interactive probe.

## Gemini (standalone `gemini` CLI)

- **Executable:** `gemini` (`0.58.0`) at `~/AppData/Roaming/npm/gemini`. On
  PATH: yes.
- **Session:** **not usable.** Launching it and sending `/usage` returns
  *"This client is no longer supported for Gemini Code Assist for individuals.
  To continue using Gemini, please migrate to the Antigravity suite of
  products"*, then an auth picker whose sign-in fails.
- **Probe result 2026-09-02:** `PROBE_SESSION_UNAVAILABLE` (the client is
  deprecated; treat as `PROBE_AUTH_REQUIRED` if a future version prompts for a
  working login).
- **Use `agy` instead** for the Gemini-family pools.

## Probe outcome vocabulary

`PROBE_OK`, `PROBE_AUTH_REQUIRED`, `PROBE_CLI_MISSING`,
`PROBE_SESSION_UNAVAILABLE`, `PROBE_PERMISSION_BLOCKED`, `PROBE_PARSE_FAILED`,
`PROBE_DATA_UNAVAILABLE`, `PROBE_TIMEOUT`, `PROBE_IDENTITY_UNCERTAIN`.

Only `PROBE_OK` (with a fresh, trust-valid, identity-verified entry) yields a
usable `PROVIDER_NATIVE_PROBE` reading. Every other outcome falls through to
the next acquisition tier. None of them disables a model, marks it
unqualified, mutates `MODEL_REGISTRY.yaml`, or increments
`failed_repair_count`.

## Security

Probe output may contain an account email / name (Codex `/status` and `agy`
`/usage` both do). **Do not write PII or credentials into `RESOURCE_STATE`.**
Persist only the normalized windows and an opaque `resource_state_key` /
account selector. Do not persist the raw `/status` or `/usage` transcript;
bounded transient inspection during parsing is fine.
