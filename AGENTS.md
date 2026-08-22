# AGENTS.md — pi-agent-protocol

> Read this first if you are an AI agent (pi / Claude Code) opening this repo in a fresh session.

## What this project is
A **pi coding-agent extension** that ports the *logic* of [`agent-protocol`](../agent-protocol) (a typed-contract MCP proxy, Go) into a **pi-native plugin**:
agents call other agents **through contracts** — mandatory input parameters validated against a JSON-Schema, and outputs validated against a JSON-Schema — with an **audit** trail.

It does **NOT** lock down worker tools (the Go version physically locks Claude workers; we deliberately do not). Enforcement here is **soft and configurable** — we want to *observe* when/how an agent bypasses a contract, then tighten.

## Read these, in order
1. **`PLAN.md`** — the phased plan (Phase 0 scaffold → Phase 1 MVP → tests → intercom → release) with task checklists.
2. **`DESIGN.md`** — architecture: the two call paths (subagent vs intercom), the `dispatch` gate flow, contract format, enforcement modes.
3. **`RESEARCH.md`** — the pi extension/subagent/intercom API facts (already researched — **do not re-research**; verify against the cited source paths if unsure).
4. **`CONCERNS.md`** — the main risks / open questions / decisions. Read before building.

## Hard conventions (do not violate)
- **Source only.** The human builds, runs, tests, commits, and releases. You write code and docs.
- **Do NOT lock worker tools** — soft enforcement only (see DESIGN "Non-goals").
- **No Russian in code/comments.** Code and comments in English, minimal.
- **Imports (exact):** `import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";` and `import { Type } from "typebox";` (see RESEARCH — these are the specifiers the installed extensions actually use).
- **Tests:** `node:test` + `tsx` (stdlib, zero-dep). Domain/pure logic first.
- **Don't `git commit`/`git push`** unless explicitly told.

## Status
Planning + scaffold. No production logic written yet. Phase 1 (MVP, subagent path) is the next build step, to be done module-by-module with human review.

## Repo location
`/Users/igorlobazov/pi-agent-protocol` — sibling of `medi_drive`, `medidrive-vault`, and `agent-protocol`.
