import { err, ok, type Result } from '@usersatoshi/results';

import {
  HarnessErrorKind,
  type AgentHarness,
  type AgentHarnessRegistry,
  type HarnessError,
} from '@kairo/executors';

export class HarnessRegistry implements AgentHarnessRegistry {
  private readonly harnesses: ReadonlyMap<string, AgentHarness>;

  constructor(harnesses: readonly AgentHarness[]) {
    const entries = new Map<string, AgentHarness>();
    for (const harness of harnesses) {
      if (!harness.id.trim() || entries.has(harness.id)) {
        throw new Error(`Harness IDs must be non-empty and unique: ${harness.id}`);
      }
      entries.set(harness.id, harness);
    }
    this.harnesses = entries;
  }

  get(harnessId: string): Result<AgentHarness, HarnessError> {
    const harness = this.harnesses.get(harnessId);
    return harness
      ? ok(harness)
      : err({
          kind: HarnessErrorKind.Unavailable,
          message: `Harness is not registered: ${harnessId}`,
        });
  }
}
