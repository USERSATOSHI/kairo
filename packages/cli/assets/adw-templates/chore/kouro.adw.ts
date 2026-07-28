import { WorkflowBuilder } from '@kouro/adw';

const workflow = new WorkflowBuilder({
  id: '{{id}}',
  version: '1.0.0',
})
  .permissions('repository.read', 'repository.write', 'terminal.execute')
  .runLimits({
    maxDurationMs: 4 * 60 * 60 * 1000,
    maxNodeInvocations: 20,
  });

const validationRepairs = workflow.counter('validationRepairs', 3);
const deliveryRepairs = workflow.counter('deliveryRepairs', 2);
const dependencies = workflow.command('dependencies', {
  command: 'bun install --frozen-lockfile',
  capabilities: ['repository.read', 'terminal.execute'],
  recoveryPolicy: 'replay_safe',
});
const implement = workflow.agent('implement', {
  role: 'maintainer',
  prompt: './prompts/implement.md',
  capabilities: ['repository.read', 'repository.write'],
  recoveryPolicy: 'resume_supported',
});
const validate = workflow.command('validate', {
  command: 'bun run format && bun run lint && bun run typecheck && bun test',
  capabilities: ['repository.read', 'terminal.execute'],
  recoveryPolicy: 'replay_safe',
});
const deliveryMetadata = workflow.agent('deliveryMetadata', {
  role: 'delivery-metadata-proposer',
  prompt: './prompts/delivery.md',
  outputSchema: './schemas/delivery-metadata.schema.ts',
  capabilities: ['repository.read'],
  recoveryPolicy: 'resume_supported',
});
const delivery = workflow.deliveryReview('delivery', {
  title: 'Review chore delivery',
  proposalFrom: 'deliveryMetadata',
});
const complete = workflow.complete('complete');
const failed = workflow.complete('failed', { result: 'failed' });

workflow.startAt(dependencies);
dependencies.on('success').to(implement);
dependencies.on('failure').to(failed);
implement.on('success').to(validate);
validate.on('success').to(deliveryMetadata);
validate
  .on('failure')
  .when(validationRepairs.belowLimit())
  .increment(validationRepairs)
  .to(implement);
validate.on('failure').otherwise().to(failed);
deliveryMetadata.on('success').to(delivery);
delivery.on('approved').to(complete);
delivery
  .on('changes_requested')
  .when(deliveryRepairs.belowLimit())
  .increment(deliveryRepairs)
  .to(implement);
delivery.on('changes_requested').otherwise().to(failed);
delivery.on('rejected').to(failed);

export default workflow.build();
