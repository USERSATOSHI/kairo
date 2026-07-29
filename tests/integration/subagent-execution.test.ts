import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import { describe, expect, test } from 'bun:test';
import { ok, type Result } from '@usersatoshi/results';

import {
  AgentExecutor,
  type AgentHarness,
  type HarnessError,
  type HarnessExecution,
  type HarnessExecutionRequest,
  type SubagentInvocationResult,
} from '@kouro/executors';
import { HarnessRegistry, LocalArtifactWriter, ScriptedFakeHarness } from '@kouro/harnesses';

class DelegatingParentHarness implements AgentHarness {
  readonly id = 'parent';
  results: readonly SubagentInvocationResult[] = [];

  async execute(request: HarnessExecutionRequest): Promise<Result<HarnessExecution, HarnessError>> {
    if (!request.subagents) throw new Error('Expected declared subagents');
    expect(request.subagents.definitions).toEqual([
      { id: 'architecture', role: 'architecture-scout' },
      { id: 'tests', role: 'test-scout' },
    ]);
    const [architectureOne, architectureTwo, testsOne, testsTwo] = await Promise.all([
      request.subagents.invoke('architecture', 'Map the domain boundary'),
      request.subagents.invoke('architecture', 'Map the executor boundary'),
      request.subagents.invoke('tests', 'Find the lowest useful tests'),
      request.subagents.invoke('tests', 'Find more tests'),
    ]);
    this.results = [
      architectureOne,
      architectureTwo,
      testsOne,
      testsTwo,
      await request.subagents.invoke('architecture', 'Exceed the total limit'),
      await request.subagents.invoke('unknown', 'Try an unauthorized role'),
    ];
    return ok({
      output: { planned: true },
      transcript: '{"type":"parent"}',
      resumeToken: 'parent-session',
    });
  }

  resume(request: HarnessExecutionRequest): Promise<Result<HarnessExecution, HarnessError>> {
    return this.execute(request);
  }
}

describe('bounded workflow subagents', () => {
  test('runs multiple definitions, enforces limits, and records nested transcripts', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'kouro-subagents-'));
    try {
      const parent = new DelegatingParentHarness();
      const child = new ScriptedFakeHarness('scout', [
        { output: { scope: 'domain' }, transcript: '{"child":"domain"}' },
        { output: { scope: 'executor' }, transcript: '{"child":"executor"}' },
        { output: { files: ['test.ts'] }, transcript: '{"child":"tests"}' },
      ]);
      const executor = new AgentExecutor(
        new HarnessRegistry([parent, child]),
        new LocalArtifactWriter(directory),
      );

      const executed = await executor.execute({
        runId: 'run-subagents',
        invocationSequence: 1,
        attemptNumber: 1,
        harnessId: parent.id,
        workingDirectory: directory,
        role: 'planner',
        prompt: 'Create a plan.',
        capabilities: ['repository.read'],
        subagentDefinitions: [
          {
            id: 'architecture',
            role: 'architecture-scout',
            prompt: 'Inspect architecture.',
            harness: child.id,
            capabilities: ['repository.read'],
            maxInvocations: 2,
            maxConcurrent: 2,
          },
          {
            id: 'tests',
            role: 'test-scout',
            prompt: 'Inspect tests.',
            harness: child.id,
            capabilities: ['repository.read'],
            maxInvocations: 2,
            maxConcurrent: 1,
          },
        ],
      });

      expect(executed.isOk()).toBe(true);
      expect(parent.results.slice(0, 3).every(({ success }) => success)).toBe(true);
      expect(parent.results[3]).toMatchObject({
        callId: 'tests:4',
        success: false,
        error: 'Subagent concurrency limit reached: 1',
      });
      expect(parent.results[4]).toMatchObject({
        callId: 'architecture:5',
        success: false,
        error: 'Subagent invocation limit reached: 2',
      });
      expect(parent.results[5]).toMatchObject({
        callId: 'unknown:6',
        success: false,
        error: 'Subagent is not authorized: unknown',
      });
      expect(child.calls).toHaveLength(3);
      expect(child.calls.map(({ request }) => request.prompt)).toEqual([
        'Inspect architecture.\n\nDelegated task:\nMap the domain boundary',
        'Inspect architecture.\n\nDelegated task:\nMap the executor boundary',
        'Inspect tests.\n\nDelegated task:\nFind the lowest useful tests',
      ]);
      expect(child.calls.every(({ request }) => request.subagents === undefined)).toBe(true);

      const runDirectory = createHash('sha256').update('run-subagents').digest('hex');
      const transcript = await readFile(
        resolve(directory, runDirectory, '1', '1', 'harness_transcript.ndjson'),
        'utf8',
      );
      expect(transcript).toContain('"type":"kouro.subagent"');
      expect(transcript).toContain('"callId":"architecture:1"');
      expect(transcript).toContain('"callId":"tests:4"');
      expect(transcript).toContain('Subagent is not authorized: unknown');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
