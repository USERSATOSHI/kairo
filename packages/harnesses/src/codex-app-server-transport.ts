import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface, type Interface as ReadlineInterface } from 'node:readline';

import { err, ok, type Result } from '@usersatoshi/results';

import type { HarnessError } from '@kouro/executors';
import { invalidResponse, processFailure } from './errors.ts';

type JsonRpcId = number | string;

export interface CodexAppServerMessage {
  readonly id?: JsonRpcId;
  readonly method?: string;
  readonly params?: unknown;
  readonly result?: unknown;
  readonly error?: unknown;
}

export interface CodexAppServerTransport {
  request(method: string, params: unknown): Promise<Result<unknown, HarnessError>>;
  notify(method: string, params: unknown): void;
  respond(id: JsonRpcId, result: unknown): void;
  subscribe(listener: (message: CodexAppServerMessage) => void): () => void;
  transcript(): string;
  dispose(): Promise<void>;
}

export interface CodexAppServerTransportFactory {
  open(
    workingDirectory: string,
    onTranscriptChunk?: (chunk: string) => Promise<void>,
  ): Promise<Result<CodexAppServerTransport, HarnessError>>;
}

interface PendingRequest {
  readonly resolve: (result: Result<unknown, HarnessError>) => void;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isMessage(value: unknown): value is CodexAppServerMessage {
  return (
    isRecord(value) &&
    (value.id === undefined || typeof value.id === 'number' || typeof value.id === 'string') &&
    (value.method === undefined || typeof value.method === 'string')
  );
}

export class StdioCodexAppServerTransport implements CodexAppServerTransport {
  private readonly process: ChildProcessWithoutNullStreams;
  private readonly lines: ReadlineInterface;
  private readonly pending = new Map<JsonRpcId, PendingRequest>();
  private readonly listeners = new Set<(message: CodexAppServerMessage) => void>();
  private readonly transcriptLines: string[] = [];
  private nextId = 1;
  private stderr = '';
  private stopped = false;

  constructor(
    workingDirectory: string,
    private readonly onTranscriptChunk?: (chunk: string) => Promise<void>,
  ) {
    this.process = spawn('codex', ['app-server'], {
      cwd: workingDirectory,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.lines = createInterface({ input: this.process.stdout });
    this.lines.on('line', (line) => this.receiveLine(line));
    this.process.stderr.setEncoding('utf8');
    this.process.stderr.on('data', (chunk: string) => {
      this.stderr += chunk;
    });
    this.process.once('error', (cause) => {
      this.stopped = true;
      this.failPending(processFailure(cause.message));
    });
    this.process.once('exit', (code, signal) => {
      this.stopped = true;
      const detail = this.stderr.trim() || `exit ${code ?? 'unknown'} (${signal ?? 'no signal'})`;
      this.failPending(processFailure(`Codex App Server stopped: ${detail}`));
    });
  }

  request(method: string, params: unknown): Promise<Result<unknown, HarnessError>> {
    if (this.stopped) {
      return Promise.resolve(err(processFailure('Codex App Server is not running')));
    }
    const id = this.nextId++;
    return new Promise((resolve) => {
      this.pending.set(id, { resolve });
      this.send({ id, method, params });
    });
  }

  notify(method: string, params: unknown): void {
    this.send({ method, params });
  }

  respond(id: JsonRpcId, result: unknown): void {
    this.send({ id, result });
  }

  subscribe(listener: (message: CodexAppServerMessage) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  transcript(): string {
    return this.transcriptLines.join('\n');
  }

  async dispose(): Promise<void> {
    this.lines.close();
    if (this.stopped) return;
    const exited = new Promise<void>((resolve) => this.process.once('exit', () => resolve()));
    this.process.kill('SIGTERM');
    await exited;
  }

  private send(message: CodexAppServerMessage): void {
    if (this.stopped) return;
    this.process.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private receiveLine(line: string): void {
    if (!line) return;
    this.transcriptLines.push(line);
    if (this.onTranscriptChunk) {
      void this.onTranscriptChunk(`${line}\n`).catch(() => undefined);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch {
      this.failPending(
        invalidResponse('Codex App Server returned malformed JSONL', this.transcript()),
      );
      return;
    }
    if (!isMessage(parsed)) {
      this.failPending(
        invalidResponse('Codex App Server returned an invalid JSON-RPC message', this.transcript()),
      );
      return;
    }
    if (parsed.id !== undefined && parsed.method === undefined) {
      const pending = this.pending.get(parsed.id);
      if (!pending) return;
      this.pending.delete(parsed.id);
      pending.resolve(
        parsed.error === undefined
          ? ok(parsed.result)
          : err(processFailure(`Codex App Server request failed: ${JSON.stringify(parsed.error)}`)),
      );
      return;
    }
    for (const listener of this.listeners) listener(parsed);
  }

  private failPending(error: HarnessError): void {
    for (const { resolve } of this.pending.values()) resolve(err(error));
    this.pending.clear();
  }
}

export class DefaultCodexAppServerTransportFactory implements CodexAppServerTransportFactory {
  open(
    workingDirectory: string,
    onTranscriptChunk?: (chunk: string) => Promise<void>,
  ): Promise<Result<CodexAppServerTransport, HarnessError>> {
    return Promise.resolve(
      ok(new StdioCodexAppServerTransport(workingDirectory, onTranscriptChunk)),
    );
  }
}
