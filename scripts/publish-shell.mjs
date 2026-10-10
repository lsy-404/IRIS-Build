import { createHash } from 'node:crypto';
import { appendFile, copyFile, lstat, mkdir, mkdtemp, open, readFile, readdir, rm, stat, truncate, writeFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { PROJECT, openEnvelope, validateContext } from './submit-macos.mjs';

const GITHUB_API = 'https://api.github.com';
const SIGN_ENDPOINT = 'https://sign.voidcarve.com/v1/requests';
const TEAM_ID = '76DMUAK6J5';
const BUNDLE_ID = 'io.github.wuyilingwei.iris';
const APP = 'IRIS.app';
const BUILD_WORKFLOW = '.github/workflows/build.yml';
const CONTEXT_ARTIFACT = 'shell-release-context';
const SIGNED_ARTIFACT = 'signed-macos';
const TERMINAL_FAILURES = ['failed', 'cancelled'];
const ARCHES = ['arm64', 'x64'];
const LIPO_ARCH = { arm64: 'arm64', x64: 'x86_64' };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ARCHIVE_DIGEST = /^sha256:[a-f0-9]{64}$/;
const VERSION = /^\d+\.\d+\.\d+$/;
const SHA = /^[a-f0-9]{40}$/;
const SAFE_CODE = /^[a-z0-9_]{1,64}$/;
const MAX_CONTEXT_BYTES = 16 * 1024;
const MAX_JSON_BYTES = 1_000_000;
const REQUIRED_ENTITLEMENTS = ['com.apple.security.cs.allow-jit', 'com.apple.security.device.audio-input', 'com.apple.security.device.camera'];
const DOWNLOAD_ATTEMPTS = 5;

class PublishError extends Error {
  constructor(code, { detail = '', transient = false } = {}) { super(code); this.code = code; this.detail = detail; this.transient = transient; }
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function defaultExec(file, args) {
  const result = spawnSync(file, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 600_000, maxBuffer: 16 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw new PublishError('COMMAND_FAILED');
  return `${result.stdout ?? ''}${result.stderr ?? ''}`;
}

function requireRunId(value) {
  if (!/^[1-9]\d*$/.test(value ?? '') || !Number.isSafeInteger(Number(value))) throw new PublishError('INVALID_RUN_ID');
  return String(Number(value));
}

function requireRepository(env) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(env.GITHUB_REPOSITORY ?? '')) throw new PublishError('INVALID_REPOSITORY');
  return env.GITHUB_REPOSITORY;
}

function requireToken(env, name = 'GITHUB_TOKEN') {
  if (!env[name]) throw new PublishError(`${name}_UNAVAILABLE`);
  return env[name];
}

async function writeOutputs(env, values) {
  const entries = Object.entries(values).map(([key, value]) => [key, String(value)]);
  if (!env.GITHUB_OUTPUT || entries.some(([, value]) => /[\r\n]/.test(value))) throw new PublishError('OUTPUT_UNAVAILABLE');
  await appendFile(env.GITHUB_OUTPUT, entries.map(([key, value]) => `${key}=${value}\n`).join(''), { mode: 0o600 });
}

async function readJsonBody(response) {
  if (!response.body) throw new PublishError('INVALID_RESPONSE');
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.byteLength;
    if (size > MAX_JSON_BYTES) throw new PublishError('INVALID_RESPONSE');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks, size).toString('utf8')); } catch { throw new PublishError('INVALID_RESPONSE'); }
}

const isTransientStatus = (status) => status === 408 || status === 429 || status >= 500;

async function githubRequest({ fetchImpl, sleep }, token, method, route, { allow404 = false } = {}) {
  if (!/^\/[A-Za-z0-9_./?=&%-]+$/.test(route)) throw new PublishError('INVALID_GITHUB_ROUTE');
  for (let attempt = 1; ; attempt += 1) {
    let response;
    try {
      response = await fetchImpl(`${GITHUB_API}${route}`, {
        method, redirect: 'error', signal: AbortSignal.timeout(30_000),
        headers: { accept: 'application/vnd.github+json', authorization: `Bearer ${token}`, 'x-github-api-version': '2022-11-28' },
      });
    } catch { response = null; }
    if (response?.ok) {
      if (method === 'DELETE') { await response.body?.cancel(); return null; }
      return readJsonBody(response);
    }
    if (response?.status === 404 && allow404) { await response.body?.cancel(); return null; }
    const transient = !response || isTransientStatus(response.status);
    await response?.body?.cancel();
    if (!transient || attempt >= 3) throw new PublishError('GITHUB_REQUEST_FAILED');
    await sleep(2000 * attempt);
  }
}

// Gate: wait until no earlier shell release is still waiting to be published.

