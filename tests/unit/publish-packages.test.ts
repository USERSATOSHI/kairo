import { describe, expect, test } from 'bun:test';

import {
  incrementPatchVersion,
  orderPublishWorkspaces,
  synchronizeLockfileWorkspaces,
  type PublishWorkspace,
  updateManifestVersion,
} from '../../scripts/publish-packages.ts';

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

describe('release versioning', () => {
  test('increments the patch component', () => {
    expect(incrementPatchVersion('0.1.0')).toBe('0.1.1');
    expect(incrementPatchVersion('2.7.99')).toBe('2.7.100');
  });

  test('rejects prerelease and non-semantic versions', () => {
    expect(() => incrementPatchVersion('1.0.0-beta.1')).toThrow(
      'Cannot automatically increment version',
    );
    expect(() => incrementPatchVersion('latest')).toThrow('Cannot automatically increment version');
  });

  test('updates the package and exact internal dependency versions', () => {
    expect(
      updateManifestVersion(
        {
          name: '@kouro/runtime',
          version: '0.1.0',
          dependencies: {
            '@kouro/domain': '0.1.0',
            zod: '^4.0.0',
          },
          devDependencies: {
            '@kouro/adw': '0.1.0',
          },
        },
        new Set(['@kouro/adw', '@kouro/domain', '@kouro/runtime']),
        '0.1.1',
      ),
    ).toEqual({
      name: '@kouro/runtime',
      version: '0.1.1',
      dependencies: {
        '@kouro/domain': '0.1.1',
        zod: '^4.0.0',
      },
      devDependencies: {
        '@kouro/adw': '0.1.1',
      },
    });
  });

  test('synchronizes workspace metadata without resolving external packages', () => {
    const lockfile = JSON.stringify({
      lockfileVersion: 1,
      workspaces: {
        '': { name: 'kouro', devDependencies: { '@kouro/cli': '0.1.0' } },
      },
      packages: { react: ['react@1.0.0'] },
    });

    const updated: unknown = JSON.parse(
      synchronizeLockfileWorkspaces(
        lockfile,
        {
          name: 'kouro',
          version: '0.1.2',
          dependencies: { '@kouro/cli': '0.1.2' },
        },
        [
          {
            name: '@kouro/cli',
            version: '0.1.2',
            bin: { kouro: './src/main.ts' },
            dependencies: { '@kouro/domain': '0.1.2' },
          },
        ],
      ),
    );

    expect(updated).toEqual({
      lockfileVersion: 1,
      workspaces: {
        '': { name: 'kouro', dependencies: { '@kouro/cli': '0.1.2' } },
        'packages/cli': {
          name: '@kouro/cli',
          version: '0.1.2',
          dependencies: { '@kouro/domain': '0.1.2' },
          bin: { kouro: './src/main.ts' },
        },
      },
      packages: { react: ['react@1.0.0'] },
    });
  });
});
