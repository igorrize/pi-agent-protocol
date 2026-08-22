# Smoke test — subagent contract path (manual; needs a live pi)

Run pi from the repo root so `<repo>/.agents/clj-reviewer.*` is discovered by both the
contract loader and pi-subagents. The extension must be wired in
`~/.pi/agent/settings.json` (`extensions` → `src/index.ts`) and reloaded.

> The runnable fixture lives in `.agents/clj-reviewer.*`. The copy under `examples/`
> is documentation only (not a discovery dir).

## 0 — Load

- `/reload`
- stderr should show: `[agent-protocol] loaded N contract(s) [mode=warn]` (N ≥ 1).
- `ap_agents({})` → lists `- clj-reviewer: in[files, rubric] out[findings]`.

## 1 — Reject (missing required param)

- `dispatch({ agent: "clj-reviewer", params: { files: ["src/validator.ts"] } })`
- Expect: `REJECTED … rubric: missing required key`.

## 2 — Unknown agent

- `dispatch({ agent: "nope", params: {} })`
- Expect: `No contract registered for "nope". Contracted agents: clj-reviewer.`

## 3 — Accept + forced structured output

- `dispatch({ agent: "clj-reviewer", params: { files: ["src/validator.ts"], rubric: "clarity + edge cases" } })`
  → `✓ Validated params for "clj-reviewer". Now call subagent(...)`.
- `subagent({ agent: "clj-reviewer", task: "Review the file(s) in PARAMS." })`
  - The `tool_call` interceptor rewrites SINGLE → one-step chain, appends the
    `PARAMS` json, and injects `outputSchema`.
  - The child is forced to finish with structured output matching `{ findings: [...] }`.

## 4 — Audit

- `ap_audit({ n: 10 })`
- Expect a trail: `dispatched` (stage gate) → `dispatched` (stage run) → `completed`.

## 5 — Bypass behaviour (AP_MODE)

- **warn** (default): call `subagent({ agent: "clj-reviewer", task: "…" })` WITHOUT a
  prior `dispatch` → allowed, audited as `bypass`; `outputSchema` still injected.
- **block**: relaunch pi with `AP_MODE=block` → the same bypass is blocked with
  `call dispatch({ agent: "clj-reviewer", params }) first`.
- **off**: `AP_MODE=off` → no interception (audit-only); the three tools still register.
- **kill-switch**: `AP_DISABLE=1` → extension is a full no-op (tools not registered).
