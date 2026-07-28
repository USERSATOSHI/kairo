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
const reviewRepairs = workflow.counter('reviewRepairs', 2);
const deliveryRepairs = workflow.counter('deliveryRepairs', 2);

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
const review = workflow.agent('review', {
  role: 'reviewer',
  prompt: './prompts/review.md',
  capabilities: ['repository.read'],
  recoveryPolicy: 'resume_supported',
});
const delivery = workflow.deliveryReview('delivery', {
  title: 'Review feature delivery',
  proposalFrom: 'review',
});
const complete = workflow.complete('complete');
const failed = workflow.complete('failed', { result: 'failed' });

workflow.startAt(plan);
plan.on('success').to(approval);
approval.on('approved').to(implement);
approval.on('rejected').to(failed);
implement.on('success').to(validate);
validate.on('success').to(review);
validate.on('failure').to(failed);
review.on('success').to(delivery);
review.on('failure').when(reviewRepairs.belowLimit()).increment(reviewRepairs).to(implement);
review.on('failure').otherwise().to(failed);
delivery.on('approved').to(complete);
delivery
  .on('changes_requested')
  .when(deliveryRepairs.belowLimit())
  .increment(deliveryRepairs)
  .to(implement);
delivery.on('rejected').to(failed);

export default workflow.build();
