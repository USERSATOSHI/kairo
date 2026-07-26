import type { RunAggregate } from '@kairo/executors';
import type { SqliteEventStore } from '@kairo/persistence-sqlite';

export interface WorkerRunServices {
  coordinatorFor(aggregate: RunAggregate): import('@kairo/executors').RunCoordinator;
  finalize(aggregate: RunAggregate): Promise<void>;
}

function stableBoundary(aggregate: RunAggregate): boolean {
  return (
    aggregate.state.status !== 'running' ||
    aggregate.state.invocations.some(({ state }) => state === 'waiting_for_approval')
  );
}

export class LocalWorker {
  private timer: ReturnType<typeof setInterval> | undefined;
  private advancing = false;
  private readonly blockedAtSequence = new Map<string, number>();

  constructor(
    private readonly store: SqliteEventStore,
    private readonly services: WorkerRunServices,
    private readonly intervalMs = 250,
  ) {}

  async recover(): Promise<void> {
    const listed = this.store.listRuns();
    if (listed.isErr()) throw new Error('Could not list runs during startup recovery');
    for (const aggregate of listed.unwrap()) {
      if (aggregate.state.status !== 'running') continue;
      const recovered = this.services.coordinatorFor(aggregate).recoverRun(aggregate.runId);
      if (recovered.isErr()) throw new Error(`Could not recover run ${aggregate.runId}`);
    }
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
  }

  async runUntilStable(runId: string): Promise<RunAggregate> {
    for (;;) {
      const loaded = this.store.loadRun(runId);
      if (loaded.isErr()) throw new Error(`Run ${runId} could not be loaded`);
      const aggregate = loaded.unwrap();
      if (stableBoundary(aggregate)) return aggregate;
      const pendingComplete = aggregate.state.invocations.find(({ state, nodeId }) => {
        const definition = aggregate.artifact.bundle.nodes.find(({ id }) => id === nodeId);
        return (
          state === 'pending' && definition?.type === 'complete' && definition.result !== 'failed'
        );
      });
      if (pendingComplete) await this.services.finalize(aggregate);
      const advanced = await this.services.coordinatorFor(aggregate).advance(runId);
      if (advanced.isErr()) {
        this.blockedAtSequence.set(runId, aggregate.nextEventSequence);
        return aggregate;
      }
      if (advanced.unwrap().nextEventSequence === aggregate.nextEventSequence) return aggregate;
    }
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  private async tick(): Promise<void> {
    if (this.advancing) return;
    this.advancing = true;
    try {
      const listed = this.store.listRuns();
      if (listed.isErr()) return;
      for (const aggregate of listed.unwrap()) {
        const blockedAt = this.blockedAtSequence.get(aggregate.runId);
        if (blockedAt !== undefined && blockedAt === aggregate.nextEventSequence) continue;
        this.blockedAtSequence.delete(aggregate.runId);
        if (aggregate.state.status === 'running') {
          await this.runUntilStable(aggregate.runId);
        }
      }
    } finally {
      this.advancing = false;
    }
  }
}
