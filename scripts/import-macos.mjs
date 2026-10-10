import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { chmod, copyFile, lstat, stat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { fileURLToPath } from 'node:url';

const API_ROOT = 'https://api.github.com/repos';
const SIGN_ENDPOINT = 'https://sign.voidcarve.com/v1/requests';
const MIN_PART_BYTES = 5 * 1024 * 1024;
const MAX_PART_BYTES = 64 * 1024 * 1024;
const PART_ATTEMPTS = 5;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const IRIS_BUILD = 'lsy-404/IRIS-Build';
const EPILOGUE = 'lsy-404/epilogue';
const MARKER = '.macos-import-run';
const BUNDLE_NAME = 'source.zip';
const MAX_JSON_BYTES = 1_000_000;

const products = Object.freeze({
  'iris-arm64': {
    repository: IRIS_BUILD,
    assetId: 627138897,
    assetName: 'IRIS-0.5.83-mac-arm64.dmg',
    assetSize: 168_172_512,
    assetDigest: 'sha256:2c0d90611509a514d4745c9097580bc1f5f6b1f8f3d98870ea45d7a9a425063e',
    version: '0.5.83',
    source: 'build-info',
    sourceSha: 'a5237f77558b8e32886ba4ea0cca90c8c416520c',
    architecture: 'arm64',
    appName: 'IRIS.app',
    bundleId: 'io.github.wuyilingwei.iris',
  },
  'iris-x64': {
    repository: IRIS_BUILD,
    assetId: 627138896,
    assetName: 'IRIS-0.5.83-mac-x64.dmg',
    assetSize: 175_467_497,
    assetDigest: 'sha256:7d8621713573ec31e41822e557e0d9ddaf7d4ff60230a322b36e8a3479236093',
    version: '0.5.83',
    source: 'build-info',
    sourceSha: 'a5237f77558b8e32886ba4ea0cca90c8c416520c',
    architecture: 'x64',
    appName: 'IRIS.app',
    bundleId: 'io.github.wuyilingwei.iris',
  },
  'epilogue-arm64': {
    repository: EPILOGUE,
    assetId: 539277392,
    assetName: 'Epilogue-v0.4.1-darwin-arm64.dmg',
    assetSize: 220_527_950,
    assetDigest: 'sha256:674e17f13d69e458e37dcd31ea43e74a4ea119912751d27194a8d0610ffcaae7',
    version: '0.4.1',
    source: 'tag',
    sourceTag: 'v0.4.1',
    sourceSha: 'f4bc64ec4b13e21e89d0a5ed8bd7708cac004209',
    architecture: 'arm64',
    appName: 'Epilogue.app',
    bundleId: 'com.electron.epilogue',
  },
});

class ImportError extends Error {
  constructor(code, transient = false) { super(code); this.code = code; this.transient = transient; }
}

function productConfig(product) {
  const config = products[product];
  if (!config) throw new ImportError('INVALID_PRODUCT');
  return config;
}

function run(file, args) {
  const result = spawnSync(file, args, { stdio: 'ignore', timeout: 120_000, env: { ...process.env, COPYFILE_DISABLE: '1' } });
  if (result.error || result.status !== 0) throw new ImportError('IMPORT_COMMAND_FAILED');
}

async function jsonResponse(response) {
  if (!response.ok || !response.body) throw new ImportError('GITHUB_REQUEST_FAILED');
  const length = Number(response.headers.get('content-length') ?? 0);
  if (length > MAX_JSON_BYTES) throw new ImportError('INVALID_GITHUB_RESPONSE');
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.byteLength;
    if (size > MAX_JSON_BYTES) throw new ImportError('INVALID_GITHUB_RESPONSE');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks, size).toString('utf8')); }
  catch { throw new ImportError('INVALID_GITHUB_RESPONSE'); }
}

