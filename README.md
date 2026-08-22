# pi-agent-protocol

![status](https://img.shields.io/badge/status-v0.1.0-blue) ![license](https://img.shields.io/badge/license-MIT-green) ![node](https://img.shields.io/badge/node-%E2%89%A5%2020-brightgreen)

> **Typed agent-to-agent contracts for the [pi](https://pi.dev) coding agent** — mandatory, validated input params + validated output + an audit trail, over `pi-subagents` and `pi-intercom`. Soft, configurable enforcement. No tool-locking.

A pi-native re-imagining of [`agent-protocol`](https://github.com/igorrize/agent-protocol) (a Go MCP proxy that physically locks workers). This plugin keeps the *contract* idea — agents only reach each other through a validated boundary — but stays **non-locking** and **observable**: you watch how/when an agent bypasses a contract, then tighten.

**Status:** v0.1.0. The **subagent** path is contract-grade and validated live on **pi-subagents 0.54**; the **intercom** path is **experimental**. Details in `PLAN.md` / `DESIGN.md` / `RESEARCH.md` / `CONCERNS.md`.

## Install

```sh
pi install git:github.com/igorrize/pi-agent-protocol
```

That adds a `git:` entry to `~/.pi/agent/settings.json` `packages`, so the extension loads in **every** session — install it globally (required for the intercom path and for ubiquitous enforcement). `typebox` and the pi API come from the host runtime (declared as optional peer deps), so there is nothing else to install.

- **Requirements:** Node ≥ 20; `pi-subagents` (subagent path) and, for the intercom path, `pi-intercom` installed in both sessions.
- **Verify:** `/reload`, then the `dispatch` / `ap_audit` / `ap_agents` tools appear and `ap_agents` lists your contracts.
- **Uninstall:** remove the `git:` entry from `packages`.

> Publishing to npm is optional; once published, `pi install npm:pi-agent-protocol` works the same way.

<details>
<summary><b>Local development</b> (run from a checkout)</summary>

Point `settings.json` `extensions` at your checkout instead of installing as a package:

```json
{ "extensions": ["/absolute/path/to/pi-agent-protocol/src/index.ts"] }
```

Then `/reload`. Don't keep both a `packages` entry **and** the `extensions` path — that double-loads the extension.

```sh
npm install
npm run typecheck
npm test          # node:test via tsx
```

</details>

## Quick start

1. **Write a contract** next to an agent — `<agent>.contract.json` beside `<agent>.md` in any pi agent dir (`~/.agents`, `<project>/.agents`, …):

   ```json
   {
     "agent_name": "code-reviewer",
     "input_schema":  { "required": ["files", "rubric"], "properties": { "files": {"type":"array"}, "rubric": {"type":"string"} } },
     "output_schema": { "required": ["findings"], "properties": { "findings": {"type":"array"}, "summary": {"type":"string"} } }
   }
   ```

2. **Dispatch** — validates the inputs against `input_schema`:

   ```js
   dispatch({ agent: "code-reviewer", params: { files: ["src/app.ts"], rubric: "clarity + edge cases" } })
   // ✓ Validated. Now call subagent({ agent: "code-reviewer", task: "..." })
   ```

3. **Run it** — the plugin appends the validated params to the task and forces schema-valid output:

   ```js
   subagent({ agent: "code-reviewer", task: "Review the files listed in PARAMS." })
   // the child is forced to emit { findings: [...] }
   ```

4. **Audit** the trail: `ap_audit({ n: 10 })` → `dispatched → completed` (with output re-validation).

Skip `dispatch` and call `subagent` directly? In `warn` it's allowed and audited as a `bypass`; in `block` it's rejected until you dispatch first.

## How it works (subagent path — the strong one)

1. A contract lives next to an agent: `<agent>.contract.json` beside `<agent>.md`.
2. `dispatch({ agent, params })` validates `params` against `input_schema`. Missing/wrong → rejected, so the model self-corrects.
3. On success `subagent({ agent, task })` is augmented: the plugin appends the params to the task and sets the contract's `output_schema` **on the call**, so pi-subagents **forces** the child to emit schema-valid output. (On pi-subagents 0.54 `outputSchema` is a top-level field of the `subagent` tool; the older "one-step chain" rewrite is obsolete — see the RESEARCH/DESIGN version notes.)
4. Every `dispatched` / `rejected` / `bypass` / `completed` / `failed` event is audited; on completion the child's structured output is re-validated against `output_schema` (sync results inline, async runs via a `pi.events` subscription).

## Intercom path (experimental)

Weaker by nature (a neighbor's reply is async / free text — see `CONCERNS.md` C2), and it needs the plugin installed **globally** so both sessions run it.

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

Small JSON-Schema subset only: `required` + top-level `properties.type` (+ `["string","null"]` unions). Flat & shallow. Both schemas are optional (no `input_schema` → nothing to validate; no `output_schema` → output not forced). No `allowed_tools` — this plugin does not lock tools.

## Tools

- `dispatch({ agent, params })` — validate params, gate a contracted subagent run.
- `ap_audit({ n? })` — recent contract events.
- `ap_agents({})` — registered contracts (name + required input/output keys).

## Configuration

- `AP_MODE` = `warn` (default — validate + audit, inject `outputSchema`, never block) | `block` (reject a contracted `subagent` call that skipped `dispatch`) | `off` (register tools + audit only, no interception).
- `AP_DISABLE=1` — hard kill-switch: the extension is a true no-op (registers nothing).
- `AP_AUDIT_FILE` — `1`/`true` appends to `~/.pi/agent/agent-protocol/audit.jsonl`, or set an explicit path; unset = in-memory only.

## Examples & dogfooding

`.agents/` ships contracted agents used to develop this repo (`code-reviewer`, `test-writer`) plus a smoke fixture (`clj-reviewer`). `test/smoke.md` is the manual end-to-end walkthrough; `examples/` holds additional draft contracts.

## License

MIT — see `LICENSE`.
