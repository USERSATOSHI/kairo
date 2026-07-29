import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import type { ArtifactContent } from '@kouro/api-contracts';
import type { ArtifactReference } from '@kouro/domain';
import { err, ok, type Result } from '@usersatoshi/results';

import type { ArtifactContentReader, ArtifactContentReaderError } from './ports.ts';

function extensionFor(kind: ArtifactReference['kind']): string {
  switch (kind) {
    case 'agent_output':
    case 'command_output':
      return 'json';
    case 'harness_transcript':
      return 'ndjson';
    case 'git_diff':
      return 'diff';
    case 'git_status':
      return 'txt';
    case 'delivery_proposal':
      return 'json';
  }
  throw new Error('Unsupported artifact kind');
}

function checksum(content: string): string {
  return `sha256:${createHash('sha256').update(content).digest('hex')}`;
}

function artifactCoordinates(
  artifact: ArtifactReference,
  invocationSequence: number | undefined,
  attemptNumber: number | undefined,
): readonly [number, number] {
  if (invocationSequence !== undefined && attemptNumber !== undefined) {
    return [invocationSequence, attemptNumber];
  }
  const match = /^(\d+):(\d+):/.exec(artifact.id);
  return [invocationSequence ?? Number(match?.[1] ?? 0), attemptNumber ?? Number(match?.[2] ?? 0)];
}

/** Reads and verifies artifacts written by LocalArtifactWriter. */
export class LocalArtifactContentReader implements ArtifactContentReader {
  constructor(private readonly root: string) {}

  async read(
    runId: string,
    artifact: ArtifactReference,
    invocationSequence?: number,
    attemptNumber?: number,
  ): Promise<Result<ArtifactContent, ArtifactContentReaderError>> {
    const runDirectory = createHash('sha256').update(runId).digest('hex');
    const filename = `${artifact.kind}.${extensionFor(artifact.kind)}`;
    const [artifactInvocation, artifactAttempt] = artifactCoordinates(
      artifact,
      invocationSequence,
      attemptNumber,
    );
    try {
      const content = await readFile(
        resolve(
          this.root,
          runDirectory,
          String(artifactInvocation),
          String(artifactAttempt),
          filename,
        ),
        'utf8',
      );
      if (checksum(content) !== artifact.checksum || Buffer.byteLength(content) !== artifact.size) {
        return err({ kind: 0, message: `Artifact ${artifact.id} failed checksum verification` });
      }
      return ok({ mediaType: artifact.mediaType, content });
    } catch (cause) {
      return err({
        kind: 0,
        message:
          cause instanceof Error ? cause.message : `Artifact ${artifact.id} could not be read`,
      });
    }
  }
}
