# Changelog

All notable changes to **pi-agent-protocol** are documented here. The format
loosely follows [Keep a Changelog](https://keepachangelog.com/); this project is
pre-1.0 and the API may change.

## [Unreleased] — 0.1.0 (in progress)

### Added — subagent contract path (Phase 1, complete)

- **`dispatch({ agent, params })`** gate tool — validates params against a
  contract's `input_schema` before a contracted agent runs; rejects
  missing/mistyped params with field-level messages so the caller self-corrects.
- **`subagent` `tool_call` interceptor** — for a contracted single-child
  `{ agent, task }` call with a matching dispatch, appends the validated params
  to the task (fenced `PARAMS` JSON) and sets the contract's `output_schema` on
  the call, so pi-subagents forces schema-valid child output.
- **`subagent` `tool_result` interceptor** — audits `completed` / `failed` /
  `async-started` and re-validates the child's `structuredOutput` against
  `output_schema` (belt-and-suspenders) via `event.details.results[]`.
- **`ap_audit({ n? })`** and **`ap_agents({})`** tools; in-memory audit ring
  buffer with optional JSONL append (`AP_AUDIT_FILE`).
- Enforcement modes **`AP_MODE=warn|block|off`** and hard kill-switch
  **`AP_DISABLE=1`**.
- Contract discovery — `<agent>.contract.json` sidecars across the standard pi
  agent directories; pending dispatches expire after a 10-minute TTL.
- JSON-Schema subset validator — `required` + top-level `properties.type`
  (+ `["string","null"]` unions); fail-open on unknown types.

### Compatibility

- Targets **pi-subagents 0.54**. That version removed top-level
  `chain`/`parallel`/`tasks` (multi-agent orchestration moved to
  `workflowScript`) and now accepts `outputSchema` as a **top-level field** of
  the `subagent` tool. The original "single → one-step chain" rewrite (designed
  against 0.31) is obsolete. See the version notes in `RESEARCH.md` / `DESIGN.md`.

### Tests

- Unit tests: validator, contracts, dispatch-core, subagent-rewrite, audit.
- Handler tests: synthetic `tool_call` / `tool_result` events + a fake `pi`/`ctx`,
  including output self-revalidation and `AP_MODE` / `AP_DISABLE` behavior.
- Manual e2e smoke (`test/smoke.md`), verified live on pi-subagents 0.54.

### Not yet

- Intercom path (Phase 3, experimental) — `src/intercom-gate.ts` is a stub.
- `workflowScript`-aware gating and async-completion re-validation (Phase 2 follow-ups).
- Release / packaging: git + npm install channels, version tag (Phase 4).
