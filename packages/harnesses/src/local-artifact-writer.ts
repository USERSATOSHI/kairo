import { createHash, randomUUID } from 'node:crypto';
import { link, mkdir, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { err, ok, type Result } from '@usersatoshi/results';

import {
  ArtifactWriterErrorKind,
  type ArtifactWriteRequest,
  type ArtifactWriter,
  type ArtifactWriterError,
} from '@kouro/executors';
import type { ArtifactReference } from '@kouro/domain';

function sha256(content: string): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(content).digest('hex')}`;
}

export class LocalArtifactWriter implements ArtifactWriter {
  constructor(private readonly root: string) {}

  /** Removes the Kouro-owned artifact tree for one run. The operation is idempotent. */
  async deleteRunArtifacts(runId: string): Promise<Result<void, ArtifactWriterError>> {
    const runDirectory = createHash('sha256').update(runId).digest('hex');
    try {
      await rm(resolve(this.root, runDirectory), { recursive: true, force: true });
      return ok(undefined);
    } catch (cause) {
      return err({
        kind: ArtifactWriterErrorKind.WriteFailure,
        message: cause instanceof Error ? cause.message : 'Artifact deletion failed',
      });
    }
  }

  async write(
    request: ArtifactWriteRequest,
  ): Promise<Result<ArtifactReference, ArtifactWriterError>> {
    const runDirectory = createHash('sha256').update(request.runId).digest('hex');
    const directory = resolve(
      this.root,
      runDirectory,
      String(request.invocationSequence),
      String(request.attemptNumber),
    );
    const extension =
      request.kind === 'agent_output' || request.kind === 'command_output'
        ? 'json'
        : request.kind === 'harness_transcript'
          ? 'ndjson'
          : request.kind === 'git_diff'
            ? 'diff'
            : 'txt';
    const filename = `${request.kind}.${extension}`;
    const path = resolve(directory, filename);
    const temporary = resolve(directory, `.${filename}.${randomUUID()}.tmp`);
    try {
      await mkdir(directory, { recursive: true });
      await writeFile(temporary, request.content, { encoding: 'utf8', flag: 'wx' });
      try {
        await link(temporary, path);
      } catch (cause) {
        if (!(cause instanceof Error) || !('code' in cause) || cause.code !== 'EEXIST') {
          throw cause;
        }
        const existing = await readFile(path, 'utf8');
        if (existing !== request.content) {
          throw new Error(`Artifact already exists with different content: ${filename}`, {
            cause,
          });
        }
      }
      await unlink(temporary);
      return ok({
        id: `${request.invocationSequence}:${request.attemptNumber}:${request.kind}`,
        kind: request.kind,
        mediaType: request.mediaType,
        checksum: sha256(request.content),
        size: Buffer.byteLength(request.content),
      });
    } catch (cause) {
      await unlink(temporary).catch(() => undefined);
      return err({
        kind: ArtifactWriterErrorKind.WriteFailure,
        message: cause instanceof Error ? cause.message : 'Artifact write failed',
      });
    }
  }
}
