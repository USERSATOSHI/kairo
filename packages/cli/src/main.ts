#!/usr/bin/env bun

import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { listRuns, getRun } from '@kouro/api';

import { ADW_TEMPLATES, createAdw, isAdwTemplate } from './create-adw.ts';
import { LocalKouroHost } from './local-host.ts';
import { executeTicketCommand } from './ticket-command.ts';

const VERSION = '0.1.0';
const HELP = `Kouro ${VERSION}

Usage:
  kouro <command> [options]

Common usage:
  kouro create adw <name> [--template <template>] [--output <directory>]
  kouro run <adw> --repo <path> (--ticket <provider:reference> | --task <text> | --task-file <path>)
  kouro pause|resume|cancel <run-id>
  kouro serve [--repo <path>]

Workflow:
  create adw      Create an ADW package from a starter template
  run             Compile and execute an ADW

Runs:
  runs            List runs for the current repository
  status          Show one run
  delete          Permanently delete one terminal run
  approve         Grant a pending approval
  reject          Reject a pending approval
  pause           Pause scheduling for a run
  resume          Resume a paused run
  cancel          Cancel a run
  interrupt       Interrupt an active invocation
  retry           Retry an interrupted invocation
  skip            Skip a policy-eligible invocation

Planning:
  ticket          Create, inspect, move, sync, and migrate tickets

Host:
  serve           Serve the current repository dashboard and API
  diagnostics     Report available agent harnesses

Global options:
  -h, --help      Show help
  -v, --version   Show version

Run "kouro help <command>" for command-specific usage.

ADW templates: ${ADW_TEMPLATES.join(', ')}`;

