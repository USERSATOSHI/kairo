#!/usr/bin/env bun

import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';

import { listRuns, getRun } from '@kairo/api';

import { ADW_TEMPLATES, createAdw, isAdwTemplate } from './create-adw.ts';
import { LocalKairoHost } from './local-host.ts';

const VERSION = '0.1.0';
const HELP = `Kairo ${VERSION}

Usage:
  kairo create adw <name> [--template <template>] [--output <directory>]
  kairo run <adw> --repo <path> [--harness <id|node=id>]...
  kairo runs
  kairo status <run-id>
  kairo approve <run-id> <invocation> --reason <text>
  kairo reject <run-id> <invocation> --reason <text>
  kairo pause|resume|cancel <run-id>
  kairo interrupt|retry|skip <run-id> <invocation> --reason <text>
  kairo diagnostics
  kairo serve [--port <number>]
  kairo --help
  kairo --version

ADW templates:
  ${ADW_TEMPLATES.join(', ')}`;

function option(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
}

function required(value: string | undefined, label: string): string {
  if (!value?.trim()) throw new Error(`${label} is required`);
  return value;
}

function print(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function harnessOptions(args: readonly string[]): {
  readonly harnesses: readonly string[];
  readonly harnessesByNode: Readonly<Record<string, readonly string[]>>;
} {
  const harnesses: string[] = [];
  const harnessesByNode: Record<string, string[]> = {};
  for (const [index, value] of args.entries()) {
    if (value !== '--harness') continue;
    const selection = required(args[index + 1], '--harness');
    const separator = selection.indexOf('=');
    if (separator < 0) {
      harnesses.push(selection);
      continue;
    }
    const nodeId = required(selection.slice(0, separator), '--harness node');
    const harnessId = required(selection.slice(separator + 1), '--harness id');
    (harnessesByNode[nodeId] ??= []).push(harnessId);
  }
  return { harnesses, harnessesByNode };
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const command = args[0];
  if (!command || command === '--help' || command === '-h') {
    process.stdout.write(`${HELP}\n`);
    return 0;
  }
  if (command === '--version' || command === '-v') {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }

  if (command === 'create') {
    if (required(args[1], 'resource') !== 'adw') {
      throw new Error(`Unknown create resource: ${args[1]}`);
    }
    const template = option(args, '--template') ?? 'feature-development';
    if (!isAdwTemplate(template)) {
      throw new Error(`Unknown ADW template: ${template}. Choose: ${ADW_TEMPLATES.join(', ')}`);
    }
    const result = await createAdw({
      name: required(args[2], 'name'),
      template,
      outputDirectory: resolve(option(args, '--output') ?? resolve(process.cwd(), '.kairo')),
    });
    if (result.isErr()) throw new Error(`${result.error.code}: ${result.error.message}`);
    print(result.unwrap());
    return 0;
  }

  const host = new LocalKairoHost();
  const initialized = await host.initialize();
  if (initialized.isErr())
    throw new Error(`${initialized.error.code}: ${initialized.error.message}`);
  const actor = process.env.USER?.trim() || 'local-operator';
  try {
    if (command === 'run') {
      const { harnesses, harnessesByNode } = harnessOptions(args);
      const result = await host.create({
        adw: required(args[1], 'adw'),
        repositoryPath: required(option(args, '--repo'), '--repo'),
        ...(harnesses.length ? { harnesses } : {}),
        ...(Object.keys(harnessesByNode).length ? { harnessesByNode } : {}),
        actor,
      });
      if (result.isErr()) throw new Error(`${result.error.code}: ${result.error.message}`);
      print(result.unwrap());
      return 0;
    }
    if (command === 'runs') {
      const result = listRuns({ runs: host.store, coordinator: host.coordinator() });
      if (result.isErr()) throw new Error(result.error.message);
      print(result.unwrap());
      return 0;
    }
    if (command === 'status') {
      const result = getRun(
        { runs: host.store, coordinator: host.coordinator() },
        required(args[1], 'run-id'),
      );
      if (result.isErr()) throw new Error(result.error.message);
      print(result.unwrap());
      return 0;
    }
    if (command === 'approve' || command === 'reject') {
      const runId = required(args[1], 'run-id');
      const invocation = Number(required(args[2], 'invocation'));
      const reason = required(option(args, '--reason'), '--reason');
      const loaded = host.store.loadRun(runId);
      if (loaded.isErr()) throw new Error(`Run ${runId} was not found`);
      const binding = loaded
        .unwrap()
        .state.invocations.find(({ sequence }) => sequence === invocation)?.approval;
      if (!binding) throw new Error(`Invocation ${invocation} is not awaiting approval`);
      const decided = host
        .coordinatorFor(loaded.unwrap())
        .decideApproval(
          runId,
          binding,
          command === 'approve' ? 'grant' : 'reject',
          actor,
          reason,
          `${command}:${randomUUID()}`,
        );
      if (decided.isErr()) throw new Error(`${command} failed`);
      const stable = await host.worker.runUntilStable(runId);
      print({ runId, status: stable.state.status });
      return 0;
    }
    if (['pause', 'resume', 'cancel'].includes(command)) {
      const runId = required(args[1], 'run-id');
      const coordinator = host.coordinator();
      const result =
        command === 'pause'
          ? coordinator.pauseRun(runId, actor, `pause:${randomUUID()}`)
          : command === 'resume'
            ? coordinator.resumeRun(runId, actor, `resume:${randomUUID()}`)
            : coordinator.cancelRun(
                runId,
                actor,
                option(args, '--reason') ?? 'cancelled by operator',
                `cancel:${randomUUID()}`,
              );
      if (result.isErr()) throw new Error(`${command} failed`);
      const stable =
        command === 'resume' ? await host.worker.runUntilStable(runId) : result.unwrap();
      print({ runId, status: stable.state.status });
      return 0;
    }
    if (['interrupt', 'retry', 'skip'].includes(command)) {
      const runId = required(args[1], 'run-id');
      const invocation = Number(required(args[2], 'invocation'));
      const reason = required(option(args, '--reason'), '--reason');
      const coordinator = host.coordinator();
      const key = `${command}:${randomUUID()}`;
      const result =
        command === 'interrupt'
          ? coordinator.interruptInvocation(runId, invocation, actor, reason, key)
          : command === 'retry'
            ? coordinator.retryInvocation(runId, invocation, actor, reason, key)
            : coordinator.skipInvocation(runId, invocation, actor, reason, key);
      if (result.isErr()) throw new Error(`${command} failed`);
      const stable =
        command === 'retry' || command === 'skip'
          ? await host.worker.runUntilStable(runId)
          : result.unwrap();
      print({ runId, status: stable.state.status });
      return 0;
    }
    if (command === 'diagnostics') {
      print(host.harnessDiagnostics());
      return 0;
    }
    if (command === 'serve') {
      const port = Number(option(args, '--port') ?? 4317);
      const served = await host.serve(port);
      if (served.isErr()) throw new Error(served.error.message);
      process.stdout.write(`Kairo listening on http://localhost:${port}\n`);
      await new Promise<void>((resolveSignal) => {
        const stop = (): void => {
          served.unwrap().stop();
          resolveSignal();
        };
        process.once('SIGINT', stop);
        process.once('SIGTERM', stop);
      });
      return 0;
    }
    throw new Error(`Unknown command: ${command}`);
  } finally {
    host.dispose();
  }
}

try {
  process.exitCode = await main();
} catch (cause) {
  process.stderr.write(`${cause instanceof Error ? cause.message : 'Kairo failed'}\n`);
  process.exitCode = 1;
}