async function pendingBuildRun(deps, token, repo, currentRunId) {
  const listing = await githubRequest(deps, token, 'GET', `/repos/${repo}/actions/artifacts?name=${CONTEXT_ARTIFACT}&per_page=100`);
  for (const artifact of listing?.artifacts ?? []) {
    const runId = artifact?.workflow_run?.id;
    if (artifact.expired || !Number.isSafeInteger(runId) || String(runId) === currentRunId) continue;
    const run = await githubRequest(deps, token, 'GET', `/repos/${repo}/actions/runs/${runId}`, { allow404: true });
    if (run && String(run.path ?? '').split('@')[0] === BUILD_WORKFLOW && run.conclusion === 'success') return runId;
  }
  return null;
}

export async function gate({ env = process.env, fetchImpl = fetch, sleep = defaultSleep, now = Date.now, summary } = {}) {
  const token = requireToken(env);
  const repo = requireRepository(env);
  const runId = requireRunId(env.GITHUB_RUN_ID);
  const timeoutMs = Number(env.INPUT_GATE_TIMEOUT_SECONDS ?? 14400) * 1000;
  const intervalMs = Number(env.INPUT_GATE_INTERVAL_SECONDS ?? 60) * 1000;
  if (!(timeoutMs >= 0) || !(intervalMs > 0)) throw new PublishError('INVALID_GATE_SETTINGS');
  const write = summary ?? (async (text) => { if (env.GITHUB_STEP_SUMMARY) await appendFile(env.GITHUB_STEP_SUMMARY, text); });
  const deadline = now() + timeoutMs;
  for (;;) {
    const blocking = await pendingBuildRun({ fetchImpl, sleep }, token, repo, runId);
    if (blocking === null) return;
    if (now() >= deadline) {
      await write(`## Shell publish pending\n\nBuild run ${blocking} has signed shell installers that are not published yet. Publish or discard that release, then build again.\n`);
      throw new PublishError('SHELL_PUBLISH_PENDING');
    }
    await sleep(intervalMs);
  }
}

// Resolve: decide whether a finished build run carries a shell release.

export async function resolve({ env = process.env, fetchImpl = fetch, sleep = defaultSleep } = {}) {
  const deps = { fetchImpl, sleep };
  const token = requireToken(env);
  const repo = requireRepository(env);
  const buildRunId = requireRunId(env.INPUT_BUILD_RUN_ID);
  const repository = await githubRequest(deps, token, 'GET', `/repos/${repo}`);
  const run = await githubRequest(deps, token, 'GET', `/repos/${repo}/actions/runs/${buildRunId}`);
  if (String(run?.id) !== buildRunId
    || String(run.path ?? '').split('@')[0] !== BUILD_WORKFLOW
    || String(run.repository?.id) !== String(env.GITHUB_REPOSITORY_ID ?? '')
    || run.run_attempt !== 1 || run.status !== 'completed' || run.conclusion !== 'success'
    || typeof repository?.default_branch !== 'string' || run.head_branch !== repository.default_branch
    || !['repository_dispatch', 'workflow_dispatch'].includes(run.event)) throw new PublishError('BUILD_RUN_NOT_ALLOWED');
  const listing = await githubRequest(deps, token, 'GET', `/repos/${repo}/actions/runs/${buildRunId}/artifacts?name=${CONTEXT_ARTIFACT}&per_page=100`);
  const artifacts = listing?.artifacts;
  if (!Array.isArray(artifacts)) throw new PublishError('CONTEXT_INVALID');
  if (artifacts.length === 0) return { shell: false };
  if (artifacts.length !== 1 || artifacts[0].expired || artifacts[0].name !== CONTEXT_ARTIFACT) throw new PublishError('CONTEXT_INVALID');
  return { shell: true };
}

// Context: strict read of the file Run A left behind.

export async function readContext({ env = process.env } = {}) {
  const file = env.INPUT_CONTEXT_FILE;
  const buildRunId = requireRunId(env.INPUT_BUILD_RUN_ID);
  if (!file || !path.isAbsolute(file)) throw new PublishError('CONTEXT_INVALID');
  const info = await lstat(file).catch(() => null);
  if (!info?.isFile() || info.size > MAX_CONTEXT_BYTES) throw new PublishError('CONTEXT_INVALID');
  let parsed;
  try { parsed = JSON.parse(await readFile(file, 'utf8')); } catch { throw new PublishError('CONTEXT_INVALID'); }
  let context;
  try { context = validateContext(parsed); } catch { throw new PublishError('CONTEXT_INVALID'); }
  if (String(context.build_run_id) !== buildRunId) throw new PublishError('CONTEXT_INVALID');
  return context;
}

export function contextOutputs(context, { pub = false, sealKey } = {}) {
  const outputs = {
    source_sha: context.source_sha,
    shell_version: context.shell_version,
    arm64_request_id: context.macos.arm64.request_id,
    arm64_input_digest: context.macos.arm64.input_digest,
    x64_request_id: context.macos.x64.request_id,
    x64_input_digest: context.macos.x64.input_digest,
  };
  if (pub) return outputs;
  for (const key of ['internal_version', 'core_build', 'core_version', 'shell_fingerprint', 'release_id']) outputs[key] = context[key];
  try { outputs.release_envelope = openEnvelope(sealKey, context); } catch { throw new PublishError('CONTEXT_INVALID'); }
  return outputs;
}

