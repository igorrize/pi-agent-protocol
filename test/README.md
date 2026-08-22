# test/ — test plan

`node:test` + `tsx` (see `package.json` → `npm test`). Pure modules first; handler
wiring tested with synthetic events later. No live pi required for unit tests.

## Unit (pure modules)
- **validator.test.ts** — happy path, missing-required, type-mismatch, `["string","null"]` unions, integer whole-float, fail-open on unknown type, non-object data, undefined schema.
- **contracts.test.ts** — valid sidecar loads; malformed JSON skipped (sibling still loads); `agent_name` filename fallback; `policy` preserved; no-schema contract still loads.
- **dispatch-core.test.ts** — `no_such_agent` (sorted `available`), `rejected` (field errors), `ok` (pending carries params + `output_schema` + `ts`).
- **subagent-rewrite.test.ts** — exact single→chain shape (params appended, `outputSchema` set, `agent`/`task` deleted); `enumerateTargets` for SINGLE/PARALLEL/CHAIN + management no-op; `appendParams` format; `applyToItems` on parallel/chain.
- **audit.test.ts** — ring eviction, `ts` fill/preserve, `recent(n)`, file append round-trips, bad path never throws.

## Handler (synthetic events + fake pi/ctx) — Phase 1.3
- valid dispatch → subagent (assert input mutation)
- invalid params → reject
- bypass in `warn` vs `block`
- no-contract passthrough

## Manual smoke (Phase 2) — `smoke.md`
End-to-end on a real agent + contract (`examples/clj-reviewer`).

> `_reports/` holds per-module build notes from the scaffolding workers (not tests).
