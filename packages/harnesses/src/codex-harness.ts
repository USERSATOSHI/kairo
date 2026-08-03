import { err, ok, type Result } from '@usersatoshi/results';

import type {
  AgentHarness,
  HarnessError,
  HarnessExecution,
  HarnessExecutionRequest,
} from '@kouro/executors';
import {
  DefaultCodexAppServerTransportFactory,
  type CodexAppServerMessage,
  type CodexAppServerTransport,
  type CodexAppServerTransportFactory,
} from './codex-app-server-transport.ts';
import { invalidResponse, processFailure } from './errors.ts';
import { parseHarnessOutput } from './structured-output.ts';
import {
  SUBAGENT_TOOL_NAME,
  subagentResultText,
  subagentToolDescription,
} from './subagent-tool.ts';

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function promptFor(request: HarnessExecutionRequest): string {
  return `Role: ${request.role}\n\n${request.prompt}`;
}

function networkAllowed(capabilities: readonly string[]): boolean {
  return capabilities.some((capability) => capability.includes('network'));
}

function sandboxPolicy(request: HarnessExecutionRequest):
  | { readonly type: 'readOnly'; readonly networkAccess: boolean }
  | {
      readonly type: 'workspaceWrite';
      readonly writableRoots: readonly string[];
      readonly networkAccess: boolean;
      readonly excludeTmpdirEnvVar: false;
      readonly excludeSlashTmp: false;
    } {
  const networkAccess = networkAllowed(request.capabilities);
  return request.capabilities.some((capability) => capability.includes('write'))
    ? {
        type: 'workspaceWrite',
        writableRoots: [request.workingDirectory],
        networkAccess,
        excludeTmpdirEnvVar: false,
        excludeSlashTmp: false,
      }
    : { type: 'readOnly', networkAccess };
}

function threadIdFrom(value: unknown): string | undefined {
  if (!isRecord(value) || !isRecord(value.thread)) return undefined;
  return typeof value.thread.id === 'string' ? value.thread.id : undefined;
}

function turnIdFrom(value: unknown): string | undefined {
  if (!isRecord(value) || !isRecord(value.turn)) return undefined;
  return typeof value.turn.id === 'string' ? value.turn.id : undefined;
}

function finalAgentText(value: unknown): string | undefined {
  if (!isRecord(value) || !Array.isArray(value.items)) return undefined;
  return value.items
    .filter(isRecord)
    .filter((item) => item.type === 'agentMessage' && typeof item.text === 'string')
    .map((item) => String(item.text))
    .at(-1);
}

function turnFailure(value: unknown): string {
  if (!isRecord(value)) return 'Codex turn failed';
  if (isRecord(value.error) && typeof value.error.message === 'string') return value.error.message;
  return 'Codex turn failed';
}

function harnessErrorMessage(error: HarnessError): string {
  return 'message' in error ? error.message : `Harness ${error.harnessId} cannot resume`;
}

function unknownErrorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}

function commandAllowed(request: HarnessExecutionRequest): boolean {
  return request.capabilities.some((capability) => capability.includes('execute'));
}

function writeAllowed(request: HarnessExecutionRequest): boolean {
  return request.capabilities.some((capability) => capability.includes('write'));
}

async function answerServerRequest(
  transport: CodexAppServerTransport,
  request: HarnessExecutionRequest,
  message: CodexAppServerMessage,
): Promise<void> {
  if (message.id === undefined || !message.method) return;
  if (message.method === 'item/commandExecution/requestApproval') {
    transport.respond(message.id, { decision: commandAllowed(request) ? 'accept' : 'decline' });
    return;
  }
  if (message.method === 'item/fileChange/requestApproval') {
    transport.respond(message.id, { decision: writeAllowed(request) ? 'accept' : 'decline' });
    return;
  }
  if (message.method === 'item/permissions/requestApproval') {
    transport.respond(message.id, { permissions: {}, scope: 'turn' });
    return;
  }
  if (message.method === 'item/tool/requestUserInput') {
    transport.respond(message.id, { answers: {} });
    return;
  }
  if (
    message.method === 'item/tool/call' &&
    request.subagents &&
    isRecord(message.params) &&
    message.params.tool === SUBAGENT_TOOL_NAME &&
    isRecord(message.params.arguments)
  ) {
    const subagent =
      typeof message.params.arguments.subagent === 'string'
        ? message.params.arguments.subagent
        : '';
    const task =
      typeof message.params.arguments.task === 'string' ? message.params.arguments.task : '';
    const result = await request.subagents.invoke(subagent, task);
    transport.respond(message.id, {
      contentItems: [{ type: 'inputText', text: subagentResultText(result) }],
      success: result.success,
    });
    return;
  }
  transport.respond(message.id, { action: 'decline', content: null });
}