async function githubJson(repository, suffix, token) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) || !/^\/[A-Za-z0-9_./-]+$/.test(suffix)) throw new ImportError('INVALID_GITHUB_ROUTE');
  const response = await fetch(`${API_ROOT}/${repository}${suffix}`, {
    headers: { accept: 'application/vnd.github+json', authorization: `Bearer ${token}`, 'x-github-api-version': '2022-11-28' },
    redirect: 'error', signal: AbortSignal.timeout(30_000),
  });
  return jsonResponse(response);
}

async function assetMetadata(config, token) {
  const metadata = await githubJson(config.repository, `/releases/assets/${config.assetId}`, token);
  if (metadata.id !== config.assetId || metadata.name !== config.assetName || metadata.size !== config.assetSize || metadata.digest !== config.assetDigest || metadata.state !== 'uploaded') throw new ImportError('ASSET_METADATA_MISMATCH');
}

function isReleaseAssetUrl(value) {
  let url;
  try { url = new URL(value); } catch { return false; }
  return url.protocol === 'https:' && url.hostname === 'release-assets.githubusercontent.com' && !url.username && !url.password && !url.hash && (!url.port || url.port === '443');
}

async function downloadAsset(config, token, destination) {
  const endpoint = `${API_ROOT}/${config.repository}/releases/assets/${config.assetId}`;
  let response = await fetch(endpoint, {
    headers: { accept: 'application/octet-stream', authorization: `Bearer ${token}`, 'x-github-api-version': '2022-11-28' },
    redirect: 'manual', signal: AbortSignal.timeout(300_000),
  });
  if ([301, 302, 303, 307, 308].includes(response.status)) {
    const location = response.headers.get('location');
    if (!location || !isReleaseAssetUrl(location)) throw new ImportError('INVALID_ASSET_REDIRECT');
    response = await fetch(location, { redirect: 'error', signal: AbortSignal.timeout(300_000) });
  }
  if (!response.ok || !response.body) throw new ImportError('ASSET_DOWNLOAD_FAILED');
  const advertisedLength = Number(response.headers.get('content-length') ?? 0);
  if (advertisedLength && advertisedLength !== config.assetSize) throw new ImportError('ASSET_SIZE_MISMATCH');
  const hash = createHash('sha256');
  let size = 0;
  const meter = new Transform({ transform(chunk, _encoding, callback) {
    size += chunk.length;
    if (size > config.assetSize) return callback(new ImportError('ASSET_SIZE_MISMATCH'));
    hash.update(chunk);
    callback(null, chunk);
  } });
  try { await pipeline(response.body, meter, createWriteStream(destination, { flags: 'wx', mode: 0o600 })); }
  catch (error) {
    await rm(destination, { force: true });
    throw error instanceof ImportError ? error : new ImportError('ASSET_DOWNLOAD_FAILED');
  }
  if (size !== config.assetSize || `sha256:${hash.digest('hex')}` !== config.assetDigest) {
    await rm(destination, { force: true });
    throw new ImportError('ASSET_DIGEST_MISMATCH');
  }
}

async function resolveSourceSha(config, workDir, token) {
  if (config.source === 'build-info') {
    const buildInfo = {
      repository: IRIS_BUILD,
      assetId: 627144226,
      assetName: 'build-info.json',
      assetSize: 148,
      assetDigest: 'sha256:d70b30f6f4946012ed4f05d032e2ddca07132b9b75119dea5eb0b7065f37920f',
    };
    await assetMetadata(buildInfo, token);
    const file = path.join(workDir, 'build-info.json');
    await downloadAsset(buildInfo, token, file);
    const info = JSON.parse(await readFile(file, 'utf8'));
    await rm(file, { force: true });
    if (info.dirty !== false || info.coreVersion !== '26.1010.5' || !/^[a-f0-9]{40}$/.test(info.commit ?? '') || info.commit !== 'a5237f77558b8e32886ba4ea0cca90c8c416520c') throw new ImportError('BUILD_INFO_MISMATCH');
    return info.commit;
  }
  if (config.source === 'tag') {
    const ref = await githubJson(EPILOGUE, `/git/ref/tags/${config.sourceTag}`, token);
    if (ref.ref !== `refs/tags/${config.sourceTag}` || ref.object?.type !== 'tag' || !/^[a-f0-9]{40}$/.test(ref.object.sha ?? '')) throw new ImportError('SOURCE_TAG_MISMATCH');
    const tag = await githubJson(EPILOGUE, `/git/tags/${ref.object.sha}`, token);
    if (tag.tag !== config.sourceTag || tag.object?.type !== 'commit' || tag.object.sha !== config.sourceSha) throw new ImportError('SOURCE_TAG_MISMATCH');
    return tag.object.sha;
  }
  throw new ImportError('INVALID_PRODUCT_CONFIG');
}

