import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SIGN_ENDPOINT = 'https://sign.voidcarve.com/v1/requests';
const BUNDLE_ID = 'io.github.wuyilingwei.iris';
const APP = 'IRIS.app';
const ARCHES = Object.freeze({ arm64: 'arm64', x64: 'x86_64' });
const MARKER = '.iris-shell-sign-run';
const BUNDLE_NAME = 'source.zip';
const MIN_PART_BYTES = 5 * 1024 * 1024;
const MAX_PART_BYTES = 64 * 1024 * 1024;
const PART_ATTEMPTS = 5;
const MAX_JSON_BYTES = 1_000_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const VERSION = /^\d+\.\d+\.\d+$/;
const SHA = /^[a-f0-9]{40}$/;
const MAC_DIR = /^mac(-[a-z0-9]+)?$/;

export const PROJECT = (arch) => `iris-shell-${arch}`;

class SubmitError extends Error {
  constructor(code, transient = false) { super(code); this.code = code; this.transient = transient; }
}

export class ContextError extends SubmitError {
  constructor() { super('CONTEXT_INVALID'); }
}

function defaultExec(file, args, { capture = false } = {}) {
  const result = spawnSync(file, args, {
    encoding: 'utf8', stdio: ['ignore', capture ? 'pipe' : 'ignore', 'ignore'], timeout: 120_000,
    env: { ...process.env, COPYFILE_DISABLE: '1' },
  });
  if (result.error || result.status !== 0) throw new SubmitError('IMPORT_COMMAND_FAILED');
  return capture ? String(result.stdout ?? '') : undefined;
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function validateRunId(value) {
  if (!/^\d+$/.test(value ?? '') || !Number.isSafeInteger(Number(value)) || Number(value) < 1) throw new SubmitError('INVALID_RUN_ID');
  return String(Number(value));
}

function requireFirstAttempt(env) {
  if (env.GITHUB_RUN_ATTEMPT !== '1') throw new SubmitError('INVALID_RUN_ATTEMPT');
}

function requireArch(value) {
  if (!Object.hasOwn(ARCHES, value ?? '')) throw new SubmitError('INVALID_ARCHITECTURE');
  return value;
}

function requireVersion(value) {
  if (!VERSION.test(value ?? '')) throw new SubmitError('INVALID_SIGNING_REQUEST');
  return value;
}

function requireSourceSha(value) {
  if (!SHA.test(value ?? '')) throw new SubmitError('INVALID_SIGNING_REQUEST');
  return value;
}

function runnerTemp(env) {
  const dir = env.RUNNER_TEMP;
  if (!dir || !path.isAbsolute(dir)) throw new SubmitError('TEMP_UNAVAILABLE');
  return path.resolve(dir);
}

async function writeOutputs(env, values) {
  const output = env.GITHUB_OUTPUT;
  const entries = Object.entries(values).map(([key, value]) => [key, String(value)]);
  if (!output || entries.some(([, value]) => /[\r\n]/.test(value))) throw new SubmitError('OUTPUT_UNAVAILABLE');
  await writeFile(output, entries.map(([key, value]) => `${key}=${value}\n`).join(''), { flag: 'a', mode: 0o600 });
}

async function fileHash(file) {
  const hash = createHash('sha256');
  let size = 0;
  for await (const chunk of createReadStream(file)) { hash.update(chunk); size += chunk.length; }
  return { digest: `sha256:${hash.digest('hex')}`, size };
}

async function sha256Hex(file) {
  return (await fileHash(file)).digest.slice('sha256:'.length);
}

async function realDirectory(target) {
  const info = await lstat(target).catch(() => null);
  return Boolean(info?.isDirectory() && !info.isSymbolicLink());
}

async function findApps(env, exec) {
  const releaseDir = path.join(path.resolve(env.GITHUB_WORKSPACE ?? ''), 'release');
  const found = new Map();
  let entries;
  try { entries = await readdir(releaseDir, { withFileTypes: true }); } catch { throw new SubmitError('APP_BUNDLE_COUNT_INVALID'); }
  for (const entry of entries) {
    if (!MAC_DIR.test(entry.name)) continue;
    const dir = path.join(releaseDir, entry.name);
    if (!await realDirectory(dir)) throw new SubmitError('APP_BUNDLE_INVALID');
    const app = path.join(dir, APP);
    const info = await lstat(app).catch(() => null);
    if (!info) continue;
    if (!info.isDirectory() || info.isSymbolicLink()) throw new SubmitError('APP_BUNDLE_INVALID');
    const lipo = exec('/usr/bin/lipo', ['-archs', path.join(app, 'Contents', 'MacOS', 'IRIS')], { capture: true }).trim();
    const arch = Object.keys(ARCHES).find((name) => ARCHES[name] === lipo);
    if (!arch || found.has(arch)) throw new SubmitError('APP_BUNDLE_COUNT_INVALID');
    found.set(arch, { dir, app });
  }
  if (found.size !== Object.keys(ARCHES).length) throw new SubmitError('APP_BUNDLE_COUNT_INVALID');
  return found;
}

function plistValue(exec, app, key) {
  return exec('/usr/bin/plutil', ['-extract', key, 'raw', '-o', '-', path.join(app, 'Contents', 'Info.plist')], { capture: true }).trim();
}

const COMPARED_FILES = [['Contents', 'Info.plist'], ['Contents', 'MacOS', 'IRIS'], ['Contents', 'Resources', 'app.asar']];

async function assertDmgMatchesApp(app, mounted) {
  const apps = [];
  for (const entry of await readdir(mounted, { withFileTypes: true })) {
    if (entry.name.endsWith('.app') && entry.isDirectory()) apps.push(entry.name);
  }
  if (apps.length !== 1 || apps[0] !== APP) throw new SubmitError('DMG_APP_MISMATCH');
  for (const parts of COMPARED_FILES) {
    const [left, right] = await Promise.all([sha256Hex(path.join(app, ...parts)), sha256Hex(path.join(mounted, APP, ...parts))]).catch(() => { throw new SubmitError('DMG_APP_MISMATCH'); });
    if (left !== right) throw new SubmitError('DMG_APP_MISMATCH');
  }
}

async function createWorkDir(env, runId, arch) {
  const workDir = await mkdtemp(path.join(runnerTemp(env), `iris-shell-sign-${runId}-${arch}-`));
  await chmod(workDir, 0o700);
  await writeFile(path.join(workDir, MARKER), `${runId}\n${arch}\n`, { flag: 'wx', mode: 0o600 });
  return workDir;
}

async function buildBundle({ env, exec, runId, arch, version, sourceSha, app, dir }) {
  const dmg = path.join(path.resolve(env.GITHUB_WORKSPACE), 'release', `IRIS-${version}-mac-${arch}.dmg`);
  const dmgInfo = await lstat(dmg).catch(() => null);
  if (!dmgInfo?.isFile()) throw new SubmitError('DMG_APP_MISMATCH');
  const workDir = await createWorkDir(env, runId, arch);
  const mounted = path.join(workDir, 'mounted');
  const stage = path.join(workDir, 'stage');
  let attached = false;
  let keep = false;
  try {
    await mkdir(mounted, { mode: 0o700 });
    await mkdir(stage, { mode: 0o700 });
    exec('/usr/bin/hdiutil', ['attach', '-readonly', '-nobrowse', '-noautoopen', '-mountpoint', mounted, dmg]);
    attached = true;
    let mismatch = null;
    try { await assertDmgMatchesApp(app, mounted); } catch (error) { mismatch = error; }
    try { exec('/usr/bin/hdiutil', ['detach', mounted]); attached = false; }
    catch { keep = true; throw new SubmitError('DISK_IMAGE_DETACH_FAILED'); }
    if (mismatch) throw mismatch;
    const tar = path.join(stage, 'unsigned.tar.gz');
    const template = path.join(stage, 'template.dmg');
    const sourceJson = path.join(stage, 'source.json');
    exec('/usr/bin/tar', ['-czf', tar, '-C', dir, '--', APP]);
    await copyFile(dmg, template);
    await writeFile(sourceJson, `${JSON.stringify({ source_sha: sourceSha, version, bundle_id: BUNDLE_ID, architecture: arch })}\n`, { flag: 'wx', mode: 0o600 });
    const bundle = path.join(workDir, BUNDLE_NAME);
    exec('/usr/bin/zip', ['-q', '-X', '-j', '-0', bundle, tar, template, sourceJson]);
    const info = await stat(bundle).catch(() => null);
    if (!info?.isFile()) throw new SubmitError('IMPORT_COMMAND_FAILED');
    await chmod(bundle, 0o600);
    await rm(stage, { recursive: true, force: true });
    await rm(mounted, { recursive: true, force: true });
    return workDir;
  } catch (error) {
    if (!keep && !attached) await rm(workDir, { recursive: true, force: true });
    throw error;
  }
}

export async function prepare({ env = process.env, exec = defaultExec } = {}) {
  const runId = validateRunId(env.GITHUB_RUN_ID);
  requireFirstAttempt(env);
  const version = requireVersion(env.INPUT_VERSION);
  const sourceSha = requireSourceSha(env.INPUT_SOURCE_SHA);
  runnerTemp(env);
  if (!env.GITHUB_WORKSPACE || !path.isAbsolute(env.GITHUB_WORKSPACE)) throw new SubmitError('WORKSPACE_UNAVAILABLE');
  const apps = await findApps(env, exec);
  for (const { app } of apps.values()) {
    let bundleId;
    let shortVersion;
    try { bundleId = plistValue(exec, app, 'CFBundleIdentifier'); shortVersion = plistValue(exec, app, 'CFBundleShortVersionString'); }
    catch { throw new SubmitError('APP_METADATA_INVALID'); }
    if (bundleId !== BUNDLE_ID || shortVersion !== version) throw new SubmitError('APP_METADATA_INVALID');
  }
  const created = {};
  try {
    for (const arch of Object.keys(ARCHES)) {
      const { app, dir } = apps.get(arch);
      created[arch] = await buildBundle({ env, exec, runId, arch, version, sourceSha, app, dir });
    }
  } catch (error) {
    await Promise.all(Object.values(created).map((dir) => rm(dir, { recursive: true, force: true })));
    throw error;
  }
  return created;
}

async function checkedWorkDir(value, arch, runId, env) {
  const workDir = path.resolve(value ?? '');
  if (path.dirname(workDir) !== runnerTemp(env) || !path.basename(workDir).startsWith(`iris-shell-sign-${runId}-${arch}-`)) throw new SubmitError('INVALID_TEMP_DIR');
  try {
    const marker = (await readFile(path.join(workDir, MARKER), 'utf8')).split('\n');
    if (marker[0] !== runId || marker[1] !== arch) throw new SubmitError('INVALID_TEMP_DIR');
  } catch (error) {
    if (error instanceof SubmitError) throw error;
    if (error.code === 'ENOENT') return null;
    throw new SubmitError('INVALID_TEMP_DIR');
  }
  return workDir;
}

async function jsonResponse(response) {
  if (!response.ok || !response.body) throw new SubmitError('SIGNING_REQUEST_FAILED');
  const length = Number(response.headers.get('content-length') ?? 0);
  if (length > MAX_JSON_BYTES) throw new SubmitError('SIGNING_REQUEST_FAILED');
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.byteLength;
    if (size > MAX_JSON_BYTES) throw new SubmitError('SIGNING_REQUEST_FAILED');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks, size).toString('utf8')); }
  catch { throw new SubmitError('SIGNING_REQUEST_FAILED'); }
}

