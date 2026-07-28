import { describe, expect, test } from 'bun:test';

import {
  deliveryMetadataChecksum,
  ensurePullRequest,
  validateDeliveryMetadata,
  type PullRequestProvider,
} from '@kouro/delivery';
import { ok } from '@usersatoshi/results';

describe('review-bound delivery metadata and publication', () => {
  test('normalizes valid metadata and rejects multiline titles', () => {
    const valid = validateDeliveryMetadata({
      commitTitle: '  Add review-bound delivery  ',
      commitBody: '  Body  ',
      pullRequestTitle: 'Add review-bound delivery',
      draft: false,
    });
    expect(valid.unwrap()).toEqual({
      commitTitle: 'Add review-bound delivery',
      commitBody: 'Body',
      pullRequestTitle: 'Add review-bound delivery',
      draft: false,
    });
    expect(
      validateDeliveryMetadata({
        commitTitle: 'bad\nmessage',
        pullRequestTitle: 'Valid',
        draft: false,
      }).isErr(),
    ).toBe(true);
  });

  test('checksums the prepared tree, artifacts, and editable proposal', () => {
    const metadata = {
      commitTitle: 'Delivery',
      pullRequestTitle: 'Delivery',
      draft: false,
    };
    const first = deliveryMetadataChecksum('head', 'tree', ['b', 'a'], metadata);
    expect(deliveryMetadataChecksum('head', 'tree', ['a', 'b'], metadata)).toBe(first);
    expect(deliveryMetadataChecksum('head', 'other-tree', ['a', 'b'], metadata)).not.toBe(first);
  });

  test('verify-then-create reuses an existing pull request', async () => {
    let creates = 0;
    const provider: PullRequestProvider = {
      id: 'github',
      find: async (input) =>
        ok({
          ...input,
          number: 42,
          url: 'https://example.test/pulls/42',
          title: 'Delivery',
          draft: false,
        }),
      create: async (input) => {
        creates += 1;
        return ok({
          ...input,
          number: 43,
          url: 'https://example.test/pulls/43',
        });
      },
    };
    const result = await ensurePullRequest(provider, {
      owner: 'owner',
      repository: 'repo',
      head: 'kouro/run',
      base: 'main',
      title: 'Delivery',
      draft: false,
    });
    expect(result.unwrap().number).toBe(42);
    expect(creates).toBe(0);
  });
});
