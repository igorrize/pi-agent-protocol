# pi-agent-protocol — Main Concerns

> The risks/open questions to keep in mind. Each: **what**, **impact**, **mitigation**, **status**. The big ones are C1–C4.

## C1 — The 2-call dispatch flow relies on model follow-through  ⭐
**What:** `dispatch` only *validates* (a pi extension tool cannot spawn+await a subagent, RESEARCH §registerTool). The model must then *also* call `subagent`. A model could call `subagent` **without** dispatching first.
**Impact:** the input contract can be skipped if the model bypasses `dispatch`.
**Mitigation:**
- `tool_call` on `subagent` checks for a matching `pending`. In `AP_MODE=block`, a contracted agent with no pending → blocked with "call dispatch() first" (forces the gate). In `warn` → allowed but audited as `bypass` (this is the *observability* the user wants).
- Output is still validated even on bypass (we inject `outputSchema` whenever a contract exists).
**Status:** accepted by design (user chose the dispatch-gate). Bypass is a *feature to observe* in `warn`, hard-stopped in `block`.

## C2 — Intercom responses are not cleanly contractable  ⭐
**What:** `ask` returns **free text** (no schema); `send`'s real answer is **async, in the peer's process**. RESEARCH §intercom.
**Impact:** you cannot schema-validate a neighbor's *response* from the caller side.
**Mitigation:** govern **outbound** cleanly (validate the payload before send); validate the **responder's** own `reply` by installing the plugin **globally** (every session polices its own replies); soft-parse `ask` replies (annotate, never hard-fail).
**Status:** intercom path is **experimental (Phase 3)**, explicitly weaker than subagent. The subagent path is the contract-grade one.

## C3 — Global install = the plugin runs in EVERY pi session  ⭐
**What:** required for intercom both-ends and ubiquitous subagent enforcement.
**Impact:** every session pays the load + `tool_call`/`tool_result` hook cost; a bug could affect *all* sessions (including subagents and unrelated projects).
**Mitigation:** keep hooks cheap and **fail-open** (a thrown handler blocks the tool — careful: that's fail-*safe* for `tool_call`; wrap our logic so our own errors never accidentally block legit calls → catch internally, log, pass through unless we explicitly decide to block). Make `AP_MODE=off` a true no-op fast-path. Gate all work behind "is there a contract for this agent?" early-return.
**Status:** open — needs careful error handling + an env kill-switch (`AP_MODE=off` or `AP_DISABLE=1`).

## C4 — `task` is free text; "mandatory params" is a convention  ⭐
**What:** subagent calls carry a free-text `task`, no structured `params` field. We inject validated params as a fenced ```json block appended to `task`.
**Impact:** the *child* must read params from prose; format drift possible; the child could ignore them.
**Mitigation:** `dispatch` validates the structured params up front (the contract IS enforced at the gate); the appended block is a deterministic, parseable convention; the child's contract/agent prompt should say "read PARAMS json". Output schema still constrains the result.
**Status:** accepted (consequence of C1's design). Revisit if prose-params prove unreliable.

---

## C5 — "No re-validation after mutation" is double-edged
**What:** pi does not re-validate `event.input` after our `tool_call` mutation — which lets us rewrite single→chain, but also means a malformed mutation reaches the executor unchecked.
**Mitigation:** unit-test `subagent-rewrite` hard (exact before/after shapes); keep mutations minimal and well-formed; never partially-rewrite.
**Status:** managed by tests.

## C6 — Parallel / chain / management calls
**What:** `subagent` also does PARALLEL (`tasks[]`), explicit CHAIN (`chain[]`), and management `action`s (`list/status/...`).
**Mitigation:** skip management actions entirely; for parallel/chain, enumerate per-item target agents and inject per item (those item types already accept `outputSchema`); only top-level SINGLE needs the single→chain rewrite.
**Status:** Phase 1 handles SINGLE; Phase 2 hardens parallel/chain + multi-pending.

## C7 — Multiple pending dispatches / staleness
**What:** several `dispatch` calls before the matching `subagent`, or a dispatch that's never consumed.
**Mitigation:** key `pending` by agent; last-wins + audit; add a TTL (drop stale pending). Define policy in Phase 2.
**Status:** open (Phase 2).

## C8 — Contract discovery across cwds
**What:** the plugin runs from many cwds; agents live in global + project dirs. Must find `<agent>.contract.json` reliably.
**Mitigation:** scan `~/.pi/agent/agents`, `~/.agents`, and walk up from cwd to a git root for `.pi/agents`/`.agents`; reload on `session_start`. Log loaded contracts.
**Status:** open — confirm discovery matches pi-subagents' own agent discovery.

## C9 — Package-specifier / version drift
**What:** the host API is imported under 3 specifiers across installs; pi-subagents/intercom internals could change between versions (researched at subagents@0.31, intercom@0.6, typebox bare import).
**Mitigation:** pin assumptions in RESEARCH.md with source paths; smoke-test on the installed versions; if `outputSchema`/chain shape changes, the rewrite is the single point to update.
**Status:** open — re-verify on upgrade.

## C10 — Testability of handlers without a live pi
**What:** real e2e needs a running pi; most CI must be offline.
**Mitigation:** keep logic in **pure** modules (validator/contracts/dispatch-core/rewrite) → full unit coverage; test handlers with **synthetic** `ToolCallEvent`/`ToolResultEvent` + a fake `pi`/`ctx`; manual smoke for true e2e.
**Status:** designed for (see PLAN Phase 1.3).

## C11 — Soft enforcement philosophy
**What:** deliberately not locking tools → a worker can do anything; the contract only governs the I/O boundary.
**Mitigation:** that's the point (observe bypass). `block` mode tightens the boundary; if hard isolation is ever needed, that's the Go `agent-protocol` harness, not this plugin.
**Status:** intentional.

## C12 — outputSchema changes child behavior
**What:** injecting `outputSchema` forces the child to end with a `structured_output` call; a child/agent not written for that could fail the step (exitCode=1) if it never calls it.
**Mitigation:** the forcing prompt is auto-added by pi-subagents; document in README that contracted agents will be required to emit structured output; keep output_schema optional (omit → no forcing).
**Status:** document + test.

---

## Quick "watch-outs" checklist
- [ ] Our `tool_call`/`tool_result` handlers **catch their own errors** (don't accidentally block legit tools).
- [ ] `AP_MODE=off` / `AP_DISABLE=1` = true fast no-op.
- [ ] Early-return when no contract for the agent.
- [ ] `subagent-rewrite` produces a **valid** chain item (tested).
- [ ] Don't touch management `action`s.
- [ ] Reload contracts on `session_start`.
- [ ] Global install safety (runs everywhere).
