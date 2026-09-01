# Agent Instructions

Read: SKILL → WORKFLOW_POLICY → CONCURRENCY_POLICY → MODEL_ROUTING_POLICY → RESOURCE_AWARE_ROUTING → OFFICIAL_COMMANDS.

This repo is reusable workflow policy, not application code.
Do not store project secrets or personal/customer data.
Model mapping changes belong in MODEL_REGISTRY.yaml; stable workflow only changes when the workflow itself changes.
Command changes must be reverified against official upstream docs and local `--help`.
