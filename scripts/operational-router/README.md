# Operational Router — Resource Adapter

The live layer that turns structured **resource evidence** into the existing
Skillpack resource-routing inputs. Contract-first: today it is fed by an
injected / fixture `ResourceEvidence` object; later the same adapter will be
fed by `orca resource status --json` with no redesign.

```
ResourceEvidence JSON
        │  evidence-provider.mjs   (injectable producer boundary)
        ▼
resource-evidence.mjs             parse + schema-check + identity firewall
        ▼
resource-adapter.mjs             ┌─ getCurrentResourceState()  → RESOURCE_STATE overlay
  ingestResourceEvidence()  ─────┤
                                 └─ getPaceObservations()      → bounded exact ephemeral
                                                                  BUDGET observation history
        ▼
../lib/resource-routing.mjs       the shared pure Skillpack resolvers
  resolvePace / selectCandidate / resolveConservationPressure / …
        ▼
BURST · BUDGET · PACE  →  resource_pressure_rank  →  eligible-candidate ranking
        ▼
orca terminal create …            (rendered by the caller; see demo-e2e.mjs)
```

## Files

| file | responsibility |
|---|---|
| `resource-evidence.mjs` | the approved `ResourceEvidence` input contract; strict JSON parse; identity firewall (email / accountId / tokens / raw payloads never retained); order-independent window identity `(scope, role, window_minutes)` |
| `evidence-provider.mjs` | `ResourceEvidenceProvider` boundary; `FixtureResourceEvidenceProvider` (today); `OrcaCliResourceEvidenceProvider` (future — needs an injected `exec`, parses JSON out of decorative stdout) |
| `resource-adapter.mjs` | `OperationalResourceAdapter`: evidence → RESOURCE_STATE mapping, the bounded ephemeral observation store, generation-continuity segmentation, `explain()` observability |
| `demo-e2e.mjs` | runnable demonstration: `node scripts/operational-router/demo-e2e.mjs` |

## Boundaries

- **Semantics live in `../lib/resource-routing.mjs`**, which is the single
  implementation the conformance checker also consumes. The adapter never
  imports `validate-policy-pack.mjs`, never re-implements a resolver, and never
  changes a threshold. `MODEL_REGISTRY.yaml` and `policies/` are untouched.
- **The observation store is process-lifetime, bounded, in-memory, discardable.**
  It is never written to `runtime/telemetry/` or any persistent store. On
  restart the exact history is lost → PACE is `UNKNOWN` until rebuilt. Exact
  ephemeral observations feed **live PACE only**; bucketed telemetry (a
  separate, optional, offline concern) is never reconstructed from them.
- **BURST and BUDGET work from the current snapshot with zero history.** PACE
  requires a valid multi-observation same-generation BUDGET series.
- **The adapter is an evidence mapper, not a hard-gate owner.** `available`,
  `status`, `rate_limited`, `retry_at` and `source_updated_at` are carried
  independently; a rate-limited fetch is not turned into unavailability, and
  `status: error` is not turned into a guessed `RED`. When a trustworthy
  mapping is not justified by policy the state is `UNKNOWN` (neutral).
- **Freshness is `source_updated_at`-based**, never `queried_at`.
- **No background polling.** Acquisition stays lazy / event-driven; call
  `refresh()` / `ingestResourceEvidence()` at routing decisions.
- **No self-tuning.** `OBSERVATION_STORE_LIMITS` and the shared `PACE_EVIDENCE`
  thresholds are versioned and operator-controlled only.
