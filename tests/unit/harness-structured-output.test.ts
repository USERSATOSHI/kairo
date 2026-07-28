import { describe, expect, test } from 'bun:test';

import { parseHarnessOutput } from '../../packages/harnesses/src/structured-output.ts';

describe('harness structured output parsing', () => {
  test('parses a direct JSON response', () => {
    expect(parseHarnessOutput('{"deliveryMetadata":{"draft":false}}')).toEqual({
      deliveryMetadata: { draft: false },
    });
  });

  test('extracts one JSON object from a prose response fenced as JSON', () => {
    expect(
      parseHarnessOutput(
        'Based on the validated change:\n\n```json\n{"deliveryMetadata":{"draft":false}}\n```',
      ),
    ).toEqual({ deliveryMetadata: { draft: false } });
  });

  test('preserves ambiguous responses for schema validation', () => {
    expect(parseHarnessOutput('```json\n{}\n```\n```json\n{}\n```')).toBe(
      '```json\n{}\n```\n```json\n{}\n```',
    );
  });
});
