// Phase 1.3 handler tests: exercise agentProtocol(pi) end-to-end against a
// fake ExtensionAPI (captures pi.on / pi.registerTool) — no real pi runtime,
// no build/tsc, source only.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import agentProtocol from "../src/index.js";

type Handler = (event: any, ctx?: any) => any;

function makeFakePi() {
  const handlers = new Map<string, Handler[]>();
  const tools = new Map<string, any>();
  const eventHandlers = new Map<string, Handler[]>();
  const pi = {
    on(ev: string, h: Handler) {
      const a = handlers.get(ev) ?? [];
      a.push(h);
      handlers.set(ev, a);
    },
    registerTool(def: any) {
      tools.set(def.name, def);
    },
    events: {
      on(channel: string, h: (data: unknown) => void) {
        const a = eventHandlers.get(channel) ?? [];
        a.push(h as Handler);
        eventHandlers.set(channel, a);
        return () => {};
      },
      emit() {},
    },
  };
  return { pi, handlers, tools, eventHandlers };
}

const AGENT_NAME = "ap-handler-test-reviewer";

const CONTRACT = {
  agent_name: AGENT_NAME,
  input_schema: {
    required: ["files", "rubric"],
    properties: {
      files: { type: "array" },
      rubric: { type: "string" },
    },
  },
  output_schema: {
    required: ["findings"],
    properties: {
      findings: { type: "array" },
    },
  },
};

/** A throwaway git-rooted project dir with `<AGENT_NAME>.contract.json` under `.agents/`. */
function makeFixtureProject(): string {
  const tmp = mkdtempSync(join(tmpdir(), "ap-handlers-"));
  writeFileSync(join(tmp, ".git"), "gitdir: fake\n"); // stops discoverAgentDirs' upward walk
  const agentsDir = join(tmp, ".agents");
  mkdirSync(agentsDir, { recursive: true });
  writeFileSync(
    join(agentsDir, `${AGENT_NAME}.contract.json`),
    JSON.stringify(CONTRACT),
  );
  return tmp;
}

interface EnvSnapshot {
  AP_MODE: string | undefined;
  AP_DISABLE: string | undefined;
  AP_AUDIT_FILE: string | undefined;
}

function snapshotEnv(): EnvSnapshot {
  return {
    AP_MODE: process.env.AP_MODE,
    AP_DISABLE: process.env.AP_DISABLE,
    AP_AUDIT_FILE: process.env.AP_AUDIT_FILE,
  };
}

function restoreEnv(snap: EnvSnapshot): void {
  for (const key of ["AP_MODE", "AP_DISABLE", "AP_AUDIT_FILE"] as const) {
    const v = snap[key];
    if (v === undefined) delete process.env[key];
    else process.env[key] = v;
  }
}

/**
 * Set AP_MODE/AP_DISABLE (AP_AUDIT_FILE always cleared — in-memory audit
 * only), call agentProtocol(pi) synchronously, then immediately restore the
 * previous env. Safe because agentProtocol reads env synchronously at
 * invocation time, before returning.
 */
function setupInstance(opts: { mode?: string; disable?: string } = {}) {
  const snap = snapshotEnv();
  if (opts.mode === undefined) delete process.env.AP_MODE;
  else process.env.AP_MODE = opts.mode;
  if (opts.disable === undefined) delete process.env.AP_DISABLE;
  else process.env.AP_DISABLE = opts.disable;
  delete process.env.AP_AUDIT_FILE;

  const { pi, handlers, tools, eventHandlers } = makeFakePi();
  agentProtocol(pi as any);

  restoreEnv(snap);
  return { handlers, tools, eventHandlers };
}

async function loadContractInto(
  handlers: Map<string, Handler[]>,
  cwd: string,
): Promise<void> {
  const startHandlers = handlers.get("session_start") ?? [];
  for (const h of startHandlers) {
    await h({ type: "session_start", reason: "startup" }, { cwd });
  }
}

async function callDispatch(
  tools: Map<string, any>,
  agent: string,
  params?: Record<string, unknown>,
): Promise<string> {
  const res = await tools.get("dispatch").execute("t1", { agent, params });
  return res.content[0].text as string;
}

async function callAudit(tools: Map<string, any>, n?: number): Promise<string> {
  const res = await tools.get("ap_audit").execute("t2", { n });
  return res.content[0].text as string;
}

async function callAgents(tools: Map<string, any>): Promise<string> {
  const res = await tools.get("ap_agents").execute("t3", {});
  return res.content[0].text as string;
}