// Signing center access.

function signingInputs(env) {
  const buildRunId = requireRunId(env.INPUT_BUILD_RUN_ID);
  const version = env.INPUT_VERSION;
  const sourceSha = env.INPUT_SOURCE_SHA;
  if (!VERSION.test(version ?? '') || !SHA.test(sourceSha ?? '')) throw new PublishError('INVALID_INPUT');
  const apiKey = env.SIGNING_API_KEY;
  if (!apiKey) throw new PublishError('SIGNING_API_KEY_UNAVAILABLE');
  const requests = {};
  for (const arch of ARCHES) {
    const id = env[`INPUT_${arch.toUpperCase()}_REQUEST_ID`];
    const digest = env[`INPUT_${arch.toUpperCase()}_INPUT_DIGEST`];
    if (!UUID.test(id ?? '') || !ARCHIVE_DIGEST.test(digest ?? '')) throw new PublishError('INVALID_INPUT');
    requests[arch] = { id, digest };
  }
  if (requests.arm64.id === requests.x64.id) throw new PublishError('INVALID_INPUT');
  return { buildRunId, version, sourceSha, apiKey, requests };
}

async function signingStatus({ fetchImpl }, inputs, arch) {
  const { id, digest } = inputs.requests[arch];
  let response;
  try {
    response = await fetchImpl(`${SIGN_ENDPOINT}/${id}`, {
      method: 'GET', redirect: 'error', signal: AbortSignal.timeout(30_000),
      headers: { authorization: `Bearer ${inputs.apiKey}`, accept: 'application/json' },
    });
  } catch { throw new PublishError('SIGNING_STATUS_UNAVAILABLE', { transient: true }); }
  if (!response.ok) {
    await response.body?.cancel();
    if (isTransientStatus(response.status)) throw new PublishError('SIGNING_STATUS_UNAVAILABLE', { transient: true });
    if (response.status === 401 || response.status === 403) throw new PublishError('SIGNING_AUTH_FAILED');
    if (response.status === 404) throw new PublishError('SIGNING_REQUEST_NOT_FOUND');
    throw new PublishError('SIGNING_STATUS_FAILED');
  }
  let body;
  try { body = await readJsonBody(response); } catch { throw new PublishError('SIGNING_STATUS_UNAVAILABLE', { transient: true }); }
  if (body?.request_id !== id || body.project_id !== PROJECT(arch) || body.platform !== 'macos'
    || body.source_run_id !== Number(inputs.buildRunId) || body.version !== inputs.version
    || body.source_sha !== inputs.sourceSha || body.input_digest !== digest) throw new PublishError('SIGNING_REQUEST_MISMATCH');
  return body;
}

function interpretStatus(body, arch) {
  if (TERMINAL_FAILURES.includes(body.state)) {
    throw new PublishError(`SIGNING_${body.state.toUpperCase()}`, { detail: typeof body.error === 'string' && SAFE_CODE.test(body.error) ? `${arch} ${body.error}` : arch });
  }
  if (body.state !== 'succeeded') return null;
  const output = body.output;
  if (!output || !ARCHIVE_DIGEST.test(output.archive_digest ?? '') || !Number.isSafeInteger(output.archive_size) || output.archive_size < 1) throw new PublishError('SIGNING_OUTPUT_INVALID');
  return { digest: output.archive_digest, size: output.archive_size };
}

export async function awaitSigning({ env = process.env, fetchImpl = fetch, sleep = defaultSleep, now = Date.now, log = (line) => process.stdout.write(`${line}\n`) } = {}) {
  const inputs = signingInputs(env);
  const timeoutMs = Number(env.INPUT_TIMEOUT_SECONDS ?? 10800) * 1000;
  if (!(timeoutMs > 0)) throw new PublishError('INVALID_INPUT');
  const deadline = now() + timeoutMs;
  const done = new Set();
  const lastState = new Map();
  for (;;) {
    let wait = 30;
    for (const arch of ARCHES.filter((name) => !done.has(name))) {
      let body;
      try { body = await signingStatus({ fetchImpl }, inputs, arch); }
      catch (error) {
        if (error.transient) continue;
        throw error;
      }
      if (interpretStatus(body, arch)) { done.add(arch); }
      const state = SAFE_CODE.test(body.state ?? '') ? body.state : 'unknown';
      if (lastState.get(arch) !== state) { lastState.set(arch, state); log(`${arch}: ${state}`); }
      if (Number.isFinite(body.retry_after_seconds)) wait = body.retry_after_seconds;
    }
    if (done.size === ARCHES.length) return;
    if (now() >= deadline) throw new PublishError('SIGNING_TIMEOUT');
    await sleep(Math.min(300, Math.max(15, wait)) * 1000);
  }
}

