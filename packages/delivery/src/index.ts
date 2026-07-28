import { createHash } from 'node:crypto';

import type { DeliveryMetadata } from '@kouro/domain';
import { err, ok, type Result } from '@usersatoshi/results';

export const enum DeliveryErrorKind {
  InvalidMetadata = 0,
  Authentication = 1,
  NotFound = 2,
  Conflict = 3,
  Unavailable = 4,
  InvalidResponse = 5,
}

export interface DeliveryError {
  readonly kind: DeliveryErrorKind;
  readonly code: string;
  readonly message: string;
}

export interface PullRequestTarget {
  readonly owner: string;
  readonly repository: string;
  readonly head: string;
  readonly base: string;
}

export interface PullRequestDetails extends PullRequestTarget {
  readonly number: number;
  readonly url: string;
  readonly title: string;
  readonly draft: boolean;
}

export interface CreatePullRequestInput extends PullRequestTarget {
  readonly title: string;
  readonly body?: string;
  readonly draft: boolean;
}

/** Provider-neutral, verify-then-create pull-request boundary. */
export interface PullRequestProvider {
  readonly id: 'github' | 'forgejo';
  find(input: PullRequestTarget): Promise<Result<PullRequestDetails | undefined, DeliveryError>>;
  create(input: CreatePullRequestInput): Promise<Result<PullRequestDetails, DeliveryError>>;
}

function error(code: string, message: string): Result<never, DeliveryError> {
  return err({ kind: DeliveryErrorKind.InvalidMetadata, code, message });
}

function validTitle(value: string): boolean {
  return Boolean(value.trim()) && !/[\r\n]/.test(value);
}

/** Validates and normalizes operator-editable commit and pull-request metadata. */
export function validateDeliveryMetadata(
  value: DeliveryMetadata,
): Result<DeliveryMetadata, DeliveryError> {
  if (!validTitle(value.commitTitle)) {
    return error('invalid_commit_title', 'Commit title must be a non-empty single line');
  }
  if (!validTitle(value.pullRequestTitle)) {
    return error(
      'invalid_pull_request_title',
      'Pull request title must be a non-empty single line',
    );
  }
  if (typeof value.draft !== 'boolean') {
    return error('invalid_draft_state', 'Draft must be a boolean');
  }
  return ok({
    commitTitle: value.commitTitle.trim(),
    ...(value.commitBody?.trim() ? { commitBody: value.commitBody.trim() } : {}),
    pullRequestTitle: value.pullRequestTitle.trim(),
    ...(value.pullRequestBody?.trim() ? { pullRequestBody: value.pullRequestBody.trim() } : {}),
    draft: value.draft,
  });
}

export function deliveryMetadataChecksum(
  preparedHead: string,
  preparedTree: string,
  artifactChecksums: readonly string[],
  metadata: DeliveryMetadata,
): `sha256:${string}` {
  const canonical = JSON.stringify({
    artifactChecksums: [...artifactChecksums].toSorted(),
    metadata,
    preparedHead,
    preparedTree,
  });
  return `sha256:${createHash('sha256').update(canonical).digest('hex')}`;
}

/** Reconciles an interrupted publication before attempting a provider create. */
export async function ensurePullRequest(
  provider: PullRequestProvider,
  input: CreatePullRequestInput,
): Promise<Result<PullRequestDetails, DeliveryError>> {
  const existing = await provider.find(input);
  if (existing.isErr()) return existing;
  return existing.value ? ok(existing.value) : provider.create(input);
}
