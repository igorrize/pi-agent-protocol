# pi-agent-protocol — Design

> The *how*. For pi API facts see `RESEARCH.md`; for risks see `CONCERNS.md`.

## Goals

- Agent-to-agent calls gated by **typed contracts**: mandatory input params (validated) + validated output + audit.
- pi-native: reuse pi-subagents (spawn) and pi-intercom (neighbor messaging). No new transport.
- **Soft, configurable** enforcement — observe bypass, then tighten.

## Non-goals

- **No tool-locking** of workers. The Go `agent-protocol` launches physically locked Claude workers (single MCP, tool whitelist, no shell). We deliberately do NOT — workers keep their normal tools. The guarantee here is the *contract boundary* (params in, output out), not a sandbox.
- No deep JSON-Schema (subset only).
- No guaranteed contract on the intercom *response* (see CONCERNS C2).

---

## The two call paths (must be handled separately)

pi has **two** distinct "call another agent" surfaces. They have different control strength, so the plugin branches on them explicitly.

| Path | What it is | block call | mutate input | validate **output** |
| ------ | ----------- | :--: | :--: | --- |
| **subagent** | spawn a child agent (`subagent` tool) | ✅ | ✅ inject `outputSchema` | ✅ by schema (pi-subagents forces + parent re-validates) |
| **intercom `ask`** | message a neighbor session, block for reply | ✅ | ✅ | ⚠️ reply is **free text** in the tool result → soft-parse only |
| **intercom `send`** | fire-and-ack to a neighbor | ✅ | ✅ | ❌ real answer arrives later, async, **in the peer's process** |

**Consequence:** the **subagent path is contract-grade** (in + out). The **intercom path** can only govern *outbound* cleanly; validating a neighbor's *response* requires the plugin to be installed in the **responder's** session too → **install the plugin globally** (`~/.pi/agent/extensions/`) so every session polices its own outbound + its own `reply`.

---

## Contract format

Sidecar JSON next to the agent's markdown: `<agent>.contract.json` beside `<agent>.md` (in any pi agent dir).

```json
{
  "agent_name": "clj-reviewer",
  "input_schema": {
    "required": ["files", "rubric"],
    "properties": {
      "files":  { "type": "array"  },
      "rubric": { "type": "string" },
      "focus":  { "type": "string" }
    }
  },
  "output_schema": {
    "required": ["findings"],
    "properties": {
      "findings": { "type": "array"  },
      "summary":  { "type": "string" }
    }
  }
}
```

