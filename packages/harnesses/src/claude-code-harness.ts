import {
  createSdkMcpServer,
  query,
  tool,
  type Options,
  type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import { err, fromAsync, ok, type Result } from '@usersatoshi/results';
import { WorktreePathGuard } from '@kouro/sandbox-worktree';
import { z } from 'zod';

import type {
  AgentHarness,
  HarnessError,
  HarnessExecution,
  HarnessExecutionRequest,
} from '@kouro/executors';
import { invalidResponse, processFailure } from './errors.ts';
import { parseHarnessOutput } from './structured-output.ts';
import {
  SUBAGENT_TOOL_NAME,
  subagentResultText,
  subagentToolDescription,
} from './subagent-tool.ts';

export interface ClaudeSdkQuery extends AsyncIterable<unknown> {
  interrupt(): Promise<unknown>;
  close(): void;
}

export interface ClaudeAgentSdk {
  query(input: AsyncIterable<SDKUserMessage>, options: Options): ClaudeSdkQuery;
}

const defaultSdk: ClaudeAgentSdk = {
  query(input, options) {
    return query({ prompt: input, options });
  },
};

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function promptFor(request: HarnessExecutionRequest): string {
  return `Role: ${request.role}\n\n${request.prompt}`;
}

function toolsFor(capabilities: readonly string[]): string[] {
  const tools = ['Read', 'Glob', 'Grep'];
  if (capabilities.some((capability) => capability.includes('write'))) {
    tools.push('Edit', 'Write');
  }
  if (capabilities.some((capability) => capability.includes('execute'))) {
    tools.push('Bash');
  }
  return tools;
}

function hasCapability(
  capabilities: readonly string[],
  expected: 'write' | 'execute' | 'network',
): boolean {
  return capabilities.some((value) => value.includes(expected));
}

function sensitiveEnvironmentVariables(): { readonly name: string; readonly mode: 'deny' }[] {
  return Object.keys(process.env)
    .filter((name) => /(AUTH|CREDENTIAL|KEY|PASSWORD|SECRET|TOKEN)/i.test(name))
    .map((name) => ({ name, mode: 'deny' as const }));
}

function sensitivePaths(): string[] {
  const home = process.env.HOME;
  if (!home) return [];
  return [
    `${home}/.ssh`,
    `${home}/.aws`,
    `${home}/.gnupg`,
    `${home}/.docker`,
    `${home}/.kube`,
    `${home}/.config/gcloud`,
    `${home}/.npmrc`,
    `${home}/.pypirc`,
    `${home}/.netrc`,
    `${home}/.git-credentials`,
  ];
}

function pathFromToolInput(input: Readonly<Record<string, unknown>>): string | undefined {
  if (typeof input.file_path === 'string') return input.file_path;
  return typeof input.path === 'string' ? input.path : undefined;
}

function fileGuardFor(request: HarnessExecutionRequest) {
  const pathGuard = new WorktreePathGuard();
  return async (input: unknown) => {
    if (!isRecord(input) || input.hook_event_name !== 'PreToolUse') return {};
    if (
      typeof input.tool_name !== 'string' ||
      !['Read', 'Glob', 'Grep', 'Edit', 'Write'].includes(input.tool_name)
    ) {
      return {};
    }
    const toolInput = isRecord(input.tool_input) ? input.tool_input : {};
    const path = pathFromToolInput(toolInput) ?? request.workingDirectory;
    const operation = input.tool_name === 'Edit' || input.tool_name === 'Write' ? 'write' : 'read';
    const guarded = await pathGuard.guard(request.workingDirectory, path, operation);
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse' as const,
        permissionDecision: guarded.isOk() ? ('allow' as const) : ('deny' as const),
        ...(guarded.isErr()
          ? {
              permissionDecisionReason:
                'Kouro denied a filesystem operation outside the assigned worktree',
            }
          : {}),
      },
    };
  };
}

function userMessage(text: string): SDKUserMessage {
  return {
    type: 'user',
    message: { role: 'user', content: text },
    parent_tool_use_id: null,
  };
}

