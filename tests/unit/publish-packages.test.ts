import { describe, expect, test } from 'bun:test';

import { orderPublishWorkspaces, type PublishWorkspace } from '../../scripts/publish-packages.ts';

function workspace(name: string, internalDependencies: readonly string[] = []): PublishWorkspace {
  return {
    directory: `/workspaces/${name}`,
    internalDependencies,
    name,
    private: false,
  };
}

describe('workspace publication order', () => {
  test('orders dependencies before consumers with stable independent ordering', () => {
    const ordered = orderPublishWorkspaces([
      workspace('@kouro/runtime', ['@kouro/adw', '@kouro/domain']),
      workspace('@kouro/domain'),
      workspace('@kouro/api-contracts', ['@kouro/domain']),
      workspace('@kouro/adw', ['@kouro/domain']),
    ]);

    expect(ordered.map(({ name }) => name)).toEqual([
      '@kouro/domain',
      '@kouro/adw',
      '@kouro/api-contracts',
      '@kouro/runtime',
    ]);
  });

  test('rejects a cyclic workspace release graph', () => {
    expect(() =>
      orderPublishWorkspaces([
        workspace('@kouro/first', ['@kouro/second']),
        workspace('@kouro/second', ['@kouro/first']),
      ]),
    ).toThrow('Workspace dependency cycle includes');
  });
});
