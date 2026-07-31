import { realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

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

export interface AgentSandboxInvocation {
  readonly command: string;
  readonly args: readonly string[];
  readonly environment: Readonly<Record<string, string>>;
}

export interface AgentCommandSandboxAvailability {
  readonly available: boolean;
  readonly runtime: 'sandbox-runtime';
  readonly platform: NodeJS.Platform;
  readonly reason?: string;
}

export interface AgentCommandSandbox {
  readonly id: string;
  availability(): Promise<AgentCommandSandboxAvailability>;
  invocation(input: SandboxedCommandInput): Promise<Result<AgentSandboxInvocation, SandboxError>>;
  execute(input: SandboxedCommandInput): Promise<Result<SandboxedCommandOutput, SandboxError>>;
}

interface HelperRequest extends AgentSandboxPolicy {
  readonly command: string;
  readonly environment: Readonly<Record<string, string>>;
}

interface HelperAvailability {
  readonly available: boolean;
  readonly reason?: string;
}

const environmentKeys = [
  'APPDATA',
  'CI',
  'COLORTERM',
  'COMSPEC',
  'HOME',
  'LANG',
  'LC_ALL',
  'LOCALAPPDATA',
  'LOGNAME',
  'NO_COLOR',
  'PATH',
  'PATHEXT',
  'PROGRAMDATA',
  'PROGRAMFILES',
  'PROGRAMFILES(X86)',
  'SHELL',
  'SYSTEMDRIVE',
  'SYSTEMROOT',
  'TEMP',
  'TERM',
  'TMP',
  'TMPDIR',
  'TZ',
  'USER',
  'USERPROFILE',
  'WINDIR',
] as const;

function messageFor(error: unknown): string {
  return error instanceof Error ? error.message : 'Sandbox operation failed';
}

function filteredEnvironment(
  source: Readonly<Record<string, string | undefined>>,
): Readonly<Record<string, string>> {
  const environment: Record<string, string> = {};
  for (const key of environmentKeys) {
    const value = source[key];
    if (value !== undefined) environment[key] = value;
  }
  const temporaryDirectory = tmpdir();
  environment.TMPDIR ??= temporaryDirectory;
  environment.TMP ??= temporaryDirectory;
  environment.TEMP ??= temporaryDirectory;
  return environment;
}

function encodeRequest(request: HelperRequest): string {
  return Buffer.from(JSON.stringify(request)).toString('base64url');
}

function helperPath(): string {
  return fileURLToPath(new URL('./sandbox-runtime-helper.ts', import.meta.url));
}

function helperExecutable(): string {
  return Bun.which('bun') ?? process.execPath;
}

async function observe(
  stream: ReadableStream<Uint8Array>,
  onData?: (data: Buffer) => void,
): Promise<void> {
  const reader = stream.getReader();
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) return;
    const data = Buffer.from(chunk.value);
    onData?.(data);
  }
}

/** Cross-platform command sandbox backed by one isolated runtime helper per command. */
export class SandboxRuntimeAgentCommandSandbox implements AgentCommandSandbox {
  readonly id = 'sandbox-runtime';

  async availability(): Promise<AgentCommandSandboxAvailability> {
    try {
      const child = Bun.spawn([helperExecutable(), helperPath(), 'check'], {
        env: filteredEnvironment(process.env),
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      if (exitCode !== 0) throw new Error(stderr.trim() || `dependency check exited ${exitCode}`);
      const parsed: unknown = JSON.parse(stdout);
      if (
        parsed === null ||
        typeof parsed !== 'object' ||
        !('available' in parsed) ||
        typeof parsed.available !== 'boolean'
      ) {
        throw new Error('Sandbox dependency check returned an invalid response');
      }
      const availability: HelperAvailability = {
        available: parsed.available,
        ...('reason' in parsed && typeof parsed.reason === 'string'
          ? { reason: parsed.reason }
          : {}),
      };
      return {
        ...availability,
        runtime: 'sandbox-runtime',
        platform: process.platform,
      };
    } catch (error) {
      return {
        available: false,
        runtime: 'sandbox-runtime',
        platform: process.platform,
        reason: messageFor(error),
      };
    }
  }

  async invocation(
    input: SandboxedCommandInput,
  ): Promise<Result<AgentSandboxInvocation, SandboxError>> {
    const availability = await this.availability();
    if (!availability.available) {
      return err(
        toErr(SandboxErrorKind.RuntimeUnavailable, {
          runtime: this.id,
          message: availability.reason ?? 'Sandbox Runtime is unavailable',
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
    const environment = filteredEnvironment({ ...process.env, ...input.environment });
    const request: HelperRequest = {
      command: input.command,
      workingDirectory: canonicalRoot.unwrap(),
      writable: input.writable,
      network: input.network,
      environment,
    };
    return ok({
      command: helperExecutable(),
      args: [helperPath(), 'execute', encodeRequest(request)],
      environment,
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
          Promise.all([
            child.exited,
            observe(child.stdout, input.onData),
            observe(child.stderr, input.onData),
          ])
            .then(([exitCode]) => {
              if (timer) clearTimeout(timer);
              input.signal?.removeEventListener('abort', abort);
              if (input.signal?.aborted) reject(new Error('aborted'));
              else if (timedOut) reject(new Error(`timeout:${input.timeoutSeconds}`));
              else resolvePromise({ exitCode });
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

  async setup(): Promise<Result<void, SandboxError>> {
    if (process.platform !== 'win32') return ok(undefined);
    return fromAsync(
      async () => {
        const child = Bun.spawn([helperExecutable(), helperPath(), 'setup'], {
          env: filteredEnvironment(process.env),
          stdin: 'inherit',
          stdout: 'inherit',
          stderr: 'inherit',
        });
        const exitCode = await child.exited;
        if (exitCode !== 0) throw new Error(`Windows sandbox setup exited ${exitCode}`);
      },
      (error) =>
        toErr(SandboxErrorKind.CommandFailure, {
          operation: 'setup',
          message: messageFor(error),
        }),
    );
  }
}
