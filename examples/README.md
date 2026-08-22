# examples — draft contracts

Draft contracts for the **PI one-shot TDD flow**. They are sketches to think with — agent names and fields will be refined when the agents and the extension are built.

## The flow they encode
```
read task
  → [scaffold] (before tests)
  → test:    write *_test.go (clear names), RUN → RED gate
  → working: implement (non-_test), RUN tests → GREEN gate   (3 failing rounds → ask the user)
  → reviewer: business-logic review + architecture micro-rules
  → human: review + push
```

## Handoff (named-outputs between chain steps)
```
test ──test_names──▶ working ──files_changed──▶ reviewer
```
- `test.output.test_names`  → `working.input.test_names`  (the tests are the spec the impl must turn green)
- `working.output.files_changed` → `reviewer.input.files_changed`

## Two extensions beyond the base agent-protocol format
1. **`policy`** (see `working.contract.json`) — behavioral rules the schema can't express. Here: `{ "max_test_attempts": 3, "on_exhausted": "ask_user" }` = the "3 failing rounds → ask me" rule. The base agent-protocol format had only `input_schema`/`output_schema`; `policy` is a pi-agent-protocol addition (loader keeps unknown top-level keys).
2. **Contract = validation + memory.** Beyond validating a handoff, the structured outputs (`test_names`, `business_findings`/`arch_findings`, `verdict`) are persisted (audit + named-outputs) as a durable trail later steps and sessions can read.

## Notes
- Schema is the small subset (see `../DESIGN.md`): `required` + top-level `properties.type`. Flat & shallow.
- `agent_name: "working"` is a placeholder — in practice this maps to `feature` / `bug`.
- No `allowed_tools` — this plugin does not lock tools.
- These are **drafts**, not wired to anything yet (the extension is unbuilt — see `../PLAN.md`).

## Still to sketch (TODO)
- `scaffold.contract.json` — runs **before** tests; output `{ created_files }`.
- `orchestrator.contract.json` — reads the task, drives the chain; the entry point of the one-shot.
