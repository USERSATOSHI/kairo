import type { RunDetails } from '@kouro/api-contracts';
import { estimateCostUsd, type TokenUsage } from '@kouro/domain';

import { invocationDisplayState } from './execution-presentation.ts';

/**
 * Deterministic swimlane timeline for a run.
 *
 * Kouro persists invocation activation order but no per-attempt wall-clock
 * spans, so the horizontal axis is the logical activation sequence, not
 * elapsed time. A block at tick k means the run's k-th invocation activation
 * belonged to that node. This keeps the view byte-stable for a given durable
 * history: replaying the same events yields the same waterfall.
 */

export interface TimelineBlock {
  readonly invocationSequence: number;
  readonly nodeId: string;
  readonly state: string;
  readonly attemptCount: number;
  readonly model?: string;
  readonly harnessId?: string;
  /** Token usage reported by the latest attempt, when any harness reported it. */
  readonly usage?: TokenUsage;
  /** Estimated USD cost of the latest attempt, when its model is priced. */
  readonly costUsd?: number;
  /** True when the invocation was reserved but never activated. */
  readonly queued: boolean;
}

export interface TimelineLane {
  readonly nodeId: string;
  readonly title: string;
  readonly nodeType: string;
  readonly ordinal: number;
  readonly blocks: readonly TimelineBlock[];
}

export interface TimelineModel {
  readonly lanes: readonly TimelineLane[];
  /** Highest reserved invocation sequence; the waterfall spans 1..tickCount. */
  readonly tickCount: number;
}

export function isTerminalRun(status: RunDetails['status']): boolean {
  return status === 'succeeded' || status === 'failed' || status === 'cancelled';
}

function displayedState(
  run: RunDetails,
  node: RunDetails['nodes'][number] | undefined,
  invocation: RunDetails['state']['invocations'][number],
): string {
  if (node?.type === 'complete' && invocation.state === 'pending' && isTerminalRun(run.status)) {
    return run.status;
  }
  return invocationDisplayState(invocation);
}

export function timelineModel(run: RunDetails): TimelineModel {
  const blocks: TimelineBlock[] = run.state.invocations.map((invocation) => {
    const node = run.nodes.find(({ id }) => id === invocation.nodeId);
    const attempt = invocation.attempts.at(-1);
    const usage = attempt?.usage;
    return {
      invocationSequence: invocation.sequence,
      nodeId: invocation.nodeId,
      state: displayedState(run, node, invocation),
      attemptCount: invocation.attempts.length,
      model: attempt?.model,
      harnessId: attempt?.harnessId,
      ...(usage ? { usage } : {}),
      ...(usage && attempt?.model
        ? (() => {
            const costUsd = estimateCostUsd(usage, attempt.model);
            return costUsd === undefined ? {} : { costUsd };
          })()
        : {}),
      queued: invocation.state === 'pending',
    };
  });
  blocks.sort((left, right) => left.invocationSequence - right.invocationSequence);
  const lanes = run.nodes
    .toSorted((left, right) => left.ordinal - right.ordinal)
    .map((node) => ({
      nodeId: node.id,
      title: node.title,
      nodeType: node.type,
      ordinal: node.ordinal,
      blocks: blocks.filter((block) => block.nodeId === node.id),
    }));
  const tickCount = blocks.reduce(
    (maximum, block) => Math.max(maximum, block.invocationSequence),
    0,
  );
  return { lanes, tickCount };
}
