// dispatch-core.ts
//
// Pure validation gate for the subagent dispatch path (DESIGN.md, "Flow —
// subagent path", step 1). Looks up the target agent's contract, validates
// the caller-supplied params against its input_schema, and either rejects
// (unknown agent / failed validation) or returns a PendingDispatch to be
// consumed by the subsequent `subagent` tool-call rewrite.
//
// No I/O, no console — callers (index.ts) own audit logging and side effects.

import type { ContractRegistry, DispatchResult } from './types.js';
import { validate } from './validator.js';

export function prepareDispatch(
  registry: ContractRegistry,
  agent: string,
  params: Record<string, unknown>,
): DispatchResult {
  const contract = registry.get(agent);
  if (!contract) {
    return { status: 'no_such_agent', available: [...registry.keys()].sort() };
  }

  const result = validate(contract.input_schema, params);
  if (!result.ok) {
    return { status: 'rejected', errors: result.errors };
  }

  return {
    status: 'ok',
    pending: {
      agent,
      params,
      outputSchema: contract.output_schema,
      ts: Date.now(),
    },
  };
}
