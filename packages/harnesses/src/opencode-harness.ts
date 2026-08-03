import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';

import { createOpencode, type Config } from '@opencode-ai/sdk/v2';
import { err, fromAsync, ok, type Result } from '@usersatoshi/results';
import type { TokenUsage } from '@kouro/domain';
import { SandboxRuntimeAgentCommandSandbox } from '@kouro/sandbox-worktree';

import type {
  AgentHarness,
  HarnessError,
  HarnessExecution,
  HarnessExecutionRequest,
  SubagentExecutionController,
} from '@kouro/executors';
import { processFailure } from './errors.ts';
import { parseHarnessOutput } from './structured-output.ts';
import { SUBAGENT_TOOL_NAME, subagentToolDescription } from './subagent-tool.ts';

export interface OpenCodeSdkSession {
  readonly sessionId: string;
  prompt(text: string): Promise<void>;
  steer(text: string): Promise<void>;
  interrupt(): Promise<void>;
  messages(): Promise<readonly unknown[]>;
  usage(): Promise<TokenUsage | undefined>;
  subscribe(listener: (event: unknown) => Promise<void>): Promise<() => Promise<void>>;
  close(): void;
}

export interface OpenCodeAgentSdk {
  create(request: HarnessExecutionRequest, resumeToken?: string): Promise<OpenCodeSdkSession>;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function promptFor(request: HarnessExecutionRequest): string {
  const schemaInstruction = request.outputSchema
    ? `\n\nReturn only JSON matching this schema:\n${JSON.stringify(request.outputSchema)}`
    : '';
  return `Role: ${request.role}\n\n${request.prompt}${schemaInstruction}`;
}

function modelFor(
  request: HarnessExecutionRequest,
): { readonly id: string; readonly providerID: string } | undefined {
  if (!request.model) return undefined;
  const separator = request.model.indexOf('/');
  if (separator < 1 || separator === request.model.length - 1) {
    throw new Error(`OpenCode model must use provider/model syntax: ${request.model}`);
  }
  return {
    providerID: request.model.slice(0, separator),
    id: request.model.slice(separator + 1),
  };
}

interface OpenCodeSandboxPlugin {
  readonly url: string;
  dispose(): Promise<void>;
}

interface OpenCodeSubagentBridge {
  readonly endpoint: string;
  readonly token: string;
  readonly description: string;
  dispose(): void;
}

function createSubagentBridge(controller: SubagentExecutionController): OpenCodeSubagentBridge {
  const token = randomUUID();
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(incoming) {
      if (
        incoming.method !== 'POST' ||
        incoming.headers.get('authorization') !== `Bearer ${token}`
      ) {
        return new Response('Unauthorized', { status: 401 });
      }
      const input = await incoming.json().catch(() => undefined);
      if (
        !isRecord(input) ||
        typeof input.subagent !== 'string' ||
        typeof input.task !== 'string'
      ) {
        return new Response('Invalid subagent request', { status: 400 });
      }
      const result = await controller.invoke(input.subagent, input.task, incoming.signal);
      return new Response(JSON.stringify(result), {
        headers: { 'content-type': 'application/json' },
      });
    },
  });
  return {
    endpoint: new URL('/subagent', server.url).href,
    token,
    description: subagentToolDescription(controller),
    dispose: () => server.stop(true),
  };
}

async function createSandboxPlugin(
  request: HarnessExecutionRequest,
  subagentBridge?: OpenCodeSubagentBridge,
): Promise<OpenCodeSandboxPlugin> {
  const directory = await mkdtemp(join(tmpdir(), 'kouro-opencode-sandbox-'));
  const path = join(directory, 'plugin.mjs');
  const moduleUrl = new URL('./opencode-sandbox-plugin.ts', import.meta.url).href;
  const policy = {
    workingDirectory: request.workingDirectory,
    writable: request.capabilities.some((capability) => capability.includes('write')),
    network: request.capabilities.some((capability) => capability.includes('network')),
    ...(subagentBridge
      ? {
          subagents: {
            endpoint: subagentBridge.endpoint,
            token: subagentBridge.token,
            description: subagentBridge.description,
          },
        }
      : {}),
  };
  await writeFile(
    path,
    `import { createOpenCodeSandboxPlugin } from ${JSON.stringify(moduleUrl)};\nexport const KouroSandboxPlugin = createOpenCodeSandboxPlugin(${JSON.stringify(policy)});\n`,
    { encoding: 'utf8', mode: 0o600 },
  );
  return {
    url: pathToFileURL(path).href,
    dispose: () => rm(directory, { recursive: true, force: true }),
  };
}

