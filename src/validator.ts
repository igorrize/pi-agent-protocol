// JSON-Schema subset validator (pure). See DESIGN.md "Validator subset".

import type { JsonType, SchemaSubset, ValidationResult } from "./types.js";

const KNOWN_TYPES = new Set<string>([
  "string",
  "number",
  "integer",
  "boolean",
  "array",
  "object",
  "null",
]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOwn(obj: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function matchesKnownType(type: JsonType, value: unknown): boolean {
  switch (type) {
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "boolean":
      return typeof value === "boolean";
    case "array":
      return Array.isArray(value);
    case "object":
      return isPlainObject(value);
    case "null":
      return value === null;
    default:
      return false;
  }
}

function typeListOf(type: string | string[]): string[] {
  return Array.isArray(type) ? type : [type];
}

/**
 * A value satisfies a (possibly union) declared type if it matches any listed
 * type. An unrecognized type name always satisfies (fail-open), whether it
 * appears alone or as one member of a union.
 */
function satisfiesType(type: string | string[], value: unknown): boolean {
  for (const t of typeListOf(type)) {
    if (!KNOWN_TYPES.has(t)) {
      return true;
    }
    if (matchesKnownType(t as JsonType, value)) {
      return true;
    }
  }
  return false;
}

export function validate(schema: SchemaSubset | undefined, data: unknown): ValidationResult {
  if (!schema) {
    return { ok: true };
  }

  const errors: Record<string, string> = {};
  const required = schema.required ?? [];
  const properties = schema.properties ?? {};

  if (isPlainObject(data)) {
    for (const key of required) {
      if (!hasOwn(data, key)) {
        errors[key] = "missing required key";
      }
    }

    for (const [field, fieldSchema] of Object.entries(properties)) {
      if (!hasOwn(data, field)) {
        continue;
      }
      const type = fieldSchema.type;
      if (type === undefined) {
        continue;
      }
      if (!satisfiesType(type, data[field])) {
        errors[field] = `expected ${typeListOf(type).join("|")}`;
      }
    }
  } else {
    for (const key of required) {
      errors[key] = "missing required key";
    }
  }

  return Object.keys(errors).length > 0 ? { ok: false, errors } : { ok: true };
}
