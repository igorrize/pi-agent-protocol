// pi-agent-protocol — extension wiring (subagent path, Phase 1).
//
// Registers the `dispatch` gate tool plus `ap_audit` / `ap_agents`, loads
// `<agent>.contract.json` sidecars on session start, and intercepts the
// `subagent` tool to enforce contracts:
//   - dispatch({agent, params})  -> validate params, store a pending dispatch
//   - subagent({agent, task})    -> consume the pending, rewrite SINGLE into a
//                                   one-step chain carrying params + outputSchema
//                                   (so pi-subagents forces schema-valid output)
//
// Enforcement is soft and configurable (AP_MODE = warn|block|off); a hard
// kill-switch (AP_DISABLE=1) makes the extension a true no-op. All handler
// bodies catch their own errors so a bug here never blocks a legit tool call
// (see CONCERNS C3). See DESIGN.md "Flow — subagent path".

import type {
  AgentToolResult,
  ExtensionAPI,
  ToolCallEvent,
  ToolResultEvent,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  Contract,
  ContractRegistry,
  Mode,
  PendingDispatch,
  SchemaSubset,
} from "./types.js";
import { loadRegistry } from "./contracts.js";
import { prepareDispatch } from "./dispatch-core.js";
import { validate } from "./validator.js";
import { rewriteSingle } from "./subagent-rewrite.js";
import {
  extractParams,
  resolvePeerContract,
  softParseReply,
  validateOutbound,
} from "./intercom-gate.js";
import { AuditLog } from "./audit.js";

/** The `subagent` tool's foreign, mutable input object. */
type SubagentInput = Record<string, unknown>;

/** Pending dispatches expire after this long if never consumed (CONCERNS C7). */
const PENDING_TTL_MS = 10 * 60 * 1000;

const VALID_MODES = new Set<Mode>(["warn", "block", "off"]);

function readMode(): Mode {
  const raw = (process.env.AP_MODE ?? "").toLowerCase();
  return VALID_MODES.has(raw as Mode) ? (raw as Mode) : "warn";
}

function isDisabled(): boolean {
  const raw = (process.env.AP_DISABLE ?? "").toLowerCase();
  return raw === "1" || raw === "true";
}

/** Resolve the optional audit-file target from AP_AUDIT_FILE. */
function resolveAuditFile(): string | undefined {
  const raw = process.env.AP_AUDIT_FILE;
  if (!raw) return undefined;
  if (raw === "1" || raw.toLowerCase() === "true") {
    return join(homedir(), ".pi", "agent", "agent-protocol", "audit.jsonl");
  }
  return raw;
}

function textResult(text: string): AgentToolResult<null> {
  return { content: [{ type: "text" as const, text }], details: null };
}

