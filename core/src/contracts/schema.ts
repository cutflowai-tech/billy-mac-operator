// Minimal strict JSON-schema subset validator (zero dependencies).
// Supported keywords: type, properties, required, additionalProperties(false|schema),
// enum, const, minLength, maxLength, pattern, minimum, maximum, items, minItems,
// maxItems, anyOf, format(date-time|uuid|sha256).
// Unknown keywords are a programming error and throw, so schemas cannot silently
// weaken validation.

export type Schema = {
  type?: 'object' | 'string' | 'integer' | 'number' | 'boolean' | 'null' | 'array';
  properties?: Record<string, Schema>;
  required?: string[];
  additionalProperties?: boolean | Schema;
  enum?: readonly unknown[];
  const?: unknown;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  minimum?: number;
  maximum?: number;
  items?: Schema;
  minItems?: number;
  maxItems?: number;
  anyOf?: Schema[];
  format?: 'date-time' | 'uuid' | 'sha256';
  description?: string;
};

const KNOWN = new Set([
  'type', 'properties', 'required', 'additionalProperties', 'enum', 'const', 'minLength',
  'maxLength', 'pattern', 'minimum', 'maximum', 'items', 'minItems', 'maxItems', 'anyOf',
  'format', 'description',
]);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA = /^[0-9a-f]{64}$/;
const DT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/;

export interface SchemaError { path: string; message: string }

export function validate(schema: Schema, value: unknown, path = '$', errs: SchemaError[] = []): SchemaError[] {
  for (const k of Object.keys(schema)) {
    if (!KNOWN.has(k)) throw new Error(`schema keyword not supported: ${k} at ${path}`);
  }
  if (schema.anyOf) {
    const ok = schema.anyOf.some((s) => validate(s, value, path, []).length === 0);
    if (!ok) errs.push({ path, message: 'no anyOf branch matched' });
    return errs;
  }
  if ('const' in schema && !deepEqual(schema.const, value)) {
    errs.push({ path, message: `expected const ${JSON.stringify(schema.const)}` });
  }
  if (schema.enum && !schema.enum.some((e) => deepEqual(e, value))) {
    errs.push({ path, message: `not in enum` });
  }
  const t = schema.type;
  if (t) {
    const actual = typeOf(value);
    const okType = t === 'number' ? actual === 'number' || actual === 'integer' : actual === t;
    if (!okType) {
      errs.push({ path, message: `expected ${t}, got ${actual}` });
      return errs;
    }
  }
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && [...value].length < schema.minLength) errs.push({ path, message: 'too short' });
    if (schema.maxLength !== undefined && [...value].length > schema.maxLength) errs.push({ path, message: 'too long' });
    if (schema.pattern && !new RegExp(schema.pattern, 'u').test(value)) errs.push({ path, message: 'pattern mismatch' });
    if (schema.format === 'uuid' && !UUID.test(value)) errs.push({ path, message: 'not a uuid' });
    if (schema.format === 'sha256' && !SHA.test(value)) errs.push({ path, message: 'not a sha256 hex digest' });
    if (schema.format === 'date-time' && (!DT.test(value) || Number.isNaN(Date.parse(value)))) {
      errs.push({ path, message: 'not a canonical UTC date-time' });
    }
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) errs.push({ path, message: 'non-finite number' });
    if (schema.minimum !== undefined && value < schema.minimum) errs.push({ path, message: 'below minimum' });
    if (schema.maximum !== undefined && value > schema.maximum) errs.push({ path, message: 'above maximum' });
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) errs.push({ path, message: 'too few items' });
    if (schema.maxItems !== undefined && value.length > schema.maxItems) errs.push({ path, message: 'too many items' });
    if (schema.items) value.forEach((v, i) => validate(schema.items!, v, `${path}[${i}]`, errs));
  }
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    const props = schema.properties ?? {};
    for (const r of schema.required ?? []) {
      if (!Object.prototype.hasOwnProperty.call(obj, r)) errs.push({ path: `${path}.${r}`, message: 'required' });
    }
    for (const [k, v] of Object.entries(obj)) {
      if (props[k]) validate(props[k], v, `${path}.${k}`, errs);
      else if (schema.additionalProperties === false || schema.additionalProperties === undefined) {
        // Default is strict: undeclared fields are rejected.
        errs.push({ path: `${path}.${k}`, message: 'unknown field' });
      } else if (typeof schema.additionalProperties === 'object') {
        validate(schema.additionalProperties, v, `${path}.${k}`, errs);
      }
    }
  }
  return errs;
}

function typeOf(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number';
  return typeof v;
}

export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a as object), kb = Object.keys(b as object);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => deepEqual((a as any)[k], (b as any)[k]));
}

export class ContractError extends Error {
  readonly errors: SchemaError[];
  constructor(errors: SchemaError[], what: string) {
    super(`${what} failed validation: ${errors.slice(0, 5).map((e) => `${e.path} ${e.message}`).join('; ')}`);
    this.errors = errors;
  }
}

export function assertValid<T>(schema: Schema, value: unknown, what: string): T {
  const errs = validate(schema, value);
  if (errs.length) throw new ContractError(errs, what);
  return value as T;
}
