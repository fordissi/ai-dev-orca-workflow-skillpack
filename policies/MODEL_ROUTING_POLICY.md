# Model Routing Policy

Version: `2026-09-01-draft`

模型 routing 與 workflow 分離，因為模型品質、價格、quota、availability 會快速變動。

## Capability Slots
ROUTER, CHEAP_GENERALIST, DEFAULT_IMPLEMENTER, STRONG_IMPLEMENTER, DEEP_REASONER, LONG_CONTEXT_DISCOVERY, INDEPENDENT_REVIEWER, REGRESSION_HUNTER, ESCALATION_MODEL

## Current Philosophy
- Luna：高 CP 值，不只當雜工；clear contract implementation 預設 Luna-first。
- Gemini/Antigravity：積極承擔 large-context discovery、cross-repo inventory、schema/API comparison、independent review、edge-case hunting、quota balancing。
- Sol：Luna 無法收斂、structural bug、complex migration 時升級。
- Claude Sonnet：architecture / contract ambiguity / auth-RBAC-RLS / deep review。
- Opus：exceptional escalation only。

## Task Classification
complexity, risk, context size, coding intensity, ambiguity, architecture need, review need, expected iterations, quota pressure。

## Escalation
兩次 repair fail、architecture issue、security/RLS ambiguity、ownership conflict、reviewer disagreement、destructive/irreversible risk 才升級。

## New Models
新模型先進 experimental mapping，低風險 benchmark correctness/latency/quota efficiency/review catch rate，再升 capability slot；不修改 stable workflow。