async function fireToolCall(
  handlers: Map<string, Handler[]>,
  input: Record<string, unknown>,
): Promise<any> {
  const [h] = handlers.get("tool_call") ?? [];
  assert.ok(h, "expected a tool_call handler to be registered");
  return h({ type: "tool_call", toolCallId: "x", toolName: "subagent", input });
}

async function fireToolResult(
  handlers: Map<string, Handler[]>,
  input: Record<string, unknown>,
  isError: boolean,
): Promise<any> {
  const [h] = handlers.get("tool_result") ?? [];
  assert.ok(h, "expected a tool_result handler to be registered");
  return h({
    type: "tool_result",
    toolCallId: "x",
    toolName: "subagent",
    input,
    content: [],
    isError,
  });
}

// --- 1. Tools registered under default env --------------------------------

test("default env: dispatch, ap_audit, ap_agents tools are registered", () => {
  const { tools } = setupInstance();
  assert.ok(tools.has("dispatch"));
  assert.ok(tools.has("ap_audit"));
  assert.ok(tools.has("ap_agents"));
});

// --- 2. AP_DISABLE=1 -> true no-op -----------------------------------------

test("AP_DISABLE=1: no tools and no handlers are registered", () => {
  const { tools, handlers } = setupInstance({ disable: "1" });
  assert.equal(tools.size, 0);
  assert.equal(handlers.size, 0);
});

// --- 3. AP_MODE=off -> tools + session_start only, no interceptors --------

test("AP_MODE=off: tools and session_start registered, no tool_call/tool_result handlers", () => {
  const { tools, handlers } = setupInstance({ mode: "off" });
  assert.ok(tools.has("dispatch"));
  assert.ok(tools.has("ap_audit"));
  assert.ok(tools.has("ap_agents"));
  assert.ok((handlers.get("session_start") ?? []).length > 0);
  assert.equal((handlers.get("tool_call") ?? []).length, 0);
  assert.equal((handlers.get("tool_result") ?? []).length, 0);
});

// --- 4. session_start loads the fixture contract ---------------------------

