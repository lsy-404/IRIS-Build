#!/usr/bin/env node

import { createWriteStream } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

const command = process.argv.slice(2);
const REPORT_LIMIT = 16_000;

async function reportFailure(logPath, status) {
  const endpoint = process.env.WORKFLOW_REPORT_API;
  const token = process.env.WORKFLOW_REPORT_TOKEN;
  const runId = process.env.GITHUB_RUN_ID;
  if (!endpoint || !token || !runId || !/^\d+$/.test(runId)) return;

  try {
    const raw = await readFile(logPath, 'utf8');
    const summary = `CI command failed with exit code ${status}.\n${raw.slice(-REPORT_LIMIT)}`;
    await fetch(endpoint, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ run_id: runId, summary }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    // Reporting must not replace the command result or expose its output.
  }
}

if (command[0] !== '--' || command.length < 2) {
  process.stderr.write('CI_STEP_FAILED_2\n');
  process.exitCode = 2;
} else {
  let directory;
  let logPath;
  let status = 1;
  try {
    directory = await mkdtemp(join(process.env.RUNNER_TEMP || tmpdir(), 'iris-ci-'));
    logPath = join(directory, 'command.log');
    status = await new Promise((resolve) => {
      const child = spawn(command[1], command.slice(2), { env: process.env, stdio: ['inherit', 'pipe', 'pipe'], windowsHide: true });
      const log = createWriteStream(logPath, { flags: 'wx', mode: 0o600 });
      let logOpen = true;
      let spawnFailed = false;
      log.on('error', () => { logOpen = false; });
      for (const stream of [child.stdout, child.stderr]) {
        stream?.on('data', (chunk) => { if (logOpen) log.write(chunk); });
      }
      child.once('error', (error) => {
        spawnFailed = true;
        if (logOpen) log.write(`${error.message}\n`);
      });
      child.once('close', async (code, signal) => {
        await new Promise((done) => log.end(done));
        resolve(code ?? (spawnFailed ? 127 : signal ? 128 : 1));
      });
    });
  } catch {
    status = 1;
  }

  if (status !== 0 && logPath) await reportFailure(logPath, status);
  if (directory) {
    try { await rm(directory, { recursive: true, force: true }); }
    catch { status = 1; }
  }

  process.stdout.write(status === 0 ? 'CI_STEP_OK\n' : `CI_STEP_FAILED_${status}\n`);
  process.exitCode = status;
}