// Fetch: download, check and stage the signed disk images.

const ISSUED_KEYS = ['schema_version', 'request_id', 'generation', 'stage', 'input_digest', 'recipe_sha', 'policy_digest', 'team_id', 'bundle_id', 'version', 'architecture',
  'codesign_verified', 'timestamp_verified', 'asar_integrity_verified', 'notarization_id', 'notarization_status', 'notary_archive_sha256', 'gatekeeper_verified', 'staple_verified', 'files'];

export function validateVerification(report, { requestId, version, arch, productSize, productSha256 }) {
  const ok = report !== null && typeof report === 'object' && !Array.isArray(report)
    && Object.keys(report).length === ISSUED_KEYS.length && ISSUED_KEYS.every((key) => Object.hasOwn(report, key))
    && report.schema_version === 1 && report.request_id === requestId && report.stage === 'dmg_finalize'
    && ARCHIVE_DIGEST.test(report.input_digest) && report.team_id === TEAM_ID && report.bundle_id === BUNDLE_ID
    && report.version === version && report.architecture === arch
    && report.codesign_verified === true && report.timestamp_verified === true
    && report.gatekeeper_verified === true && report.staple_verified === true
    && report.notarization_status === 'Accepted'
    && Number.isSafeInteger(report.generation) && report.generation > 0
    && typeof report.asar_integrity_verified === 'boolean'
    && SHA.test(report.recipe_sha) && ARCHIVE_DIGEST.test(report.policy_digest)
    && UUID.test(report.notarization_id) && /^[a-f0-9]{64}$/.test(report.notary_archive_sha256)
    && Array.isArray(report.files) && report.files.length === 1
    && Object.keys(report.files[0]).sort().join() === 'path,sha256,size'
    && report.files[0].path === 'product.dmg' && report.files[0].size === productSize && report.files[0].sha256 === productSha256;
  if (!ok) throw new PublishError('VERIFICATION_REPORT_INVALID');
  return report;
}

async function hashFile(file, algorithm) {
  const hash = createHash(algorithm);
  let size = 0;
  for await (const chunk of createReadStream(file)) { hash.update(chunk); size += chunk.length; }
  return { hash, size };
}

async function downloadArchive({ fetchImpl, sleep }, inputs, arch, expected, dest) {
  const url = `${SIGN_ENDPOINT}/${inputs.requests[arch].id}/download`;
  await writeFile(dest, '', { mode: 0o600 });
  for (let attempt = 1; ; attempt += 1) {
    const have = (await stat(dest)).size;
    let failure = null;
    try {
      const headers = { authorization: `Bearer ${inputs.apiKey}`, accept: 'application/zip' };
      if (have > 0) headers.range = `bytes=${have}-`;
      const response = await fetchImpl(url, { method: 'GET', redirect: 'error', headers, signal: AbortSignal.timeout(600_000) });
      if (response.status === 409 || response.status === 410) { await response.body?.cancel(); throw new PublishError('SIGNED_OUTPUT_UNAVAILABLE'); }
      if (response.status === 401 || response.status === 403 || response.status === 404) { await response.body?.cancel(); throw new PublishError('SIGNING_AUTH_FAILED'); }
      if (response.status === 416) { await response.body?.cancel(); await truncate(dest, 0); failure = new PublishError('DOWNLOAD_INTERRUPTED', { transient: true }); }
      else if (!response.ok || !response.body) { await response.body?.cancel(); failure = new PublishError('DOWNLOAD_INTERRUPTED', { transient: true }); }
      else {
        if (response.headers.get('x-signing-archive-digest') !== expected.digest) { await response.body.cancel(); throw new PublishError('SIGNED_OUTPUT_MISMATCH'); }
        let offset = have;
        if (response.status === 200) offset = 0;
        else if (response.status !== 206 || response.headers.get('content-range') !== `bytes ${have}-${expected.size - 1}/${expected.size}`) { await response.body.cancel(); throw new PublishError('SIGNED_OUTPUT_MISMATCH'); }
        if (offset === 0 && have > 0) await truncate(dest, 0);
        const handle = await open(dest, 'a');
        let written = offset;
        try {
          for await (const chunk of response.body) {
            written += chunk.byteLength;
            if (written > expected.size) throw new PublishError('SIGNED_OUTPUT_MISMATCH');
            await handle.write(chunk);
          }
        } catch (error) {
          if (error instanceof PublishError) throw error;
          failure = new PublishError('DOWNLOAD_INTERRUPTED', { transient: true });
        } finally { await handle.close(); }
        if (!failure && written < expected.size) failure = new PublishError('DOWNLOAD_INTERRUPTED', { transient: true });
        if (!failure) break;
      }
    } catch (error) {
      if (!(error instanceof PublishError)) failure = new PublishError('DOWNLOAD_INTERRUPTED', { transient: true });
      else if (error.transient) failure = error;
      else throw error;
    }
    if (attempt >= DOWNLOAD_ATTEMPTS) throw new PublishError('SIGNED_OUTPUT_UNAVAILABLE');
    await sleep(2000 * 2 ** (attempt - 1));
  }
  const { hash, size } = await hashFile(dest, 'sha256');
  if (size !== expected.size || `sha256:${hash.digest('hex')}` !== expected.digest) throw new PublishError('SIGNED_OUTPUT_MISMATCH');
}

