import type { Result } from '@usersatoshi/results';

import {
  SandboxRuntimeAgentCommandSandbox,
  type AgentSandboxInvocation,
  type SandboxedCommandInput,
} from './agent-command-sandbox.ts';
import type { SandboxError } from './errors.ts';
import { WorktreePathGuard } from './worktree-path-guard.ts';

/** @deprecated Use `AgentSandboxInvocation`. */
export type BubblewrapInvocation = AgentSandboxInvocation;

/**
 * @deprecated Use `SandboxRuntimeAgentCommandSandbox` and `WorktreePathGuard`.
 * This compatibility facade now uses the cross-platform runtime.
 */
export class BubblewrapAgentSandbox extends SandboxRuntimeAgentCommandSandbox {
  private readonly pathGuard = new WorktreePathGuard();

  guardPath(
    root: string,
    path: string,
    operation: 'read' | 'write',
  ): Promise<Result<string, SandboxError>> {
    return this.pathGuard.guard(root, path, operation);
  }

  override invocation(
    input: SandboxedCommandInput,
  ): Promise<Result<AgentSandboxInvocation, SandboxError>> {
    return super.invocation(input);
  }
}
