# pi-agent-protocol

> **Typed agent-to-agent contracts for the [pi](https://pi.dev) coding agent.** Mandatory, validated input params + validated output + an audit trail — over `pi-subagents` and `pi-intercom`. Soft, configurable enforcement. No tool-locking.

A pi-native re-imagining of [`agent-protocol`](https://github.com/igorrize/agent-protocol) (a Go MCP proxy that physically locks workers). This plugin keeps the *contract* idea — agents only reach each other through a validated boundary — but stays **non-locking** and **observable**: you can watch how/when an agent bypasses a contract, then tighten.

> **Status: Phase 1 complete.** The subagent contract path works end-to-end and is validated live on **pi-subagents 0.54** (unit + handler tests green; see `test/smoke.md`). The intercom path is **experimental** (Phase 3): outbound `send`/`ask` gating + `ask`-reply soft-parse are implemented; responder-side `reply` validation is deferred. Not released. See `PLAN.md`, `DESIGN.md`, `RESEARCH.md`, `CONCERNS.md`.

## How it works (subagent path, the strong one)

1. A contract lives next to an agent: `examples/clj-reviewer.contract.json` beside `clj-reviewer.md`.
2. The orchestrator calls **`dispatch({ agent, params })`** → params are validated against the contract's `input_schema`. Missing/wrong → rejected (the model self-corrects).
3. On success the orchestrator calls `subagent({ agent, task })`; the plugin appends the validated params to the task and sets the contract's `output_schema` **on the call** so pi-subagents **forces** the child to emit schema-valid output. (On pi-subagents 0.54 `outputSchema` is a top-level field of the `subagent` tool; the older "one-step chain" rewrite is obsolete — see the RESEARCH/DESIGN version notes.)
4. Every `dispatched` / `rejected` / `bypass` / `completed` / `failed` event is audited (`ap_audit`); on completion the child's structured output is re-validated against `output_schema`.

See `DESIGN.md` for the full flow, the intercom path, and the enforcement matrix.

## Intercom path (experimental)

Weaker by nature (a neighbor's reply is async / free text — see `CONCERNS.md` C2) and it needs the plugin installed **globally** so both sessions run it.

- **Outbound** (`intercom` `send` / `ask`): when `to` matches a contract's `agent_name` (case-insensitive), the outbound payload — carried as a `context` attachment named `params` (JSON) — is validated against the peer's `input_schema`. `block` rejects; `warn` audits (`intercom-dispatched` / `intercom-rejected`).
- **Reply** (`ask` result): the free-text reply is best-effort parsed for a JSON object and checked against the peer's `output_schema`; the result is **annotated** (never hard-failed) and audited (`intercom-reply`).
- **Deferred:** responder-side `reply` validation — a session has no well-defined mapping to "its own" contract.

## Contract format (`<agent>.contract.json`)

```json
{
  "agent_name": "clj-reviewer",
  "input_schema":  { "required": ["files","rubric"], "properties": { "files":{"type":"array"}, "rubric":{"type":"string"} } },
  "output_schema": { "required": ["findings"], "properties": { "findings":{"type":"array"}, "summary":{"type":"string"} } }
}
```

Small JSON-Schema subset only: `required` + top-level `properties.type` (+ `["string","null"]` unions). Flat & shallow. No `allowed_tools` — this plugin does not lock tools.

## Tools

- `dispatch({ agent, params })` — validate params, gate a contracted subagent run.
- `ap_audit({ n? })` — recent contract events.
- `ap_agents({})` — registered contracts.

## Configuration

- `AP_MODE` = `warn` (default — validate + audit, inject `outputSchema`, never block) | `block` (reject a contracted `subagent` call that skipped `dispatch`) | `off` (register tools + audit only, no interception).
- `AP_DISABLE=1` — hard kill-switch: the extension is a true no-op (registers nothing).
- `AP_AUDIT_FILE` — `1`/`true` appends to `~/.pi/agent/agent-protocol/audit.jsonl`, or set an explicit path; unset = in-memory only.

## Install

```sh
pi install git:github.com/igorrize/pi-agent-protocol
```

This adds a `git:` entry to your `~/.pi/agent/settings.json` `packages`, so the extension loads in **every** session — which is what you want (required for the intercom path and for ubiquitous enforcement). `typebox` and the pi API are provided by the host runtime (declared as optional peer deps), so there is nothing else to install. Requires Node ≥ 20.

**Local development** — point `settings.json` `extensions` at your checkout instead of installing as a package:

```json
{ "extensions": ["/absolute/path/to/pi-agent-protocol/src/index.ts"] }
```

Then `/reload`.

## Development

```sh
npm install
npm run typecheck
npm test          # node:test via tsx
```

## License

MIT.