function field(output, pattern) {
  return pattern.exec(output)?.[1];
}

function failCheck(name) { throw new PublishError(`MACOS_VERIFICATION_FAILED:${name}`); }

async function check(name, action) {
  try { return await action(); } catch { return failCheck(name); }
}

function requireIdentity(output, name) {
  if (field(output, /^TeamIdentifier=(.*)$/m) !== TEAM_ID) failCheck(name);
  const timestamp = field(output, /^Timestamp=(.*)$/m);
  if (!timestamp || timestamp.trim() === 'none') failCheck(name);
}

async function findMountedApp(mounted) {
  const apps = [];
  for (const entry of await readdir(mounted, { withFileTypes: true })) {
    if (entry.name.endsWith('.app') && entry.isDirectory()) apps.push(entry.name);
  }
  if (apps.length !== 1 || apps[0] !== APP) throw new PublishError('APP_BUNDLE_COUNT_INVALID');
  return path.join(mounted, APP);
}

const DEVELOPER_ID_REQUIREMENT = `anchor apple generic and identifier "${BUNDLE_ID}" and certificate leaf[subject.OU] = "${TEAM_ID}"`;

export async function verifyMacos({ exec = defaultExec, dmg, arch, version, tmpRoot = os.tmpdir() }) {
  const gatekeeper = 'source=Notarized Developer ID';
  await check('dmg-codesign', () => exec('/usr/bin/codesign', ['--verify', '--strict', '--verbose=2', dmg]));
  requireIdentity(await check('dmg-identity', () => exec('/usr/bin/codesign', ['-dv', '--verbose=4', dmg])), 'dmg-identity');
  await check('dmg-staple', () => exec('/usr/bin/xcrun', ['stapler', 'validate', dmg]));
  const dmgAssessment = await check('dmg-gatekeeper', () => exec('/usr/sbin/spctl', ['--assess', '--type', 'open', '--context', 'context:primary-signature', '--verbose=2', dmg]));
  if (!dmgAssessment.includes(gatekeeper)) failCheck('dmg-gatekeeper');

  const work = await mkdtemp(path.join(tmpRoot, 'iris-verify-'));
  const mounted = path.join(work, 'mounted');
  let attached = false;
  let failure = null;
  try {
    await check('dmg-mount', async () => { await mkdir(mounted, { mode: 0o700 }); exec('/usr/bin/hdiutil', ['attach', '-readonly', '-nobrowse', '-noautoopen', '-mountpoint', mounted, dmg]); attached = true; });
    const app = await check('dmg-mount', () => findMountedApp(mounted));

    await check('app-codesign', () => exec('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', `-R=${DEVELOPER_ID_REQUIREMENT}`, app]));
    const appIdentity = await check('app-identity', () => exec('/usr/bin/codesign', ['-dv', '--verbose=4', app]));
    requireIdentity(appIdentity, 'app-identity');
    if (!/^Authority=Developer ID Application: /m.test(appIdentity)) failCheck('app-identity');
    const flags = field(appIdentity, /flags=0x[0-9a-f]+\(([^)]*)\)/);
    if (!flags || !flags.split(',').includes('runtime')) failCheck('app-identity');
    const entitlements = await check('app-entitlements', () => exec('/usr/bin/codesign', ['-d', '--entitlements', '-', '--xml', app]));
    for (const key of REQUIRED_ENTITLEMENTS) if (!entitlements.includes(`<key>${key}</key>`)) failCheck('app-entitlements');

    const plist = path.join(app, 'Contents', 'Info.plist');
    const read = (key) => exec('/usr/bin/plutil', ['-extract', key, 'raw', '-o', '-', plist]).trim();
    if (await check('app-metadata', () => read('CFBundleIdentifier')) !== BUNDLE_ID) failCheck('app-metadata');
    if (await check('app-metadata', () => read('CFBundleShortVersionString')) !== version) failCheck('app-metadata');
    const archs = await check('app-metadata', () => exec('/usr/bin/lipo', ['-archs', path.join(app, 'Contents', 'MacOS', 'IRIS')]));
    if (archs.trim() !== LIPO_ARCH[arch]) failCheck('app-metadata');

    await check('app-notarization', () => exec('/usr/bin/xcrun', ['stapler', 'validate', app]));
    const appAssessment = await check('app-notarization', () => exec('/usr/sbin/spctl', ['--assess', '--type', 'execute', '--verbose=2', app]));
    if (!appAssessment.includes(gatekeeper)) failCheck('app-notarization');

    // The in-app updater copies the bundle out of the image and clears attributes before swapping it in.
    const copyRoot = path.join(work, 'copy');
    await check('updater-copy', async () => {
      await mkdir(copyRoot, { mode: 0o700 });
      exec('/usr/bin/ditto', [app, path.join(copyRoot, APP)]);
      exec('/usr/bin/xattr', ['-cr', path.join(copyRoot, APP)]);
      exec('/usr/bin/codesign', ['--verify', '--deep', '--strict', path.join(copyRoot, APP)]);
    });
  } catch (error) {
    failure = error;
  }
  let detachFailed = false;
  if (attached) {
    try { exec('/usr/bin/hdiutil', ['detach', mounted]); } catch { detachFailed = true; }
  }
  if (!detachFailed) await rm(work, { recursive: true, force: true });
  if (failure) throw failure;
  if (detachFailed) failCheck('dmg-detach');
}