- No `allowed_tools` (Go version has it for locking; we don't lock).
- `input_schema` / `output_schema` are both optional. No `input_schema` → no mandatory params (dispatch passes through). No `output_schema` → output not validated.
- Why sidecar, not frontmatter: pi parses agent frontmatter into a **flat string map** and a custom key lands in `extraFields` (preserved but only as a string) — awkward for nested JSON. A sidecar keeps the schema first-class and is what the user chose ("next to the agent").

### Validator subset (port of agent-protocol)

- `required`: every listed key must be present.
- `properties.<field>.type`: type of each **present, top-level** field.
- types: `string`, `number`, `integer` (whole floats like `1.0` ok), `boolean`, `array`, `object`, `null`, and unions `["string","null"]`.
- **Not** checked: nested objects, array `items`, `enum`, `minimum`/`maximum`, `minLength`, `format`. Unknown type → **pass (fail-open)**.
- Keep contracts **flat and shallow** — validate top-level shape only.

---

## Flow — subagent path (the 2-call dispatch gate)

Why 2 calls: a pi extension **tool cannot synchronously spawn a subagent and await it** (RESEARCH §registerTool). So `dispatch` is a **validation gate**, and the model then makes the actual `subagent` call, which the interceptor augments.

```
1. Orchestrator calls:  dispatch({ agent:"clj-reviewer", params:{ files:[...], rubric:"..." } })
      │
      ├─ no contract for agent      → { status:"no_such_agent", available:[...] }   (hard stop)
      ├─ validate(params, input_schema) fails → { status:"rejected", errors:{rubric:"missing required key"} }
      │                                          (orchestrator self-corrects, re-dispatches)
      └─ ok → store pending[agent] = { params, outputSchema: contract.output_schema }
              audit("dispatched")
              return "✓ Validated. Now call subagent({ agent:'clj-reviewer', task:'<your task>' })."
2. Orchestrator calls:  subagent({ agent:"clj-reviewer", task:"Review schema.go" })
      │  tool_call interceptor:
      │   - target agent has contract + pending exists → REWRITE input (single→chain):
      │        input.chain = [{ agent, task: task + "\n\nPARAMS:\n```json\n{...validated params...}\n```",
      │                         outputSchema: pending.outputSchema }]
      │        delete input.agent; delete input.task
      │     consume pending; audit("dispatched→run")
      │   - contract but NO pending:  AP_MODE=block → { block, reason:"call dispatch() first" }
      │                               AP_MODE=warn  → allow + audit("bypass")
      │                               AP_MODE=off   → allow
      │     (still inject outputSchema if a contract exists, so output is validated even on bypass)
      ▼
3. pi-subagents runs the child with outputSchema → child gets a `structured_output` tool that
   forces schema-valid output (throws on mismatch = in-loop retry); parent re-validates output.json.
      │
4. tool_result interceptor on subagent → audit("completed"/"failed").
```

### single → one-step chain (the key trick)

> **SUPERSEDED (pi-subagents 0.54, confirmed live 2026-07-16):** top-level `chain`/`parallel`/`tasks` were **removed** (`use workflowScript`), so the single→chain rewrite below no longer works — a `{chain:[…]}` call errors. In 0.54 the public tool accepts `outputSchema` **directly on a top-level `{agent, task}` call** and forwards it to the child, so the interceptor now just sets `input.outputSchema` and appends the params block to `input.task` (see `subagent-rewrite.ts` → `rewriteSingle`). The text below is kept for historical context.

`outputSchema` is honored **only on chain/parallel items**, never on a top-level SINGLE `{agent,task}` call (RESEARCH §subagent). And there is **no re-validation after a `tool_call` mutation**, so rewriting the shape at runtime is safe.

Before (model's call):

```json
{ "agent": "clj-reviewer", "task": "Review schema.go" }
```

After (interceptor mutates `event.input` in place):

```json
{ "chain": [ {
    "agent": "clj-reviewer",
    "task": "Review schema.go\n\nPARAMS:\n```json\n{\"files\":[...],\"rubric\":\"...\"}\n```",
    "outputSchema": { "required": ["findings"], "properties": { "findings": {"type":"array"}, "summary":{"type":"string"} } }
} ] }
```

For PARALLEL (`tasks[]`) / explicit CHAIN (`chain[]`) calls: set `outputSchema` on each item whose `agent` has a contract (those item types already accept `outputSchema`), and append params to each item's `task`.

---

## Flow — intercom path (experimental, outbound-governed)

Plugin installed globally → present in both sessions.

```
Sender session:
  tool_call on intercom {action:"send"|"ask", to:"peerName", message, attachments}
    - if `to` resolves to a contracted peer → validate the params payload
      (carried as a `context` attachment named "params", JSON) vs peer.input_schema
      → block/warn per AP_MODE.  audit("intercom-dispatched"/"rejected").
  tool_result on intercom {action:"ask"} (sync reply, free text)
    - soft-parse the "**Reply from X:**\n<text>" body vs peer.output_schema → annotate; never hard-fail.

Responder session (same plugin instance):
  tool_call on intercom {action:"reply", message}
    - validate the responder's own output vs THIS agent's output_schema → block/warn. audit.
```

Limits: `send` has no response at the call site (answer is async in the peer's process); `ask` reply is free text (no machine envelope). So intercom output validation is best-effort. See CONCERNS C2.

---

## Enforcement modes (`AP_MODE`)

- `warn` (default) — validate + **audit**, surface a warning, but **never block**. Lets you watch bypass ("ready to see how an agent gets around the contract").
- `block` — reject non-conforming calls (`{block, reason}`); caller self-corrects (agent-protocol-style).
- `off` — audit only; no validation surfaced, no block.

Toggle live by relaunch with the env set. Implementation reads `process.env.AP_MODE` (subagent-aware not required — applies to all sessions).

---

## Audit

- In-memory ring (last N events) + optional append to `~/.pi/agent/agent-protocol/audit.jsonl`.
- Event: `{ ts, kind: "dispatched"|"rejected"|"no_such_agent"|"bypass"|"completed"|"failed"|"intercom-*", agent, path:"subagent"|"intercom", mode, detail }`.
- Exposed via the `ap_audit` tool (recent N) and `ap_agents` (registered contracts).

---

## Registered tools

- `dispatch({ agent, params })` — the gate (subagent path).
- `ap_audit({ n? })` — recent audit events.
- `ap_agents({})` — registered contracts (name + required input/output keys).

## File layout

```
src/
  index.ts            # wiring: session_start load, registerTool, tool_call, tool_result
  types.ts            # Contract, PendingDispatch, AuditEvent, Mode
  validator.ts        # JSON-Schema subset validator (pure)
  contracts.ts        # discover + load <agent>.contract.json sidecars (pure-ish)
  dispatch-core.ts    # prepareDispatch (pure)
  subagent-rewrite.ts # enumerate targets + single→chain + params/outputSchema injection (pure)
  audit.ts            # event log
  intercom-gate.ts    # Phase 3, experimental
```

## Why global install

Two reasons: (1) every session can enforce subagent contracts; (2) intercom response validation needs the plugin in the **responder's** session. So install at `~/.pi/agent/extensions/` (after release: a `packages` entry).
