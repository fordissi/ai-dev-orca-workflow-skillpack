# Agent Instructions

Read: SKILL → WORKFLOW_POLICY → CONCURRENCY_POLICY → MODEL_ROUTING_POLICY → MODEL_REGISTRY → RESOURCE_AWARE_ROUTING → OFFICIAL_COMMANDS → Current Project Handoff.

This repo is reusable workflow policy, not application code.
Do not store project secrets or personal/customer data.
Model mapping changes belong in MODEL_REGISTRY.yaml; stable workflow only changes when the workflow itself changes.
Command changes must be reverified against official upstream docs and local `--help`.
Markdown policy is normative; scripts/ is only a conformance checker.
