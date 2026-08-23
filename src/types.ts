// Shared types for pi-agent-protocol.
//
// Pure type declarations plus the cross-module function-signature contracts.
// Implementations live in their own modules; this file is the single source of
// truth for the shapes those modules exchange. Keep it dependency-free.

/** Enforcement mode, read from AP_MODE (default "warn"). */
export type Mode = "warn" | "block" | "off";

/** JSON-Schema primitive type names we understand (the validated subset). */
export type JsonType =
 | "string"
 | "number"
 | "integer"
 | "boolean"
 | "array"
 | "object"
 | "null";

/**
 * The small JSON-Schema subset a contract uses. Flat and shallow: only
 * `required` plus top-level `properties[field].type` (a single type or a union
 * array like ["string","null"]). Everything else (nested objects, array items,
 * enum, minimum/maximum, format, ...) is ignored by the validator.
 */
export interface SchemaSubset {
 required?: string[];
 properties?: Record<
  string,
  { type?: JsonType | JsonType[] | string | string[] }
 >;
 [key: string]: unknown;
}

/** A parsed `<agent>.contract.json` sidecar. */
export interface Contract {
 agent_name: string;
 input_schema?: SchemaSubset;
 output_schema?: SchemaSubset;
 /** Behavioral rules the schema cannot express (pi-agent-protocol extension), preserved as-is. */
 policy?: Record<string, unknown>;
 [key: string]: unknown;
}

/** agentName -> contract. */
export type ContractRegistry = Map<string, Contract>;

/** Result of validate(): ok, or a field -> message error map. */
export type ValidationResult =
 | { ok: true }
 | { ok: false; errors: Record<string, string> };

/** A validated dispatch waiting to be consumed by the matching subagent call. */
export interface PendingDispatch {
 agent: string;
 params: Record<string, unknown>;
 outputSchema?: SchemaSubset;
 /** epoch ms when created (for TTL / last-wins policy). */
 ts: number;
 /** correlation id linking gate -> run -> completion for this flow. */
 cid?: string;
}

/** Outcome of prepareDispatch(). */
export type DispatchResult =
 | { status: "no_such_agent"; available: string[] }
 | { status: "rejected"; errors: Record<string, string> }
 | { status: "ok"; pending: PendingDispatch };

/** Audit event kinds across both call paths. */
export type AuditKind =
 | "dispatched"
 | "rejected"
 | "no_such_agent"
 | "bypass"
 | "completed"
 | "failed"
 | "intercom-dispatched"
 | "intercom-rejected"
 | "intercom-reply";

/** Which surface an event came from. */
export type CallPath = "subagent" | "intercom";

/** One audit record. */
export interface AuditEvent {
 ts: number;
 kind: AuditKind;
 agent?: string;
 path: CallPath;
 mode: Mode;
 /** correlation id linking the events of one dispatch -> run -> completion flow. */
 cid?: string;
 detail?: unknown;
}

// --- Cross-module function-signature contracts (implemented elsewhere) ---
//
// validator.ts:
//   export function validate(schema: SchemaSubset | undefined, data: unknown): ValidationResult
//
// dispatch-core.ts:
//   export function prepareDispatch(
//     registry: ContractRegistry,
//     agent: string,
//     params: Record<string, unknown>,
//   ): DispatchResult
