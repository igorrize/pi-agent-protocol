// intercom-gate.ts — Phase 3 (experimental): the intercom call path.
//
// See DESIGN.md "Flow — intercom path" and CONCERNS C2. The intercom path can
// only govern the OUTBOUND call cleanly; a neighbor's reply is async / free
// text, so response validation is best-effort (soft parse), and the plugin
// must be installed globally so both sessions run it.
//
// Convention (experimental): a peer is "contracted" when the intercom `to`
// target matches a contract's agent_name (case-insensitive). The outbound
// params payload travels as a `context` attachment named "params" (JSON body).
// Responder-side `reply` validation is deferred: a session has no well-defined
// mapping to "its own" contract.
//
// Pure module: no I/O, no pi API — index.ts owns wiring, audit, and blocking.

import type { Contract, ContractRegistry, ValidationResult } from "./types.js";
import { validate } from "./validator.js";

interface IntercomAttachment {
    type?: string;
    name?: string;
    content?: string;
}

/** Resolve an intercom `to` target to a contract by case-insensitive agent_name. */
export function resolvePeerContract(
    registry: ContractRegistry,
    to: unknown,
): Contract | undefined {
    if (typeof to !== "string" || to.length === 0) return undefined;
    const lower = to.toLowerCase();
    for (const contract of registry.values()) {
        if (contract.agent_name.toLowerCase() === lower) return contract;
    }
    return undefined;
}

/** Extract the JSON params payload from a `context` attachment named "params". */
export function extractParams(
    attachments: unknown,
): Record<string, unknown> | undefined {
    if (!Array.isArray(attachments)) return undefined;
    for (const raw of attachments as IntercomAttachment[]) {
        if (
            raw &&
            raw.type === "context" &&
            raw.name === "params" &&
            typeof raw.content === "string"
        ) {
            try {
                const parsed: unknown = JSON.parse(raw.content);
                if (
                    parsed &&
                    typeof parsed === "object" &&
                    !Array.isArray(parsed)
                ) {
                    return parsed as Record<string, unknown>;
                }
            } catch {
                return undefined;
            }
            return undefined;
        }
    }
    return undefined;
}

/** Validate an outbound intercom payload against the peer's input_schema. */
export function validateOutbound(
    contract: Contract,
    params: Record<string, unknown> | undefined,
): ValidationResult {
    return validate(contract.input_schema, params ?? {});
}

/** Best-effort JSON extraction from a free-text intercom reply. */
export function extractReplyJson(
    replyText: string,
): Record<string, unknown> | undefined {
    if (typeof replyText !== "string") return undefined;
    const candidates: string[] = [];
    const fenced = replyText.match(/```json\s*([\s\S]*?)```/i);
    if (fenced && fenced[1]) candidates.push(fenced[1]);
    const brace = replyText.match(/\{[\s\S]*\}/);
    if (brace) candidates.push(brace[0]);
    for (const candidate of candidates) {
        try {
            const parsed: unknown = JSON.parse(candidate.trim());
            if (
                parsed &&
                typeof parsed === "object" &&
                !Array.isArray(parsed)
            ) {
                return parsed as Record<string, unknown>;
            }
        } catch {
            // try the next candidate
        }
    }
    return undefined;
}

/**
 * Soft-parse a free-text `ask` reply and validate it against the peer's
 * output_schema. Never throws; returns {} when there is nothing to check.
 */
export function softParseReply(
    replyText: string,
    contract: Contract | undefined,
): { parsed?: Record<string, unknown>; result?: ValidationResult } {
    if (!contract || !contract.output_schema) return {};
    const parsed = extractReplyJson(replyText);
    if (parsed === undefined) {
        return {
            result: {
                ok: false,
                errors: { _: "no JSON object found in reply" },
            },
        };
    }
    return { parsed, result: validate(contract.output_schema, parsed) };
}