function observeTurn(
  transport: CodexAppServerTransport,
  request: HarnessExecutionRequest,
): {
  readonly completion: Promise<Result<string, HarnessError>>;
  readonly setTurnId: (id: string) => void;
  readonly dispose: () => void;
} {
  let turnId: string | undefined;
  let streamedText = '';
  let resolveCompletion: ((result: Result<string, HarnessError>) => void) | undefined;
  const completion = new Promise<Result<string, HarnessError>>((resolve) => {
    resolveCompletion = resolve;
  });
  function finish(result: Result<string, HarnessError>): void {
    if (!resolveCompletion) throw new Error('Codex turn observer is not initialized');
    resolveCompletion(result);
  }
  const unsubscribe = transport.subscribe((message) => {
    if (
      message.id !== undefined &&
      (message.method?.includes('request') || message.method === 'item/tool/call')
    ) {
      void answerServerRequest(transport, request, message).catch((cause: unknown) => {
        if (message.id === undefined) return;
        transport.respond(message.id, {
          contentItems: [
            {
              type: 'inputText',
              text: `Subagent tool failed: ${unknownErrorMessage(cause)}`,
            },
          ],
          success: false,
        });
      });
      return;
    }
    if (message.method === 'item/agentMessage/delta' && isRecord(message.params)) {
      if (typeof message.params.delta === 'string') streamedText += message.params.delta;
      return;
    }
    if (message.method !== 'turn/completed' || !isRecord(message.params)) return;
    const turn = message.params.turn;
    if (!isRecord(turn) || (turnId && turn.id !== turnId)) return;
    if (turn.status === 'interrupted') {
      finish(err(processFailure('Codex turn was interrupted')));
      return;
    }
    if (turn.status === 'failed') {
      finish(err(processFailure(turnFailure(turn))));
      return;
    }
    const finalText = finalAgentText(turn) ?? streamedText;
    finish(
      finalText
        ? ok(finalText)
        : err(invalidResponse('Codex turn has no final agent message', transport.transcript())),
    );
  });
  return {
    completion,
    setTurnId(id: string) {
      turnId = id;
    },
    dispose: unsubscribe,
  };
}

async function applyControls(
  transport: CodexAppServerTransport,
  request: HarnessExecutionRequest,
  threadId: string,
  turnId: string,
  stopped: () => boolean,
): Promise<void> {
  if (!request.controls) return;
  const handled = new Set<number>();
  let interruptSent = false;
  while (!stopped()) {
    const controls = await request.controls.read();
    for (const steering of controls.steering) {
      if (handled.has(steering.requestSequence)) continue;
      handled.add(steering.requestSequence);
      const steered = await transport.request('turn/steer', {
        threadId,
        expectedTurnId: turnId,
        input: [{ type: 'text', text: steering.message }],
      });
      if (steered.isOk()) {
        await request.controls.steeringApplied(steering.requestSequence);
      } else {
        await request.controls.steeringRejected(
          steering.requestSequence,
          harnessErrorMessage(steered.error),
        );
      }
    }
    if (controls.interruptRequested && !interruptSent) {
      interruptSent = true;
      await transport.request('turn/interrupt', { threadId, turnId });
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
  }
}

async function openThread(
  transport: CodexAppServerTransport,
  request: HarnessExecutionRequest,
  resumeToken?: string,
): Promise<Result<string, HarnessError>> {
  const initialized = await transport.request('initialize', {
    clientInfo: { name: 'kouro', title: 'Kouro', version: '0.1.0' },
    capabilities: null,
  });
  if (initialized.isErr()) return initialized;
  transport.notify('initialized', {});

  const thread = await transport.request(resumeToken ? 'thread/resume' : 'thread/start', {
    ...(resumeToken ? { threadId: resumeToken } : {}),
    cwd: request.workingDirectory,
    ...(request.model ? { model: request.model } : {}),
    approvalPolicy: 'on-request',
    ...(!resumeToken && request.subagents
      ? {
          dynamicTools: [
            {
              type: 'function',
              name: SUBAGENT_TOOL_NAME,
              description: subagentToolDescription(request.subagents),
              inputSchema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  subagent: { type: 'string', minLength: 1 },
                  task: { type: 'string', minLength: 1 },
                },
                required: ['subagent', 'task'],
              },
            },
          ],
        }
      : {}),
  });
  if (thread.isErr()) return thread;
  const threadId = threadIdFrom(thread.unwrap());
  if (!threadId) {
    return err(invalidResponse('Codex App Server returned no thread ID', transport.transcript()));
  }
  if (!resumeToken && request.onResumeToken) await request.onResumeToken(threadId);
  return ok(threadId);
}

