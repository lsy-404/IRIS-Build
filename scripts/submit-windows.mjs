import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { chmod, cp, lstat, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SIGN_ENDPOINT = 'https://sign.voidcarve.com/v1/requests';
const PROJECT = 'iris-shell-windows-x64';
const BUNDLE_ID = 'io.github.wuyilingwei.iris';
const VERSION = /^\d+\.\d+\.\d+$/;
const SHA = /^[a-f0-9]{40}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MARKER = '.iris-shell-windows-sign-run';
const PART_ATTEMPTS = 5;

class SubmitError extends Error {
  constructor(code, transient = false) { super(code); this.code = code; this.transient = transient; }
}

const sleepDefault = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function fail(code) { throw new SubmitError(code); }

function requireRun(env) {
  if (env.GITHUB_RUN_ATTEMPT !== '1' || !/^[1-9]\d*$/.test(env.GITHUB_RUN_ID ?? '') || !Number.isSafeInteger(Number(env.GITHUB_RUN_ID))) fail('INVALID_RUN');
  if (!VERSION.test(env.INPUT_VERSION ?? '') || !SHA.test(env.INPUT_SOURCE_SHA ?? '')) fail('INVALID_SIGNING_REQUEST');
  if (!env.RUNNER_TEMP || !path.isAbsolute(env.RUNNER_TEMP) || !env.GITHUB_WORKSPACE || !path.isAbsolute(env.GITHUB_WORKSPACE)) fail('TEMP_UNAVAILABLE');
}

function runPowerShell(env) {
  const command = "Add-Type -AssemblyName System.IO.Compression.FileSystem; [System.IO.Compression.ZipFile]::CreateFromDirectory($env:IRIS_ARCHIVE_STAGE, $env:IRIS_SOURCE_ARCHIVE, [System.IO.Compression.CompressionLevel]::Optimal, $false)";
  const result = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command], { encoding: 'utf8', stdio: ['ignore', 'ignore', 'ignore'], timeout: 120_000, env });
  if (result.error || result.status !== 0) fail('ARCHIVE_CREATE_FAILED');
}

async function hashFile(file) {
  const hash = createHash('sha256');
  let size = 0;
  for await (const chunk of createReadStream(file)) { hash.update(chunk); size += chunk.length; }
  return { digest: `sha256:${hash.digest('hex')}`, size };
}

async function prepare(env) {
  requireRun(env);
  const app = path.join(path.resolve(env.GITHUB_WORKSPACE), 'release', 'win-unpacked');
  const appInfo = await lstat(app).catch(() => null);
  if (!appInfo?.isDirectory() || appInfo.isSymbolicLink()) fail('APP_DIRECTORY_INVALID');
  const exeInfo = await lstat(path.join(app, 'IRIS.exe')).catch(() => null);
  if (!exeInfo?.isFile()) fail('APP_DIRECTORY_INVALID');
  const base = path.resolve(env.RUNNER_TEMP);
  const work = await mkdtemp(path.join(base, `iris-shell-windows-${env.GITHUB_RUN_ID}-`));
  await chmod(work, 0o700);
  try {
    await writeFile(path.join(work, MARKER), `${env.GITHUB_RUN_ID}\n`, { flag: 'wx', mode: 0o600 });
    const stage = path.join(work, 'stage');
    await mkdir(stage, { mode: 0o700 });
    const stagedApp = path.join(stage, 'app');
    await cp(app, stagedApp, { recursive: true, errorOnExist: true, force: false });
    await writeFile(path.join(stage, 'source.json'), `${JSON.stringify({ source_sha: env.INPUT_SOURCE_SHA, version: env.INPUT_VERSION, bundle_id: BUNDLE_ID, architecture: 'x64' })}\n`, { flag: 'wx', mode: 0o600 });
    const archive = path.join(work, 'source.zip');
    runPowerShell({ ...env, IRIS_ARCHIVE_STAGE: stage, IRIS_SOURCE_ARCHIVE: archive });
    const info = await stat(archive).catch(() => null);
    if (!info?.isFile() || info.size < 1) fail('ARCHIVE_CREATE_FAILED');
    await rm(stage, { recursive: true, force: true });
    return { work, archive };
  } catch (error) {
    await rm(work, { recursive: true, force: true });
    throw error;
  }
}

async function jsonBody(response) {
  if (!response.ok || !response.body) fail('SIGNING_REQUEST_FAILED');
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) { size += chunk.byteLength; if (size > 1_000_000) fail('SIGNING_REQUEST_FAILED'); chunks.push(chunk); }
  try { return JSON.parse(Buffer.concat(chunks, size).toString('utf8')); } catch { fail('SIGNING_REQUEST_FAILED'); }
}

