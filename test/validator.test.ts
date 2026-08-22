import { test } from "node:test";
import assert from "node:assert/strict";
import { validate } from "../src/validator.js";
import type { SchemaSubset } from "../src/types.js";

test("happy path: all required present, declared types ok", () => {
  const schema: SchemaSubset = {
    required: ["name", "age"],
    properties: {
      name: { type: "string" },
      age: { type: "integer" },
    },
  };
  assert.deepEqual(validate(schema, { name: "Alice", age: 30 }), { ok: true });
});

test("missing required key is reported", () => {
  const schema: SchemaSubset = {
    required: ["name", "age"],
    properties: {
      name: { type: "string" },
      age: { type: "integer" },
    },
  };
  assert.deepEqual(validate(schema, { name: "Alice" }), {
    ok: false,
    errors: { age: "missing required key" },
  });
});

test("type mismatch on a present field is reported", () => {
  const schema: SchemaSubset = {
    properties: { age: { type: "integer" } },
  };
  assert.deepEqual(validate(schema, { age: "thirty" }), {
    ok: false,
    errors: { age: "expected integer" },
  });
});

test("union type ['string','null'] accepts either member", () => {
  const schema: SchemaSubset = {
    properties: { nickname: { type: ["string", "null"] } },
  };
  assert.deepEqual(validate(schema, { nickname: "Bob" }), { ok: true });
  assert.deepEqual(validate(schema, { nickname: null }), { ok: true });
  assert.deepEqual(validate(schema, { nickname: 42 }), {
    ok: false,
    errors: { nickname: "expected string|null" },
  });
});

test("integer accepts a whole float (1.0) but rejects 1.5", () => {
  const schema: SchemaSubset = {
    properties: { count: { type: "integer" } },
  };
  assert.deepEqual(validate(schema, { count: 1.0 }), { ok: true });
  assert.deepEqual(validate(schema, { count: 1.5 }), {
    ok: false,
    errors: { count: "expected integer" },
  });
});

test("unrecognized type name fails open (always passes)", () => {
  const schema: SchemaSubset = {
    properties: { weird: { type: "frobnicate" } },
  };
  assert.deepEqual(validate(schema, { weird: 12345 }), { ok: true });
  assert.deepEqual(validate(schema, { weird: "anything" }), { ok: true });
  assert.deepEqual(validate(schema, { weird: null }), { ok: true });
});

test("extra/undeclared fields are ignored", () => {
  const schema: SchemaSubset = {
    required: ["name"],
    properties: { name: { type: "string" } },
  };
  assert.deepEqual(validate(schema, { name: "Alice", extra: 12345, nested: { a: 1 } }), {
    ok: true,
  });
});

test("non-object data treats every required key as missing", () => {
  const schema: SchemaSubset = { required: ["name"] };
  const nonObjects: unknown[] = [null, undefined, "a string", 42, true, [1, 2, 3]];

  for (const data of nonObjects) {
    assert.deepEqual(validate(schema, data), {
      ok: false,
      errors: { name: "missing required key" },
    });
  }
});

test("undefined schema always passes", () => {
  assert.deepEqual(validate(undefined, { anything: 1 }), { ok: true });
  assert.deepEqual(validate(undefined, null), { ok: true });
  assert.deepEqual(validate(undefined, "not an object"), { ok: true });
});

test("schema with no required and no properties always passes", () => {
  assert.deepEqual(validate({}, { anything: 1 }), { ok: true });
  assert.deepEqual(validate({}, null), { ok: true });
});

test("all errors are collected together, not just the first", () => {
  const schema: SchemaSubset = {
    required: ["name", "age"],
    properties: {
      name: { type: "string" },
      age: { type: "integer" },
    },
  };
  assert.deepEqual(validate(schema, { age: "not a number" }), {
    ok: false,
    errors: {
      name: "missing required key",
      age: "expected integer",
    },
  });
});