function listEntries(output) {
  return output.split('\n').map((line) => line.trim()).filter(Boolean).sort();
}

export function latestMacYml({ version, x64, arm64, now }) {
  const entry = (arch, file) => `  - url: IRIS-${version}-mac-${arch}.dmg\n    sha512: ${file.sha512}\n    size: ${file.size}\n`;
  return `version: ${version}\nfiles:\n${entry('x64', x64)}${entry('arm64', arm64)}path: IRIS-${version}-mac-x64.dmg\nsha512: ${x64.sha512}\nreleaseDate: '${new Date(now()).toISOString()}'\n`;
}

async function retryStatus(deps, inputs, arch) {
  for (let attempt = 1; ; attempt += 1) {
    try { return await signingStatus(deps, inputs, arch); }
    catch (error) {
      if (!error.transient || attempt >= 5) throw error;
      await deps.sleep(2000 * 2 ** (attempt - 1));
    }
  }
}

export async function fetchSigned({ env = process.env, fetchImpl = fetch, sleep = defaultSleep, now = Date.now, exec = defaultExec } = {}) {
  const inputs = signingInputs(env);
  const runId = requireRunId(env.GITHUB_RUN_ID);
  if (!env.RUNNER_TEMP || !path.isAbsolute(env.RUNNER_TEMP)) throw new PublishError('TEMP_UNAVAILABLE');
  const deps = { fetchImpl, sleep };
  const work = path.join(env.RUNNER_TEMP, `iris-signed-${runId}`);
  const out = path.join(env.RUNNER_TEMP, 'signed-macos');
  await mkdir(work, { mode: 0o700 });
  await mkdir(out, { mode: 0o700 });
  const files = [];
  for (const arch of ARCHES) {
    const body = await retryStatus(deps, inputs, arch);
    const expected = interpretStatus(body, arch);
    if (!expected) throw new PublishError('SIGNED_OUTPUT_UNAVAILABLE');
    const zip = path.join(work, `${arch}.zip`);
    await downloadArchive(deps, inputs, arch, expected, zip);
    const entries = listEntries(exec('/usr/bin/unzip', ['-Z1', zip]));
    if (entries.join() !== 'product.dmg,verification.json') throw new PublishError('SIGNED_ARCHIVE_INVALID');
    const unpacked = path.join(work, arch);
    await mkdir(unpacked, { mode: 0o700 });
    exec('/usr/bin/unzip', ['-o', '-q', '-d', unpacked, zip]);
    const product = path.join(unpacked, 'product.dmg');
    const reportFile = path.join(unpacked, 'verification.json');
    const productInfo = await lstat(product).catch(() => null);
    const reportInfo = await lstat(reportFile).catch(() => null);
    if (!productInfo?.isFile() || !reportInfo?.isFile() || reportInfo.size > 65536) throw new PublishError('SIGNED_ARCHIVE_INVALID');
    const sha256 = await hashFile(product, 'sha256');
    const sha256Hex = sha256.hash.digest('hex');
    let report;
    try { report = JSON.parse(await readFile(reportFile, 'utf8')); } catch { throw new PublishError('VERIFICATION_REPORT_INVALID'); }
    validateVerification(report, { requestId: inputs.requests[arch].id, version: inputs.version, arch, productSize: sha256.size, productSha256: sha256Hex });
    await verifyMacos({ exec, dmg: product, arch, version: inputs.version, tmpRoot: env.RUNNER_TEMP });
    const name = `IRIS-${inputs.version}-mac-${arch}.dmg`;
    await copyFile(product, path.join(out, name));
    const sha512 = (await hashFile(product, 'sha512')).hash.digest('base64');
    files.push({ name, size: sha256.size, sha256: sha256Hex, sha512, arch, request_id: inputs.requests[arch].id });
  }
  const byArch = Object.fromEntries(files.map((file) => [file.arch, file]));
  await writeFile(path.join(out, 'latest-mac.yml'), latestMacYml({ version: inputs.version, x64: byArch.x64, arm64: byArch.arm64, now }), { mode: 0o600 });
  await writeFile(path.join(out, 'signed-macos.json'), `${JSON.stringify({ version: inputs.version, files })}\n`, { mode: 0o600 });
  await rm(work, { recursive: true, force: true });
  return out;
}

