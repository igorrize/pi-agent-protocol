# pi-agent-protocol — Project Plan

A pi extension bringing **typed agent-to-agent contracts** (mandatory input params + validated output + audit) to pi-subagents and pi-intercom. Soft, configurable enforcement. No tool-locking.

> See `DESIGN.md` for the *how*, `RESEARCH.md` for the *pi API facts*, `CONCERNS.md` for the risks.

---

## Current status — 2026-08-22 (M0–M3 done; Phase 4 release-ready)

**Done & verified:**

- Scaffold + shared types (`package.json`, `tsconfig.json`, `.gitignore`, `src/types.ts`).
- Pure modules + unit tests: `validator`, `contracts`, `dispatch-core`, `subagent-rewrite`, `audit`. **`npm run typecheck` + `npm test` green.**
- Wiring `src/index.ts`: `dispatch` gate + `ap_audit` / `ap_agents`, `session_start` contract load, `subagent` `tool_call` / `tool_result` interceptors, `AP_MODE` / `AP_DISABLE` / `AP_AUDIT_FILE`.
- Extension **wired into `~/.pi/agent/settings.json`** and loaded; the three tools are live.
- **E2E smoke green on pi-subagents 0.54** (`.agents/clj-reviewer.*`): `ap_agents` lists the contract → dispatch rejects missing params → `no_such_agent` → valid dispatch → the subagent run is **forced to schema-valid `{findings}`** → `ap_audit` shows `dispatched(gate) → dispatched(run) → completed`.

**⚠ Version-drift fix (CONCERNS C9), found + fixed live:** RESEARCH was pi-subagents 0.31; installed is **0.54**, which **removed top-level `chain`/`parallel`/`tasks`** (`use workflowScript`), so the DESIGN "single→chain" trick no longer works. Fix: 0.54 accepts **`outputSchema` directly on a top-level `{agent, task}` call**, so `rewriteSingle` now sets `input.outputSchema` + appends the PARAMS block to `input.task` (no chain). The interceptor gates only structured SINGLE calls; `workflowScript` orchestration is left alone (Phase 2). See DESIGN/RESEARCH version notes.

**Left — remaining writing:**

- ~~Handler tests (Phase 1.3)~~ **done** — `test/handlers.test.ts` (12 cases via a fake pi/ctx). **All Phase 1 tests green — Phase 1 complete & verified.**
- Optional smoke: `AP_MODE=block` bypass, `AP_MODE=off`, `AP_DISABLE=1` (core already proven).
- Phase 2 hardening **essentially complete**: ~~`tool_result` + async-completion self-revalidation~~ **done**; ~~`workflowScript`-aware auditing~~ **done** (observe-only — detect contracted agents in inline JS + audit `via:workflowScript`; `block` requires a prior dispatch; no JS mutation); multi-pending last-wins + 10min TTL done. Remaining: a minor multi-pending audit nuance, otherwise Phase 3/4.
- ~~Phase 3: implement `src/intercom-gate.ts`~~ **done (experimental)** — outbound `send`/`ask` gating + `ask`-reply soft-parse; **validated live** via a `code-reviewer` peer session (positive + negative rounds); responder-side `reply` deferred.
- **Phase 4 release-ready:** `LICENSE` (MIT), package metadata + optional peer deps (`typebox`, pi API), README install section, `CHANGELOG`. Dogfood agents added (`code-reviewer`, `test-writer`). **Your steps:** push to `github.com/igorrize/pi-agent-protocol` → `pi install git:…` → `git tag v0.1.0`.

---

## Goal

Make agent-to-agent calls in pi **systemic, not prompt-based**: a caller must satisfy a contract (required params, typed) before a target agent runs, and the target's output is validated against a contract — with every dispatch/reject/complete **audited**. Mirror the value of the Go `agent-protocol` proxy, but pi-native and non-locking.

## Non-goals (v1)

