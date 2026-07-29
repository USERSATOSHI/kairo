import type { ArtifactView, RunDetails } from '@kouro/api-contracts';

type NodeInvocation = RunDetails['state']['invocations'][number];
type InvocationState = NodeInvocation['state'];

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Returns the operator-facing state while preserving durable runtime semantics. */
export function invocationDisplayState(invocation: NodeInvocation): InvocationState {
  return invocation.outcome === 'failure' ? 'failed' : invocation.state;
}

/** Returns the most useful durable failure detail available for an invocation. */
export function invocationFailure(
  invocation: NodeInvocation,
): { readonly kind: string; readonly message: string } | undefined {
  const attemptFailure = invocation.attempts.findLast(
    ({ failure }) => failure !== undefined,
  )?.failure;
  if (attemptFailure) return attemptFailure;
  if (invocation.outcome !== 'failure' || !isRecord(invocation.output)) return undefined;

  const stderr =
    typeof invocation.output.stderr === 'string' ? invocation.output.stderr.trim() : '';
  if (stderr) return { kind: 'command failure', message: stderr };

  const error = invocation.output.error;
  if (typeof error === 'string' && error.trim()) {
    return { kind: 'command failure', message: error.trim() };
  }
  if (isRecord(error) && typeof error.message === 'string' && error.message.trim()) {
    return { kind: 'command failure', message: error.message.trim() };
  }
  return { kind: 'command failure', message: 'The command exited unsuccessfully.' };
}

/** Formats an artifact byte count with binary units suitable for compact UI metadata. */
export function formatByteSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return `${bytes} B`;
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KiB', 'MiB', 'GiB', 'TiB', 'PiB'] as const;
  let value = bytes;
  let unitIndex = -1;
  do {
    value /= 1024;
    unitIndex += 1;
  } while (value >= 1024 && unitIndex < units.length - 1);
  const precision = value < 10 ? 1 : 0;
  return `${value.toFixed(precision)} ${units[unitIndex]}`;
}

/** Returns the Git diff published for the approval's exact invocation. */
export function approvalDiffArtifact(
  artifacts: readonly ArtifactView[],
  invocationSequence: number,
): ArtifactView | undefined {
  return artifacts.find(
    (artifact) =>
      artifact.kind === 'git_diff' &&
      (artifact.invocationSequence === invocationSequence ||
        (artifact.invocationSequence === undefined &&
          artifact.id.startsWith(`${invocationSequence}:`))),
  );
}
