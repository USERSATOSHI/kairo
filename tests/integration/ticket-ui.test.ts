import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, test } from 'bun:test';

import { createKairoApp, KairoTicketRunQuery } from '@kairo/api';
import type { TicketProviderConfigurationView } from '@kairo/api-contracts';
import type { CommandExecution, CommandRunner, CommandRunnerError } from '@kairo/executors';
import { RunCoordinator } from '@kairo/executors';
import { SqliteEventStore } from '@kairo/persistence-sqlite';
import {
  SqliteTicketRepository,
  SqliteTicketRunStore,
  SqliteTicketSyncStore,
  TicketService,
  type TicketClock,
  type TicketIdGenerator,
  type TicketMigration,
} from '@kairo/tickets';
import { type Result } from '@usersatoshi/results';

class UnusedCommandRunner implements CommandRunner {
  execute(): Promise<Result<CommandExecution, CommandRunnerError>> {
    throw new Error('Ticket UI queries do not execute commands');
  }
}

class FixedClock implements TicketClock {
  now(): string {
    return '2026-07-26T20:00:00.000Z';
  }
}

class FixedIds implements TicketIdGenerator {
  ticketId(): string {
    return 'ticket-ui-1';
  }

  commentId(): string {
    return 'comment-ui-1';
  }
}

const providerConfigurations: readonly TicketProviderConfigurationView[] = [
  {
    id: 'local',
    displayName: 'Local SQLite',
    configured: true,
    credentialSource: 'none',
    message: 'Ready',
  },
  {
    id: 'github',
    displayName: 'GitHub Issues',
    configured: true,
    credentialSource: 'server_environment',
    owner: 'acme',
    repository: 'kairo',
    message: 'Token resolved by the server',
  },
];

function migration(stage: TicketMigration['stage'], updatedAt: string): TicketMigration {
  return {
    ticketId: 'ticket-ui-1',
    targetProvider: 'github',
    projectId: 'project-ui',
    marker: 'kairo-ticket:ticket-ui-1',
    stage,
    snapshot: {
      revision: 1,
      title: 'Expose ticket history',
      description: 'Show durable ticket records in one place.',
      status: 'backlog',
      labels: ['ui'],
      assignees: ['satoshi'],
    },
    createdAt: '2026-07-26T20:00:00.000Z',
    updatedAt,
  };
}

describe('T6 ticket API and UI read model', () => {
  test('lists projects, derives a board card, and returns durable ticket history', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'kairo-t6-ticket-ui-'));
    const databasePath = join(directory, 'kairo.sqlite');
    const runStore = new SqliteEventStore(databasePath);
    const tickets = new SqliteTicketRepository(databasePath);
    const ticketRuns = new SqliteTicketRunStore(databasePath);
    const ticketSync = new SqliteTicketSyncStore(databasePath);
    try {
      expect(runStore.initialize().isOk()).toBe(true);
      expect(tickets.initialize().isOk()).toBe(true);
      expect(ticketRuns.initialize().isOk()).toBe(true);
      expect(ticketSync.initialize().isOk()).toBe(true);
      const service = new TicketService(tickets, new FixedClock(), new FixedIds());
      expect(
        service
          .create({
            projectId: 'project-ui',
            title: 'Expose ticket history',
            description: 'Show durable ticket records in one place.',
            priority: 'high',
            labels: ['ui'],
            assignees: ['satoshi'],
          })
          .isOk(),
      ).toBe(true);
      expect(
        service
          .addComment('ticket-ui-1', { author: 'satoshi', body: 'Keep secrets server-side.' })
          .isOk(),
      ).toBe(true);
      expect(
        ticketRuns
          .recordRunStart(
            {
              id: 'snapshot-ui-1',
              runId: 'run-ui-1',
              ticketId: 'ticket-ui-1',
              projectId: 'project-ui',
              title: 'Expose ticket history',
              description: 'Show durable ticket records in one place.',
              priority: 'high',
              labels: ['ui'],
              assignees: ['satoshi'],
              provider: 'local',
              providerRevision: '1',
              capturedAt: '2026-07-26T20:01:00.000Z',
            },
            {
              ticketId: 'ticket-ui-1',
              runId: 'run-ui-1',
              kind: 'implementation',
              createdAt: '2026-07-26T20:01:00.000Z',
            },
          )
          .isOk(),
      ).toBe(true);
      expect(
        ticketSync
          .recordSyncOperation({
            idempotencyKey: 'sync-ui-1',
            ticketId: 'ticket-ui-1',
            provider: 'github',
            operation: 'update',
            status: 'failed',
            request: '{}',
            error: 'provider unavailable',
            updatedAt: '2026-07-26T20:02:00.000Z',
          })
          .isOk(),
      ).toBe(true);
      expect(
        ticketSync.saveMigration(migration('prepared', '2026-07-26T20:03:00.000Z')).isOk(),
      ).toBe(true);
      expect(
        ticketSync.saveMigration(migration('remote_created', '2026-07-26T20:04:00.000Z')).isOk(),
      ).toBe(true);

      const coordinator = new RunCoordinator(runStore, new UnusedCommandRunner());
      const app = createKairoApp({
        runs: runStore,
        coordinator,
        tickets: {
          repository: tickets,
          runs: ticketRuns,
          runQuery: new KairoTicketRunQuery(runStore),
          sync: ticketSync,
        },
        ticketProviders: { list: () => providerConfigurations },
      });

      expect(
        await (await app.handle(new Request('http://kairo.test/ticket-projects'))).json(),
      ).toEqual([{ id: 'project-ui', ticketCount: 1 }]);
      expect(
        await (
          await app.handle(new Request('http://kairo.test/tickets?projectId=project-ui'))
        ).json(),
      ).toEqual([
        expect.objectContaining({
          column: 'backlog',
          ticket: expect.objectContaining({ id: 'ticket-ui-1', priority: 'high' }),
        }),
      ]);
      expect(
        await (await app.handle(new Request('http://kairo.test/tickets/ticket-ui-1'))).json(),
      ).toEqual(
        expect.objectContaining({
          comments: [expect.objectContaining({ id: 'comment-ui-1' })],
          runs: [expect.objectContaining({ runId: 'run-ui-1' })],
          snapshots: [expect.objectContaining({ id: 'snapshot-ui-1' })],
          syncOperations: [
            expect.objectContaining({ idempotencyKey: 'sync-ui-1', status: 'failed' }),
          ],
          migrations: [
            expect.objectContaining({ stage: 'prepared' }),
            expect.objectContaining({ stage: 'remote_created' }),
          ],
        }),
      );
      expect(
        await (await app.handle(new Request('http://kairo.test/ticket-providers'))).json(),
      ).toEqual(providerConfigurations);
    } finally {
      ticketSync.dispose();
      ticketRuns.dispose();
      tickets.dispose();
      runStore.dispose();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
