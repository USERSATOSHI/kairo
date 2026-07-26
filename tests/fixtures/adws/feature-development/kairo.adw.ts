import { all, output, WorkflowBuilder } from '@kairo/adw';

const workflow = new WorkflowBuilder({
  id: 'feature-development',
  version: '1.0.0',
});

workflow.permissions('repository.read', 'repository.write', 'terminal.execute');
workflow.runLimits({
  maxDurationMs: 8 * 60 * 60 * 1000,
  maxNodeInvocations: 30,
});

const testRepairs = workflow.counter('testRepair', 3);
const reviewRepairs = workflow.counter('reviewRepair', 2);
const worktree = workflow.command('worktree', {
  command: 'git rev-parse --is-inside-work-tree',
  capabilities: ['repository.read', 'terminal.execute'],
  recoveryPolicy: 'replay_safe',
});
const plan = workflow.agent('plan', {
  role: 'planner',
  prompt: './prompts/plan.md',
  outputSchema: './schemas/plan.schema.ts',
  capabilities: ['repository.read'],
  recoveryPolicy: 'resume_supported',
});
const planApproval = workflow.approval('planApproval', {
  title: 'Approve implementation plan',
});
const implement = workflow.agent('implement', {
  role: 'implementer',
  prompt: './prompts/implement.md',
  outputSchema: './schemas/change.schema.ts',
  capabilities: ['repository.read', 'repository.write', 'terminal.execute'],
  recoveryPolicy: 'resume_supported',
});
const validate = workflow.command('validate', {
  command: 'bun run lint && bun run format && bun test',
  capabilities: ['repository.read', 'terminal.execute'],
  recoveryPolicy: 'replay_safe',
});
const review = workflow.agent('review', {
  role: 'reviewer',
  prompt: './prompts/review.md',
  outputSchema: './schemas/review.schema.ts',
  capabilities: ['repository.read'],
  recoveryPolicy: 'resume_supported',
});
const deliveryApproval = workflow.approval('deliveryApproval', {
  title: 'Approve merge-ready delivery',
});
const complete = workflow.complete('complete');
const failed = workflow.complete('failed', { result: 'failed' });

workflow.startAt(worktree);
worktree.on('success').to(plan);
worktree.on('failure').to(failed);
plan.on('success').to(planApproval);
planApproval.on('approved').to(implement);
planApproval.on('rejected').to(failed);
implement.on('success').to(validate);
validate.on('success').to(review);
validate.on('failure').when(testRepairs.belowLimit()).increment(testRepairs).to(implement);
validate.on('failure').when(testRepairs.atLimit()).to(failed);
review.on('success').when(output('approved').equals(true)).to(deliveryApproval);
review
  .on('success')
  .when(all(output('approved').equals(false), reviewRepairs.belowLimit()))
  .increment(reviewRepairs)
  .to(implement);
review
  .on('success')
  .when(all(output('approved').equals(false), reviewRepairs.atLimit()))
  .to(failed);
deliveryApproval.on('approved').to(complete);
deliveryApproval.on('rejected').to(failed);

export default workflow.build();
