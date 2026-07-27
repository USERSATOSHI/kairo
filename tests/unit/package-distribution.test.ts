import { describe, expect, test } from 'bun:test';

interface PackageManifest {
  readonly bin?: Readonly<Record<string, string>>;
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly files?: readonly string[];
  readonly private?: boolean;
}

async function packageManifest(path: string): Promise<PackageManifest> {
  const value: unknown = await Bun.file(path).json();
  if (typeof value !== 'object' || value === null) throw new Error(`Invalid manifest at ${path}`);
  return value;
}

describe('package distribution', () => {
  test('ships a thin root launcher backed by the public CLI package', async () => {
    const manifest = await packageManifest('package.json');

    expect(manifest.bin?.kouro).toBe('bin/kouro.ts');
    expect(manifest.dependencies?.['@kouro/cli']).toBe('0.1.3');
    expect(manifest.files).toContain('bin');
    expect(manifest.files).not.toContain('packages/cli/dist');
  });

  test('publishes CLI source, workflow assets, and web assets separately', async () => {
    const [cli, web] = await Promise.all([
      packageManifest('packages/cli/package.json'),
      packageManifest('packages/web/package.json'),
    ]);

    expect(cli.private).not.toBe(true);
    expect(cli.dependencies?.['@kouro/web']).toBe('0.1.3');
    expect(cli.files).toEqual(expect.arrayContaining(['src', 'assets']));
    expect(web.private).not.toBe(true);
    expect(web.files).toContain('dist');
    expect(web.files).not.toContain('src');
  });
});
