#!/usr/bin/env node

import { createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

const command = process.argv.slice(2);
const REPORT_LIMIT = 12_000;
const privateLogDirectory = process.env.CI_PRIVATE_LOG_DIR;

async function preparePrivateLogs() {
  await mkdir(privateLogDirectory, { recursive: true, mode: 0o700 });
  const entries = await readdir(privateLogDirectory, { withFileTypes: true });
  const directories = await Promise.all(entries
    .filter((entry) => entry.isDirectory() && /^ci-(?:\d+|local)-/.test(entry.name))
    .map(async (entry) => {
      const path = join(privateLogDirectory, entry.name);
      return { path, modified: (await stat(path)).mtimeMs };
    }));
  directories.sort((left, right) => right.modified - left.modified);
  for (const entry of directories.slice(19)) await rm(entry.path, { recursive: true, force: true });
}

function redact(output) {
  let summary = output;
  const secrets = Object.entries(process.env)
    .filter(([name, value]) => value && value.length >= 4 && /(?:token|secret|password|key|pat|envelope|release_id|build_id|internal_version|sha|ref)/i.test(name))
    .map(([, value]) => value)
    .sort((left, right) => right.length - left.length);
  for (const value of secrets) summary = summary.split(value).join('[REDACTED]');
  return summary
    .replace(/(?:authorization:\s*(?:basic|bearer)\s+|(?:ghp_|github_pat_)[A-Za-z0-9_]+)[^\s'"`]+/gi, '[REDACTED]')
    .replace(/\b(?:run|release|build)[ _-]?id\s*[:=]\s*[^\s,]+/gi, '[REDACTED]')
    .replace(/\b(?:commit|sha|ref)\s*[:=]\s*[^\s,]+/gi, '[REDACTED]');
}

async function reportFailure(logPath, status) {
  const endpoint = process.env.WORKFLOW_REPORT_API;
  const token = process.env.WORKFLOW_REPORT_TOKEN;
  const runId = process.env.GITHUB_RUN_ID;
  if (!endpoint || !token || !runId || !/^\d+$/.test(runId)) return;

  try {
    const raw = await readFile(logPath, 'utf8');
    const summary = `CI command failed with exit code ${status}.\n${redact(raw).slice(-REPORT_LIMIT)}`;
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ run_id: runId, status: 'failed', exit_code: status, summary }),
      signal: AbortSignal.timeout(10_000),
    });
    await response.body?.cancel();
    if (!response.ok) process.stderr.write(`CI_REPORT_FAILED_${response.status}\n`);
  } catch {
    process.stderr.write('CI_REPORT_UNAVAILABLE\n');
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
    if (privateLogDirectory) await preparePrivateLogs();
    const runId = /^\d+$/.test(process.env.GITHUB_RUN_ID || '') ? process.env.GITHUB_RUN_ID : 'local';
    directory = await mkdtemp(join(privateLogDirectory || process.env.RUNNER_TEMP || tmpdir(), `ci-${runId}-`));
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
  if (directory && (status === 0 || !privateLogDirectory)) {
    try { await rm(directory, { recursive: true, force: true }); }
    catch { status = 1; }
  }

  process.stdout.write(status === 0 ? 'CI_STEP_OK\n' : `CI_STEP_FAILED_${status}\n`);
  process.exitCode = status;
}
