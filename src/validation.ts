// src/validation.ts
// JSON schema validation using Ajv

import Ajv from "ajv";

const ajv = new Ajv({ allErrors: true, strict: false });
const VALIDATOR_CACHE = new WeakMap<object, any>();

export function validateToolArgs(schema: any | undefined, args: any, context: string): void {
  if (!schema || typeof schema !== 'object') return; // nothing to validate

  let validate = VALIDATOR_CACHE.get(schema);
  if (!validate) {
    validate = ajv.compile(schema as any);
    VALIDATOR_CACHE.set(schema, validate);
  }

  const ok = validate(args);
  if (!ok) {
    const msg = (validate.errors || [])
      .map((e: any) => `${e.instancePath || e.schemaPath}: ${e.message}`)
      .join('; ');
    throw new Error(`${context} arguments failed schema validation: ${msg}`);
  }
}

// Test helper (keep the __internal_ prefix for backwards compatibility)
export function __internal_validateToolArgs(schema: any, args: any) {
  validateToolArgs(schema, args, 'test');
}
