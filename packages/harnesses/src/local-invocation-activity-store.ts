import { createHash } from 'node:crypto';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import type { InvocationActivitySession, InvocationActivitySink } from '@kouro/executors';
import { err, ok, type Result } from '@usersatoshi/results';

export interface InvocationActivityContent {
  readonly harnessId: string;
  readonly role: string;
  readonly prompt: string;
  readonly transcript: string;
  readonly complete: boolean;
}

export interface InvocationActivityReadError {
  readonly kind: 0;
  readonly message: string;
}

interface ActivityHeader {
  readonly type: 'kouro.activity.started';
  readonly harnessId: string;
  readonly role: string;
  readonly prompt: string;
}

function isNotFound(cause: unknown): boolean {
  return cause instanceof Error && 'code' in cause && cause.code === 'ENOENT';
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseHeader(value: string): ActivityHeader | undefined {
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) &&
      parsed.type === 'kouro.activity.started' &&
      typeof parsed.harnessId === 'string' &&
      typeof parsed.role === 'string' &&
      typeof parsed.prompt === 'string'
      ? {
          type: 'kouro.activity.started',
          harnessId: parsed.harnessId,
          role: parsed.role,
          prompt: parsed.prompt,
        }
      : undefined;
  } catch {
    return undefined;
  }
}

export class LocalInvocationActivityStore implements InvocationActivitySink {
  constructor(private readonly root: string) {}

  async start(session: InvocationActivitySession): Promise<void> {
    const path = this.pathFor(session);
    await mkdir(dirname(path), { recursive: true });
    const header: ActivityHeader = {
      type: 'kouro.activity.started',
      harnessId: session.harnessId,
      role: session.role,
      prompt: session.prompt,
    };
    await writeFile(path, `${JSON.stringify(header)}\n`, 'utf8');
  }

  async append(session: InvocationActivitySession, chunk: string): Promise<void> {
    await appendFile(this.pathFor(session), chunk, 'utf8');
  }

  async finish(session: InvocationActivitySession): Promise<void> {
    await appendFile(
      this.pathFor(session),
      `\n${JSON.stringify({ type: 'kouro.activity.finished' })}\n`,
      'utf8',
    );
  }

  async read(
    runId: string,
    invocationSequence: number,
    attemptNumber: number,
  ): Promise<Result<InvocationActivityContent | undefined, InvocationActivityReadError>> {
    try {
      const content = await readFile(
        this.pathFor({ runId, invocationSequence, attemptNumber }),
        'utf8',
      );
      const headerEnd = content.indexOf('\n');
      const header = headerEnd < 0 ? undefined : parseHeader(content.slice(0, headerEnd));
      if (!header) {
        return err({ kind: 0, message: 'Invocation activity metadata is malformed' });
      }
      const marker = `\n${JSON.stringify({ type: 'kouro.activity.finished' })}\n`;
      const complete = content.endsWith(marker);
      return ok({
        harnessId: header.harnessId,
        role: header.role,
        prompt: header.prompt,
        transcript: content.slice(headerEnd + 1, complete ? -marker.length : undefined),
        complete,
      });
    } catch (cause) {
      return isNotFound(cause)
        ? ok(undefined)
        : err({
            kind: 0,
            message:
              cause instanceof Error ? cause.message : 'Invocation activity could not be read',
          });
    }
  }

  private pathFor(
    session: Pick<InvocationActivitySession, 'runId' | 'invocationSequence' | 'attemptNumber'>,
  ): string {
    const runDirectory = createHash('sha256').update(session.runId).digest('hex');
    return resolve(
      this.root,
      runDirectory,
      String(session.invocationSequence),
      String(session.attemptNumber),
      'activity.ndjson',
    );
  }
}