- **No physical tool-locking** of workers (the Go version's "locked Claude" — we explicitly skip; workers keep their normal tools).
- No new transport/broker (reuse pi-subagents spawn + pi-intercom broker).
- No deep JSON-Schema (only the small subset agent-protocol uses — `required` + top-level `properties.type` + unions). See DESIGN.
- No guaranteed enforcement on the intercom *response* path (structurally async/free-text — see CONCERNS C2).

---

## Phases

### Phase 0 — Scaffold  *(no business logic)*

**Deliverables**

- [x] `package.json` — `pi.extensions: ["./src/index.ts"]`, `type: module`, scripts (`test`, `typecheck`), dev deps (`tsx`, `typescript`, `typebox`), peer/types `@earendil-works/pi-coding-agent`.
- [x] `tsconfig.json` — NodeNext, strict, no emit (jiti/tsx runs TS directly).
- [x] `.gitignore` — `node_modules`, `dist`, `*.log`.
- [x] `README.md` — user-facing (install, contract format, usage, AP_MODE, audit).
- [x] `src/` **implemented, not stubs**: `index.ts`, `types.ts`, `validator.ts`, `contracts.ts`, `dispatch-core.ts`, `subagent-rewrite.ts`, `audit.ts`, `intercom-gate.ts`.
- [x] `examples/clj-reviewer.md` + `examples/clj-reviewer.contract.json` (sample agent + sidecar contract).
- [x] `test/` skeleton + `test/README.md` (test plan).
- [x] Local dev wired: `./src/index.ts` added to `~/.pi/agent/settings.json` `extensions`, reloaded, `dispatch`/`ap_audit`/`ap_agents` confirmed live.

**Definition of done:** `pi` loads the extension with no errors; `dispatch`/`ap_audit`/`ap_agents` tools are listed (even if they no-op); `npm test` runs (0 tests OK); `npm run typecheck` passes.

---

### Phase 1 — MVP: the **subagent** path (contract-grade)

This is the strong path: input validated by us, output validated by pi-subagents' `outputSchema`.

**1.1 Pure core (unit-tested, no live pi)**

- [x] `validator.ts` — `validate(schema, data) -> {ok:true} | {ok:false, errors:Record<string,string>}`. Subset: `required` present; for each *present* top-level field, check `properties[f].type` (string|number|integer(whole-float ok)|boolean|array|object|null + `["string","null"]` unions); unknown type = pass (fail-open); ignore nested/items/enum/min/max. Port from agent-protocol's validator semantics (see RESEARCH §validator).
- [x] `contracts.ts` — discover `<agent>.contract.json` sidecars next to `<agent>.md` across agent dirs (`~/.pi/agent/agents`, `~/.agents`, `<cwd…gitroot>/.pi/agents`, `.agents`); parse → `Map<agentName, Contract>`. Contract = `{agent_name, input_schema?, output_schema?}`.
- [x] `dispatch-core.ts` — `prepareDispatch(registry, agent, params) -> {status:"no_such_agent", available} | {status:"rejected", errors} | {status:"ok", pending:{agent, params, outputSchema}}`.
- [x] `subagent-rewrite.ts` — mutate a `subagent` tool-call `input` for a `pending`: set **top-level `outputSchema`** + append validated params to `task` (pi-subagents 0.54 — **not** the old single→chain; see version note in DESIGN/RESEARCH). `enumerateTargets`/`applyToItems` retained as helpers.
- [x] `audit.ts` — in-memory ring buffer + optional append to `~/.pi/agent/agent-protocol/audit.jsonl`; `record(event)`, `recent(n)`.

**1.2 Extension wiring `index.ts`**

- [x] `session_start` (+ `resources_discover`) → load contracts into registry.
- [x] `registerTool("dispatch", {agent, params})` → `prepareDispatch`; on `ok` store `pending[agent]` + return "validated, now call subagent(...)"; on `rejected`/`no_such_agent` return errors. Audit.
- [x] `tool_call` on `subagent` → structured SINGLE `{agent,task}` only (0.54): if a matching `pending` exists, set top-level `outputSchema` + append params; if none and `AP_MODE=block` → `{block, reason:"dispatch first"}`; `warn` → allow + inject `outputSchema` + audit `bypass`; `off` → no interception. `workflowScript`/management/legacy-multi are skipped.
- [x] `tool_result` on `subagent` → audit `completed`/`failed` (output already validated by pi-subagents). Optional self-revalidate.
- [x] `AP_MODE` env (`warn`|`block`|`off`, default `warn`); `AP_AUDIT_FILE` toggle.

**1.3 Tests**

- [x] Unit: validator (happy, missing-required, type-mismatch, unions, fail-open).
- [x] Unit: contracts (fixtures: valid sidecar, missing schema, malformed JSON).
- [x] Unit: dispatch-core (ok / rejected / no_such_agent).
- [x] Unit: subagent-rewrite (top-level `outputSchema` set + params appended; `enumerateTargets`/`applyToItems` helpers).
- [x] Handler tests with **synthetic events** + fake `pi`/`ctx` (`test/handlers.test.ts`, 12 cases): tools registered, `AP_DISABLE` no-op, `AP_MODE=off` no interceptors, contract load, dispatch reject/unknown, dispatch→subagent mutation (top-level `outputSchema` + params, no chain), bypass warn vs block, no-contract passthrough, skip management/workflowScript/legacy, `tool_result` completed/failed.

**Definition of done:** on a real test agent + contract, `dispatch` rejects missing params, accepts valid, the subsequent `subagent` run is forced to emit schema-valid output, bypass behaves per `AP_MODE`, and `ap_audit` shows the events.

---

### Phase 2 — Hardening + docs

- [x] Edge cases: multi-pending last-wins + 10min TTL (done); management `action`s skipped (done); parallel/chain mixed — **moot on 0.54** (top-level multi removed; use `workflowScript`). A multi-pending *audit* nuance remains minor/deferred.
- [x] `tool_result` **+ async-completion** self-revalidation of the child's `structuredOutput` vs `output_schema`. Sync/finished results via `event.details.results[]`; async completions via a `pi.events.on("subagent:async-complete")` subscription (0.54 runs single children async by default, so completion arrives out-of-band, not as a `tool_result`). Honest `async-started` labeling + safe fallback; audit `detail.via` marks the source. Covered by 8 handler tests.
- [x] README updated for 0.54 (accurate mechanism/status/config) + `CHANGELOG.md` started (0.1.0). `examples/` cover `clj-reviewer` (+ runnable `.agents/` fixture); further expansion optional.
- [x] Smoke script `test/smoke.md` (manual e2e steps).

---

### Phase 3 — the **intercom** path (experimental)

Weaker by nature (response is async/free-text — see CONCERNS C2). Requires the plugin installed **globally** so each session polices its own outbound + replies.

- [x] `intercom-gate.ts`: `tool_call` on `intercom` `send`/`ask` → if `to` resolves to a contracted peer, validate the outbound payload vs the peer's `input_schema` (payload carried as a `context` attachment named `params`, JSON). Block/warn per `AP_MODE`.
- [ ] **Deferred** — `tool_call` on `intercom` `reply` (responder-side output validation): a session has no well-defined mapping to "its own" contract. Documented as a limitation.
- [x] `tool_result` on `intercom` `ask` → soft-parse the free-text reply vs peer `output_schema`; annotate, never hard-fail.
- [x] Tests (15 unit + 7 handler, synthetic intercom events); marked **experimental** in README.

---

### Phase 4 — Release

- [x] LICENSE (MIT), package metadata (`repository`/`homepage`/`keywords`/`engines`/`files`), `typebox` + pi API as optional **peerDependencies**, semver `0.1.0`.
- [x] Installable like other pi plugins (`pi.extensions` + peer deps; ships TS source, loaded via jiti). **Your step:** push, then `pi install git:github.com/igorrize/pi-agent-protocol` (npm publish optional later).
- [ ] **Your step:** after install, replace the local-dev `extensions` path in `settings.json` with the installed `packages` entry.
- [x] `CHANGELOG.md` + README install section done. **Your step:** `git tag v0.1.0` after push.

---

## Milestones

1. **M0** ✅ Scaffold loads in pi (Phase 0).
2. **M1** ✅ subagent contract works end-to-end on a real agent (Phase 1) — validated live on pi-subagents 0.54.
3. **M2** ✅ Tested + documented (Phase 2 core) — unit + handler tests, live smoke, README + CHANGELOG.
4. **M3** intercom experimental path (Phase 3).
5. **M4** Released + installed globally (Phase 4).

## Decisions locked

- Repo: `~/pi-agent-protocol` (sibling, TS package, releasable).
- Params convention: dedicated **`dispatch({agent, params})`** gate tool (2-call flow: dispatch validates → model calls subagent → interceptor injects outputSchema + params). See CONCERNS C1.
- Enforcement: configurable **`AP_MODE`** = `warn`(default) | `block` | `off`; audit always.
- Contract: sidecar **`<agent>.contract.json`** next to the agent `.md`.
- Test runner: `node:test` + `tsx`.

## Open decisions (pick before the relevant phase)

- Release channel detail (npm vs git-only) — Phase 4.
- Multi-pending policy — Phase 2. (Pending TTL implemented: 10min, last-wins.)
- Intercom payload convention (attachment vs message-embedded JSON) — Phase 3.