// Assemble: combine the signed images with the other platforms' installers.

export async function assemble({ env = process.env } = {}) {
  const staged = env.IRIS_STAGED_DIR;
  const signed = env.INPUT_SIGNED_DIR;
  const version = env.INPUT_VERSION;
  if (!staged || !signed || !VERSION.test(version ?? '')) throw new PublishError('INVALID_INPUT');
  const othersExpected = [`IRIS-${version}-win-x64.exe`, `IRIS-${version}-linux-x86_64.AppImage`, `IRIS-${version}-linux-arm64.AppImage`, 'latest.yml', 'latest-linux.yml', 'latest-linux-arm64.yml'].sort();
  const dmgs = ARCHES.map((arch) => `IRIS-${version}-mac-${arch}.dmg`);
  const sameSet = async (dir, expected) => {
    const names = (await readdir(dir).catch(() => null))?.sort();
    return names !== undefined && names.join('\n') === [...expected].sort().join('\n');
  };
  if (!await sameSet(staged, othersExpected)) throw new PublishError('STAGED_SET_INVALID');
  let manifest;
  try { manifest = JSON.parse(await readFile(path.join(signed, 'signed-macos.json'), 'utf8')); } catch { throw new PublishError('STAGED_SET_INVALID'); }
  const listed = Array.isArray(manifest?.files) ? manifest.files.map((file) => file?.name).sort() : [];
  if (manifest?.version !== version || listed.join('\n') !== [...dmgs].sort().join('\n') || !await sameSet(signed, [...dmgs, 'latest-mac.yml', 'signed-macos.json'])) throw new PublishError('STAGED_SET_INVALID');
  for (const file of manifest.files) {
    const target = path.join(signed, file.name);
    const { hash, size } = await hashFile(target, 'sha256');
    if (size !== file.size || hash.digest('hex') !== file.sha256) throw new PublishError('STAGED_SET_INVALID');
  }
  for (const name of ['latest.yml', 'latest-linux.yml', 'latest-linux-arm64.yml']) {
    const text = await readFile(path.join(staged, name), 'utf8');
    const named = /^version:\s*['"]?([^'"\s]+)['"]?\s*$/m.exec(text)?.[1];
    if (named !== version) throw new PublishError('STAGED_SET_INVALID');
  }
  for (const name of [...dmgs, 'latest-mac.yml']) await copyFile(path.join(signed, name), path.join(staged, name));
  if (!await sameSet(staged, [...othersExpected, ...dmgs, 'latest-mac.yml'])) throw new PublishError('STAGED_SET_INVALID');
}

// Preflight: has this release already reached the license service?

function compareVersions(left, right) {
  const a = left.split('.').map(Number);
  const b = right.split('.').map(Number);
  for (let part = 0; part < 3; part += 1) if (a[part] !== b[part]) return a[part] < b[part] ? -1 : 1;
  return 0;
}

async function internalGet({ fetchImpl, sleep }, origin, token, route) {
  for (let attempt = 1; ; attempt += 1) {
    let response = null;
    try {
      response = await fetchImpl(`${origin}${route}`, {
        method: 'GET', redirect: 'error', signal: AbortSignal.timeout(30_000), headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
      });
    } catch { response = null; }
    if (response?.status === 404) { await response.body?.cancel(); return null; }
    if (response?.ok) return readJsonBody(response);
    await response?.body?.cancel();
    if (attempt >= 3) throw new PublishError('RELEASE_META_UNAVAILABLE');
    await sleep(5000 * attempt);
  }
}

// "Already" means the license service serves this release; the side record alone only proves a publish began.
export async function preflight({ env = process.env, fetchImpl = fetch, sleep = defaultSleep } = {}) {
  const token = requireToken(env, 'IRIS_RELEASE_UPLOAD_TOKEN');
  const origin = (env.IRIS_LICENSE_API_URL ?? '').replace(/\/+$/, '');
  if (!/^https:\/\/[^/]+$/.test(origin)) throw new PublishError('INVALID_INPUT');
  if (!VERSION.test(env.INPUT_VERSION ?? '') || !/^[A-Za-z0-9_-]{43}$/.test(env.INPUT_RELEASE_ID ?? '')) throw new PublishError('INVALID_INPUT');
  const deps = { fetchImpl, sleep };
  const meta = await internalGet(deps, origin, token, '/api/v1/internal/releases/shell-release-meta');
  if (meta === null) return { already: false };
  if (!VERSION.test(meta?.version ?? '')) throw new PublishError('RELEASE_META_INVALID');
  if (meta.release_id !== env.INPUT_RELEASE_ID) {
    if (compareVersions(meta.version, env.INPUT_VERSION) >= 0) throw new PublishError('RELEASE_SUPERSEDED');
    return { already: false };
  }
  const current = await internalGet(deps, origin, token, '/api/v1/internal/releases/current');
  return { already: current?.release_id === env.INPUT_RELEASE_ID && /^\d+\.\d+$/.test(current?.compatibility_tag ?? '') };
}

