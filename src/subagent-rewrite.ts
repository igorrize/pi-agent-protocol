// subagent-rewrite.ts
//
// Pure helpers for the subagent tool_call interceptor (DESIGN.md, "Flow —
// subagent path"). The `subagent` tool's `input` is a foreign, mutable object.
//
// pi-subagents 0.54 removed top-level `tasks`/`chain`/`parallel` (use
// `workflowScript`) and now accepts `outputSchema` DIRECTLY on a top-level
// single-child `{agent, task}` call — so `rewriteSingle` just sets
// `input.outputSchema` and appends the params block to `input.task` (no chain).
// There is no re-validation after a tool_call mutation, so mutating `input` in
// place here is safe.
//
// `enumerateTargets` / `applyToItems` remain as generic pure helpers over the
// legacy multi-agent shapes (kept for tests / potential future workflowScript
// handling); the live interceptor only uses `rewriteSingle`.
//
// No I/O, no console — callers (index.ts) own audit logging and side effects.

import type { PendingDispatch } from "./types.js";

/** The subagent tool's `input`: a foreign, loosely-shaped, mutable object. */
type SubagentInput = Record<string, unknown>;

/** `action` values that make a subagent call management, not agent dispatch. */
const MANAGEMENT_ACTIONS = new Set([
  "list",
  "get",
  "models",
  "create",
  "update",
  "delete",
  "status",
  "interrupt",
  "resume",
  "append-step",
  "doctor",
]);

/** Append a validated params blob to a task string as a fenced JSON block. */
export function appendParams(
  task: string,
  params: Record<string, unknown>,
): string {
  return `${task}\n\nPARAMS:\n\`\`\`json\n${JSON.stringify(params, null, 2)}\n\`\`\``;
}

/** Coerce a foreign `task` value to a string ("" when absent/non-string). */
function taskOf(task: unknown): string {
  return typeof task === "string" ? task : "";
}

/**
 * List the target agent names a subagent call would dispatch to, across
 * SINGLE ({agent}), PARALLEL ({tasks:[{agent}]}), and CHAIN ({chain:[{agent,
 * parallel:[{agent}]}]}) shapes. A management `action` dispatches to no
 * agent, so it always returns []. Non-string agents are ignored; results are
 * de-duplicated, preserving first-seen order.
 */
export function enumerateTargets(input: SubagentInput): string[] {
  if (
    typeof input.action === "string" &&
    MANAGEMENT_ACTIONS.has(input.action)
  ) {
    return [];
  }

  const seen = new Set<string>();
  const targets: string[] = [];
  const add = (agent: unknown): void => {
    if (typeof agent === "string" && !seen.has(agent)) {
      seen.add(agent);
      targets.push(agent);
    }
  };

  add(input.agent);

  if (Array.isArray(input.tasks)) {
    for (const item of input.tasks) add(item?.agent);
  }

  if (Array.isArray(input.chain)) {
    for (const item of input.chain) {
      add(item?.agent);
      if (Array.isArray(item?.parallel)) {
        for (const nested of item.parallel) add(nested?.agent);
      }
    }
  }

  return targets;
}

/**
 * Carry a validated dispatch onto a top-level SINGLE {agent, task} call:
 * append the params block to `input.task` and set top-level `input.outputSchema`
 * (when the pending defines one). Mutates `input` in place; `agent`/`task` are
 * kept — pi-subagents 0.54 accepts `outputSchema` on the single-child call
 * directly (no chain).
 */
export function rewriteSingle(
  input: SubagentInput,
  pending: PendingDispatch,
): void {
  input.task = appendParams(taskOf(input.task), pending.params);
  if (pending.outputSchema) {
    input.outputSchema = pending.outputSchema;
  }
}

/**
 * For PARALLEL (`tasks`) and CHAIN (`chain`, including nested `parallel`)
 * calls, resolve each item's `agent` via `resolve` and, when a pending is
 * found, set `outputSchema` (only if the pending defines one) and append its
 * params to the item's `task`. Items whose agent has no pending are left
 * untouched.
 */
export function applyToItems(
  input: SubagentInput,
  resolve: (agent: string) => PendingDispatch | undefined,
): void {
  const applyToItem = (item: SubagentInput | undefined): void => {
    if (!item || typeof item.agent !== "string") return;
    const pending = resolve(item.agent);
    if (!pending) return;

    if (pending.outputSchema) {
      item.outputSchema = pending.outputSchema;
    }
    item.task = appendParams(taskOf(item.task), pending.params);
  };

  if (Array.isArray(input.tasks)) {
    for (const item of input.tasks) applyToItem(item);
  }

  if (Array.isArray(input.chain)) {
    for (const item of input.chain) {
      applyToItem(item);
      if (item && Array.isArray(item.parallel)) {
        for (const nested of item.parallel) applyToItem(nested);
      }
    }
  }
}
