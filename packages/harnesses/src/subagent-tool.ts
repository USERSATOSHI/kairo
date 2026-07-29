import type { SubagentExecutionController, SubagentInvocationResult } from '@kouro/executors';

export const SUBAGENT_TOOL_NAME = 'subagent';

export function subagentToolDescription(controller: SubagentExecutionController): string {
  const definitions = controller.definitions.map(({ id, role }) => `${id} (${role})`).join(', ');
  return [
    'Delegate one bounded task to a workflow-declared subagent.',
    `Authorized subagents: ${definitions}.`,
    'Use independent calls in parallel only when their tasks do not depend on each other.',
  ].join(' ');
}

export function subagentResultText(result: SubagentInvocationResult): string {
  return JSON.stringify(result);
}
