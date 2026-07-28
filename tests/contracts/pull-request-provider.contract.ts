import { describe, expect, test } from 'bun:test';

import { DeliveryErrorKind, type PullRequestProvider } from '@kouro/delivery';

export interface PullRequestProviderContractFactory {
  create(
    fetch: (input: string | URL | Request, init?: RequestInit) => Promise<Response>,
  ): PullRequestProvider;
  existingResponse: Readonly<Record<string, unknown>>;
}

export function pullRequestProviderContract(
  name: string,
  factory: PullRequestProviderContractFactory,
): void {
  const target = {
    owner: 'owner',
    repository: 'repository',
    head: 'kouro/run-1',
    base: 'main',
  };

  describe(`${name} pull-request provider contract`, () => {
    test('finds an existing head/base pull request before recovery creates', async () => {
      const provider = factory.create(async () => Response.json([factory.existingResponse]));
      const found = await provider.find(target);
      expect(found.unwrap()).toMatchObject({
        ...target,
        number: 17,
        url: 'https://forge.example/pulls/17',
      });
    });

    test('creates the exact reviewed metadata', async () => {
      let requestBody: unknown;
      const provider = factory.create(async (_input, init) => {
        requestBody = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
        return Response.json(factory.existingResponse);
      });
      const created = await provider.create({
        ...target,
        title: 'Reviewed delivery',
        body: 'Exact body',
        draft: true,
      });
      expect(created.isOk()).toBe(true);
      expect(requestBody).toMatchObject({
        title: 'Reviewed delivery',
        head: 'kouro/run-1',
        base: 'main',
        body: 'Exact body',
        draft: true,
      });
    });

    test('returns a typed authentication failure', async () => {
      const provider = factory.create(async () => new Response('', { status: 401 }));
      const found = await provider.find(target);
      expect(found.isErr()).toBe(true);
      if (found.isErr()) expect(found.error.kind).toBe(DeliveryErrorKind.Authentication);
    });
  });
}
