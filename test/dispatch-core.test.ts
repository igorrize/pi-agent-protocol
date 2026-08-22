import test from 'node:test';
import assert from 'node:assert/strict';

import { prepareDispatch } from '../src/dispatch-core.js';
import type { Contract, ContractRegistry } from '../src/types.js';

const cljReviewer: Contract = {
  agent_name: 'clj-reviewer',
  input_schema: {
    required: ['files', 'rubric'],
    properties: {
      files: { type: 'array' },
      rubric: { type: 'string' },
      focus: { type: 'string' },
    },
  },
  output_schema: {
    required: ['findings'],
    properties: {
      findings: { type: 'array' },
      summary: { type: 'string' },
    },
  },
};

function makeRegistry(): ContractRegistry {
  // Insertion order deliberately unsorted so the `available` sort below is
  // actually exercised (not accidentally already-sorted by Map iteration).
  return new Map<string, Contract>([
    ['zeta-agent', { agent_name: 'zeta-agent' }],
    ['clj-reviewer', cljReviewer],
    ['alpha-agent', { agent_name: 'alpha-agent' }],
  ]);
}

test('unknown agent -> no_such_agent with a sorted available list', () => {
  const registry = makeRegistry();
  const result = prepareDispatch(registry, 'ghost-agent', {});

  if (result.status !== 'no_such_agent') {
    assert.fail(`expected status "no_such_agent", got "${result.status}"`);
  }
  assert.deepEqual(result.available, ['alpha-agent', 'clj-reviewer', 'zeta-agent']);
});

test('missing required param -> rejected with the field error', () => {
  const registry = makeRegistry();
  // `rubric` is required by cljReviewer.input_schema but omitted here.
  const result = prepareDispatch(registry, 'clj-reviewer', { files: ['a.go'] });

  if (result.status !== 'rejected') {
    assert.fail(`expected status "rejected", got "${result.status}"`);
  }
  assert.ok('rubric' in result.errors, 'expected an error entry for the missing "rubric" field');
  assert.equal(typeof result.errors.rubric, 'string');
});

test('valid params -> ok, with pending carrying params, output_schema, and a numeric ts', () => {
  const registry = makeRegistry();
  const params = { files: ['a.go'], rubric: 'strict' };

  const before = Date.now();
  const result = prepareDispatch(registry, 'clj-reviewer', params);
  const after = Date.now();

  if (result.status !== 'ok') {
    assert.fail(`expected status "ok", got "${result.status}"`);
  }
  assert.equal(result.pending.agent, 'clj-reviewer');
  assert.deepEqual(result.pending.params, params);
  assert.deepEqual(result.pending.outputSchema, cljReviewer.output_schema);
  assert.equal(typeof result.pending.ts, 'number');
  assert.ok(
    result.pending.ts >= before && result.pending.ts <= after,
    'ts should be a Date.now() snapshot taken during the call',
  );
});

test('no input_schema on the contract -> params pass through unvalidated', () => {
  const registry = makeRegistry();
  const result = prepareDispatch(registry, 'zeta-agent', { anything: 'goes' });

  if (result.status !== 'ok') {
    assert.fail(`expected status "ok", got "${result.status}"`);
  }
  assert.deepEqual(result.pending.params, { anything: 'goes' });
  assert.equal(result.pending.outputSchema, undefined);
});
