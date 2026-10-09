import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { fileURLToPath } from 'node:url';

const API_ROOT = 'https://api.github.com/repos';
const SIGN_ENDPOINT = 'https://sign.voidcarve.com/v1/requests';
const IRIS_BUILD = 'lsy-404/IRIS-Build';
const EPILOGUE = 'lsy-404/epilogue';
const MARKER = '.macos-import-run';
const MAX_JSON_BYTES = 1_000_000;

const products = Object.freeze({
  'iris-arm64': {
    repository: IRIS_BUILD,
    assetId: 623425708,
    assetName: 'IRIS-0.5.80-mac-arm64.dmg',
    assetSize: 169_998_705,
    assetDigest: 'sha256:e16b613e9c3d39482603fe02ea3d0475add686d67f0fac169fc5a8f686e893fc',
    version: '0.5.80',
    source: 'build-info',
    sourceSha: 'f6d90bce8063a8c84d715f0950faa5a0fb805538',
    architecture: 'arm64',
    appName: 'IRIS.app',
    bundleId: 'io.github.wuyilingwei.iris',
  },
  'iris-x64': {
    repository: IRIS_BUILD,
    assetId: 623425709,
    assetName: 'IRIS-0.5.80-mac-x64.dmg',
    assetSize: 177_291_721,
    assetDigest: 'sha256:9d70b0d33cc7c2e5c9adc818fa7d86ada860b3c91465d98150b94789911f2c11',
    version: '0.5.80',
    source: 'build-info',
    sourceSha: 'f6d90bce8063a8c84d715f0950faa5a0fb805538',
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
  },
});

class ImportError extends Error {
  constructor(code) { super(code); this.code = code; }
}

function productConfig(product) {
  const config = products[product];
  if (!config) throw new ImportError('INVALID_PRODUCT');
  return config;
}

function run(file, args) {
  const result = spawnSync(file, args, { stdio: 'ignore', timeout: 120_000 });
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
      assetId: 623426004,
      assetName: 'build-info.json',
      assetSize: 148,
      assetDigest: 'sha256:6d33929256793cdeb75a360dccececeb3c677fa7373393e8643357561a408104',
    };
    await assetMetadata(buildInfo, token);
    const file = path.join(workDir, 'build-info.json');
    await downloadAsset(buildInfo, token, file);
    const info = JSON.parse(await readFile(file, 'utf8'));
    await rm(file, { force: true });
    if (info.dirty !== false || info.coreVersion !== '26.1009.0' || !/^[a-f0-9]{40}$/.test(info.commit ?? '') || info.commit !== 'f6d90bce8063a8c84d715f0950faa5a0fb805538') throw new ImportError('BUILD_INFO_MISMATCH');
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

function runnerTemp() {
  const dir = process.env.RUNNER_TEMP;
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
  run('/usr/bin/hdiutil', ['attach', '-readonly', '-nobrowse', '-mountpoint', mountPath, dmgPath]);
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
    await writeOutput('work_dir', workDir);
    await writeOutput('output_dir', outputDir);
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
    await rm(workDir, { recursive: true, force: true });
    if (detachFailed) throw new ImportError('DISK_IMAGE_DETACH_FAILED');
    throw error;
  }
}

async function checkedWorkDir(value, product, runId) {
  const workDir = path.resolve(value ?? '');
  if (path.dirname(workDir) !== runnerTemp() || !path.basename(workDir).startsWith(`iris-macos-import-${runId}-`)) throw new ImportError('INVALID_TEMP_DIR');
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

async function submit() {
  const product = process.env.INPUT_PRODUCT;
  const config = productConfig(product);
  const runId = validateRunId(process.env.GITHUB_RUN_ID);
  const runAttempt = process.env.GITHUB_RUN_ATTEMPT;
  const artifactId = process.env.INPUT_ARTIFACT_ID;
  if (runAttempt !== '1' || !/^\d+$/.test(artifactId ?? '') || !Number.isSafeInteger(Number(artifactId)) || Number(artifactId) < 1) throw new ImportError('INVALID_SIGNING_REQUEST');
  if (process.env.INPUT_VERSION !== config.version || process.env.INPUT_SOURCE_SHA !== config.sourceSha) throw new ImportError('INVALID_SIGNING_REQUEST');
  const workDir = await checkedWorkDir(process.env.INPUT_WORK_DIR, product, runId);
  if (!workDir) throw new ImportError('INVALID_TEMP_DIR');
  const apiKey = process.env.SIGNING_API_KEY;
  if (!apiKey) throw new ImportError('SIGNING_API_KEY_UNAVAILABLE');
  const body = {
    project_id: `import-${product}`,
    platform: 'macos',
    run_id: Number(runId),
    run_attempt: 1,
    artifact_id: Number(artifactId),
    version: config.version,
    source_sha: process.env.INPUT_SOURCE_SHA,
  };
  const idempotencyKey = `import-${product}-${runId}-1`;
  if (idempotencyKey.length < 16 || idempotencyKey.length > 160) throw new ImportError('INVALID_SIGNING_REQUEST');
  let response;
  try {
    response = await fetch(SIGN_ENDPOINT, {
      method: 'POST',
      redirect: 'error',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json', accept: 'application/json', 'idempotency-key': idempotencyKey },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
  } catch { throw new ImportError('SIGNING_REQUEST_FAILED'); }
  if (!response.ok) throw new ImportError('SIGNING_REQUEST_FAILED');
  const result = await jsonResponse(response);
  if (result.state !== 'accepted_waiting_source') throw new ImportError('SIGNING_REQUEST_FAILED');
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
    else if (args[0] === 'submit') await submit();
    else await cleanup();
  } catch (error) {
    process.stderr.write(`${error instanceof ImportError ? error.code : 'IMPORT_FAILED'}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
