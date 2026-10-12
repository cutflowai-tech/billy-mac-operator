# ADR-0003: One audited runtime dependency — the official Anthropic SDK

Status: Accepted (2026-10-11) · REQ-16, REQ-33 · Amends ADR-0001 ("zero npm deps")

## Context
The provider adapter must call the Anthropic Messages API correctly: typed errors, structured outputs, model discovery, and refusal fallbacks. Anthropic's guidance for TypeScript projects is to use the official SDK rather than hand-written HTTP.

## Decision
The core takes exactly one runtime dependency:
- **Package:** `@anthropic-ai/sdk` 0.128.0, pinned exactly. It was published more than two weeks before adoption.
- **Install:** `--ignore-scripts`, with 6 transitive packages and no install scripts.
- **Contract:** the SDK is used as **transport only** (`core/src/ai/anthropic.ts`) with `maxRetries: 0`. Budget, egress and retry policy remain the single responsibility of `ModelGateway`.
- **Dev-only:** TypeScript 7.0.2 and `@types/node` are typecheck tools and are never shipped (asserted by T-REL-06).

## Consequences
- Supply-chain surface is limited to the SDK tree recorded in `upstream.lock.json`, `core/package-lock.json` and `sbom.json`.
- Updates follow `docs/developer-runbook.md` (pin, inspect for new install scripts and dependencies, requalify).
