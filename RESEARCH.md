# pi-agent-protocol — Research (pi internals)

> Authoritative findings from reading the installed pi packages (2026-06-29). **Do not re-research** unless something below fails to match; verify against the cited source paths. Everything here is local on this machine.

## Source paths (local)

- **Extension docs (full):** `~/.pi/agent/git/github.com/rytswd/pi-agent-extensions/node_modules/@mariozechner/pi-coding-agent/docs/extensions.md`
- **Canonical types** (`ExtensionAPI`, all events, `ToolDefinition`, `ToolCallEvent`, `ToolResultEvent`): `…/@mariozechner/pi-coding-agent/dist/core/extensions/types.d.ts`
- **subagent:** `~/.nvm/versions/node/v22.20.0/lib/node_modules/pi-subagents/` (v0.31, TS source under `src/`)
- **intercom:** `~/.nvm/versions/node/v22.20.0/lib/node_modules/pi-intercom/` (v0.6, `index.ts`)
- **Reference extensions:** `~/.pi/agent/npm/node_modules/pi-mcp-adapter/index.ts`, `~/.pi/agent/extensions/max-asks.ts`

## Package-specifier caveat

The same API is imported under different specifiers across installs: `@earendil-works/pi-coding-agent` (max-asks, pi-mcp-adapter), `@mariozechner/pi-coding-agent` (docs/types pkg), bare `pi-coding-agent` (older). **Use `@earendil-works/pi-coding-agent`** (matches the user's working `max-asks.ts`). TypeBox is imported as **bare `typebox`** (`import { Type } from "typebox";` — confirmed in `pi-mcp-adapter/index.ts:3`). Enums (if needed): `StringEnum` from `@mariozechner/pi-ai`.

---

## Extension model

- Auto-discovered from `~/.pi/agent/extensions/*.ts` (or `*/index.ts`) [global] and `.pi/extensions/*.ts` [project]; or via `settings.json` `extensions:[paths]` / `packages:[npm|git]`. Only auto-discovered locations support `/reload`.
- Default export = factory `export default function (pi: ExtensionAPI) { ... }`; may be `async` (awaited before startup).
- Loaded via `jiti` → TS runs without compilation; npm deps work with a sibling `package.json` + `npm install`.
- Subagent detection: `process.env.PI_SUBAGENT_RUN_ID` set, or `Number(process.env.PI_SUBAGENT_DEPTH) > 0`. Main interactive session sets neither.
- Handler type: `(event, ctx) => R | void | Promise<R | void>`; returning `void`/`undefined` = pass through.

## Events (load-bearing for us)

- **`tool_call`** — before a tool runs. `event = { type:"tool_call", toolCallId, toolName, input }`. **`event.input` is MUTABLE** — mutate in place to patch args (NO re-validation after). Return `{ block?: boolean, reason?: string }` to reject (only blocking is honored; cannot replace result here). Throwing also blocks (fail-safe). Narrow with `isToolCallEventType("subagent", event)`.
- **`tool_result`** — after a tool runs, before result reaches the LLM. `event = { type:"tool_result", toolCallId, toolName, input, content:[{type:"text"|"image",...}], isError, details }`. Return `{ content?, details?, isError? }` to **modify the result** (middleware-chained across extensions; omitted fields unchanged).
- `session_start` `{reason}` — load contracts here. `resources_discover` `{cwd,reason}` — can also contribute resource paths.
- (Observational only, cannot modify: `tool_execution_start/update/end`.)
- Other useful: `before_agent_start` (inject message / replace system prompt), `context` (mutate messages before LLM call), `message_end` (replace finalized message). 29 events total.

## registerTool (exact, from pi-mcp-adapter)

```ts
import { Type } from "typebox";
pi.registerTool({
  name: "dispatch",
  label: "Dispatch",
  description: "…",
  promptSnippet: "…",                       // one-line entry in "Available tools"
  parameters: Type.Object({
    agent:  Type.String({ description: "…" }),
    params: Type.Unsafe({ type: "object", additionalProperties: true, description: "…" }), // raw JSON-Schema
  }),
  async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
    // … async OK; throw to mark isError; return:
    return { content: [{ type: "text" as const, text: "…" }], details: { /* state */ } };
  },
});
```

- `parameters` is a **TypeBox** schema (`Type.Object`, `Type.Optional`, `Type.String/Boolean/...`). For a raw/foreign JSON-Schema use `Type.Unsafe(schema as never)`.
- `execute` signature: `(toolCallId, params, signal, onUpdate, ctx) => Promise<{content, details, isError?}>`. **Throw** to fail (sets `isError`); returning an object never marks error.
- Tools can be registered at load or runtime; they appear without `/reload`. `pi.registerFlag(name, {description,type})` registers CLI flags. `pi.getAllTools()` lists tools.
- Gotcha: a tool's `execute` (ExtensionContext) **cannot** call `ctx.reload()`; to run a command, `pi.sendUserMessage("/cmd", { deliverAs: "followUp" })`.

---

## subagent (pi-subagents@0.31)

> **VERSION UPDATE — installed pi-subagents is 0.54.0 (not 0.31); confirmed live 2026-07-16.** Top-level `tasks`/`chain`/`parallel`/`concurrency`/`chainDir` were **removed** — such a call errors with *"Legacy top-level chain and parallel inputs were removed; use workflowScript."* Multi-agent orchestration is now `workflowScript` (inline JS). **Crucially, `outputSchema` is now a top-level param of the public tool** (`src/extension/schemas.ts`, `SubagentParamProperties`): a single `{agent, task, outputSchema}` call forces structured output on the child directly — no chain rewrite. `src/extension/public-execution.ts` converts `{agent, task}` into `return runs.run("main", {…})` and forwards top-level `outputSchema` as a workflow default. The 0.31 notes below are historical; the plugin's `rewriteSingle` now sets top-level `outputSchema` + appends params.

- **One LLM tool: `subagent`** (no separate `run`/`dispatch`). Multiplexes via `action` (`list/get/models/create/update/delete/status/interrupt/resume/append-step/doctor`) + execution modes.
- Execution modes (top-level `input` fields):
  - **SINGLE:** `agent` (string) + `task` (string).
  - **PARALLEL:** `tasks: TaskItem[]` where `TaskItem = {agent, task, cwd?, count?, output?, outputMode?, reads?, progress?, model?, skill?, acceptance?}` — **NO `outputSchema`**.
  - **CHAIN:** `chain: ChainItem[]` where `ChainItem = {agent?, task?, phase?, label?, as?, outputSchema?, cwd?, output?, outputMode?, reads?, progress?, skill?, model?, acceptance?, parallel?, expand?, collect?, concurrency?, failFast?, worktree?}`; `parallel` items (`ParallelTaskSchema`) ALSO have `outputSchema?`.
  - Shared: `context:"fresh"|"fork"`, `async`, `timeoutMs`, `agentScope`, `cwd`, `model`, `skill`, `acceptance`, `clarify`, `worktree`, `control`, …
- **CRITICAL:** `outputSchema` exists **ONLY** on chain/parallel items — **NOT** top-level, NOT SINGLE, NOT `tasks[]`. To force output validation on a plain `{agent,task}` call → **rewrite to a one-step chain**: `input.chain=[{agent,task,outputSchema}]; delete input.agent; delete input.task`. Safe because `tool_call` does **no re-validation after mutation**.
- `outputSchema` enforcement (when present): child registers a `structured_output` tool whose params wrap the schema (`{value: schema}`), validates and **throws** on mismatch (in-loop retry inside the child); the child's final action must be `structured_output`. Parent re-reads `output.json` and re-validates (compiled TypeBox). Missing/invalid → step `exitCode=1` (NO parent re-spawn). Schema type is `Type.Unsafe({type:"object", additionalProperties:true})`; non-object roots rejected.
- Result: `{ content:[{type:"text", text}], details }`. With structured output, the value is `JSON.stringify`'d into `text` and available as `result.structuredOutput` / named-output `.structured`.
- **`task` is FREE TEXT** — there is no structured `params` field on a subagent call. → "mandatory params" requires a convention (we use the `dispatch` gate tool + appending params JSON into `task`).
- Env in a spawned child: `PI_SUBAGENT_CHILD="1"`, `PI_SUBAGENT_RUN_ID`, `PI_SUBAGENT_CHILD_AGENT` (agent name), `PI_SUBAGENT_DEPTH` (incremented), `PI_SUBAGENT_STRUCTURED_OUTPUT_SCHEMA`/`…_CAPTURE` (when structured), `MCP_DIRECT_TOOLS`, plus many `PI_SUBAGENT_PARENT_*`.
- Agents: `*.md` (frontmatter `name, description, tools, model, defaultContext, …` — `KNOWN_FIELDS`). **Unknown frontmatter keys → `AgentConfig.extraFields` (preserved on disk, ignored by execution, value is a flat string).** Discovery dirs: builtin, `~/.pi/agent/agents`, `~/.agents`, `<project>/.pi/agents`, `<project>/.agents` + packaged.

## intercom (pi-intercom@0.6)

- Tools: **`intercom`** (always) + **`contact_supervisor`** (only inside a subagent; target = parent fixed by env).
- `intercom` input (TypeBox): `action: Type.String` (**free string**, not enum — values `list|send|ask|reply|pending|status`, enforced in a runtime `switch`), `to?` (peer name case-insensitive OR UUID), `message?`, `attachments?: [{type:"file"|"snippet"|"context", name, content, language?}]`, `replyTo?`. Per-action required (in `execute`, not schema): `send`/`ask` need `to`+`message`; `reply` needs `message`.
- **`ask` is SYNCHRONOUS:** blocks (10-min timeout) and returns the peer's reply in the **same tool result** as **free text** (`**Reply from X:**\n<text>`) — no schema/envelope.
- **`send` is fire-and-ack:** returns only "Message sent to X". The real answer arrives later, async, **in the peer's process** (a separate injected message + a separate `reply` tool call there).
- Incoming messages surface as **injected messages** (`pi.sendMessage({customType:"intercom_message"}, {triggerTurn})`), **not** tool calls — except a reply matching an active `ask` is consumed by the waiter.
- `contact_supervisor`: `reason` (**real enum** `need_decision|progress_update|interview_request`), `message?`, `interview?`. `need_decision`/`interview_request` block for the parent's reply; `interview_request` is the only one with a declared response envelope `{responses:[{id,value}]}` — but validation is **soft** (parse failure still returns `isError:false` + free text).
- Broker: star topology, unix socket `~/.pi/agent/intercom/broker.sock`, length-prefixed JSON.

### Enforcement implication (intercom)

You can see + block + mutate the **outbound** call. You **cannot** cleanly validate the **response**: `ask` reply is free text (soft-parse only); `send` answer is async in the peer's process. To validate a neighbor's reply you must intercept the **responder's** `reply` in **its** session → **install the plugin globally**.

---

## Verdict (capabilities we rely on)

1. Block a tool call by name — **YES** (`tool_call` → `{block,reason}`).
2. Mutate a call's args before run — **YES** (`event.input` in place, no re-validation).
3. Read/modify a call's result — **YES** (`tool_result` → `{content?,details?,isError?}`).
4. Force a subagent's output to a schema — **YES**, via single→chain rewrite injecting `outputSchema` (pi-subagents then forces + re-validates).
5. Validate an intercom response by schema — **NO** (async/free-text); only outbound gating + soft-parse.