const COMMAND_HELP: Readonly<Record<string, string>> = {
  create: `Usage:
  kouro create adw <name> [--template <template>] [--output <directory>]

Creates .kouro/<name> by default.
Templates: ${ADW_TEMPLATES.join(', ')}`,
  run: `Usage:
  kouro run <adw> --repo <path> (--ticket <provider:reference> | --task <text> | --task-file <path>) [--harness <id|node=id>]...

Examples:
  kouro run feature-development --repo . --task "Add CSV export" --harness codex
  kouro run feature-development --repo . --ticket kouro:<ticket-id> --harness plan=codex`,
  runs: `Usage:
  kouro runs [--repo <path> | --all-repos]

Lists the current repository by default.`,
  status: `Usage:
  kouro status <run-id> [--repo <path> | --all-repos]`,
  delete: `Usage:
  kouro delete <run-id> --yes [--repo <path> | --all-repos]

Permanently removes a terminal run, its Kouro worktree, artifacts, events, and projections.
The source repository and delivery branch are preserved.`,
  approve: `Usage:
  kouro approve <run-id> <invocation> --reason <text>`,
  reject: `Usage:
  kouro reject <run-id> <invocation> --reason <text>`,
  pause: `Usage:
  kouro pause|resume|cancel <run-id> [--reason <text>]`,
  resume: `Usage:
  kouro pause|resume|cancel <run-id> [--reason <text>]`,
  cancel: `Usage:
  kouro pause|resume|cancel <run-id> [--reason <text>]`,
  interrupt: `Usage:
  kouro interrupt|retry|skip <run-id> <invocation> --reason <text>`,
  retry: `Usage:
  kouro interrupt|retry|skip <run-id> <invocation> --reason <text>`,
  skip: `Usage:
  kouro interrupt|retry|skip <run-id> <invocation> --reason <text>`,
  ticket: `Usage:
  kouro ticket create --project <id> --title <text> (--description <text> | --description-file <path>) [options]
  kouro ticket list --project <id>
  kouro ticket show <ticket-id>
  kouro ticket update <ticket-id> --revision <number> [options]
  kouro ticket move <ticket-id> --revision <number> --status <status>
  kouro ticket close|cancel|reopen <ticket-id> --revision <number>
  kouro ticket comment <ticket-id> --body <text> [--author <name>]
  kouro ticket providers
  kouro ticket import <github|forgejo> --project <id>
  kouro ticket pull|push <ticket-id>
  kouro ticket migrate <ticket-id> --to <github|forgejo> --project <id>`,
  serve: `Usage:
  kouro serve [--port <number>] [--repo <path> | --all-repos]

Serves only the current repository by default. It can monitor a CLI-owned run
without interrupting it and takes over execution when the worker lease becomes available.`,
  diagnostics: `Usage:
  kouro diagnostics`,
};

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
  if (command === 'help') {
    process.stdout.write(`${COMMAND_HELP[args[1] ?? ''] ?? HELP}\n`);
    return 0;
  }
  if (command === '--version' || command === '-v') {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write(`${COMMAND_HELP[command] ?? HELP}\n`);
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
      outputDirectory: resolve(option(args, '--output') ?? resolve(process.cwd(), '.kouro')),
    });
    if (result.isErr()) throw new Error(`${result.error.code}: ${result.error.message}`);
    print(result.unwrap());
    return 0;
  }

  const host = new LocalKouroHost();
  const initialized = await host.initialize();
  if (initialized.isErr())
    throw new Error(`${initialized.error.code}: ${initialized.error.message}`);
  const actor = process.env.USER?.trim() || 'local-operator';
  try {
    if (command === 'ticket') {
      print(await executeTicketCommand(host, args.slice(1), actor));
      return 0;
    }
    if (command === 'run') {
      const { harnesses, harnessesByNode } = harnessOptions(args);
      const taskFile = option(args, '--task-file');
      const inlineTask = option(args, '--task');
      if (taskFile && inlineTask) {
        throw new Error('Use exactly one of --task and --task-file');
      }
      const task = taskFile ? await readFile(resolve(taskFile), 'utf8') : inlineTask;
      const ticket = option(args, '--ticket');
      const result = await host.create({
        adw: required(args[1], 'adw'),
        repositoryPath: required(option(args, '--repo'), '--repo'),
        ...(task ? { task } : {}),
        ...(ticket ? { ticket } : {}),
        ...(harnesses.length ? { harnesses } : {}),
        ...(Object.keys(harnessesByNode).length ? { harnessesByNode } : {}),
        actor,
      });
      if (result.isErr()) throw new Error(`${result.error.code}: ${result.error.message}`);
      print(result.unwrap());
      return 0;
    }
    if (command === 'runs') {
      const runs = args.includes('--all-repos')
        ? host.store
        : host.runStoreForRepository(resolve(option(args, '--repo') ?? process.cwd()));
      const result = listRuns({ runs, coordinator: host.coordinator() });
      if (result.isErr()) throw new Error(result.error.message);
      print(result.unwrap());
      return 0;
    }
    if (command === 'status') {
      const runs = args.includes('--all-repos')
        ? host.store
        : host.runStoreForRepository(resolve(option(args, '--repo') ?? process.cwd()));
      const result = getRun({ runs, coordinator: host.coordinator() }, required(args[1], 'run-id'));
      if (result.isErr()) throw new Error(result.error.message);
      print(result.unwrap());
      return 0;
    }
    if (command === 'delete') {
      if (!args.includes('--yes')) {
        throw new Error('Run deletion is permanent; pass --yes to confirm');
      }
      const runId = required(args[1], 'run-id');
      const runs = args.includes('--all-repos')
        ? host.store
        : host.runStoreForRepository(resolve(option(args, '--repo') ?? process.cwd()));
      const visible = runs.loadRun(runId);
      if (visible.isErr()) throw new Error(`Run ${runId} was not found in this repository`);
      const deleted = await host.delete(runId);
      if (deleted.isErr()) throw new Error(`${deleted.error.code}: ${deleted.error.message}`);
      print(deleted.unwrap());
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
      const repositoryPath = args.includes('--all-repos')
        ? undefined
        : resolve(option(args, '--repo') ?? process.cwd());
      const served = await host.serve(port, repositoryPath);
      if (served.isErr()) throw new Error(served.error.message);
      process.stdout.write(
        `Kouro listening on http://localhost:${port} (${repositoryPath ?? 'all repositories'})\n`,
      );
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
  process.stderr.write(`${cause instanceof Error ? cause.message : 'Kouro failed'}\n`);
  process.exitCode = 1;
}
