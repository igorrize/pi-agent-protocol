import test from "node:test";
import assert from "node:assert/strict";
import type { PendingDispatch } from "../src/types.js";
import {
  appendParams,
  enumerateTargets,
  rewriteSingle,
  applyToItems,
} from "../src/subagent-rewrite.js";

// --- appendParams ---

test("appendParams: appends a fenced json PARAMS block after the task text", () => {
  const params = { files: ["schema.go"], rubric: "strict" };
  const result = appendParams("Review schema.go", params);
  const expected =
    "Review schema.go\n\nPARAMS:\n```json\n" +
    JSON.stringify(params, null, 2) +
    "\n```";
  assert.equal(result, expected);
});

test("appendParams: works with an empty task", () => {
  const result = appendParams("", { a: 1 });
  assert.ok(result.startsWith("\n\nPARAMS:\n```json\n"));
  assert.ok(result.includes(JSON.stringify({ a: 1 }, null, 2)));
  assert.ok(result.endsWith("\n```"));
});

// --- enumerateTargets ---

test("enumerateTargets: SINGLE {agent,task} returns [agent]", () => {
  const targets = enumerateTargets({
    agent: "clj-reviewer",
    task: "Review schema.go",
  });
  assert.deepEqual(targets, ["clj-reviewer"]);
});

test("enumerateTargets: PARALLEL {tasks:[]} returns each item's agent, de-duped, in order", () => {
  const targets = enumerateTargets({
    tasks: [
      { agent: "a", task: "t1" },
      { agent: "b", task: "t2" },
      { agent: "a", task: "t3" },
    ],
  });
  assert.deepEqual(targets, ["a", "b"]);
});

test("enumerateTargets: CHAIN {chain:[]} incl. nested parallel[] returns all agents, de-duped, in order", () => {
  const targets = enumerateTargets({
    chain: [
      { agent: "a", task: "t" },
      {
        agent: "b",
        task: "t2",
        parallel: [
          { agent: "c", task: "t3" },
          { agent: "a", task: "t4" },
        ],
      },
    ],
  });
  assert.deepEqual(targets, ["a", "b", "c"]);
});

test("enumerateTargets: a management action returns []", () => {
  assert.deepEqual(enumerateTargets({ action: "list" }), []);
  assert.deepEqual(
    enumerateTargets({ action: "status", agent: "some-run-id" }),
    [],
  );
  assert.deepEqual(enumerateTargets({ action: "doctor" }), []);
});

test("enumerateTargets: non-string / missing agents are ignored", () => {
  assert.deepEqual(enumerateTargets({}), []);
  assert.deepEqual(enumerateTargets({ agent: 42 }), []);
  assert.deepEqual(
    enumerateTargets({ tasks: [{ task: "no agent" }, { agent: "x" }] }),
    ["x"],
  );
});

// --- rewriteSingle ---

test("rewriteSingle: appends params to task and sets top-level outputSchema, preserving agent/task", () => {
  const input: Record<string, any> = {
    agent: "clj-reviewer",
    task: "Review schema.go",
    model: "gpt-5",
  };
  const pending: PendingDispatch = {
    agent: "clj-reviewer",
    params: { files: ["schema.go"], rubric: "strict" },
    outputSchema: {
      required: ["findings"],
      properties: { findings: { type: "array" }, summary: { type: "string" } },
    },
    ts: 1000,
  };

  rewriteSingle(input, pending);

  // pi-subagents 0.54: outputSchema goes on the top-level single-child call; no chain.
  assert.equal("chain" in input, false);
  assert.equal(input.agent, "clj-reviewer");
  assert.ok(input.task.startsWith("Review schema.go\n\nPARAMS:\n```json\n"));
  assert.ok(input.task.includes(JSON.stringify(pending.params, null, 2)));
  assert.deepEqual(input.outputSchema, pending.outputSchema);
  // Unrelated top-level fields are preserved untouched.
  assert.equal(input.model, "gpt-5");
});

test("rewriteSingle: omits outputSchema when pending has none", () => {
  const input: Record<string, any> = { agent: "a", task: "do it" };
  const pending: PendingDispatch = { agent: "a", params: { x: 1 }, ts: 1 };

  rewriteSingle(input, pending);

  assert.equal("outputSchema" in input, false);
  assert.ok(input.task.includes(JSON.stringify({ x: 1 }, null, 2)));
});

test("rewriteSingle: treats a missing task as an empty string", () => {
  const input: Record<string, any> = { agent: "a" };
  const pending: PendingDispatch = { agent: "a", params: { x: 1 }, ts: 1 };

  rewriteSingle(input, pending);

  assert.ok(input.task.startsWith("\n\nPARAMS:\n```json\n"));
});

// --- applyToItems ---

test("applyToItems: patches resolved items in tasks[] and chain[] (incl. nested parallel[]), leaves unresolved items untouched", () => {
  const pendingA: PendingDispatch = {
    agent: "a",
    params: { x: 1 },
    outputSchema: { required: ["x"] },
    ts: 1,
  };
  const pendingC: PendingDispatch = { agent: "c", params: { y: 2 }, ts: 2 };
  const pendingE: PendingDispatch = {
    agent: "e",
    params: { z: 3 },
    outputSchema: { required: ["z"], properties: { z: { type: "number" } } },
    ts: 3,
  };

  const pendingByAgent: Record<string, PendingDispatch | undefined> = {
    a: pendingA,
    c: pendingC,
    e: pendingE,
  };
  const resolve = (agent: string): PendingDispatch | undefined =>
    pendingByAgent[agent];

  const input: Record<string, any> = {
    tasks: [
      { agent: "a", task: "do A" },
      { agent: "b", task: "do B" },
    ],
    chain: [
      { agent: "c", task: "do C" },
      {
        agent: "d",
        task: "do D",
        parallel: [{ agent: "e", task: "do E" }],
      },
    ],
  };

  applyToItems(input, resolve);

  // tasks[0] (agent "a") resolves: params appended, outputSchema set.
  assert.equal(input.tasks[0].task, appendParams("do A", { x: 1 }));
  assert.deepEqual(input.tasks[0].outputSchema, pendingA.outputSchema);

  // tasks[1] (agent "b") does not resolve: untouched.
  assert.equal(input.tasks[1].task, "do B");
  assert.equal("outputSchema" in input.tasks[1], false);

  // chain[0] (agent "c") resolves, pending has no outputSchema: task
  // appended, no outputSchema key added.
  assert.equal(input.chain[0].task, appendParams("do C", { y: 2 }));
  assert.equal("outputSchema" in input.chain[0], false);

  // chain[1] (agent "d") does not resolve: untouched itself...
  assert.equal(input.chain[1].task, "do D");
  assert.equal("outputSchema" in input.chain[1], false);

  // ...but its nested parallel[0] (agent "e") resolves.
  const nested = input.chain[1].parallel[0];
  assert.equal(nested.task, appendParams("do E", { z: 3 }));
  assert.deepEqual(nested.outputSchema, pendingE.outputSchema);
});

test("applyToItems: no-op when nothing resolves", () => {
  const input: Record<string, any> = {
    tasks: [{ agent: "z", task: "unchanged" }],
  };
  applyToItems(input, () => undefined);
  assert.equal(input.tasks[0].task, "unchanged");
  assert.equal("outputSchema" in input.tasks[0], false);
});