function runnerTemp(env = process.env) {
  const dir = env.RUNNER_TEMP;
  if (!dir || !path.isAbsolute(dir)) throw new ImportError('TEMP_UNAVAILABLE');
  return path.resolve(dir);
}

async function createWorkDir(product, runId) {
  const workDir = await mkdtemp(path.join(runnerTemp(), `iris-macos-import-${runId}-`));
  await chmod(workDir, 0o700);
  await writeFile(path.join(workDir, MARKER), `${runId}\n${product}\n`, { flag: 'wx', mode: 0o600 });
  return workDir;
}

function outputPath(workDir) {
  const outputDir = path.join(workDir, 'output');
  return mkdir(outputDir, { mode: 0o700 }).then(() => outputDir);
}

function readBundleId(appPath) {
  const infoPath = path.join(appPath, 'Contents', 'Info.plist');
  const result = spawnSync('/usr/bin/plutil', ['-extract', 'CFBundleIdentifier', 'raw', '-o', '-', infoPath], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000 });
  if (result.error || result.status !== 0 || typeof result.stdout !== 'string') throw new ImportError('APP_METADATA_INVALID');
  const bundleId = result.stdout.trim();
  if (!/^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/.test(bundleId)) throw new ImportError('APP_METADATA_INVALID');
  return bundleId;
}

function mountDiskImage(dmgPath, mountPath) {
  run('/usr/bin/hdiutil', ['attach', '-readonly', '-nobrowse', '-noautoopen', '-mountpoint', mountPath, dmgPath]);
}

async function detachDiskImage(mountPath) {
  run('/usr/bin/hdiutil', ['detach', mountPath]);
}

function writeOutput(key, value) {
  const output = process.env.GITHUB_OUTPUT;
  if (!output || /[\r\n]/.test(value)) throw new ImportError('OUTPUT_UNAVAILABLE');
  return writeFile(output, `${key}=${value}\n`, { flag: 'a', mode: 0o600 });
}

function validateRunId(value) {
  if (!/^\d+$/.test(value ?? '') || !Number.isSafeInteger(Number(value)) || Number(value) < 1) throw new ImportError('INVALID_RUN_ID');
  return String(Number(value));
}

