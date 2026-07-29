import { WorkflowBuilder } from '@kouro/adw';

const workflow = new WorkflowBuilder({
  id: 'feature-simulation',
  version: '1.0.0',
});

workflow.permissions('repository.read', 'terminal.execute');
workflow.defaults({ modelProfile: 'coding-strong' });
workflow.subworkflow('validation', {
  package: '../shared',
  version: '1.0.0',
});

const scout = workflow.subagent('scout', {
  role: 'repository-scout',
  prompt: './prompts/scout.md',
  outputSchema: './schemas/scout.schema.ts',
  capabilities: ['repository.read'],
  maxInvocations: 2,
  maxConcurrent: 2,
});
const plan = workflow.agent('plan', {
  role: 'planner',
  prompt: './prompts/plan.md',
  outputSchema: './schemas/plan.schema.ts',
  capabilities: ['repository.read'],
  recoveryPolicy: 'resume_supported',
});
plan.uses(scout);
const approve = workflow.approval('approve', {
  title: 'Approve the plan',
});
const test = workflow.command('test', {
  command: 'bun test',
  capabilities: ['repository.read', 'terminal.execute'],
  recoveryPolicy: 'replay_safe',
});
const complete = workflow.complete('complete');

workflow.startAt(plan);
plan.on('success').to(approve);
approve.on('approved').to(test);
test.on('passed').to(complete);

export default workflow.build();
