import { access, realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';

import { err, fromAsync, ok, type Result } from '@usersatoshi/results';

import { SandboxErrorKind, type SandboxError, toErr } from './errors.ts';

export interface AgentSandboxPolicy {
  readonly workingDirectory: string;
  readonly writable: boolean;
  readonly network: boolean;
}

export interface SandboxedCommandInput extends AgentSandboxPolicy {
  readonly command: string;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly signal?: AbortSignal;
  readonly timeoutSeconds?: number;
  readonly onData?: (data: Buffer) => void;
}

export interface SandboxedCommandOutput {
  readonly exitCode: number | null;
}

export interface BubblewrapInvocation {
  readonly command: string;
  readonly args: readonly string[];
  readonly environment: Readonly<Record<string, string>>;
}

const hiddenDirectories = ['.ssh', '.aws', '.gnupg', '.docker', '.kube', '.config/gcloud'];
const hiddenFiles = ['.npmrc', '.pypirc', '.netrc', '.git-credentials'];
const environmentKeys = [
  'CI',
  'COLORTERM',
  'HOME',
  'LANG',
  'LC_ALL',
  'LOGNAME',
  'NO_COLOR',
  'PATH',
  'SHELL',
  'TERM',
  'TZ',
  'USER',
] as const;

function messageFor(error: unknown): string {
  return error instanceof Error ? error.message : 'Sandbox operation failed';
}

function isWithin(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === '' || (!path.startsWith('..') && !isAbsolute(path));
}

function mountDestinationArguments(root: string): string[] {
  if (!isWithin('/tmp', root)) return [];
  const suffix = relative('/tmp', root);
  let current = '/tmp';
  return suffix.split('/').flatMap((segment) => {
    current = resolve(current, segment);
    return ['--dir', current];
  });
}

async function nearestExistingParent(path: string): Promise<string> {
  let candidate = path;
  while (true) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      const parent = dirname(candidate);
      if (parent === candidate) throw new Error(`No existing parent for ${path}`);
      candidate = parent;
    }
  }
}

function filteredEnvironment(
  source: Readonly<Record<string, string | undefined>>,
): Readonly<Record<string, string>> {
  const environment: Record<string, string> = {};
  for (const key of environmentKeys) {
    const value = source[key];
    if (value !== undefined) environment[key] = value;
  }
  environment.TMPDIR = '/tmp';
  environment.TMP = '/tmp';
  environment.TEMP = '/tmp';
  return environment;
}

async function existingPaths(home: string): Promise<{
  readonly directories: readonly string[];
  readonly files: readonly string[];
}> {
  const directories: string[] = [];
  const files: string[] = [];
  for (const suffix of hiddenDirectories) {
    const path = resolve(home, suffix);
    try {
      if ((await stat(path)).isDirectory()) directories.push(path);
    } catch {
      // Missing credential paths need no mount.
    }
  }
  for (const suffix of hiddenFiles) {
    const path = resolve(home, suffix);
    try {
      if ((await stat(path)).isFile()) files.push(path);
    } catch {
      // Missing credential paths need no mount.
    }
  }
  return { directories, files };
}

/** Linux Bubblewrap implementation for agent-controlled command execution. */
export class BubblewrapAgentSandbox {
  readonly id = 'bubblewrap';

  available(): boolean {
    return process.platform === 'linux' && Bun.which('bwrap') !== null;
  }