async function executeTurn(
  transport: CodexAppServerTransport,
  request: HarnessExecutionRequest,
  threadId: string,
): Promise<Result<string, HarnessError>> {
  const observed = observeTurn(transport, request);
  try {
    const turn = await transport.request('turn/start', {
      threadId,
      input: [{ type: 'text', text: promptFor(request) }],
      cwd: request.workingDirectory,
      approvalPolicy: 'on-request',
      sandboxPolicy: sandboxPolicy(request),
      ...(request.model ? { model: request.model } : {}),
      ...(request.reasoningEffort ? { effort: request.reasoningEffort } : {}),
      ...(request.outputSchema ? { outputSchema: request.outputSchema } : {}),
    });
    if (turn.isErr()) return turn;
    const turnId = turnIdFrom(turn.unwrap());
    if (!turnId) {
      return err(invalidResponse('Codex App Server returned no turn ID', transport.transcript()));
    }
    observed.setTurnId(turnId);

    let stopped = false;
    const controls = applyControls(transport, request, threadId, turnId, () => stopped);
    const controlFailure = controls.then(
      () => new Promise<Result<string, HarnessError>>(() => undefined),
      (cause: unknown) =>
        err(processFailure(`Codex control channel failed: ${unknownErrorMessage(cause)}`)),
    );
    const completed = await Promise.race([observed.completion, controlFailure]);
    stopped = true;
    await controls.catch(() => undefined);
    return completed;
  } finally {
    observed.dispose();
  }
}

/** Runs Codex through its bidirectional local App Server protocol. */
export class CodexHarness implements AgentHarness {
  readonly id = 'codex';

  constructor(
    private readonly transportFactory: CodexAppServerTransportFactory = new DefaultCodexAppServerTransportFactory(),
  ) {}

  execute(request: HarnessExecutionRequest): Promise<Result<HarnessExecution, HarnessError>> {
    return this.run(request);
  }

  resume(
    request: HarnessExecutionRequest,
    token: string,
  ): Promise<Result<HarnessExecution, HarnessError>> {
    return this.run(request, token);
  }

  private async run(
    request: HarnessExecutionRequest,
    resumeToken?: string,
  ): Promise<Result<HarnessExecution, HarnessError>> {
    const opened = await this.transportFactory.open(
      request.workingDirectory,
      request.onTranscriptChunk,
    );
    if (opened.isErr()) return opened;
    const transport = opened.unwrap();
    try {
      const thread = await openThread(transport, request, resumeToken);
      if (thread.isErr()) return thread;
      const threadId = thread.unwrap();
      const completed = await executeTurn(transport, request, threadId);
      if (completed.isErr()) return completed;
      return ok({
        output: parseHarnessOutput(completed.unwrap()),
        transcript: transport.transcript(),
        resumeToken: threadId,
      });
    } finally {
      await transport.dispose();
    }
  }
}