export default function agentProtocol(pi: ExtensionAPI): void {
  if (isDisabled()) {
    console.error("[agent-protocol] disabled via AP_DISABLE — no-op");
    return;
  }

  const mode = readMode();
  const audit = new AuditLog({ file: resolveAuditFile() });
  const pending = new Map<string, PendingDispatch>();
  let registry: ContractRegistry = new Map();

  function loadNow(cwd: string): void {
    try {
      registry = loadRegistry(cwd, homedir());
      console.error(
        `[agent-protocol] loaded ${registry.size} contract(s) [mode=${mode}]`,
      );
    } catch (err) {
      console.error("[agent-protocol] contract load failed:", err);
      registry = new Map();
    }
  }

  /** Take and remove a fresh (non-stale) pending dispatch for an agent. */
  function consume(agent: string): PendingDispatch | undefined {
    const p = pending.get(agent);
    if (!p) return undefined;
    pending.delete(agent);
    if (Date.now() - p.ts > PENDING_TTL_MS) return undefined;
    return p;
  }

  pi.on("session_start", async (_event, ctx) => {
    loadNow(ctx.cwd);
  });

  // --- Registered tools -----------------------------------------------------

  pi.registerTool({
    name: "dispatch",
    label: "Dispatch",
    description:
      "Validate params against a contracted agent's input_schema before calling it. " +
      "On success, immediately call subagent({ agent, task }); the contract's output " +
      "schema is then enforced automatically. Returns rejection details if params are invalid.",
    promptSnippet:
      "dispatch({ agent, params }) — validate a contracted agent's inputs before subagent()",
    parameters: Type.Object({
      agent: Type.String({
        description: "Target agent name (must have a <agent>.contract.json).",
      }),
      params: Type.Optional(
        Type.Unsafe<Record<string, unknown>>({
          type: "object",
          additionalProperties: true,
          description:
            "Structured params validated against the agent's input_schema.",
        }),
      ),
    }),
    async execute(_toolCallId, params) {
      const agent = params.agent;
      const supplied = (params.params ?? {}) as Record<string, unknown>;
      const res = prepareDispatch(registry, agent, supplied);

      if (res.status === "no_such_agent") {
        audit.record({
          kind: "no_such_agent",
          agent,
          path: "subagent",
          mode,
          detail: { available: res.available },
        });
        return textResult(
          `No contract registered for "${agent}". Contracted agents: ${res.available.join(", ") || "(none)"}.`,
        );
      }
      if (res.status === "rejected") {
        audit.record({
          kind: "rejected",
          agent,
          path: "subagent",
          mode,
          detail: { errors: res.errors },
        });
        const lines = Object.entries(res.errors)
          .map(([k, v]) => `  - ${k}: ${v}`)
          .join("\n");
        return textResult(
          `REJECTED: params for "${agent}" do not satisfy the contract:\n${lines}\n\nFix the params and call dispatch again.`,
        );
      }

      pending.set(agent, res.pending);
      audit.record({
        kind: "dispatched",
        agent,
        path: "subagent",
        mode,
        detail: { stage: "gate" },
      });
      return textResult(
        `\u2713 Validated params for "${agent}". Now call subagent({ agent: "${agent}", task: "<your task>" }); ` +
          `the contract's output schema will be enforced automatically.`,
      );
    },
  });

  pi.registerTool({
    name: "ap_audit",
    label: "Agent-protocol audit",
    description:
      "Show recent pi-agent-protocol contract events (dispatched / rejected / bypass / completed / failed).",
    promptSnippet: "ap_audit({ n? }) — recent contract events",
    parameters: Type.Object({
      n: Type.Optional(
        Type.Number({
          description: "How many recent events to show (default 20).",
        }),
      ),
    }),
    async execute(_toolCallId, params) {
      const n = typeof params.n === "number" && params.n > 0 ? params.n : 20;
      const events = audit.recent(n);
      if (events.length === 0) return textResult("(no audit events)");
      return textResult(events.map((e) => JSON.stringify(e)).join("\n"));
    },
  });

  pi.registerTool({
    name: "ap_agents",
    label: "Agent-protocol agents",
    description:
      "List registered agent contracts with their required input/output keys.",
    promptSnippet: "ap_agents({}) — list registered contracts",
    parameters: Type.Object({}),
    async execute() {
      if (registry.size === 0) return textResult("(no contracts loaded)");
      const lines = [...registry.values()].map((c) => {
        const inReq = c.input_schema?.required ?? [];
        const outReq = c.output_schema?.required ?? [];
        return `- ${c.agent_name}: in[${inReq.join(", ")}] out[${outReq.join(", ")}]`;
      });
      return textResult(lines.join("\n"));
    },
  });

  // In "off" mode we register tools + load contracts (observability) but attach
  // no interceptors: no blocking, no input mutation. True fast path (CONCERNS C3).
  if (mode === "off") {
    return;
  }

  // --- Interceptors ---------------------------------------------------------

  /** Inject only an outputSchema onto a SINGLE call (bypass path, no params). */
  function injectOutputSchemaSingle(
    input: SubagentInput,
    outputSchema: SchemaSubset,
  ): void {
    input.outputSchema = outputSchema;
  }

  function handleSingle(
    input: SubagentInput,
    agent: string,
  ): { block: true; reason: string } | void {
    const contract = registry.get(agent);
    if (!contract) return; // uncontracted -> pass through

    const p = consume(agent);
    if (p) {
      rewriteSingle(input, p);
      audit.record({
        kind: "dispatched",
        agent,
        path: "subagent",
        mode,
        detail: { stage: "run" },
      });
      return;
    }

    // Contracted agent called without a matching dispatch (CONCERNS C1).
    if (mode === "block") {
      audit.record({
        kind: "bypass",
        agent,
        path: "subagent",
        mode,
        detail: { blocked: true },
      });
      return {
        block: true,
        reason:
          `Agent "${agent}" is contracted. Call dispatch({ agent: "${agent}", params }) first to validate ` +
          `required inputs, then call subagent again.`,
      };
    }

    // warn: allow, but still enforce output when the contract declares one.
    let injectedOutputSchema = false;
    if (contract.output_schema) {
      injectOutputSchemaSingle(input, contract.output_schema);
      injectedOutputSchema = true;
    }
    audit.record({
      kind: "bypass",
      agent,
      path: "subagent",
      mode,
      detail: { injectedOutputSchema },
    });
  }

  /** Find agent names referenced in a workflowScript (best-effort string scan). */
  function scanWorkflowAgents(script: string): string[] {
    const re = /\bagent\s*:\s*["']([^"']+)["']/g;
    const seen = new Set<string>();
    const out: string[] = [];
    let m: RegExpExecArray | null;
    while ((m = re.exec(script)) !== null) {
      const name = m[1];
      if (name && !seen.has(name)) {
        seen.add(name);
        out.push(name);
      }
    }
    return out;
  }

  /**
   * workflowScript orchestration (0.54 multi-agent) is inline JS we cannot
   * safely mutate, so this path is OBSERVED, not enforced: audit each contracted
   * agent referenced. In block mode, require a prior dispatch for each (we still
   * cannot inject outputSchema — the caller must set it in their runs.run item).
   */
  function handleWorkflowScript(
    script: string,
  ): { block: true; reason: string } | void {
    const contracted = scanWorkflowAgents(script).filter((a) =>
      registry.has(a),
    );
    if (contracted.length === 0) return;

    const missing: string[] = [];
    for (const agent of contracted) {
      const p = consume(agent);
      if (p) {
        audit.record({
          kind: "dispatched",
          agent,
          path: "subagent",
          mode,
          detail: { stage: "run", via: "workflowScript" },
        });
      } else {
        audit.record({
          kind: "bypass",
          agent,
          path: "subagent",
          mode,
          detail: { via: "workflowScript" },
        });
        missing.push(agent);
      }
    }

    if (mode === "block" && missing.length > 0) {
      return {
        block: true,
        reason:
          `workflowScript references contracted agent(s) without a prior dispatch: ${missing.join(", ")}. ` +
          `Call dispatch({ agent, params }) for each first. Note: pi-agent-protocol cannot inject outputSchema into ` +
          `workflowScript — set outputSchema yourself in the runs.run item.`,
      };
    }
  }

  /**
   * Intercom OUTBOUND gate (experimental): validate a send/ask to a contracted
   * peer against its input_schema (params carried as a `context` attachment
   * named "params"). Uncontracted peers pass through; warn never blocks.
   */
  function handleIntercomCall(
    input: SubagentInput,
  ): { block: true; reason: string } | void {
    const action = typeof input.action === "string" ? input.action : undefined;
    if (action !== "send" && action !== "ask") return;
    const contract = resolvePeerContract(registry, input.to);
    if (!contract) return;

    const params = extractParams(input.attachments);
    const res = validateOutbound(contract, params);
    if (res.ok) {
      audit.record({
        kind: "intercom-dispatched",
        agent: contract.agent_name,
        path: "intercom",
        mode,
        detail: { action },
      });
      return;
    }

    audit.record({
      kind: "intercom-rejected",
      agent: contract.agent_name,
      path: "intercom",
      mode,
      detail: { action, errors: res.errors },
    });
    if (mode === "block") {
      const lines = Object.entries(res.errors)
        .map(([k, v]) => `${k}: ${v}`)
        .join("; ");
      return {
        block: true,
        reason:
          `intercom ${action} to contracted peer "${contract.agent_name}" failed input validation: ${lines}. ` +
          `Send the params as a context attachment named "params" (JSON).`,
      };
    }
  }

  pi.on("tool_call", (event: ToolCallEvent) => {
    try {
      if (event.toolName === "intercom") {
        return handleIntercomCall(event.input as SubagentInput);
      }
      if (event.toolName !== "subagent") return;
      const input = event.input as SubagentInput;

      // Management actions: never touch.
      if (input.action !== undefined) return;

      // workflowScript orchestration (0.54): observed, not enforced.
      if (typeof input.workflowScript === "string") {
        return handleWorkflowScript(input.workflowScript);
      }

      // Structured single-child call: { agent, task }. Legacy top-level
      // tasks/chain/parallel were removed in 0.54 (pi-subagents rejects them).
      if (typeof input.agent !== "string") return;
      if (
        input.tasks !== undefined ||
        input.chain !== undefined ||
        input.parallel !== undefined
      )
        return;

      return handleSingle(input, input.agent);
    } catch (err) {
      console.error(
        "[agent-protocol] tool_call handler error (passing through):",
        err,
      );
      return;
    }
  });

  /**
   * Audit one child result and self-revalidate its structuredOutput against the
   * contract's output_schema (belt-and-suspenders; pi-subagents already enforces
   * it). Async launches that have not finished carry no output yet.
   */
  function auditChildResult(
    agent: string,
    contract: Contract,
    r: Record<string, unknown>,
    via: string,
  ): void {
    if (r.detached === true) {
      audit.record({
        kind: "dispatched",
        agent,
        path: "subagent",
        mode,
        detail: { stage: "async-started", via },
      });
      return;
    }
    const exitCode = typeof r.exitCode === "number" ? r.exitCode : undefined;
    const failed =
      r.error !== undefined ||
      r.structuredOutputFailed === true ||
      (exitCode !== undefined && exitCode !== 0);
    if (failed) {
      audit.record({
        kind: "failed",
        agent,
        path: "subagent",
        mode,
        detail: {
          error: r.error,
          structuredOutputFailed: r.structuredOutputFailed === true,
          exitCode,
          via,
        },
      });
      return;
    }
    // Completed: re-validate the child's structured output against the contract.
    let revalidation: unknown = "not-required";
    if (contract.output_schema) {
      if (r.structuredOutput === undefined) {
        revalidation = "no-structured-output";
      } else {
        const res = validate(contract.output_schema, r.structuredOutput);
        revalidation = res.ok ? "ok" : { errors: res.errors };
      }
    }
    audit.record({
      kind: "completed",
      agent,
      path: "subagent",
      mode,
      detail: { revalidation, via },
    });
  }

  pi.on("tool_result", (event: ToolResultEvent) => {
    try {
      if (event.toolName === "intercom") {
        const input = event.input as SubagentInput;
        if (input.action !== "ask") return;
        const contract = resolvePeerContract(registry, input.to);
        if (!contract || !contract.output_schema) return;
        const replyText = event.content
          .map((c) => (c.type === "text" ? c.text : ""))
          .join("\n");
        const { result } = softParseReply(replyText, contract);
        if (!result) return;
        audit.record({
          kind: "intercom-reply",
          agent: contract.agent_name,
          path: "intercom",
          mode,
          detail: result.ok
            ? { ok: true }
            : { ok: false, errors: result.errors },
        });
        const note = result.ok
          ? `\n\n[agent-protocol] reply from "${contract.agent_name}" satisfies output_schema.`
          : `\n\n[agent-protocol] reply from "${contract.agent_name}" does NOT satisfy output_schema: ${Object.entries(
              result.errors,
            )
              .map(([k, v]) => `${k}: ${v}`)
              .join("; ")}`;
        return {
          content: [...event.content, { type: "text" as const, text: note }],
        };
      }
      if (event.toolName !== "subagent") return;

      // Preferred: per-child results carry each child's structuredOutput.
      const rawResults = (event.details as { results?: unknown } | undefined)
        ?.results;
      const results = Array.isArray(rawResults)
        ? (rawResults as Record<string, unknown>[])
        : undefined;
      if (results && results.length > 0) {
        let handled = false;
        for (const r of results) {
          const agent = typeof r.agent === "string" ? r.agent : undefined;
          if (!agent) continue;
          const contract = registry.get(agent);
          if (!contract) continue;
          handled = true;
          auditChildResult(agent, contract, r, "tool_result");
        }
        if (handled) return;
      }

      // Fallback: no per-child results (e.g. an async launch) — best-effort by input.agent.
      const input = event.input as SubagentInput;
      const agent = typeof input.agent === "string" ? input.agent : undefined;
      if (!agent || !registry.has(agent)) return;
      audit.record({
        kind: event.isError ? "failed" : "completed",
        agent,
        path: "subagent",
        mode,
        detail: {
          isError: event.isError,
          revalidation: "unavailable",
          via: "tool_result-fallback",
        },
      });
    } catch (err) {
      console.error(
        "[agent-protocol] tool_result handler error (ignoring):",
        err,
      );
      return;
    }
  });

  // Async runs finish out-of-band (pi-subagents 0.54 runs a single child async
  // by default), so completion does NOT arrive as a tool_result. Subscribe to
  // the async-complete event on pi.events to re-validate each contracted
  // child's structured output when the run actually finishes.
  pi.events.on("subagent:async-complete", (data: unknown) => {
    try {
      const rawResults = (data as { results?: unknown } | undefined)?.results;
      const results = Array.isArray(rawResults)
        ? (rawResults as Record<string, unknown>[])
        : undefined;
      if (!results) return;
      for (const r of results) {
        const agent = typeof r.agent === "string" ? r.agent : undefined;
        if (!agent) continue;
        const contract = registry.get(agent);
        if (!contract) continue;
        auditChildResult(agent, contract, r, "async-complete");
      }
    } catch (err) {
      console.error(
        "[agent-protocol] async-complete handler error (ignoring):",
        err,
      );
    }
  });
}
