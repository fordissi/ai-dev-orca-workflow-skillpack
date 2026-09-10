# ResourceEvidence fixtures

Injected `ResourceEvidence` objects for the Operational Router adapter tests and
the end-to-end demonstration (`scripts/operational-router/demo-e2e.mjs`).

These stand in for the future `orca resource status --json` producer. Shape and
rules: `scripts/operational-router/resource-evidence.mjs`.

| file | purpose |
|---|---|
| `codex-budget-series-1.json` .. `-3.json` | same-generation weekly BUDGET burn (feeds PACE) |
| `codex-capacity-grant.json` | weekly `remaining_ratio` jumps up + `reset_at` moves → continuity break → PACE UNKNOWN |
| `codex-burst-nearly-spent.json` | single snapshot, 5h BURST at 0.03, reset far → burst depletion HIGH with zero history |
| `multi-provider-rebalance.json` | Codex weekly not scarce but PACE-pressured (3rd of a series) + healthy Gemini peer |
| `gemini-buckets.json` | Antigravity Gemini vs non-Gemini pools as distinct `resource_state_key`s |
| `unknown-role-window.json` | a `role: "UNKNOWN"` window retained raw, ignored by BURST/BUDGET |
| `provider-unavailable.json` | `available: false`, `status: "error"` mapped conservatively (UNKNOWN, not RED) |
| `stale-source.json` | `source_updated_at` old while `queried_at` fresh → not treated as fresh |
| `malformed-not-json.txt` | not JSON at all → `MALFORMED_JSON` |
| `malformed-schema.json` | no `providers` → `SCHEMA_INVALID` |
| `identity-bearing.json` | carries `email` / `accountId` / `token` → dropped (or rejected in strict mode) |
