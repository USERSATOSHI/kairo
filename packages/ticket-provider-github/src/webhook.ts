import { createHmac, timingSafeEqual } from 'node:crypto';

import {
  TicketProviderErrorKind,
  type ProviderTicket,
  type TicketProviderError,
} from '@kouro/tickets';
import { ok, safeCall, type Result } from '@usersatoshi/results';

import { githubError } from './errors.ts';

export function validateGitHubWebhookSignature(
  payload: string,
  signature: string,
  secret: string,
): Result<boolean, TicketProviderError> {
  return safeCall(
    () => {
      const expected = `sha256=${createHmac('sha256', secret).update(payload).digest('hex')}`;
      const actualBytes = Buffer.from(signature);
      const expectedBytes = Buffer.from(expected);
      return (
        actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes)
      );
    },
    () => ({
      kind: TicketProviderErrorKind.InvalidResponse,
      code: 'github_signature_validation_failed',
      message: 'GitHub webhook signature could not be validated',
    }),
  );
}

export function normalizeGitHubIssueWebhook(
  payload: unknown,
  owner: string,
  repository: string,
): Result<ProviderTicket, TicketProviderError> {
  if (
    payload === null ||
    typeof payload !== 'object' ||
    !('issue' in payload) ||
    payload.issue === null ||
    typeof payload.issue !== 'object'
  ) {
    return githubError(
      TicketProviderErrorKind.InvalidResponse,
      'github_invalid_webhook',
      'GitHub webhook does not contain an issue',
    );
  }
  const issue = payload.issue;
  if (
    !('number' in issue) ||
    typeof issue.number !== 'number' ||
    !('title' in issue) ||
    typeof issue.title !== 'string' ||
    !('html_url' in issue) ||
    typeof issue.html_url !== 'string' ||
    !('updated_at' in issue) ||
    typeof issue.updated_at !== 'string' ||
    !('state' in issue) ||
    (issue.state !== 'open' && issue.state !== 'closed')
  ) {
    return githubError(
      TicketProviderErrorKind.InvalidResponse,
      'github_invalid_webhook_issue',
      'GitHub webhook issue is malformed',
    );
  }
  const labels =
    'labels' in issue && Array.isArray(issue.labels)
      ? issue.labels.flatMap((label) =>
          label !== null &&
          typeof label === 'object' &&
          'name' in label &&
          typeof label.name === 'string'
            ? [label.name]
            : [],
        )
      : [];
  const assignees =
    'assignees' in issue && Array.isArray(issue.assignees)
      ? issue.assignees.flatMap((assignee) =>
          assignee !== null &&
          typeof assignee === 'object' &&
          'login' in assignee &&
          typeof assignee.login === 'string'
            ? [assignee.login]
            : [],
        )
      : [];
  return ok({
    binding: {
      kind: 'github',
      owner,
      repository,
      issueNumber: issue.number,
      externalUrl: issue.html_url,
      lastSyncedRevision: issue.updated_at,
    },
    title: issue.title,
    description: 'body' in issue && typeof issue.body === 'string' ? issue.body : '',
    status: issue.state === 'closed' ? 'done' : 'backlog',
    labels,
    assignees,
    revision: issue.updated_at,
    updatedAt: issue.updated_at,
  });
}
