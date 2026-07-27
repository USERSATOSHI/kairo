import { WorkflowBuilder } from '@kouro/adw';

const workflow = new WorkflowBuilder({
  id: '{{id}}',
  version: '1.0.0',
})
  .permissions('repository.read', 'repository.write', 'terminal.execute')
  .runLimits({
    maxDurationMs: 4 * 60 * 60 * 1000,
    maxNodeInvocations: 12,
  });

const reproduce = workflow.agent('reproduce', {
  role: 'bug-investigator',
  prompt: './prompts/reproduce.md',
  capabilities: ['repository.read', 'terminal.execute'],
  recoveryPolicy: 'resume_supported',
});
const fix = workflow.agent('fix', {
  role: 'bug-fixer',
  prompt: './prompts/fix.md',
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

workflow.startAt(reproduce);
reproduce.on('success').to(fix);
fix.on('success').to(validate);
validate.on('success').to(complete);
validate.on('failure').to(failed);

export default workflow.build();