  async invocation(
    input: SandboxedCommandInput,
  ): Promise<Result<BubblewrapInvocation, SandboxError>> {
    if (!this.available()) {
      return err(
        toErr(SandboxErrorKind.RuntimeUnavailable, {
          runtime: 'bwrap',
          message: 'Bubblewrap is required for sandboxed agent commands',
        }),
      );
    }
    const canonicalRoot = await fromAsync(
      () => realpath(input.workingDirectory),
      (error) =>
        toErr(SandboxErrorKind.BoundaryViolation, {
          operation: 'execute',
          root: input.workingDirectory,
          path: input.workingDirectory,
          reason: messageFor(error),
        }),
    );
    if (canonicalRoot.isErr()) return canonicalRoot;
    const root = canonicalRoot.unwrap();
    const home = input.environment?.HOME ?? process.env.HOME;
    const hidden = home
      ? await existingPaths(home)
      : { directories: [] as readonly string[], files: [] as readonly string[] };
    const args = [
      '--die-with-parent',
      '--new-session',
      '--unshare-pid',
      '--unshare-ipc',
      '--unshare-uts',
      '--unshare-cgroup-try',
      '--ro-bind',
      '/',
      '/',
      '--dev',
      '/dev',
      '--proc',
      '/proc',
      '--tmpfs',
      '/tmp',
      ...mountDestinationArguments(root),
      ...hidden.directories.flatMap((path) => ['--tmpfs', path]),
      ...hidden.files.flatMap((path) => ['--ro-bind', '/dev/null', path]),
      ...(input.writable ? ['--bind', root, root] : ['--ro-bind', root, root]),
      ...(input.network ? [] : ['--unshare-net']),
      '--chdir',
      root,
      '--',
      'bash',
      '--noprofile',
      '--norc',
      '-lc',
      input.command,
    ];
    return ok({
      command: 'bwrap',
      args,
      environment: filteredEnvironment(input.environment ?? process.env),
    });
  }

  async execute(
    input: SandboxedCommandInput,
  ): Promise<Result<SandboxedCommandOutput, SandboxError>> {
    const invocation = await this.invocation(input);
    if (invocation.isErr()) return invocation;
    const prepared = invocation.unwrap();
    return fromAsync(
      () =>
        new Promise<SandboxedCommandOutput>((resolvePromise, reject) => {
          const child = Bun.spawn([prepared.command, ...prepared.args], {
            cwd: input.workingDirectory,
            env: prepared.environment,
            stdout: 'pipe',
            stderr: 'pipe',
          });
          let timedOut = false;
          let timer: ReturnType<typeof setTimeout> | undefined;
          const stop = (): void => {
            if (!child.killed) child.kill('SIGKILL');
          };
          const abort = (): void => stop();
          input.signal?.addEventListener('abort', abort, { once: true });
          if (input.timeoutSeconds !== undefined && input.timeoutSeconds > 0) {
            timer = setTimeout(() => {
              timedOut = true;
              stop();
            }, input.timeoutSeconds * 1000);
          }
          const observe = async (stream: ReadableStream<Uint8Array>): Promise<void> => {
            const reader = stream.getReader();
            while (true) {
              const chunk = await reader.read();
              if (chunk.done) return;
              input.onData?.(Buffer.from(chunk.value));
            }
          };
          Promise.all([child.exited, observe(child.stdout), observe(child.stderr)])
            .then(([exitCode]) => {
              if (timer) clearTimeout(timer);
              input.signal?.removeEventListener('abort', abort);
              if (input.signal?.aborted) {
                reject(new Error('aborted'));
              } else if (timedOut) {
                reject(new Error(`timeout:${input.timeoutSeconds}`));
              } else {
                resolvePromise({ exitCode });
              }
            })
            .catch(reject);
        }),
      (error) =>
        toErr(SandboxErrorKind.CommandFailure, {
          operation: 'execute',
          message: messageFor(error),
        }),
    );
  }

  async guardPath(
    root: string,
    path: string,
    operation: 'read' | 'write',
  ): Promise<Result<string, SandboxError>> {
    const guarded = await fromAsync(
      async () => {
        const canonicalRoot = await realpath(root);
        const lexical = resolve(canonicalRoot, path);
        if (!isWithin(canonicalRoot, lexical)) {
          throw new Error('Path is outside the worktree');
        }
        const existing = operation === 'read' ? lexical : await nearestExistingParent(lexical);
        const canonicalExisting = await realpath(existing);
        if (!isWithin(canonicalRoot, canonicalExisting)) {
          throw new Error('Path escapes the worktree through a symbolic link');
        }
        return lexical;
      },
      (error) =>
        toErr(SandboxErrorKind.BoundaryViolation, {
          operation,
          root,
          path,
          reason: messageFor(error),
        }),
    );
    return guarded;
  }
}