async function prepare() {
  const product = process.env.INPUT_PRODUCT;
  const config = productConfig(product);
  const runId = validateRunId(process.env.GITHUB_RUN_ID);
  if (process.env.GITHUB_RUN_ATTEMPT !== '1') throw new ImportError('INVALID_RUN_ATTEMPT');
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new ImportError('GITHUB_TOKEN_UNAVAILABLE');
  const workDir = await createWorkDir(product, runId);
  const dmgPath = path.join(workDir, 'source.dmg');
  const mountPath = path.join(workDir, 'mounted');
  let mounted = false;
  try {
    await assetMetadata(config, token);
    const sourceSha = await resolveSourceSha(config, workDir, token);
    await downloadAsset(config, token, dmgPath);
    await mkdir(mountPath, { mode: 0o700 });
    mountDiskImage(dmgPath, mountPath);
    mounted = true;
    const apps = [];
    for (const entry of await readdir(mountPath, { withFileTypes: true })) {
      if (entry.name.endsWith('.app') && entry.isDirectory()) apps.push(entry.name);
    }
    if (apps.length !== 1 || !/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,95}\.app$/.test(apps[0]) || config.appName && apps[0] !== config.appName) throw new ImportError('APP_BUNDLE_COUNT_INVALID');
    const appPath = path.join(mountPath, apps[0]);
    const appInfo = await lstat(appPath);
    if (!appInfo.isDirectory() || appInfo.isSymbolicLink()) throw new ImportError('APP_BUNDLE_INVALID');
    const bundleId = readBundleId(appPath);
    if (config.bundleId && bundleId !== config.bundleId) throw new ImportError('APP_BUNDLE_ID_MISMATCH');
    const outputDir = await outputPath(workDir);
    const tarPath = path.join(outputDir, 'unsigned.tar.gz');
    run('/usr/bin/tar', ['-czf', tarPath, '-C', mountPath, '--', apps[0]]);
    await copyFile(dmgPath, path.join(outputDir, 'template.dmg'));
    const source = { source_sha: sourceSha, version: config.version, bundle_id: bundleId, architecture: config.architecture };
    await writeFile(path.join(outputDir, 'source.json'), `${JSON.stringify(source)}\n`, { flag: 'wx', mode: 0o600 });
    for (const name of ['unsigned.tar.gz', 'template.dmg', 'source.json']) await chmod(path.join(outputDir, name), 0o600);
    const bundlePath = path.join(workDir, BUNDLE_NAME);
    run('/usr/bin/zip', ['-q', '-X', '-j', '-0', bundlePath, tarPath, path.join(outputDir, 'template.dmg'), path.join(outputDir, 'source.json')]);
    await chmod(bundlePath, 0o600);
    await writeOutput('work_dir', workDir);
    await writeOutput('version', config.version);
    await writeOutput('source_sha', sourceSha);
    if (mounted) {
      await detachDiskImage(mountPath);
      mounted = false;
    }
    await rm(dmgPath, { force: true });
    await rm(mountPath, { recursive: true, force: true });
  } catch (error) {
    let detachFailed = false;
    if (mounted) {
      try { await detachDiskImage(mountPath); } catch { detachFailed = true; }
    }
    if (!detachFailed) await rm(workDir, { recursive: true, force: true });
    if (detachFailed) throw new ImportError('DISK_IMAGE_DETACH_FAILED');
    throw error;
  }
}

async function checkedWorkDir(value, product, runId, env = process.env) {
  const workDir = path.resolve(value ?? '');
  if (path.dirname(workDir) !== runnerTemp(env) || !path.basename(workDir).startsWith(`iris-macos-import-${runId}-`)) throw new ImportError('INVALID_TEMP_DIR');
  try {
    const marker = (await readFile(path.join(workDir, MARKER), 'utf8')).split('\n');
    if (marker[0] !== runId || marker[1] !== product) throw new ImportError('INVALID_TEMP_DIR');
  } catch (error) {
    if (error instanceof ImportError) throw error;
    if (error.code === 'ENOENT') return null;
    throw new ImportError('INVALID_TEMP_DIR');
  }
  return workDir;
}

async function bundleDigest(file) {
  const hash = createHash('sha256');
  let size = 0;
  for await (const chunk of createReadStream(file)) { hash.update(chunk); size += chunk.length; }
  return { digest: `sha256:${hash.digest('hex')}`, size };
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
  } catch { throw new ImportError('SIGNING_REQUEST_FAILED', true); }
  if (!response.ok) throw new ImportError('SIGNING_REQUEST_FAILED', response.status >= 500 || response.status === 408 || response.status === 429);
  return jsonResponse(response);
}

// The center answers the plan and complete calls idempotently, so a lost or slow response can be asked for again.
async function centerRetry(sleep, call) {
  for (let attempt = 1; ; attempt += 1) {
    try { return await call(); }
    catch (error) {
      if (!(error instanceof ImportError) || !error.transient || attempt >= PART_ATTEMPTS) throw error;
      await sleep(2000 * 2 ** (attempt - 1));
    }
  }
}