async function centerJson(fetchImpl, url, method, apiKey, body, extraHeaders = {}, timeoutMs = 30_000) {
  let response;
  try {
    response = await fetchImpl(url, {
      method,
      redirect: 'error',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json', accept: 'application/json', ...extraHeaders },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch { throw new SubmitError('SIGNING_REQUEST_FAILED', true); }
  if (!response.ok) throw new SubmitError('SIGNING_REQUEST_FAILED', response.status >= 500 || response.status === 408 || response.status === 429);
  return jsonResponse(response);
}

// The center answers the plan and complete calls idempotently, so a lost or slow response can be asked for again.
async function centerRetry(sleep, call) {
  for (let attempt = 1; ; attempt += 1) {
    try { return await call(); }
    catch (error) {
      if (!(error instanceof SubmitError) || !error.transient || attempt >= PART_ATTEMPTS) throw error;
      await sleep(2000 * 2 ** (attempt - 1));
    }
  }
}

function validateUploadPlan(plan, bundle) {
  const received = plan?.received_parts;
  if (!Number.isInteger(plan?.part_size) || plan.part_size < MIN_PART_BYTES || plan.part_size > MAX_PART_BYTES
    || !Number.isInteger(plan.part_count) || plan.part_count !== Math.ceil(bundle.size / plan.part_size)
    || !Array.isArray(received) || !received.every((n) => Number.isInteger(n) && n >= 1 && n <= plan.part_count)) throw new SubmitError('SIGNING_REQUEST_FAILED');
  return plan;
}

async function putPart(fetchImpl, url, apiKey, file, start, length) {
  const response = await fetchImpl(url, {
    method: 'PUT',
    redirect: 'error',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/octet-stream', 'content-length': String(length) },
    body: createReadStream(file, { start, end: start + length - 1 }),
    duplex: 'half',
    signal: AbortSignal.timeout(300_000),
  });
  await response.body?.cancel();
  return response.status;
}

async function uploadParts(fetchImpl, sleep, base, apiKey, file, bundle) {
  const fetchPlan = async () => validateUploadPlan(await centerRetry(sleep, () => centerJson(fetchImpl, `${base}/source`, 'POST', apiKey, {})), bundle);
  let plan = await fetchPlan();
  for (let part = 1; part <= plan.part_count; part += 1) {
    if (plan.received_parts.includes(part)) continue;
    const start = (part - 1) * plan.part_size;
    const length = Math.min(plan.part_size, bundle.size - start);
    for (let attempt = 1; ; attempt += 1) {
      let status = 0;
      try { status = await putPart(fetchImpl, `${base}/source/parts/${part}`, apiKey, file, start, length); } catch { status = 0; }
      if (status === 200) break;
      const transient = status === 0 || status >= 500 || status === 408 || status === 429;
      if (!transient || attempt >= PART_ATTEMPTS) throw new SubmitError('SOURCE_UPLOAD_FAILED');
      await sleep(2000 * 2 ** (attempt - 1));
      plan = await fetchPlan();
      if (plan.received_parts.includes(part)) break;
    }
  }
}

export async function submitSource({ env = process.env, fetchImpl = fetch, sleep = defaultSleep } = {}) {
  const arch = requireArch(env.INPUT_ARCH);
  const runId = validateRunId(env.GITHUB_RUN_ID);
  requireFirstAttempt(env);
  const version = requireVersion(env.INPUT_VERSION);
  const sourceSha = requireSourceSha(env.INPUT_SOURCE_SHA);
  const workDir = await checkedWorkDir(env.INPUT_WORK_DIR, arch, runId, env);
  if (!workDir) throw new SubmitError('INVALID_TEMP_DIR');
  const apiKey = env.SIGNING_API_KEY;
  if (!apiKey) throw new SubmitError('SIGNING_API_KEY_UNAVAILABLE');
  const file = path.join(workDir, BUNDLE_NAME);
  const info = await stat(file).catch(() => null);
  if (!info?.isFile()) throw new SubmitError('INVALID_SIGNING_REQUEST');
  const bundle = await fileHash(file);
  if (bundle.size < 1) throw new SubmitError('INVALID_SIGNING_REQUEST');
  const body = {
    project_id: PROJECT(arch),
    platform: 'macos',
    execution_visibility: 'public',
    run_id: Number(runId),
    run_attempt: 1,
    input_digest: bundle.digest,
    input_size: bundle.size,
    version,
    source_sha: sourceSha,
  };
  const created = await centerJson(fetchImpl, SIGN_ENDPOINT, 'POST', apiKey, body, { 'idempotency-key': `iris-shell-${arch}-${runId}-1` });
  if (typeof created.request_id !== 'string' || !UUID.test(created.request_id)) throw new SubmitError('SIGNING_REQUEST_FAILED');
  const result = { request_id: created.request_id, input_digest: bundle.digest, input_size: bundle.size };
  if (created.state === 'accepted_waiting_source') return result;
  if (created.state !== 'awaiting_upload') throw new SubmitError('SIGNING_REQUEST_FAILED');
  const base = `${SIGN_ENDPOINT}/${created.request_id}`;
  await uploadParts(fetchImpl, sleep, base, apiKey, file, bundle);
  const completed = await centerRetry(sleep, () => centerJson(fetchImpl, `${base}/source/complete`, 'POST', apiKey, {}, {}, 300_000));
  if (completed.state !== 'accepted_waiting_source') throw new SubmitError('SIGNING_REQUEST_FAILED');
  return result;
}

const PATTERNS = Object.freeze({
  source_sha: SHA,
  shell_version: VERSION,
  internal_version: /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/,
  core_build: /^[0-9]{1,12}$/,
  core_version: /^(?:[1-9]?\d)\.(?:[1-9]\d{2,3})\.(?:0|[1-9]\d*)$/,
  shell_fingerprint: /^[a-f0-9]{64}$/,
  release_id: /^[A-Za-z0-9_-]{43}$/,
  sealed_envelope: /^[A-Za-z0-9_-]{1,8192}$/,
});
const CONTEXT_KEYS = ['schema_version', 'build_run_id', ...Object.keys(PATTERNS), 'macos'];
const MACOS_KEYS = ['project_id', 'request_id', 'input_digest', 'input_size'];

function exactKeys(value, keys) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

/** Validates a parsed context and returns a canonical copy; throws ContextError on any deviation. */
export function validateContext(value) {
  if (!exactKeys(value, CONTEXT_KEYS) || value.schema_version !== 1
    || !Number.isSafeInteger(value.build_run_id) || value.build_run_id < 1) throw new ContextError();
  for (const [key, pattern] of Object.entries(PATTERNS)) {
    if (typeof value[key] !== 'string' || !pattern.test(value[key])) throw new ContextError();
  }
  if (!value.core_version.endsWith(`.${value.core_build}`)) throw new ContextError();
  if (!exactKeys(value.macos, Object.keys(ARCHES))) throw new ContextError();
  const macos = {};
  for (const arch of Object.keys(ARCHES)) {
    const entry = value.macos[arch];
    if (!exactKeys(entry, MACOS_KEYS) || entry.project_id !== PROJECT(arch) || typeof entry.request_id !== 'string' || !UUID.test(entry.request_id)
      || typeof entry.input_digest !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(entry.input_digest)
      || !Number.isSafeInteger(entry.input_size) || entry.input_size < 1) throw new ContextError();
    macos[arch] = { project_id: entry.project_id, request_id: entry.request_id, input_digest: entry.input_digest, input_size: entry.input_size };
  }
  if (macos.arm64.request_id === macos.x64.request_id) throw new ContextError();
  const canonical = { schema_version: 1, build_run_id: value.build_run_id };
  for (const key of Object.keys(PATTERNS)) canonical[key] = value[key];
  canonical.macos = macos;
  return canonical;
}

// The release-key envelope sits in a public artifact, so it is wrapped under a repository secret that no private-source step receives.
function sealKey(secret) {
  if (typeof secret !== 'string' || secret.length < 32) throw new SubmitError('SEAL_KEY_INVALID');
  return Buffer.from(hkdfSync('sha256', secret, 'iris-shell-release-context', 'envelope-v1', 32));
}

const sealAad = (context) => Buffer.from(`${context.build_run_id}:${context.source_sha}:${context.release_id}`);

export function sealEnvelope(secret, context, envelope) {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', sealKey(secret), nonce);
  cipher.setAAD(sealAad(context));
  const body = Buffer.concat([cipher.update(envelope, 'utf8'), cipher.final()]);
  return Buffer.concat([nonce, body, cipher.getAuthTag()]).toString('base64url');
}

export function openEnvelope(secret, context) {
  const raw = Buffer.from(context.sealed_envelope, 'base64url');
  if (raw.length < 12 + 16 + 1) throw new ContextError();
  try {
    const decipher = createDecipheriv('aes-256-gcm', sealKey(secret), raw.subarray(0, 12));
    decipher.setAAD(sealAad(context));
    decipher.setAuthTag(raw.subarray(raw.length - 16));
    return Buffer.concat([decipher.update(raw.subarray(12, raw.length - 16)), decipher.final()]).toString('utf8');
  } catch (error) {
    if (error instanceof SubmitError) throw error;
    throw new ContextError();
  }
}

export function buildContext(env = process.env) {
  const size = (raw) => (/^[1-9]\d{0,15}$/.test(raw ?? '') ? Number(raw) : NaN);
  const arch = (name) => ({
    project_id: PROJECT(name),
    request_id: env[`INPUT_${name.toUpperCase()}_REQUEST_ID`],
    input_digest: env[`INPUT_${name.toUpperCase()}_INPUT_DIGEST`],
    input_size: size(env[`INPUT_${name.toUpperCase()}_INPUT_SIZE`]),
  });
  const runId = /^\d+$/.test(env.GITHUB_RUN_ID ?? '') ? Number(env.GITHUB_RUN_ID) : NaN;
  const candidate = { schema_version: 1, build_run_id: runId };
  for (const key of Object.keys(PATTERNS)) candidate[key] = env[`INPUT_${key.toUpperCase()}`];
  const envelope = env.INPUT_RELEASE_ENVELOPE;
  if (!/^[A-Za-z0-9_-]{1,4096}$/.test(envelope ?? '')) throw new ContextError();
  candidate.sealed_envelope = 'x';
  candidate.macos = { arm64: arch('arm64'), x64: arch('x64') };
  const canonical = validateContext(candidate);
  canonical.sealed_envelope = sealEnvelope(env.IRIS_CONTEXT_SEAL_KEY, canonical, envelope);
  return validateContext(canonical);
}

export async function writeContext({ env = process.env } = {}) {
  const context = buildContext(env);
  const dir = path.join(runnerTemp(env), 'shell-release-context');
  try { await mkdir(dir, { mode: 0o700 }); } catch { throw new SubmitError('CONTEXT_WRITE_FAILED'); }
  const file = path.join(dir, 'context.json');
  await writeFile(file, `${JSON.stringify(context, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  return file;
}

export async function cleanup({ env = process.env } = {}) {
  const runId = validateRunId(env.GITHUB_RUN_ID);
  const dirs = (env.INPUT_WORK_DIRS ?? '').split(/\s+/).filter(Boolean);
  const targets = [];
  for (const dir of dirs) {
    const resolved = path.resolve(dir);
    const prefix = `iris-shell-sign-${runId}-`;
    if (path.dirname(resolved) !== runnerTemp(env) || !path.basename(resolved).startsWith(prefix)) throw new SubmitError('INVALID_TEMP_DIR');
    const arch = Object.keys(ARCHES).find((name) => path.basename(resolved).startsWith(`${prefix}${name}-`));
    if (!arch) throw new SubmitError('INVALID_TEMP_DIR');
    targets.push(await checkedWorkDir(resolved, arch, runId, env));
  }
  for (const dir of targets) if (dir) await rm(dir, { recursive: true, force: true });
}

export async function main(args = process.argv.slice(2), { env = process.env, stderr = process.stderr, fetchImpl = fetch, sleep = defaultSleep, exec = defaultExec } = {}) {
  try {
    if (args.length !== 1 || !['prepare', 'submit', 'context', 'cleanup'].includes(args[0])) throw new SubmitError('INVALID_COMMAND');
    if (args[0] === 'prepare') {
      const dirs = await prepare({ env, exec });
      await writeOutputs(env, { arm64_work_dir: dirs.arm64, x64_work_dir: dirs.x64 });
    } else if (args[0] === 'submit') {
      await writeOutputs(env, await submitSource({ env, fetchImpl, sleep }));
    } else if (args[0] === 'context') {
      await writeOutputs(env, { path: await writeContext({ env }) });
    } else await cleanup({ env });
    return 0;
  } catch (error) {
    stderr.write(`${error instanceof SubmitError ? error.code : 'SUBMIT_FAILED'}\n`);
    return 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await main();
