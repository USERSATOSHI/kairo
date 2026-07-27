import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import type { TicketPriority, TicketStatus, UpdateTicketInput } from '@kouro/tickets';
import type { Result } from '@usersatoshi/results';

import type { LocalKouroHost } from './local-host.ts';

const priorities: readonly TicketPriority[] = ['low', 'medium', 'high', 'critical'];
const statuses: readonly TicketStatus[] = ['backlog', 'ready', 'blocked', 'done', 'cancelled'];

function option(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
}

function options(args: readonly string[], name: string): readonly string[] {
  const values: string[] = [];
  for (const [index, value] of args.entries()) {
    const selected = args[index + 1];
    if (value === name && selected) values.push(selected);
  }
  return values;
}

function required(value: string | undefined, label: string): string {
  if (!value?.trim()) throw new Error(`${label} is required`);
  return value.trim();
}

function revision(args: readonly string[]): number {
  const value = Number(required(option(args, '--revision'), '--revision'));
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error('--revision must be a positive integer');
  }
  return value;
}

function priority(value: string | undefined): TicketPriority | undefined {
  switch (value) {
    case undefined:
      return undefined;
    case 'low':
    case 'medium':
    case 'high':
    case 'critical':
      return value;
  }
  throw new Error(`--priority must be one of: ${priorities.join(', ')}`);
}

function status(value: string | undefined): TicketStatus {
  const selected = required(value, '--status');
  switch (selected) {
    case 'backlog':
    case 'ready':
    case 'blocked':
    case 'done':
    case 'cancelled':
      return selected;
  }
  throw new Error(`--status must be one of: ${statuses.join(', ')}`);
}

function remoteProvider(value: string | undefined): 'github' | 'forgejo' {
  const selected = required(value, 'provider');
  if (selected !== 'github' && selected !== 'forgejo') {
    throw new Error('provider must be github or forgejo');
  }
  return selected;
}

function failure(error: unknown): Error {
  return new Error(
    typeof error === 'object' && error !== null && 'message' in error
      ? String(error.message)
      : JSON.stringify(error),
  );
}

function unwrap<T, E extends { readonly kind: number }>(result: Result<T, E>): T {
  if (result.isErr()) throw failure(result.error);
  return result.value;
}

function configured<T>(value: T | undefined, provider: string): T {
  if (value === undefined) {
    throw new Error(
      `${provider} is not configured; run "kouro ticket providers" for required environment variables`,
    );
  }
  return value;
}

async function description(args: readonly string[]): Promise<string> {
  const inline = option(args, '--description');
  const file = option(args, '--description-file');
  if (inline && file) throw new Error('Use one of --description or --description-file');
  return file ? readFile(resolve(file), 'utf8') : required(inline, '--description');
}

/** Executes the ticket CLI without leaking transport parsing into ticket services. */
export async function executeTicketCommand(
  host: LocalKouroHost,
  args: readonly string[],
  actor: string,
): Promise<unknown> {
  const command = required(args[0], 'ticket command');
  if (command === 'providers') return host.ticketProviderConfigurations();
  if (command === 'create') {
    const selectedPriority = priority(option(args, '--priority'));
    return unwrap(
      host.createTicket({
        projectId: required(option(args, '--project'), '--project'),
        title: required(option(args, '--title'), '--title'),
        description: await description(args),
        ...(selectedPriority ? { priority: selectedPriority } : {}),
        labels: options(args, '--label'),
        assignees: options(args, '--assignee'),
      }),
    );
  }
  if (command === 'list') {
    return unwrap(host.listTickets(required(option(args, '--project'), '--project')));
  }
  if (command === 'show') return unwrap(host.getTicket(required(args[1], 'ticket-id')));
  if (command === 'update') {
    const selectedPriority = priority(option(args, '--priority'));
    const input: UpdateTicketInput = {
      expectedRevision: revision(args),
      ...(option(args, '--title') ? { title: option(args, '--title') } : {}),
      ...(option(args, '--description') ? { description: option(args, '--description') } : {}),
      ...(selectedPriority ? { priority: selectedPriority } : {}),
      ...(args.includes('--label') ? { labels: options(args, '--label') } : {}),
      ...(args.includes('--assignee') ? { assignees: options(args, '--assignee') } : {}),
    };
    return unwrap(host.updateTicket(required(args[1], 'ticket-id'), input));
  }
  if (command === 'move') {
    return unwrap(
      host.moveTicket(
        required(args[1], 'ticket-id'),
        revision(args),
        status(option(args, '--status')),
      ),
    );
  }
  if (command === 'close' || command === 'cancel' || command === 'reopen') {
    const ticketId = required(args[1], 'ticket-id');
    const expectedRevision = revision(args);
    const result =
      command === 'close'
        ? host.closeTicket(ticketId, expectedRevision)
        : command === 'cancel'
          ? host.cancelTicket(ticketId, expectedRevision)
          : host.reopenTicket(ticketId, expectedRevision);
    return unwrap(result);
  }
  if (command === 'comment') {
    return unwrap(
      host.addTicketComment(
        required(args[1], 'ticket-id'),
        option(args, '--author') ?? actor,
        required(option(args, '--body'), '--body'),
      ),
    );
  }
  if (command === 'import') {
    const provider = remoteProvider(args[1]);
    return unwrap(
      configured(
        await host.importTickets(provider, required(option(args, '--project'), '--project')),
        provider,
      ),
    );
  }
  if (command === 'pull') {
    const ticketId = required(args[1], 'ticket-id');
    const ticket = unwrap(host.getTicket(ticketId));
    if (ticket.binding.kind === 'local') throw new Error('A local ticket cannot be pulled');
    return unwrap(configured(await host.pullTicket(ticketId), ticket.binding.kind));
  }
  if (command === 'push') {
    const ticketId = required(args[1], 'ticket-id');
    const ticket = unwrap(host.getTicket(ticketId));
    if (ticket.binding.kind === 'local')
      throw new Error('Migrate a local ticket before pushing it');
    return unwrap(
      configured(
        await host.pushTicket(ticketId, `cli:push:${crypto.randomUUID()}`),
        ticket.binding.kind,
      ),
    );
  }
  if (command === 'migrate') {
    const provider = remoteProvider(option(args, '--to'));
    return unwrap(
      configured(
        await host.migrateTicket(
          required(args[1], 'ticket-id'),
          required(option(args, '--project'), '--project'),
          provider,
        ),
        provider,
      ),
    );
  }
  throw new Error(`Unknown ticket command: ${command}`);
}