function validateUploadPlan(plan, bundle) {
  const received = plan?.received_parts;
  if (!Number.isInteger(plan?.part_size) || plan.part_size < MIN_PART_BYTES || plan.part_size > MAX_PART_BYTES
    || !Number.isInteger(plan.part_count) || plan.part_count !== Math.ceil(bundle.size / plan.part_size)
    || !Array.isArray(received) || !received.every((n) => Number.isInteger(n) && n >= 1 && n <= plan.part_count)) throw new ImportError('SIGNING_REQUEST_FAILED');
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
      if (!transient || attempt >= PART_ATTEMPTS) throw new ImportError('SOURCE_UPLOAD_FAILED');
      await sleep(2000 * 2 ** (attempt - 1));
      plan = await fetchPlan();
      if (plan.received_parts.includes(part)) break;
    }
  }
}

export async function submitSource({ fetchImpl = fetch, env = process.env, sleep = defaultSleep } = {}) {
  const product = env.INPUT_PRODUCT;
  const config = productConfig(product);
  const runId = validateRunId(env.GITHUB_RUN_ID);
  if (env.GITHUB_RUN_ATTEMPT !== '1') throw new ImportError('INVALID_SIGNING_REQUEST');
  if (env.INPUT_VERSION !== config.version || env.INPUT_SOURCE_SHA !== config.sourceSha) throw new ImportError('INVALID_SIGNING_REQUEST');
  const workDir = await checkedWorkDir(env.INPUT_WORK_DIR, product, runId, env);
  if (!workDir) throw new ImportError('INVALID_TEMP_DIR');
  const apiKey = env.SIGNING_API_KEY;
  if (!apiKey) throw new ImportError('SIGNING_API_KEY_UNAVAILABLE');
  const file = path.join(workDir, BUNDLE_NAME);
  const info = await stat(file).catch(() => null);
  if (!info?.isFile()) throw new ImportError('INVALID_SIGNING_REQUEST');
  const bundle = await bundleDigest(file);
  if (bundle.size < 1) throw new ImportError('INVALID_SIGNING_REQUEST');
  const body = {
    project_id: `import-${product}`,
    platform: 'macos',
    execution_visibility: 'public',
    run_id: Number(runId),
    run_attempt: 1,
    input_digest: bundle.digest,
    input_size: bundle.size,
    version: config.version,
    source_sha: config.sourceSha,
  };
  const idempotencyKey = `import-${product}-${runId}-1`;
  if (idempotencyKey.length < 16 || idempotencyKey.length > 160) throw new ImportError('INVALID_SIGNING_REQUEST');
  const created = await centerJson(fetchImpl, SIGN_ENDPOINT, 'POST', apiKey, body, { 'idempotency-key': idempotencyKey });
  if (typeof created.request_id !== 'string' || !UUID.test(created.request_id)) throw new ImportError('SIGNING_REQUEST_FAILED');
  if (created.state === 'accepted_waiting_source') return;
  if (created.state !== 'awaiting_upload') throw new ImportError('SIGNING_REQUEST_FAILED');
  const base = `${SIGN_ENDPOINT}/${created.request_id}`;
  await uploadParts(fetchImpl, sleep, base, apiKey, file, bundle);
  const completed = await centerRetry(sleep, () => centerJson(fetchImpl, `${base}/source/complete`, 'POST', apiKey, {}, {}, 300_000));
  if (completed.state !== 'accepted_waiting_source') throw new ImportError('SIGNING_REQUEST_FAILED');
}

async function cleanup() {
  const product = process.env.INPUT_PRODUCT;
  productConfig(product);
  const runId = validateRunId(process.env.GITHUB_RUN_ID);
  const workDir = await checkedWorkDir(process.env.INPUT_WORK_DIR, product, runId);
  if (workDir) await rm(workDir, { recursive: true, force: true });
}

export async function main(args = process.argv.slice(2)) {
  try {
    if (args.length !== 1 || !['prepare', 'submit', 'cleanup'].includes(args[0])) throw new ImportError('INVALID_COMMAND');
    if (args[0] === 'prepare') await prepare();
    else if (args[0] === 'submit') await submitSource();
    else await cleanup();
  } catch (error) {
    process.stderr.write(`${error instanceof ImportError ? error.code : 'IMPORT_FAILED'}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
