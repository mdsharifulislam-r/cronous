import { createHash } from 'node:crypto';
import Ajv2020, { ErrorObject, ValidateFunction } from 'ajv/dist/2020';
import addFormats from 'ajv-formats';

export interface PayloadIssue {
  /** JSON pointer into the payload, e.g. "/to" ("" for the root). */
  path: string;
  message: string;
}

/**
 * Validates payloads against per-job JSON Schemas (draft 2020-12). Compiled validators
 * are cached by schema content, so repeated submissions cost one hash and one call.
 * Remote references are disabled: schemas must be self-contained.
 */
export class PayloadSchemaValidator {
  private readonly ajv = new Ajv2020({ allErrors: true, strict: false, loadSchema: undefined, validateSchema: true });
  private readonly cache = new Map<string, ValidateFunction>();

  constructor(private readonly maxCached = 1_000) {
    addFormats(this.ajv);
  }

  /** Returns an error message when the schema itself is invalid, otherwise null. */
  checkSchema(schema: unknown): string | null {
    if (typeof schema !== 'object' || schema === null || Array.isArray(schema)) return 'payloadSchema must be a JSON object';
    try {
      this.compile(schema as Record<string, unknown>);
      return null;
    } catch (error) {
      return `invalid payloadSchema: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  /** Validates `payload` (undefined is validated as null). Returns [] when valid. */
  validate(schema: Record<string, unknown>, payload: unknown): PayloadIssue[] {
    const validate = this.compile(schema);
    if (validate(payload === undefined ? null : payload)) return [];
    return (validate.errors ?? []).slice(0, 20).map(toIssue);
  }

  private compile(schema: Record<string, unknown>): ValidateFunction {
    const key = createHash('sha256').update(JSON.stringify(schema)).digest('hex');
    const cached = this.cache.get(key);
    if (cached) return cached;
    // $id would register the schema globally in Ajv and collide on recompilation.
    const { $id: _ignored, ...withoutId } = schema;
    const validate = this.ajv.compile(withoutId);
    if (this.cache.size >= this.maxCached) this.cache.delete(this.cache.keys().next().value!);
    this.cache.set(key, validate);
    return validate;
  }
}

function toIssue(error: ErrorObject): PayloadIssue {
  const extra =
    error.keyword === 'required'
      ? ` (${(error.params as { missingProperty: string }).missingProperty})`
      : error.keyword === 'additionalProperties'
        ? ` (${(error.params as { additionalProperty: string }).additionalProperty})`
        : '';
  return { path: error.instancePath, message: `${error.message ?? 'is invalid'}${extra}` };
}
