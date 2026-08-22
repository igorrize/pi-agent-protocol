import test from "node:test";
import assert from "node:assert/strict";
import type { Contract, ContractRegistry } from "../src/types.js";
import {
  resolvePeerContract,
  extractParams,
  validateOutbound,
  extractReplyJson,
  softParseReply,
} from "../src/intercom-gate.js";

const CONTRACT: Contract = {
  agent_name: "clj-reviewer",
  input_schema: {
    required: ["files", "rubric"],
    properties: { files: { type: "array" }, rubric: { type: "string" } },
  },
  output_schema: {
    required: ["findings"],
    properties: { findings: { type: "array" } },
  },
};

function registryOf(...contracts: Contract[]): ContractRegistry {
  const m: ContractRegistry = new Map();
  for (const c of contracts) m.set(c.agent_name, c);
  return m;
}

// --- resolvePeerContract ---

test("resolvePeerContract: case-insensitive agent_name match", () => {
  const reg = registryOf(CONTRACT);
  assert.equal(resolvePeerContract(reg, "clj-reviewer"), CONTRACT);
  assert.equal(resolvePeerContract(reg, "CLJ-Reviewer"), CONTRACT);
});

test("resolvePeerContract: no match / non-string / empty", () => {
  const reg = registryOf(CONTRACT);
  assert.equal(resolvePeerContract(reg, "other"), undefined);
  assert.equal(resolvePeerContract(reg, 42), undefined);
  assert.equal(resolvePeerContract(reg, ""), undefined);
  assert.equal(resolvePeerContract(new Map(), "clj-reviewer"), undefined);
});

// --- extractParams ---

test("extractParams: reads a context attachment named params", () => {
  const params = { files: ["a.ts"], rubric: "strict" };
  const atts = [
    { type: "context", name: "params", content: JSON.stringify(params) },
  ];
  assert.deepEqual(extractParams(atts), params);
});

test("extractParams: missing / wrong / malformed -> undefined", () => {
  assert.equal(extractParams(undefined), undefined);
  assert.equal(extractParams([]), undefined);
  assert.equal(
    extractParams([{ type: "file", name: "params", content: "{}" }]),
    undefined,
  );
  assert.equal(
    extractParams([{ type: "context", name: "other", content: "{}" }]),
    undefined,
  );
  assert.equal(
    extractParams([{ type: "context", name: "params", content: "{bad json" }]),
    undefined,
  );
  assert.equal(
    extractParams([{ type: "context", name: "params", content: "[1,2]" }]),
    undefined,
  );
});

// --- validateOutbound ---

test("validateOutbound: valid params ok, missing required -> errors", () => {
  assert.deepEqual(validateOutbound(CONTRACT, { files: [], rubric: "r" }), {
    ok: true,
  });
  const res = validateOutbound(CONTRACT, { files: [] });
  assert.equal(res.ok, false);
  if (!res.ok) assert.ok("rubric" in res.errors);
});

test("validateOutbound: no input_schema -> ok", () => {
  assert.deepEqual(validateOutbound({ agent_name: "x" }, undefined), {
    ok: true,
  });
});

// --- extractReplyJson ---

test("extractReplyJson: fenced json block", () => {
  const reply = '**Reply from X:**\nHere:\n```json\n{"findings":[]}\n```\ndone';
  assert.deepEqual(extractReplyJson(reply), { findings: [] });
});

test("extractReplyJson: bare object", () => {
  assert.deepEqual(extractReplyJson('prefix {"a":1} suffix'), { a: 1 });
});

test("extractReplyJson: none / malformed -> undefined", () => {
  assert.equal(extractReplyJson("no json here"), undefined);
  assert.equal(extractReplyJson("{not: valid}"), undefined);
});

// --- softParseReply ---

test("softParseReply: no contract or no output_schema -> {}", () => {
  assert.deepEqual(softParseReply("{}", undefined), {});
  assert.deepEqual(softParseReply("{}", { agent_name: "x" }), {});
});

test("softParseReply: valid reply -> parsed + ok", () => {
  const r = softParseReply('```json\n{"findings":[]}\n```', CONTRACT);
  assert.deepEqual(r.parsed, { findings: [] });
  assert.deepEqual(r.result, { ok: true });
});

test("softParseReply: invalid reply (missing required) -> result errors", () => {
  const r = softParseReply('{"summary":"x"}', CONTRACT);
  assert.equal(r.result?.ok, false);
});

test("softParseReply: no json in reply -> result error", () => {
  const r = softParseReply("just prose, no object", CONTRACT);
  assert.equal(r.result?.ok, false);
});