async function postJson(fetchImpl, url, key, body, headers = {}, timeoutMs = 30_000) {
  let response;
  try {
    response = await fetchImpl(url, { method: 'POST', redirect: 'error', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', accept: 'application/json', ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
  } catch { throw new SubmitError('SIGNING_REQUEST_FAILED', true); }
  if (!response.ok) throw new SubmitError('SIGNING_REQUEST_FAILED', response.status >= 500 || response.status === 408 || response.status === 429);
  return jsonBody(response);
}

async function retry(sleep, action) {
  for (let attempt = 1; ; attempt += 1) {
    try { return await action(); }
    catch (error) {
      if (!(error instanceof SubmitError) || !error.transient || attempt >= PART_ATTEMPTS) throw error;
      await sleep(2000 * 2 ** (attempt - 1));
    }
  }
}

function validatePlan(plan, bundle) {
  if (!Number.isInteger(plan?.part_size) || plan.part_size < 5 * 1024 * 1024 || plan.part_size > 64 * 1024 * 1024
    || !Number.isInteger(plan.part_count) || plan.part_count !== Math.ceil(bundle.size / plan.part_size)
    || !Array.isArray(plan.received_parts) || !plan.received_parts.every((part) => Number.isInteger(part) && part >= 1 && part <= plan.part_count)) fail('SIGNING_REQUEST_FAILED');
  return plan;
}

async function upload(fetchImpl, sleep, base, key, archive, bundle) {
  const plan = async () => validatePlan(await retry(sleep, () => postJson(fetchImpl, `${base}/source`, key, {})), bundle);
  let current = await plan();
  for (let part = 1; part <= current.part_count; part += 1) {
    if (current.received_parts.includes(part)) continue;
    const start = (part - 1) * current.part_size;
    const length = Math.min(current.part_size, bundle.size - start);
    for (let attempt = 1; ; attempt += 1) {
      let status = 0;
      try {
        const response = await fetchImpl(`${base}/source/parts/${part}`, { method: 'PUT', redirect: 'error', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/octet-stream', 'content-length': String(length) }, body: createReadStream(archive, { start, end: start + length - 1 }), duplex: 'half', signal: AbortSignal.timeout(300_000) });
        status = response.status;
        await response.body?.cancel();
      } catch { status = 0; }
      if (status === 200) break;
      if (status !== 0 && status < 500 && status !== 408 && status !== 429 || attempt >= PART_ATTEMPTS) fail('SOURCE_UPLOAD_FAILED');
      await sleep(2000 * 2 ** (attempt - 1));
      current = await plan();
      if (current.received_parts.includes(part)) break;
    }
  }
  const completed = await retry(sleep, () => postJson(fetchImpl, `${base}/source/complete`, key, {}, {}, 300_000));
  if (completed.state !== 'accepted_waiting_source') fail('SIGNING_REQUEST_FAILED');
}

async function submit(env, fetchImpl, sleep) {
  requireRun(env);
  if (!env.SIGNING_API_KEY) fail('SIGNING_API_KEY_UNAVAILABLE');
  const work = path.resolve(env.INPUT_WORK_DIR ?? '');
  if (path.dirname(work) !== path.resolve(env.RUNNER_TEMP) || !path.basename(work).startsWith(`iris-shell-windows-${env.GITHUB_RUN_ID}-`)) fail('INVALID_TEMP_DIR');
  const marker = await readFile(path.join(work, MARKER), 'utf8').catch(() => '');
  if (marker !== `${env.GITHUB_RUN_ID}\n`) fail('INVALID_TEMP_DIR');
  const archive = path.join(work, 'source.zip');
  const bundle = await hashFile(archive);
  if (bundle.size < 1) fail('INVALID_SIGNING_REQUEST');
  const runId = Number(env.GITHUB_RUN_ID);
  const created = await postJson(fetchImpl, SIGN_ENDPOINT, env.SIGNING_API_KEY, {
    project_id: PROJECT, platform: 'windows', execution_visibility: 'public', run_id: runId, run_attempt: 1,
    input_digest: bundle.digest, input_size: bundle.size, version: env.INPUT_VERSION, source_sha: env.INPUT_SOURCE_SHA,
  }, { 'idempotency-key': `iris-shell-windows-x64-${runId}-1` });
  if (typeof created.request_id !== 'string' || !UUID.test(created.request_id)) fail('SIGNING_REQUEST_FAILED');
  if (created.state !== 'accepted_waiting_source') {
    if (created.state !== 'awaiting_upload') fail('SIGNING_REQUEST_FAILED');
    const base = `${SIGN_ENDPOINT}/${created.request_id}`;
    await upload(fetchImpl, sleep, base, env.SIGNING_API_KEY, archive, bundle);
  }
  return { request_id: created.request_id, input_digest: bundle.digest, input_size: bundle.size };
}

async function writeOutputs(env, values) {
  if (!env.GITHUB_OUTPUT || Object.values(values).some((value) => /[\r\n]/.test(String(value)))) fail('OUTPUT_UNAVAILABLE');
  const { appendFile } = await import('node:fs/promises');
  await appendFile(env.GITHUB_OUTPUT, Object.entries(values).map(([key, value]) => `${key}=${value}\n`).join(''), { mode: 0o600 });
}

export async function main(args = process.argv.slice(2), { env = process.env, fetchImpl = fetch, sleep = sleepDefault, stderr = process.stderr } = {}) {
  try {
    if (args.length !== 1 || !['prepare', 'submit'].includes(args[0])) fail('INVALID_COMMAND');
    if (args[0] === 'prepare') {
      const result = await prepare(env);
      await writeOutputs(env, { work_dir: result.work });
    } else await writeOutputs(env, await submit(env, fetchImpl, sleep));
    return 0;
  } catch (error) {
    stderr.write(`${error instanceof SubmitError ? error.code : 'SUBMIT_FAILED'}\n`);
    return 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await main();
