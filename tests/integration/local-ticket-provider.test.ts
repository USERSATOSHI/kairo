import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, test } from 'bun:test';

import { LocalTicketProvider } from '@kairo/ticket-provider-local';
import { TicketErrorKind, type TicketClock, type TicketIdGenerator } from '@kairo/tickets';

class SteppingClock implements TicketClock {
  private sequence = 0;

  now(): string {
    this.sequence += 1;
    return `2026-07-26T00:00:0${this.sequence}.000Z`;
  }
}

class ScriptedIds implements TicketIdGenerator {
  private ticketSequence = 0;
  private commentSequence = 0;

  ticketId(): string {
    this.ticketSequence += 1;
    return `ticket-${this.ticketSequence}`;
  }

  commentId(): string {
    this.commentSequence += 1;
    return `comment-${this.commentSequence}`;
  }
}

function databasePath(): { readonly directory: string; readonly path: string } {
  const directory = mkdtempSync(join(tmpdir(), 'kairo-tickets-'));
  return {
    directory,
    path: join(directory, 'tickets.sqlite'),
  };
}

describe('T1 local ticket foundation', () => {
  test('persists a complete local lifecycle without Git or a provider', () => {
    const location = databasePath();
    const options = { clock: new SteppingClock(), ids: new ScriptedIds() };
    let provider = new LocalTicketProvider(location.path, options);
    try {
      expect(provider.initialize().isOk()).toBe(true);

      const created = provider
        .create({
          projectId: 'greenfield',
          title: 'Create a local plan',
          description: 'The project does not have a repository yet.',
          priority: 'critical',
          labels: ['planning', 'local', 'planning'],
          assignees: ['satoshi'],
        })
        .unwrap();
      expect(created).toMatchObject({
        id: 'ticket-1',
        status: 'backlog',
        revision: 1,
        binding: { kind: 'local' },
        labels: ['local', 'planning'],
      });

      const ready = provider.move(created.id, created.revision, 'ready').unwrap();
      expect(ready).toMatchObject({ status: 'ready', revision: 2 });

      const updated = provider
        .update(ready.id, {
          expectedRevision: ready.revision,
          title: 'Create the local plan',
          labels: ['planning', 'accepted'],
        })
        .unwrap();
      expect(updated).toMatchObject({
        title: 'Create the local plan',
        revision: 3,
        labels: ['accepted', 'planning'],
      });

      provider
        .addComment(updated.id, {
          author: 'user:satoshi',
          body: 'Keep this independent from Git.',
        })
        .unwrap();
      expect(provider.listComments(updated.id).unwrap()).toEqual([
        {
          id: 'comment-1',
          ticketId: 'ticket-1',
          author: 'user:satoshi',
          body: 'Keep this independent from Git.',
          binding: { kind: 'local' },
          createdAt: '2026-07-26T00:00:04.000Z',
        },
      ]);

      const dependent = provider
        .create({
          projectId: 'greenfield',
          title: 'Initialize the repository later',
          description: '',
        })
        .unwrap();
      provider
        .addRelationship({
          sourceTicketId: updated.id,
          targetTicketId: dependent.id,
          kind: 'blocks',
        })
        .unwrap();
      expect(provider.listRelationships(updated.id).unwrap()).toEqual([
        {
          sourceTicketId: 'ticket-1',
          targetTicketId: 'ticket-2',
          kind: 'blocks',
        },
      ]);

      const afterComment = provider.get(updated.id).unwrap();
      expect(afterComment.revision).toBe(4);
      const stale = provider.update(updated.id, {
        expectedRevision: updated.revision,
        description: 'stale edit',
      });
      if (stale.isOk()) throw new Error('Expected stale revision failure');
      expect(stale.error).toEqual({
        kind: TicketErrorKind.RevisionConflict,
        ticketId: 'ticket-1',
        expected: 3,
        actual: 4,
      });

      const invalidMove = provider.move(afterComment.id, afterComment.revision, 'done');
      if (invalidMove.isOk()) throw new Error('Expected invalid planning move');
      expect(invalidMove.error.kind).toBe(TicketErrorKind.InvalidStatusTransition);

      const closed = provider.close(afterComment.id, afterComment.revision).unwrap();
      expect(closed).toMatchObject({ status: 'done', revision: 5 });
      const reopened = provider.reopen(closed.id, closed.revision).unwrap();
      expect(reopened).toMatchObject({ status: 'ready', revision: 6 });

      provider.dispose();
      provider = new LocalTicketProvider(location.path, options);
      expect(provider.initialize().isOk()).toBe(true);
      expect(
        provider
          .list('greenfield')
          .unwrap()
          .map(({ id }) => id)
          .toSorted(),
      ).toEqual(['ticket-1', 'ticket-2']);
      expect(provider.get('ticket-1').unwrap()).toMatchObject({
        id: 'ticket-1',
        status: 'ready',
        revision: 6,
      });
    } finally {
      provider.dispose();
      rmSync(location.directory, { recursive: true, force: true });
    }
  });

  test('rejects duplicate and self relationships with typed failures', () => {
    const location = databasePath();
    const provider = new LocalTicketProvider(location.path, {
      clock: new SteppingClock(),
      ids: new ScriptedIds(),
    });
    try {
      expect(provider.initialize().isOk()).toBe(true);
      const first = provider
        .create({ projectId: 'project', title: 'First', description: '' })
        .unwrap();
      const second = provider
        .create({ projectId: 'project', title: 'Second', description: '' })
        .unwrap();
      const relationship = {
        sourceTicketId: first.id,
        targetTicketId: second.id,
        kind: 'related' as const,
      };
      provider.addRelationship(relationship).unwrap();
      const duplicate = provider.addRelationship(relationship);
      if (duplicate.isOk()) throw new Error('Expected duplicate relationship failure');
      expect(duplicate.error.kind).toBe(TicketErrorKind.RelationshipConflict);

      const selfRelationship = provider.addRelationship({
        sourceTicketId: first.id,
        targetTicketId: first.id,
        kind: 'related',
      });
      if (selfRelationship.isOk()) throw new Error('Expected self-relationship failure');
      expect(selfRelationship.error.kind).toBe(TicketErrorKind.RelationshipConflict);
    } finally {
      provider.dispose();
      rmSync(location.directory, { recursive: true, force: true });
    }
  });
});
