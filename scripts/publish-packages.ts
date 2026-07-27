import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

interface RegistryTarget {
  readonly configFile: string;
  readonly registry: string;
  readonly tokenEnvironmentVariable: string;
  readonly publicAccess: boolean;
}

export interface PublishWorkspace {
  readonly directory: string;
  readonly internalDependencies: readonly string[];
  readonly name: string;
  readonly private: boolean;
}

const TARGETS: Readonly<Record<string, RegistryTarget>> = {
  forgejo: {
    configFile: 'bunfig.publish-forgejo.toml',
    registry: 'https://git.usersatoshi.com/api/packages/kouro/npm/',
    tokenEnvironmentVariable: 'KOURO_FORGEJO_TOKEN',
    publicAccess: false,
  },
  npm: {
    configFile: 'bunfig.publish-npm.toml',
    registry: 'https://registry.npmjs.org/',
    tokenEnvironmentVariable: 'NPM_TOKEN',
    publicAccess: true,
  },
};

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function dependencyNames(manifest: Readonly<Record<string, unknown>>): readonly string[] {
  const names = new Set<string>();
  for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
    const dependencies = manifest[field];
    if (!isRecord(dependencies)) continue;
    for (const name of Object.keys(dependencies)) names.add(name);
  }
  return [...names].toSorted((left, right) => left.localeCompare(right));
}

async function loadWorkspaces(root: string): Promise<readonly PublishWorkspace[]> {
  const packagesDirectory = resolve(root, 'packages');
  const entries = await readdir(packagesDirectory, { withFileTypes: true });
  const workspaces: PublishWorkspace[] = [];

  for (const entry of entries
    .filter((candidate) => candidate.isDirectory())
    .toSorted((left, right) => left.name.localeCompare(right.name))) {
    const directory = resolve(packagesDirectory, entry.name);
    const manifestValue: unknown = JSON.parse(
      await readFile(resolve(directory, 'package.json'), 'utf8'),
    );
    if (!isRecord(manifestValue) || typeof manifestValue.name !== 'string') {
      throw new Error(`Invalid package manifest at packages/${entry.name}/package.json`);
    }
    workspaces.push({
      directory,
      internalDependencies: dependencyNames(manifestValue),
      name: manifestValue.name,
      private: manifestValue.private === true,
    });
  }

  return workspaces;
}

/** Returns workspace packages in stable dependency-first release order. */
export function orderPublishWorkspaces(
  workspaces: readonly PublishWorkspace[],
): readonly PublishWorkspace[] {
  const byName = new Map(workspaces.map((workspace) => [workspace.name, workspace]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const ordered: PublishWorkspace[] = [];

  function visit(workspace: PublishWorkspace): void {
    if (visited.has(workspace.name)) return;
    if (visiting.has(workspace.name)) {
      throw new Error(`Workspace dependency cycle includes ${workspace.name}`);
    }
    visiting.add(workspace.name);
    for (const dependency of workspace.internalDependencies) {
      const internal = byName.get(dependency);
      if (internal) visit(internal);
    }
    visiting.delete(workspace.name);
    visited.add(workspace.name);
    ordered.push(workspace);
  }

  for (const workspace of workspaces.toSorted((left, right) =>
    left.name.localeCompare(right.name),
  )) {
    visit(workspace);
  }
  return ordered;
}

async function publishPackage(
  root: string,
  directory: string,
  name: string,
  target: RegistryTarget,
  dryRun: boolean,
): Promise<void> {
  process.stdout.write(`Publishing ${name} to ${target.registry}${dryRun ? ' (dry run)' : ''}\n`);
  const command = [
    'bun',
    `--config=${resolve(root, target.configFile)}`,
    'publish',
    '--registry',
    target.registry,
    '--tolerate-republish',
    ...(target.publicAccess ? ['--access', 'public'] : []),
    ...(dryRun ? ['--dry-run'] : []),
  ];
  const processResult = Bun.spawn(command, {
    cwd: directory,
    env: {
      ...process.env,
      NPM_CONFIG_TOKEN: process.env[target.tokenEnvironmentVariable] ?? '',
    },
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
  });
  const exitCode = await processResult.exited;
  if (exitCode !== 0) throw new Error(`Publishing ${name} failed with exit code ${exitCode}`);
}

async function main(): Promise<void> {
  const root = resolve(import.meta.dir, '..');
  const targetName = process.argv[2] ?? '';
  const target = TARGETS[targetName];
  const options = process.argv.slice(3);
  const dryRun = options.length === 1 && options[0] === '--dry-run';
  if (!target || (options.length > 0 && !dryRun)) {
    process.stderr.write('Usage: bun run scripts/publish-packages.ts <forgejo|npm> [--dry-run]\n');
    process.exitCode = 1;
    return;
  }
  if (!dryRun && !process.env[target.tokenEnvironmentVariable]) {
    process.stderr.write(
      `Set ${target.tokenEnvironmentVariable} before publishing to ${targetName}.\n`,
    );
    process.exitCode = 1;
    return;
  }

  const workspaces = orderPublishWorkspaces(await loadWorkspaces(root));
  for (const workspace of workspaces) {
    if (workspace.private) {
      process.stdout.write(`Skipping private workspace ${workspace.name}\n`);
      continue;
    }
    await publishPackage(root, workspace.directory, workspace.name, target, dryRun);
  }
  await publishPackage(root, root, 'kouro', target, dryRun);
}

if (import.meta.main) {
  await main();
}