async function* inputMessages(
  request: HarnessExecutionRequest,
  stopped: () => boolean,
): AsyncGenerator<SDKUserMessage> {
  yield userMessage(promptFor(request));
  if (!request.controls) return;
  const handled = new Set<number>();
  while (!stopped()) {
    const controls = await request.controls.read();
    for (const steering of controls.steering) {
      if (handled.has(steering.requestSequence)) continue;
      handled.add(steering.requestSequence);
      yield userMessage(steering.message);
      await request.controls.steeringApplied(steering.requestSequence);
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
  }
}

function resultFrom(
  message: unknown,
): Result<{ readonly output: unknown; readonly sessionId: string }, HarnessError> | undefined {
  if (!isRecord(message) || message.type !== 'result') return undefined;
  if (message.subtype !== 'success') {
    const errors = Array.isArray(message.errors)
      ? message.errors.filter((error): error is string => typeof error === 'string')
      : [];
    return err(processFailure(errors.join('; ') || `Claude Agent ${String(message.subtype)}`));
  }
  if (typeof message.session_id !== 'string') {
    return err(processFailure('Claude Agent SDK returned no session ID'));
  }
  return ok({
    output:
      message.structured_output === undefined
        ? parseHarnessOutput(typeof message.result === 'string' ? message.result : '')
        : message.structured_output,
    sessionId: message.session_id,
  });
}

function optionsFor(request: HarnessExecutionRequest, resumeToken?: string): Options {
  const tools = toolsFor(request.capabilities);
  const subagentServer = request.subagents
    ? createSdkMcpServer({
        name: 'kouro',
        version: '1',
        alwaysLoad: true,
        tools: [
          tool(
            SUBAGENT_TOOL_NAME,
            subagentToolDescription(request.subagents),
            {
              subagent: z.string().min(1),
              task: z.string().min(1),
            },
            async ({ subagent, task }) => {
              const result = await request.subagents?.invoke(subagent, task);
              if (!result) {
                return {
                  content: [{ type: 'text' as const, text: 'Subagents are unavailable' }],
                  isError: true,
                };
              }
              return {
                content: [{ type: 'text' as const, text: subagentResultText(result) }],
                isError: !result.success,
              };
            },
            { alwaysLoad: true },
          ),
        ],
      })
    : undefined;
  if (subagentServer) {
    tools.push(`mcp__kouro__${SUBAGENT_TOOL_NAME}`);
  }
  const outputSchema = isRecord(request.outputSchema) ? { ...request.outputSchema } : undefined;
  const canWrite = hasCapability(request.capabilities, 'write');
  const canExecute = hasCapability(request.capabilities, 'execute');
  const canNetwork = hasCapability(request.capabilities, 'network');
  return {
    cwd: request.workingDirectory,
    tools,
    allowedTools: tools,
    ...(subagentServer ? { mcpServers: { kouro: subagentServer } } : {}),
    permissionMode: 'dontAsk',
    settingSources: [],
    hooks: {
      PreToolUse: [{ hooks: [fileGuardFor(request)] }],
    },
    ...(canExecute
      ? {
          sandbox: {
            enabled: true,
            failIfUnavailable: true,
            autoAllowBashIfSandboxed: true,
            allowUnsandboxedCommands: false,
            network: {
              ...(canNetwork ? {} : { deniedDomains: ['*'], strictAllowlist: true }),
              allowLocalBinding: false,
              allowUnixSockets: [],
              allowAllUnixSockets: false,
            },
            filesystem: {
              allowRead: [request.workingDirectory],
              allowWrite: canWrite ? [request.workingDirectory] : [],
              denyWrite: canWrite ? [] : [request.workingDirectory],
              denyRead: sensitivePaths(),
            },
            credentials: {
              files: sensitivePaths().map((path) => ({ path, mode: 'deny' as const })),
              envVars: sensitiveEnvironmentVariables(),
            },
          },
        }
      : {}),
    ...(request.model ? { model: request.model } : {}),
    ...(request.reasoningEffort ? { effort: request.reasoningEffort } : {}),
    ...(outputSchema
      ? { outputFormat: { type: 'json_schema' as const, schema: outputSchema } }
      : {}),
    ...(resumeToken ? { resume: resumeToken } : {}),
  };
}

async function watchInterrupt(
  request: HarnessExecutionRequest,
  activeQuery: ClaudeSdkQuery,
  stopped: () => boolean,
): Promise<void> {
  if (!request.controls) return;
  while (!stopped()) {
    const controls = await request.controls.read();
    if (controls.interruptRequested) {
      await activeQuery.interrupt();
      return;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
  }
}

/** Runs agent requests through the Claude Agent SDK. */
export class ClaudeCodeHarness implements AgentHarness {
  readonly id = 'claude-code';

  constructor(private readonly sdk: ClaudeAgentSdk = defaultSdk) {}

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
    const transcript: string[] = [];
    let stopped = false;
    const activeQuery = this.sdk.query(
      inputMessages(request, () => stopped),
      optionsFor(request, resumeToken),
    );
    const interrupt = watchInterrupt(request, activeQuery, () => stopped);
    const executed = await fromAsync(
      async () => {
        for await (const message of activeQuery) {
          const line = JSON.stringify(message);
          transcript.push(line);
          if (request.onTranscriptChunk) await request.onTranscriptChunk(`${line}\n`);
          if (!resumeToken && request.onResumeToken && isRecord(message)) {
            const token = typeof message.session_id === 'string' ? message.session_id : undefined;
            if (token) {
              resumeToken = token;
              await request.onResumeToken(token);
            }
          }
          const result = resultFrom(message);
          if (result) return result;
        }
        return err(invalidResponse('Claude Agent SDK returned no result', transcript.join('\n')));
      },
      (cause) =>
        processFailure(
          cause instanceof Error ? cause.message : 'Claude Agent SDK execution failed',
        ),
    );
    stopped = true;
    await interrupt.catch(() => undefined);
    activeQuery.close();
    if (executed.isErr()) return executed;
    const result = executed.unwrap();
    if (result.isErr()) return result;
    const completed = result.unwrap();
    return ok({
      output: completed.output,
      transcript: transcript.join('\n'),
      resumeToken: completed.sessionId,
    });
  }
}