function configFor(request: HarnessExecutionRequest, pluginUrl?: string): Config {
  const canWrite = request.capabilities.some((capability) => capability.includes('write'));
  const canExecute = request.capabilities.some((capability) => capability.includes('execute'));
  const canNetwork = request.capabilities.some((capability) => capability.includes('network'));
  return {
    autoupdate: false,
    share: 'disabled',
    default_agent: 'kouro',
    plugin: pluginUrl ? [pluginUrl] : [],
    instructions: [],
    skills: { paths: [], urls: [] },
    agent: {
      kouro: {
        mode: 'primary',
        ...(request.reasoningEffort ? { variant: request.reasoningEffort } : {}),
        tools: {
          read: true,
          glob: true,
          grep: true,
          list: true,
          edit: canWrite,
          write: canWrite,
          bash: canExecute,
          webfetch: canNetwork,
          websearch: canNetwork,
          task: false,
          [SUBAGENT_TOOL_NAME]: request.subagents !== undefined,
        },
        permission: {
          read: 'allow',
          glob: 'allow',
          grep: 'allow',
          list: 'allow',
          edit: canWrite ? 'allow' : 'deny',
          bash: canExecute ? 'allow' : 'deny',
          webfetch: canNetwork ? 'allow' : 'deny',
          websearch: canNetwork ? 'allow' : 'deny',
          external_directory: 'deny',
          [SUBAGENT_TOOL_NAME]: request.subagents ? 'allow' : 'deny',
          task: 'deny',
          question: 'deny',
          skill: 'deny',
        },
      },
    },
  };
}

function failureMessage(value: unknown): string {
  if (isRecord(value) && typeof value.message === 'string') return value.message;
  return JSON.stringify(value);
}

const defaultSdk: OpenCodeAgentSdk = {
  async create(request, resumeToken) {
    const canExecute = request.capabilities.some((capability) => capability.includes('execute'));
    if (canExecute) {
      const sandboxAvailability = await new SandboxRuntimeAgentCommandSandbox().availability();
      if (!sandboxAvailability.available) {
        throw new Error(
          sandboxAvailability.reason ??
            'Sandbox Runtime is required for OpenCode command execution',
        );
      }
    }
    const subagentBridge = request.subagents ? createSubagentBridge(request.subagents) : undefined;
    let sandboxPlugin: OpenCodeSandboxPlugin | undefined;
    try {
      sandboxPlugin =
        canExecute || subagentBridge
          ? await createSandboxPlugin(request, subagentBridge)
          : undefined;
    } catch (cause) {
      subagentBridge?.dispose();
      throw cause;
    }
    const controller = new AbortController();
    let clientAndServer: Awaited<ReturnType<typeof createOpencode>>;
    try {
      clientAndServer = await createOpencode({
        hostname: '127.0.0.1',
        port: 0,
        signal: controller.signal,
        config: configFor(request, sandboxPlugin?.url),
      });
    } catch (cause) {
      await sandboxPlugin?.dispose();
      subagentBridge?.dispose();
      throw cause;
    }
    const { client, server } = clientAndServer;
    const model = modelFor(request);
    const selectedModel = model
      ? {
          ...model,
          ...(request.reasoningEffort ? { variant: request.reasoningEffort } : {}),
        }
      : undefined;
    const sessionResponse = resumeToken
      ? await client.v2.session.get({ sessionID: resumeToken })
      : await client.v2.session.create({
          agent: 'kouro',
          location: { directory: request.workingDirectory },
          ...(selectedModel ? { model: selectedModel } : {}),
        });
    if (sessionResponse.error) {
      server.close();
      await sandboxPlugin?.dispose();
      subagentBridge?.dispose();
      throw new Error(failureMessage(sessionResponse.error));
    }
    const sessionId = sessionResponse.data?.data.id;
    if (!sessionId) {
      server.close();
      await sandboxPlugin?.dispose();
      subagentBridge?.dispose();
      throw new Error('OpenCode SDK returned no session ID');
    }
    return {
      sessionId,
      async prompt(text) {
        const prompted = await client.v2.session.prompt({
          sessionID: sessionId,
          prompt: { text },
          delivery: 'queue',
          resume: true,
        });
        if (prompted.error) throw new Error(failureMessage(prompted.error));
        const waited = await client.v2.session.wait({ sessionID: sessionId });
        if (waited.error) throw new Error(failureMessage(waited.error));
      },
      async steer(text) {
        const steered = await client.v2.session.prompt({
          sessionID: sessionId,
          prompt: { text },
          delivery: 'steer',
          resume: true,
        });
        if (steered.error) throw new Error(failureMessage(steered.error));
      },
      async interrupt() {
        const interrupted = await client.v2.session.interrupt({ sessionID: sessionId });
        if (interrupted.error) throw new Error(failureMessage(interrupted.error));
      },
      async messages() {
        const messages = await client.v2.session.messages({
          sessionID: sessionId,
          order: 'asc',
          limit: 1000,
        });
        if (messages.error) throw new Error(failureMessage(messages.error));
        return messages.data?.data ?? [];
      },
      async usage() {
        const info = await client.v2.session.get({ sessionID: sessionId });
        if (info.error) return undefined;
        return usageFromOpenCodeSession(info.data?.data);
      },
      async subscribe(listener) {
        const events = await client.v2.session.events({ sessionID: sessionId });
        let stopped = false;
        const observing = (async () => {
          for await (const event of events.stream) {
            if (stopped) break;
            await listener(event);
          }
        })();
        return async () => {
          stopped = true;
          await events.stream.return(undefined);
          await observing.catch(() => undefined);
        };
      },
      close() {
        controller.abort();
        server.close();
        void sandboxPlugin?.dispose();
        subagentBridge?.dispose();
      },
    };
  },
};