// Cleanup: drop transient artifacts and, last, the pending-publish marker.

async function listArtifacts(deps, token, repo, runId) {
  const found = [];
  for (let page = 1; page <= 20; page += 1) {
    const listing = await githubRequest(deps, token, 'GET', `/repos/${repo}/actions/runs/${runId}/artifacts?per_page=100&page=${page}`);
    const artifacts = listing?.artifacts ?? [];
    found.push(...artifacts);
    if (artifacts.length < 100) break;
  }
  return found;
}

export async function cleanupArtifacts({ env = process.env, fetchImpl = fetch, sleep = defaultSleep, log = (line) => process.stdout.write(`${line}\n`) } = {}) {
  const deps = { fetchImpl, sleep };
  const token = requireToken(env);
  const repo = requireRepository(env);
  const currentRun = requireRunId(env.GITHUB_RUN_ID);
  const buildRun = requireRunId(env.INPUT_BUILD_RUN_ID);
  const remove = (artifact) => githubRequest(deps, token, 'DELETE', `/repos/${repo}/actions/artifacts/${artifact.id}`, { allow404: true });
  const markers = [];
  let failed = 0;
  for (const runId of new Set([buildRun, currentRun])) {
    for (const artifact of await listArtifacts(deps, token, repo, runId)) {
      if (!Number.isSafeInteger(artifact?.id)) continue;
      if (runId === buildRun && artifact.name === CONTEXT_ARTIFACT) { markers.push(artifact); continue; }
      try { await remove(artifact); } catch { failed += 1; }
    }
  }
  // Signed images left by publish runs that were held or failed are public until they expire.
  const stale = await githubRequest(deps, token, 'GET', `/repos/${repo}/actions/artifacts?name=${SIGNED_ARTIFACT}&per_page=100`).catch(() => { failed += 1; return null; });
  for (const artifact of stale?.artifacts ?? []) {
    const runId = artifact?.workflow_run?.id;
    if (!Number.isSafeInteger(artifact?.id) || !Number.isSafeInteger(runId) || String(runId) === currentRun) continue;
    try {
      const run = await githubRequest(deps, token, 'GET', `/repos/${repo}/actions/runs/${runId}`, { allow404: true });
      if (run === null || run.status === 'completed') await remove(artifact);
    } catch { failed += 1; }
  }
  if (failed) log(`ARTIFACT_DELETE_FAILED ${failed}`);
  for (const marker of markers) {
    for (let attempt = 1; ; attempt += 1) {
      try { await remove(marker); break; }
      catch {
        if (attempt >= 3) throw new PublishError('CONTEXT_DELETE_FAILED');
        await sleep(2000 * attempt);
      }
    }
  }
}

export async function main(args = process.argv.slice(2), deps = {}) {
  const env = deps.env ?? process.env;
  const stderr = deps.stderr ?? process.stderr;
  try {
    const [command, flag] = args;
    if (!['gate', 'resolve', 'context', 'await', 'fetch', 'assemble', 'preflight', 'cleanup-artifacts'].includes(command)
      || args.length > 2 || (flag !== undefined && !(command === 'context' && flag === '--public'))) throw new PublishError('INVALID_COMMAND');
    const injected = { env, fetchImpl: deps.fetchImpl, sleep: deps.sleep, now: deps.now, exec: deps.exec, log: deps.log };
    const defined = Object.fromEntries(Object.entries(injected).filter(([, value]) => value !== undefined));
    if (command === 'gate') await gate(defined);
    else if (command === 'resolve') await writeOutputs(env, { shell: (await resolve(defined)).shell });
    else if (command === 'context') await writeOutputs(env, contextOutputs(await readContext({ env }), { pub: flag === '--public', sealKey: env.IRIS_CONTEXT_SEAL_KEY }));
    else if (command === 'await') await awaitSigning(defined);
    else if (command === 'fetch') await writeOutputs(env, { dir: await fetchSigned(defined) });
    else if (command === 'assemble') await assemble({ env });
    else if (command === 'preflight') await writeOutputs(env, { already: (await preflight(defined)).already });
    else await cleanupArtifacts(defined);
    return 0;
  } catch (error) {
    const code = error instanceof PublishError ? error.code : 'PUBLISH_FAILED';
    stderr.write(`${code}${error instanceof PublishError && error.detail ? ` ${error.detail}` : ''}\n`);
    return 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await main();