test("session_start loads a contract that ap_agents then lists", async () => {
  const { handlers, tools } = setupInstance();
  const project = makeFixtureProject();
  try {
    await loadContractInto(handlers, project);
    const text = await callAgents(tools);
    assert.match(text, new RegExp(AGENT_NAME));
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

// --- 5. dispatch reject: missing required field -----------------------------

test("dispatch: missing required param is REJECTED and names the field", async () => {
  const { handlers, tools } = setupInstance();
  const project = makeFixtureProject();
  try {
    await loadContractInto(handlers, project);
    const text = await callDispatch(tools, AGENT_NAME, { files: ["a.ts"] }); // rubric missing
    assert.match(text, /REJECTED/);
    assert.match(text, /rubric/);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

// --- 6. dispatch: unknown agent ---------------------------------------------

test("dispatch: unknown agent reports no contract", async () => {
  const { tools } = setupInstance();
  const text = await callDispatch(tools, "totally-unregistered-agent", {});
  assert.match(text, /No contract/);
});

// --- 7. dispatch accept then subagent SINGLE rewrite ------------------------

test("dispatch accept + subagent single: outputSchema set, params appended to task, no chain", async () => {
  const { handlers, tools } = setupInstance();
  const project = makeFixtureProject();
  try {
    await loadContractInto(handlers, project);
    const params = { files: ["a.ts"], rubric: "strict" };
    const dispatchText = await callDispatch(tools, AGENT_NAME, params);
    assert.doesNotMatch(dispatchText, /REJECTED/);

    const input: Record<string, unknown> = {
      agent: AGENT_NAME,
      task: "Review",
    };
    const result = await fireToolCall(handlers, input);

    assert.equal(result, undefined);
    assert.deepEqual(input.outputSchema, CONTRACT.output_schema);
    assert.equal(input.agent, AGENT_NAME);
    assert.equal("chain" in input, false);
    assert.ok((input.task as string).startsWith("Review"));
    assert.ok((input.task as string).includes(JSON.stringify(params, null, 2)));
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

// --- 8. bypass block: contracted agent, no prior dispatch, AP_MODE=block ---

test("bypass block: contracted agent without dispatch is blocked, input unmutated", async () => {
  const { handlers } = setupInstance({ mode: "block" });
  const project = makeFixtureProject();
  try {
    await loadContractInto(handlers, project);

    const input: Record<string, unknown> = {
      agent: AGENT_NAME,
      task: "Review",
    };
    const result = await fireToolCall(handlers, input);

    assert.equal(result?.block, true);
    assert.match(result?.reason ?? "", /dispatch/);
    assert.equal("outputSchema" in input, false);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

// --- 9. bypass warn: contracted agent, no prior dispatch, AP_MODE=warn ----

test("bypass warn: contracted agent without dispatch passes through with outputSchema only", async () => {
  const { handlers } = setupInstance({ mode: "warn" });
  const project = makeFixtureProject();
  try {
    await loadContractInto(handlers, project);

    const input: Record<string, unknown> = {
      agent: AGENT_NAME,
      task: "Review",
    };
    const result = await fireToolCall(handlers, input);

    assert.equal(result, undefined);
    assert.deepEqual(input.outputSchema, CONTRACT.output_schema);
    assert.equal(input.task, "Review"); // unchanged: no params to append
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

// --- 10. non-contracted agent: pure passthrough -----------------------------

test("non-contracted agent: tool_call passes through untouched", async () => {
  const { handlers } = setupInstance();
  const input: Record<string, unknown> = {
    agent: "totally-unknown",
    task: "Do stuff",
  };
  const before = { ...input };

  const result = await fireToolCall(handlers, input);

  assert.equal(result, undefined);
  assert.deepEqual(input, before);
});

// --- 11. skip: management action / workflowScript / legacy shapes ----------

test("skip without mutation: action, workflowScript, and legacy tasks/chain/parallel inputs", async () => {
  const { handlers } = setupInstance();
  const project = makeFixtureProject();
  try {
    await loadContractInto(handlers, project);

    const managementInput: Record<string, unknown> = { action: "list" };
    const workflowInput: Record<string, unknown> = {
      agent: AGENT_NAME,
      workflowScript: "x",
    };
    const tasksInput: Record<string, unknown> = {
      agent: AGENT_NAME,
      tasks: [],
    };

    for (const input of [managementInput, workflowInput, tasksInput]) {
      const result = await fireToolCall(handlers, input);
      assert.equal(result, undefined);
      assert.equal("outputSchema" in input, false);
    }
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

// --- 12. tool_result: completed / failed audit records ---------------------

test("tool_result: completed and failed runs are audited for a contracted agent", async () => {
  const { handlers, tools } = setupInstance();
  const project = makeFixtureProject();
  try {
    await loadContractInto(handlers, project);

    await fireToolResult(handlers, { agent: AGENT_NAME }, false);
    const completedText = await callAudit(tools);
    assert.match(completedText, /completed/);

    await fireToolResult(handlers, { agent: AGENT_NAME }, true);
    const failedText = await callAudit(tools);
    assert.match(failedText, /failed/);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

// --- 13-16. tool_result self-revalidation via details.results[] ------------

async function fireToolResultDetails(
  handlers: Map<string, Handler[]>,
  results: Record<string, unknown>[],
): Promise<any> {
  const [h] = handlers.get("tool_result") ?? [];
  assert.ok(h, "expected a tool_result handler to be registered");
  return h({
    type: "tool_result",
    toolCallId: "x",
    toolName: "subagent",
    input: {},
    content: [],
    isError: false,
    details: { results },
  });
}

test("tool_result self-revalidation: valid structuredOutput -> completed + revalidation ok", async () => {
  const { handlers, tools } = setupInstance();
  const project = makeFixtureProject();
  try {
    await loadContractInto(handlers, project);
    await fireToolResultDetails(handlers, [
      { agent: AGENT_NAME, exitCode: 0, structuredOutput: { findings: [] } },
    ]);
    const text = await callAudit(tools);
    assert.match(text, /completed/);
    assert.match(text, /"revalidation":"ok"/);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test("tool_result self-revalidation: invalid structuredOutput -> completed with revalidation errors", async () => {
  const { handlers, tools } = setupInstance();
  const project = makeFixtureProject();
  try {
    await loadContractInto(handlers, project);
    // structuredOutput missing the required "findings" key
    await fireToolResultDetails(handlers, [
      { agent: AGENT_NAME, exitCode: 0, structuredOutput: { summary: "x" } },
    ]);
    const text = await callAudit(tools);
    assert.match(text, /completed/);
    assert.match(text, /findings/); // the missing-required error names the field
    assert.doesNotMatch(text, /"revalidation":"ok"/);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test("tool_result: detached async launch -> async-started, not completed", async () => {
  const { handlers, tools } = setupInstance();
  const project = makeFixtureProject();
  try {
    await loadContractInto(handlers, project);
    await fireToolResultDetails(handlers, [
      { agent: AGENT_NAME, detached: true },
    ]);
    const text = await callAudit(tools);
    assert.match(text, /async-started/);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test("tool_result: failed child (nonzero exitCode) -> failed", async () => {
  const { handlers, tools } = setupInstance();
  const project = makeFixtureProject();
  try {
    await loadContractInto(handlers, project);
    await fireToolResultDetails(handlers, [
      { agent: AGENT_NAME, exitCode: 1, error: "boom" },
    ]);
    const text = await callAudit(tools);
    assert.match(text, /failed/);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

// --- 17-20. async-completion revalidation via pi.events -------------------

async function fireAsyncComplete(
  eventHandlers: Map<string, Handler[]>,
  results: Record<string, unknown>[],
): Promise<any> {
  const [h] = eventHandlers.get("subagent:async-complete") ?? [];
  assert.ok(h, "expected a subagent:async-complete handler");
  return h({ results });
}

test("async-complete: valid structuredOutput -> completed + revalidation ok (via async-complete)", async () => {
  const { handlers, tools, eventHandlers } = setupInstance();
  const project = makeFixtureProject();
  try {
    await loadContractInto(handlers, project);
    await fireAsyncComplete(eventHandlers, [
      { agent: AGENT_NAME, exitCode: 0, structuredOutput: { findings: [] } },
    ]);
    const text = await callAudit(tools);
    assert.match(text, /completed/);
    assert.match(text, /"revalidation":"ok"/);
    assert.match(text, /"via":"async-complete"/);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test("async-complete: invalid structuredOutput -> revalidation errors", async () => {
  const { handlers, tools, eventHandlers } = setupInstance();
  const project = makeFixtureProject();
  try {
    await loadContractInto(handlers, project);
    await fireAsyncComplete(eventHandlers, [
      { agent: AGENT_NAME, exitCode: 0, structuredOutput: { summary: "x" } },
    ]);
    const text = await callAudit(tools);
    assert.match(text, /findings/);
    assert.doesNotMatch(text, /"revalidation":"ok"/);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test("async-complete: failed child -> failed", async () => {
  const { handlers, tools, eventHandlers } = setupInstance();
  const project = makeFixtureProject();
  try {
    await loadContractInto(handlers, project);
    await fireAsyncComplete(eventHandlers, [
      { agent: AGENT_NAME, exitCode: 1, error: "boom" },
    ]);
    const text = await callAudit(tools);
    assert.match(text, /failed/);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test("AP_MODE=off: no async-complete subscription", () => {
  const { eventHandlers } = setupInstance({ mode: "off" });
  assert.equal((eventHandlers.get("subagent:async-complete") ?? []).length, 0);
});

// --- 21-24. workflowScript-aware auditing ---------------------------------

const WF = (agent: string): string =>
  `return runs.run("main", { agent: "${agent}", task: "x" })`;

test("workflowScript: contracted agent without dispatch is audited as bypass (warn)", async () => {
  const { handlers, tools } = setupInstance();
  const project = makeFixtureProject();
  try {
    await loadContractInto(handlers, project);
    const input: Record<string, unknown> = { workflowScript: WF(AGENT_NAME) };
    const result = await fireToolCall(handlers, input);
    assert.equal(result, undefined);
    const text = await callAudit(tools);
    assert.match(text, /bypass/);
    assert.match(text, /"via":"workflowScript"/);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test("workflowScript: block mode blocks a contracted agent without dispatch", async () => {
  const { handlers } = setupInstance({ mode: "block" });
  const project = makeFixtureProject();
  try {
    await loadContractInto(handlers, project);
    const input: Record<string, unknown> = { workflowScript: WF(AGENT_NAME) };
    const result = await fireToolCall(handlers, input);
    assert.equal(result?.block, true);
    assert.match(result?.reason ?? "", new RegExp(AGENT_NAME));
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test("workflowScript: a prior dispatch is consumed and audited as dispatched", async () => {
  const { handlers, tools } = setupInstance();
  const project = makeFixtureProject();
  try {
    await loadContractInto(handlers, project);
    await callDispatch(tools, AGENT_NAME, { files: ["a.ts"], rubric: "r" });
    const input: Record<string, unknown> = { workflowScript: WF(AGENT_NAME) };
    const result = await fireToolCall(handlers, input);
    assert.equal(result, undefined);
    const text = await callAudit(tools);
    assert.match(text, /"via":"workflowScript"/);
    assert.match(text, /dispatched/);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test("workflowScript: no contracted agents -> pass through, no block", async () => {
  const { handlers } = setupInstance({ mode: "block" });
  const project = makeFixtureProject();
  try {
    await loadContractInto(handlers, project);
    const input: Record<string, unknown> = {
      workflowScript: WF("some-uncontracted-agent"),
    };
    const result = await fireToolCall(handlers, input);
    assert.equal(result, undefined);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

// --- 25-31. intercom path (experimental) ----------------------------------

async function fireIntercomCall(
  handlers: Map<string, Handler[]>,
  input: Record<string, unknown>,
): Promise<any> {
  const [h] = handlers.get("tool_call") ?? [];
  assert.ok(h, "expected a tool_call handler");
  return h({ type: "tool_call", toolCallId: "x", toolName: "intercom", input });
}

async function fireIntercomResult(
  handlers: Map<string, Handler[]>,
  input: Record<string, unknown>,
  content: Array<{ type: string; text?: string }>,
): Promise<any> {
  const [h] = handlers.get("tool_result") ?? [];
  assert.ok(h, "expected a tool_result handler");
  return h({
    type: "tool_result",
    toolCallId: "x",
    toolName: "intercom",
    input,
    content,
    isError: false,
  });
}

const paramsAttachment = (params: Record<string, unknown>) => [
  { type: "context", name: "params", content: JSON.stringify(params) },
];

test("intercom send: valid params to a contracted peer -> intercom-dispatched", async () => {
  const { handlers, tools } = setupInstance();
  const project = makeFixtureProject();
  try {
    await loadContractInto(handlers, project);
    const result = await fireIntercomCall(handlers, {
      action: "send",
      to: AGENT_NAME,
      message: "hi",
      attachments: paramsAttachment({ files: [], rubric: "r" }),
    });
    assert.equal(result, undefined);
    assert.match(await callAudit(tools), /intercom-dispatched/);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test("intercom ask: missing params to a contracted peer -> rejected (warn, no block)", async () => {
  const { handlers, tools } = setupInstance();
  const project = makeFixtureProject();
  try {
    await loadContractInto(handlers, project);
    const result = await fireIntercomCall(handlers, {
      action: "ask",
      to: AGENT_NAME,
      message: "hi",
    });
    assert.equal(result, undefined);
    assert.match(await callAudit(tools), /intercom-rejected/);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test("intercom send: block mode blocks invalid outbound to a contracted peer", async () => {
  const { handlers } = setupInstance({ mode: "block" });
  const project = makeFixtureProject();
  try {
    await loadContractInto(handlers, project);
    const result = await fireIntercomCall(handlers, {
      action: "send",
      to: AGENT_NAME,
      message: "hi",
    });
    assert.equal(result?.block, true);
    assert.match(result?.reason ?? "", /params/);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test("intercom: uncontracted peer passes through", async () => {
  const { handlers } = setupInstance({ mode: "block" });
  const project = makeFixtureProject();
  try {
    await loadContractInto(handlers, project);
    const result = await fireIntercomCall(handlers, {
      action: "send",
      to: "some-random-peer",
      message: "hi",
    });
    assert.equal(result, undefined);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test("intercom: non-send/ask actions are not gated", async () => {
  const { handlers } = setupInstance({ mode: "block" });
  const project = makeFixtureProject();
  try {
    await loadContractInto(handlers, project);
    for (const action of ["list", "reply", "status", "pending"]) {
      const result = await fireIntercomCall(handlers, {
        action,
        to: AGENT_NAME,
      });
      assert.equal(result, undefined);
    }
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test("intercom ask reply: valid JSON is annotated + audited (intercom-reply)", async () => {
  const { handlers, tools } = setupInstance();
  const project = makeFixtureProject();
  try {
    await loadContractInto(handlers, project);
    const content = [
      {
        type: "text",
        text: '**Reply from X:**\n```json\n{"findings":[]}\n```',
      },
    ];
    const result = await fireIntercomResult(
      handlers,
      { action: "ask", to: AGENT_NAME },
      content,
    );
    const joined = (result?.content ?? [])
      .map((c: { text?: string }) => c.text ?? "")
      .join("");
    assert.match(joined, /satisfies output_schema/);
    assert.match(await callAudit(tools), /intercom-reply/);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test("intercom ask reply: invalid JSON is annotated as non-conforming", async () => {
  const { handlers } = setupInstance();
  const project = makeFixtureProject();
  try {
    await loadContractInto(handlers, project);
    const content = [
      { type: "text", text: '**Reply:**\n{"summary":"no findings"}' },
    ];
    const result = await fireIntercomResult(
      handlers,
      { action: "ask", to: AGENT_NAME },
      content,
    );
    const joined = (result?.content ?? [])
      .map((c: { text?: string }) => c.text ?? "")
      .join("");
    assert.match(joined, /does NOT satisfy/);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});
