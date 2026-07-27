import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';

import { fromAsync, type Result } from '@usersatoshi/results';

import { CliErrorKind, cliErr, type CliError } from './errors.ts';

export const ADW_TEMPLATES = ['feature-development', 'hotfix', 'bug-fix', 'chore'] as const;

export type AdwTemplate = (typeof ADW_TEMPLATES)[number];

export interface CreateAdwRequest {
  readonly name: string;
  readonly template: AdwTemplate;
  readonly outputDirectory: string;
}

export interface CreatedAdw {
  readonly name: string;
  readonly template: AdwTemplate;
  readonly path: string;
}

const adwNamePattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : 'ADW template creation failed';
}

function displayName(name: string): string {
  return name
    .split('-')
    .map((part) => `${part[0]?.toUpperCase() ?? ''}${part.slice(1)}`)
    .join(' ');
}

function render(content: string, name: string): string {
  return content
    .replaceAll('{{id}}', name)
    .replaceAll('{{name}}', displayName(name))
    .replaceAll("from '../kouro-sdk.ts'", "from './kouro-sdk.ts'");
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (cause) {
    if (typeof cause === 'object' && cause !== null && 'code' in cause && cause.code === 'ENOENT') {
      return false;
    }
    throw cause;
  }
}

async function renderTemplate(source: string, destination: string, name: string): Promise<void> {
  await mkdir(destination, { recursive: true });
  const entries = await readdir(source, { withFileTypes: true });
  for (const entry of entries) {
    const sourcePath = resolve(source, entry.name);
    const destinationPath = resolve(destination, entry.name);
    if (entry.isDirectory()) {
      await renderTemplate(sourcePath, destinationPath, name);
      continue;
    }
    if (!entry.isFile()) continue;
    await writeFile(destinationPath, render(await readFile(sourcePath, 'utf8'), name));
  }
}

/**
 * Creates a compilable ADW package from a bundled template without replacing an
 * existing path.
 */
export async function createAdw(request: CreateAdwRequest): Promise<Result<CreatedAdw, CliError>> {
  if (!adwNamePattern.test(request.name)) {
    return cliErr(
      CliErrorKind.InvalidArguments,
      'invalid_adw_name',
      'ADW name must be a lowercase kebab-case identifier',
    );
  }
  if (!isAdwTemplate(request.template)) {
    return cliErr(
      CliErrorKind.InvalidArguments,
      'invalid_adw_template',
      `ADW template must be one of: ${ADW_TEMPLATES.join(', ')}`,
    );
  }

  const target = resolve(request.outputDirectory, request.name);
  const source = resolve(import.meta.dir, '..', 'assets', 'adw-templates', request.template);
  const created = await fromAsync(
    async () => {
      await mkdir(dirname(target), { recursive: true });
      if (await pathExists(target)) {
        throw new Error(`Target already exists: ${target}`);
      }
      const temporary = await mkdtemp(resolve(dirname(target), `.${basename(target)}.tmp-`));
      try {
        await renderTemplate(source, temporary, request.name);
        const sdkSource = resolve(import.meta.dir, '..', 'assets', 'adw-templates', 'kouro-sdk.ts');
        await writeFile(resolve(temporary, 'kouro-sdk.ts'), await readFile(sdkSource, 'utf8'));
        await rename(temporary, target);
      } catch (cause) {
        await rm(temporary, { recursive: true, force: true });
        throw cause;
      }
      return { name: request.name, template: request.template, path: target };
    },
    (cause): CliError => ({
      kind: CliErrorKind.Scaffolding,
      code: 'adw_creation_failed',
      message: errorMessage(cause),
    }),
  );
  return created;
}

export function isAdwTemplate(value: string): value is AdwTemplate {
  return ADW_TEMPLATES.some((template) => template === value);
}
