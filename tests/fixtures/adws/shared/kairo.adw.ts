import { WorkflowBuilder } from '@kairo/adw';

const workflow = new WorkflowBuilder({
  id: 'shared-validation',
  version: '1.0.0',
});
const complete = workflow.complete('complete');

workflow.startAt(complete);

export default workflow.build();