function finalOutput(messages: readonly unknown[]): Result<unknown, HarnessError> {
  const assistant = messages
    .filter(isRecord)
    .filter(({ type }) => type === 'assistant')
    .at(-1);
  if (!assistant) return err(processFailure('OpenCode SDK returned no assistant message'));
  if (assistant.error !== undefined) return err(processFailure(failureMessage(assistant.error)));
  if (assistant.structured !== undefined) return ok(assistant.structured);
  if (!Array.isArray(assistant.content)) {
    return err(processFailure('OpenCode SDK assistant message has no content'));
  }
  const text = assistant.content
    .filter(isRecord)
    .filter((part) => part.type === 'text' && typeof part.text === 'string')
    .map((part) => String(part.text))
    .join('');
  return text
    ? ok(parseHarnessOutput(text))
    : err(processFailure('OpenCode SDK returned no assistant text'));
}

function noopUnsubscribe(): Promise<void> {
  return Promise.resolve();
}

function usageFromOpenCodeSession(value: unknown): TokenUsage | undefined {
  if (!isRecord(value) || !isRecord(value.tokens)) return undefined;
  const tokens = value.tokens;
  const input = numberField(tokens, 'input');
  const output = numberField(tokens, 'output');
  if (input === undefined && output === undefined) return undefined;
  const reasoning = numberField(tokens, 'reasoning');
  const cache = isRecord(tokens.cache)
    ? {
        read: numberField(tokens.cache, 'read'),
        write: numberField(tokens.cache, 'write'),
      }
    : undefined;
  return {
    inputTokens: input ?? 0,
    outputTokens: output ?? 0,
    ...(reasoning === undefined ? {} : { reasoningTokens: reasoning }),
    ...(cache?.read === undefined ? {} : { cacheReadTokens: cache.read }),
    ...(cache?.write === undefined ? {} : { cacheWriteTokens: cache.write }),
  };
}

function numberField(value: Readonly<Record<string, unknown>>, key: string): number | undefined {
  return typeof value[key] === 'number' && Number.isFinite(value[key]) ? value[key] : undefined;
}

async function applyControls(
  request: HarnessExecutionRequest,
  session: OpenCodeSdkSession,
  stopped: () => boolean,
): Promise<boolean> {
  if (!request.controls) return false;
  const handled = new Set<number>();
  while (!stopped()) {
    const controls = await request.controls.read();
    for (const steering of controls.steering) {
      if (handled.has(steering.requestSequence)) continue;
      handled.add(steering.requestSequence);
      try {
        await session.steer(steering.message);
        await request.controls.steeringApplied(steering.requestSequence);
      } catch (cause) {
        await request.controls.steeringRejected(
          steering.requestSequence,
          cause instanceof Error ? cause.message : 'OpenCode SDK rejected steering',
        );
      }
    }
    if (controls.interruptRequested) {
      await session.interrupt();
      return true;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

/** Runs agent requests through the OpenCode SDK and supervised local server. */
export class OpenCodeHarness implements AgentHarness {
  readonly id = 'opencode';

  constructor(private readonly sdk: OpenCodeAgentSdk = defaultSdk) {}

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
    const created = await fromAsync(
      () => this.sdk.create(request, resumeToken),
      (cause) =>
        processFailure(
          cause instanceof Error ? cause.message : 'OpenCode SDK session creation failed',
        ),
    );
    if (created.isErr()) return created;
    const session = created.unwrap();
    const transcript: string[] = [];
    let unsubscribe = noopUnsubscribe;
    try {
      unsubscribe = await session.subscribe(async (event) => {
        const line = JSON.stringify(event);
        transcript.push(line);
        if (request.onTranscriptChunk) await request.onTranscriptChunk(`${line}\n`);
      });
      if (!resumeToken && request.onResumeToken) {
        await request.onResumeToken(session.sessionId);
      }
      let stopped = false;
      const controls = applyControls(request, session, () => stopped);
      const prompted = await fromAsync(
        () => session.prompt(promptFor(request)),
        (cause) =>
          processFailure(cause instanceof Error ? cause.message : 'OpenCode SDK execution failed'),
      );
      stopped = true;
      const interrupted = await controls.catch(() => false);
      if (interrupted) return err(processFailure('OpenCode SDK session was interrupted'));
      if (prompted.isErr()) return prompted;
      const messages = await fromAsync(
        () => session.messages(),
        (cause) =>
          processFailure(cause instanceof Error ? cause.message : 'OpenCode messages failed'),
      );
      if (messages.isErr()) return messages;
      const output = finalOutput(messages.unwrap());
      if (output.isErr()) return output;
      let usage: TokenUsage | undefined;
      try {
        usage = await session.usage();
      } catch {
        usage = undefined;
      }
      return ok({
        output: output.unwrap(),
        transcript: transcript.join('\n'),
        resumeToken: session.sessionId,
        ...(usage ? { usage } : {}),
      });
    } finally {
      await unsubscribe();
      session.close();
    }
  }
}
