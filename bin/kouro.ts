#!/usr/bin/env bun

import { runCli } from '@kouro/cli';

try {
  process.exitCode = await runCli();
} catch (cause) {
  process.stderr.write(`${cause instanceof Error ? cause.message : 'Kouro failed'}\n`);
  process.exitCode = 1;
}
