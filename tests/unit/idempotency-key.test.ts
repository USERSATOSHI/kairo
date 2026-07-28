import { describe, expect, test } from 'bun:test';

import { newIdempotencyKey } from '../../packages/web/src/idempotency-key.ts';

describe('web approval idempotency keys', () => {
  test('uses the platform UUID when it is available', () => {
    expect(newIdempotencyKey({ randomUUID: () => 'platform-uuid' })).toBe('platform-uuid');
  });

  test('falls back to a version-4 UUID when randomUUID is unavailable', () => {
    expect(
      newIdempotencyKey({
        getRandomValues: (values) => {
          values.fill(0);
          return values;
        },
      }),
    ).toBe('00000000-0000-4000-8000-000000000000');
  });
});
