import { describe, expect, test } from 'bun:test';

import { controlInvocation, controlRun, publishRun } from '../../packages/web/src/api.ts';

describe('web control API client', () => {
  test('sends idempotent run and exact-invocation control requests', async () => {
    const originalFetch = globalThis.fetch;
    const requests: { readonly url: string; readonly init?: RequestInit }[] = [];
    globalThis.fetch = Object.assign(
      (...args: Parameters<typeof fetch>): ReturnType<typeof fetch> => {
        const [input, init] = args;
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        requests.push({ url, ...(init ? { init } : {}) });
        return Promise.resolve(
          Response.json({
            runId: 'run/with spaces',
            status: 'running',
          }),
        );
      },
      {
        preconnect: (...args: Parameters<typeof fetch.preconnect>) =>
          originalFetch.preconnect(...args),
      },
    );
    try {
      await controlRun('run/with spaces', 'pause', {
        actor: 'web-user',
        idempotencyKey: 'pause-1',
      });
      await controlInvocation('run/with spaces', 7, 'steer', {
        actor: 'web-user',
        message: 'Keep the public contract.',
        idempotencyKey: 'steer-1',
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(requests.map(({ url }) => url)).toEqual([
      '/api/runs/run%2Fwith%20spaces/pause',
      '/api/runs/run%2Fwith%20spaces/invocations/7/steer',
    ]);
    expect(requests.map(({ init }) => init?.method)).toEqual(['POST', 'POST']);
    expect(requests[1]?.init?.body).toBe(
      JSON.stringify({
        actor: 'web-user',
        message: 'Keep the public contract.',
        idempotencyKey: 'steer-1',
      }),
    );
  });

  test('surfaces the API error message for failed publication', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = Object.assign(
      (..._args: Parameters<typeof fetch>): ReturnType<typeof fetch> =>
        Promise.resolve(
          Response.json(
            {
              error: {
                code: 'run_publication_failed',
                message:
                  'Remote origin is not configured for /repositories/kouro; add the repository remote before publishing',
              },
            },
            { status: 409 },
          ),
        ),
      {
        preconnect: (...args: Parameters<typeof fetch.preconnect>) =>
          originalFetch.preconnect(...args),
      },
    );
    try {
      let failure: unknown;
      try {
        await publishRun('run-1');
      } catch (cause) {
        failure = cause;
      }
      if (!(failure instanceof Error)) throw new Error('Publication should have failed');
      expect(failure.message).toContain(
        'Kouro API request failed (409): Remote origin is not configured for /repositories/kouro',
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
