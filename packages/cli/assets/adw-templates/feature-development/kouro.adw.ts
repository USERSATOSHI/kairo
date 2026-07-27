import { WorkflowBuilder } from '@kouro/adw';

const workflow = new WorkflowBuilder({
  id: '{{id}}',
  version: '1.0.0',
})
  .permissions('repository.read', 'repository.write', 'terminal.execute')
  .runLimits({
    maxDurationMs: 8 * 60 * 60 * 1000,
    maxNodeInvocations: 20,
  });

const plan = workflow.agent('plan', {
  role: 'planner',
  prompt: './prompts/plan.md',
  capabilities: ['repository.read'],
  recoveryPolicy: 'resume_supported',
});
const approval = workflow.approval('approval', {
  title: 'Approve feature implementation plan',
});
const implement = workflow.agent('implement', {
  role: 'implementer',
  prompt: './prompts/implement.md',
  capabilities: ['repository.read', 'repository.write', 'terminal.execute'],
  recoveryPolicy: 'resume_supported',
});
const validate = workflow.command('validate', {
  command: 'bun run format && bun run lint && bun run typecheck && bun test',
  capabilities: ['repository.read', 'terminal.execute'],
  recoveryPolicy: 'replay_safe',
});
const complete = workflow.complete('complete');
const failed = workflow.complete('failed', { result: 'failed' });

workflow.startAt(plan);
plan.on('success').to(approval);
approval.on('approved').to(implement);
approval.on('rejected').to(failed);
implement.on('success').to(validate);
validate.on('success').to(complete);
validate.on('failure').to(failed);

export default workflow.build();
