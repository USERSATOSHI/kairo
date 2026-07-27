import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, test } from 'bun:test';

import {
  SqliteTicketRepository,
  SqliteTicketRunStore,
  TicketErrorKind,
  TicketRunService,
  TicketService,
  type TicketClock,
  type TicketError,
  type TicketIdGenerator,
  type TicketRunLauncher,
  type TicketRunQuery,
  type TicketRunView,
  type TicketSnapshot,
} from '@kouro/tickets';
import { ok, type Result } from '@usersatoshi/results';

class FixedClock implements TicketClock {
  now(): string {
    return '2026-07-26T10:00:00.000Z';
  }
}

class FixedIds implements TicketIdGenerator {
  ticketId(): string {
    return 'ticket-1';
  }
  commentId(): string {
    return 'comment-1';
  }
  snapshotId(): string {
    return 'snapshot-1';
  }
}

class FakeLauncher implements TicketRunLauncher {
  snapshot?: TicketSnapshot;

  start(input: {
    readonly snapshot: TicketSnapshot;
  }): Promise<Result<{ readonly runId: string }, TicketError>> {
    this.snapshot = input.snapshot;
    return Promise.resolve(ok({ runId: 'run-1' }));
  }
}

class FakeRunQuery implements TicketRunQuery {
  readonly views = new Map<string, TicketRunView>();

  get(runId: string): Result<TicketRunView | undefined, TicketError> {
    return ok(this.views.get(runId));
  }
}

describe('T2 ticket-to-run integration', () => {
  test('captures an immutable snapshot, links history, and prevents parallel implementation', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'kouro-ticket-runs-'));
    const path = join(directory, 'kouro.sqlite');
    const tickets = new SqliteTicketRepository(path);
    const runs = new SqliteTicketRunStore(path);
    try {
      expect(tickets.initialize().isOk()).toBe(true);
      expect(runs.initialize().isOk()).toBe(true);
      const ids = new FixedIds();
      const ticketService = new TicketService(tickets, new FixedClock(), ids);
      const created = ticketService
        .create({
          projectId: 'project-1',
          title: 'Original objective',
          description: 'Original description',
          labels: ['runtime'],
          assignees: ['satoshi'],
        })
        .unwrap();
      const launcher = new FakeLauncher();
      const query = new FakeRunQuery();
      const service = new TicketRunService(tickets, runs, query, launcher, new FixedClock(), ids);

      const link = await service.start({
        ticketId: created.id,
        kind: 'implementation',
        workflow: 'feature-development',
        repositoryPath: '/repo',
        actor: 'user:satoshi',
      });
      expect(link.unwrap()).toEqual({
        ticketId: 'ticket-1',
        runId: 'run-1',
        kind: 'implementation',
        createdAt: '2026-07-26T10:00:00.000Z',
      });
      expect(launcher.snapshot).toMatchObject({
        id: 'snapshot-1',
        runId: '',
        title: 'Original objective',
        provider: 'local',
        providerRevision: '1',
      });

      ticketService
        .update(created.id, {
          expectedRevision: 1,
          title: 'Changed after run start',
        })
        .unwrap();
      expect(runs.listSnapshots(created.id).unwrap()).toEqual([
        {
          id: 'snapshot-1',
          runId: 'run-1',
          ticketId: 'ticket-1',
          projectId: 'project-1',
          title: 'Original objective',
          description: 'Original description',
          labels: ['runtime'],
          assignees: ['satoshi'],
          provider: 'local',
          providerRevision: '1',
          capturedAt: '2026-07-26T10:00:00.000Z',
        },
      ]);

      query.views.set('run-1', {
        runId: 'run-1',
        active: true,
        column: 'implementing',
      });
      expect(service.board('project-1').unwrap()[0]?.column).toBe('implementing');

      const duplicate = await service.start({
        ticketId: created.id,
        kind: 'implementation',
        workflow: 'feature-development',
        repositoryPath: '/repo',
        actor: 'user:satoshi',
      });
      if (duplicate.isOk()) throw new Error('Expected active-run conflict');
      expect(duplicate.error.kind).toBe(TicketErrorKind.InvalidInput);
    } finally {
      runs.dispose();
      tickets.dispose();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
