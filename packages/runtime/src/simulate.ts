import { canonicalJson } from '@kairo/adw';
import type {
  CompiledWorkflowArtifact,
  JsonValue,
  OrchestrationIntent,
  RunEvent,
  RunState,
} from '@kairo/domain';
import { ok, type Result } from '@usersatoshi/results';
import type { RuntimeError } from './errors.ts';
import { reduceRun } from './reducer.ts';
import { scheduleRun } from './scheduler.ts';

export interface SimulationOutput {
  readonly state: RunState;
  readonly intents: readonly OrchestrationIntent[];
  readonly canonical: string;
}

export function simulate(
  artifact: CompiledWorkflowArtifact,
  events: readonly RunEvent[],
): Result<SimulationOutput, RuntimeError> {
  const reduced = reduceRun(artifact, events);
  if (reduced.isErr()) {
    return reduced;
  }
  const state = reduced.unwrap();

  const scheduled = scheduleRun(artifact, state);
  if (scheduled.isErr()) {
    return scheduled;
  }
  const intents = scheduled.unwrap();

  return ok({
    state,
    intents,
    // RunState and intents contain JSON-only domain values.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    canonical: canonicalJson({
      state,
      intents,
    } as unknown as JsonValue),
  });
}
