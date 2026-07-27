import type { JsonValue } from '@kouro/domain';

export interface StructuredOutputIssue {
  readonly path: string;
  readonly message: string;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function childPath(path: string, key: string): string {
  return path === '$' ? `$.${key}` : `${path}.${key}`;
}

function matchesType(value: unknown, type: string): boolean {
  switch (type) {
    case 'null':
      return value === null;
    case 'boolean':
      return typeof value === 'boolean';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'integer':
      return typeof value === 'number' && Number.isSafeInteger(value);
    case 'string':
      return typeof value === 'string';
    case 'array':
      return Array.isArray(value);
    case 'object':
      return isRecord(value);
    default:
      return false;
  }
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function validateCombinators(
  value: unknown,
  schema: Readonly<Record<string, unknown>>,
  path: string,
): StructuredOutputIssue | undefined {
  if (Array.isArray(schema.allOf)) {
    for (const child of schema.allOf) {
      const issue = validateValue(value, child, path);
      if (issue) return issue;
    }
  }
  if (
    Array.isArray(schema.anyOf) &&
    !schema.anyOf.some((child) => !validateValue(value, child, path))
  ) {
    return { path, message: 'must match at least one anyOf schema' };
  }
  if (
    Array.isArray(schema.oneOf) &&
    schema.oneOf.filter((child) => !validateValue(value, child, path)).length !== 1
  ) {
    return { path, message: 'must match exactly one oneOf schema' };
  }
  return undefined;
}

function validateArray(
  value: readonly unknown[],
  schema: Readonly<Record<string, unknown>>,
  path: string,
): StructuredOutputIssue | undefined {
  if (typeof schema.minItems === 'number' && value.length < schema.minItems) {
    return { path, message: `must contain at least ${schema.minItems} items` };
  }
  if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) {
    return { path, message: `must contain at most ${schema.maxItems} items` };
  }
  if (schema.items !== undefined) {
    for (const [index, child] of value.entries()) {
      const issue = validateValue(child, schema.items, `${path}[${index}]`);
      if (issue) return issue;
    }
  }
  return undefined;
}

function validateObject(
  value: Readonly<Record<string, unknown>>,
  schema: Readonly<Record<string, unknown>>,
  path: string,
): StructuredOutputIssue | undefined {
  if (Array.isArray(schema.required)) {
    for (const key of schema.required) {
      if (typeof key === 'string' && !(key in value)) {
        return { path: childPath(path, key), message: 'is required' };
      }
    }
  }

  const properties = isRecord(schema.properties) ? schema.properties : {};
  for (const [key, child] of Object.entries(value)) {
    const childSchema = properties[key];
    if (childSchema !== undefined) {
      const issue = validateValue(child, childSchema, childPath(path, key));
      if (issue) return issue;
    } else if (schema.additionalProperties === false) {
      return { path: childPath(path, key), message: 'is not allowed' };
    } else if (isRecord(schema.additionalProperties)) {
      const issue = validateValue(child, schema.additionalProperties, childPath(path, key));
      if (issue) return issue;
    }
  }
  return undefined;
}

function validateValue(
  value: unknown,
  schemaValue: unknown,
  path: string,
): StructuredOutputIssue | undefined {
  if (schemaValue === true) return undefined;
  if (schemaValue === false) return { path, message: 'is rejected by the schema' };
  if (!isRecord(schemaValue)) return { path, message: 'schema must be an object or boolean' };

  const combinatorIssue = validateCombinators(value, schemaValue, path);
  if (combinatorIssue) return combinatorIssue;

  if ('const' in schemaValue && !sameJson(value, schemaValue.const)) {
    return { path, message: 'must equal the declared const value' };
  }
  if (Array.isArray(schemaValue.enum) && !schemaValue.enum.some((item) => sameJson(value, item))) {
    return { path, message: 'must equal one of the declared enum values' };
  }

  const declaredTypes =
    typeof schemaValue.type === 'string'
      ? [schemaValue.type]
      : Array.isArray(schemaValue.type)
        ? schemaValue.type.filter((item): item is string => typeof item === 'string')
        : [];
  if (declaredTypes.length > 0 && !declaredTypes.some((type) => matchesType(value, type))) {
    return { path, message: `must have type ${declaredTypes.join(' or ')}` };
  }

  if (Array.isArray(value)) return validateArray(value, schemaValue, path);
  if (isRecord(value)) return validateObject(value, schemaValue, path);
  if (typeof value === 'string') {
    if (typeof schemaValue.minLength === 'number' && value.length < schemaValue.minLength) {
      return { path, message: `must contain at least ${schemaValue.minLength} characters` };
    }
    if (typeof schemaValue.maxLength === 'number' && value.length > schemaValue.maxLength) {
      return { path, message: `must contain at most ${schemaValue.maxLength} characters` };
    }
  }
  return undefined;
}

function toJsonValue(value: unknown): JsonValue | undefined {
  if (
    value === null ||
    typeof value === 'boolean' ||
    typeof value === 'string' ||
    (typeof value === 'number' && Number.isFinite(value))
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    const result: JsonValue[] = [];
    for (const child of value) {
      const converted = toJsonValue(child);
      if (converted === undefined) return undefined;
      result.push(converted);
    }
    return result;
  }
  if (isRecord(value)) {
    const result: Record<string, JsonValue> = {};
    for (const [key, child] of Object.entries(value)) {
      const converted = toJsonValue(child);
      if (converted === undefined) return undefined;
      result[key] = converted;
    }
    return result;
  }
  return undefined;
}

export function validateStructuredOutput(
  value: unknown,
  schema: JsonValue,
): { readonly output?: JsonValue; readonly issue?: StructuredOutputIssue } {
  const output = toJsonValue(value);
  if (output === undefined) {
    return { issue: { path: '$', message: 'must be finite JSON data' } };
  }
  const issue = validateValue(output, schema, '$');
  return issue ? { issue } : { output };
}
