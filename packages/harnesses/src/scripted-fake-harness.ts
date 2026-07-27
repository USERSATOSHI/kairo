import { ok, type Result } from '@usersatoshi/results';

import type {
  AgentHarness,
  HarnessError,
  HarnessExecution,
  HarnessExecutionRequest,
} from '@kouro/executors';

export type ScriptedHarnessResult = Result<HarnessExecution, HarnessError>;

export interface RecordedHarnessCall {
  readonly operation: 'execute' | 'resume';
  readonly request: HarnessExecutionRequest;
  readonly token?: string;
}

function isScriptedResult(
  item: ScriptedHarnessResult | HarnessExecution,
): item is ScriptedHarnessResult {
  return (
    item !== null && typeof item === 'object' && 'isErr' in item && typeof item.isErr === 'function'
  );
}

export class ScriptedFakeHarness implements AgentHarness {
  readonly calls: RecordedHarnessCall[] = [];
  private readonly script: ScriptedHarnessResult[];

  constructor(
    readonly id: string,
    script: readonly (ScriptedHarnessResult | HarnessExecution)[],
  ) {
    this.script = script.map((item) => (isScriptedResult(item) ? item : ok(item)));
  }

  execute(request: HarnessExecutionRequest): Promise<Result<HarnessExecution, HarnessError>> {
    this.calls.push({ operation: 'execute', request });
    return Promise.resolve(this.next());
  }

  resume(
    request: HarnessExecutionRequest,
    token: string,
  ): Promise<Result<HarnessExecution, HarnessError>> {
    this.calls.push({ operation: 'resume', request, token });
    return Promise.resolve(this.next());
  }

  private next(): ScriptedHarnessResult {
    const scripted = this.script.shift();
    if (!scripted) {
      throw new Error(`No scripted result remains for harness: ${this.id}`);
    }
    return scripted;
  }
}
