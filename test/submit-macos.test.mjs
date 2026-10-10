import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildContext, cleanup, main, openEnvelope, prepare, submitSource, validateContext, writeContext } from '../scripts/submit-macos.mjs';

const PART = 5 * 1024 * 1024;
const ID = '3f2b8c1e-0a4d-4e8b-9c55-1d2e3f4a5b6c';
const ID2 = '4a2b8c1e-0a4d-4e8b-9c55-1d2e3f4a5b6d';
const SHA = 'a5237f77558b8e32886ba4ea0cca90c8c416520c';
const VERSION = '1.2.3';
const noSleep = async () => {};

async function signFixture(size, arch = 'arm64') {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'submit-test-'));
  const workDir = path.join(temp, `iris-shell-sign-77-${arch}-abc`);
  await mkdir(workDir);
  await writeFile(path.join(workDir, '.iris-shell-sign-run'), `77\n${arch}\n`);
  const bytes = randomBytes(size);
  await writeFile(path.join(workDir, 'source.zip'), bytes);
  const env = {
    RUNNER_TEMP: temp, INPUT_ARCH: arch, GITHUB_RUN_ID: '77', GITHUB_RUN_ATTEMPT: '1',
    INPUT_VERSION: VERSION, INPUT_SOURCE_SHA: SHA, INPUT_WORK_DIR: workDir, SIGNING_API_KEY: 'test-key',
  };
  return { env, bytes, temp, workDir };
}

function json(status, value) {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}

async function drain(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

function center({ size, createState = 'awaiting_upload', createStatus = 202, received = [], failParts = [], completeState = 'accepted_waiting_source', requestId = ID, completeFailures = [], beginFailures = [] }) {
  const log = { create: null, creates: 0, createHeaders: null, parts: [], begins: 0, completes: 0, urls: [] };
  const have = new Set(received);
  const failures = new Map(failParts.map(([part, status]) => [part, status]));
  const count = Math.ceil(size / PART);
  const fetchImpl = async (url, options) => {
    log.urls.push(url);
    const headers = options.headers;
    if (url === 'https://sign.voidcarve.com/v1/requests') {
      log.creates += 1;
      log.create = JSON.parse(options.body);
      log.createHeaders = headers;
      if (createStatus !== 202) return json(createStatus, { error: 'x' });
      return json(202, { request_id: requestId, state: createState });
    }
    if (url === `https://sign.voidcarve.com/v1/requests/${requestId}/source`) {
      log.begins += 1;
      if (beginFailures.length) return new Response(null, { status: beginFailures.shift() });
      return json(200, { part_size: PART, part_count: count, received_parts: [...have].sort((a, b) => a - b) });
    }
    const part = url.match(/\/source\/parts\/(\d+)$/);
    if (part) {
      const n = Number(part[1]);
      const body = await drain(options.body);
      assert.equal(Number(headers['content-length']), body.length);
      const failure = failures.get(n);
      if (failure) { failures.delete(n); return new Response(null, { status: failure }); }
      log.parts.push({ n, body });
      have.add(n);
      return json(200, { part: n, received_parts: [...have] });
    }
    if (url.endsWith('/source/complete')) {
      log.completes += 1;
      if (completeFailures.length) return new Response(null, { status: completeFailures.shift() });
      return json(200, { request_id: requestId, state: completeState });
    }
    throw new Error(`unexpected ${url}`);
  };
  return { fetchImpl, log };
}

test('create body and idempotency key carry the exact contract for each architecture', async () => {
  for (const arch of ['arm64', 'x64']) {
    const { env, bytes } = await signFixture(2 * PART + 7, arch);
    const { fetchImpl, log } = center({ size: bytes.length });
    const result = await submitSource({ fetchImpl, env, sleep: noSleep });
    assert.deepEqual(log.create, {
      project_id: `iris-shell-${arch}`, platform: 'macos', execution_visibility: 'public', run_id: 77, run_attempt: 1,
      input_digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`, input_size: bytes.length, version: VERSION, source_sha: SHA,
    });
    assert.deepEqual(Object.keys(log.create), ['project_id', 'platform', 'execution_visibility', 'run_id', 'run_attempt', 'input_digest', 'input_size', 'version', 'source_sha']);
    assert.equal(log.createHeaders['idempotency-key'], `iris-shell-${arch}-77-1`);
    assert.deepEqual(result, { request_id: ID, input_digest: log.create.input_digest, input_size: bytes.length });
  }
});

test('refuses invalid inputs before any network call', async () => {
  const cases = [
    ['second run attempt', (e) => { e.GITHUB_RUN_ATTEMPT = '2'; }],
    ['universal architecture', (e) => { e.INPUT_ARCH = 'universal'; }],
    ['short version', (e) => { e.INPUT_VERSION = '1.2'; }],
    ['uppercase source sha', (e) => { e.INPUT_SOURCE_SHA = SHA.toUpperCase(); }],
    ['short source sha', (e) => { e.INPUT_SOURCE_SHA = SHA.slice(1); }],
    ['work dir outside the runner temp', (e) => { e.INPUT_WORK_DIR = path.join(os.tmpdir(), path.basename(e.INPUT_WORK_DIR)); }],
    ['missing signing key', (e) => { delete e.SIGNING_API_KEY; }],
    ['bad run id', (e) => { e.GITHUB_RUN_ID = '0'; }],
  ];
  for (const [label, mutate] of cases) {
    const { env } = await signFixture(PART + 3);
    mutate(env);
    let calls = 0;
    await assert.rejects(submitSource({ fetchImpl: async () => { calls += 1; throw new Error('network'); }, env, sleep: noSleep }), Error, label);
    assert.equal(calls, 0, label);
  }
});

test('refuses a marker written for another run or architecture', async () => {
  for (const marker of ['78\narm64\n', '77\nx64\n']) {
    const { env, workDir } = await signFixture(PART + 3);
    await writeFile(path.join(workDir, '.iris-shell-sign-run'), marker);
    let calls = 0;
    await assert.rejects(submitSource({ fetchImpl: async () => { calls += 1; }, env, sleep: noSleep }), { code: 'INVALID_TEMP_DIR' });
    assert.equal(calls, 0);
  }
});

test('uploads exact slices that reassemble to the bundle and then completes', async () => {
  const { env, bytes } = await signFixture(2 * PART + 7);
  const { fetchImpl, log } = center({ size: bytes.length });
  await submitSource({ fetchImpl, env, sleep: noSleep });
  assert.deepEqual(log.parts.map((p) => p.body.length), [PART, PART, 7]);
  assert.ok(Buffer.concat(log.parts.map((p) => p.body)).equals(bytes));
  assert.equal(log.completes, 1);
});

test('resume skips parts the center already holds', async () => {
  const { env, bytes } = await signFixture(2 * PART + 7);
  const { fetchImpl, log } = center({ size: bytes.length, received: [1, 2] });
  await submitSource({ fetchImpl, env, sleep: noSleep });
  assert.deepEqual(log.parts.map((p) => p.n), [3]);
});

test('retries transient part failures (503 and a dropped connection) then succeeds', async () => {
  const { env, bytes } = await signFixture(PART + 3);
  const { fetchImpl, log } = center({ size: bytes.length, failParts: [[1, 503]] });
  await submitSource({ fetchImpl, env, sleep: noSleep });
  assert.equal(log.begins, 2);
  const dropped = await signFixture(PART + 3);
  const inner = center({ size: dropped.bytes.length });
  let drops = 1;
  const flaky = async (url, options) => {
    if (/\/source\/parts\/1$/.test(url) && drops-- > 0) { options.body.destroy(); throw new TypeError('fetch failed'); }
    return inner.fetchImpl(url, options);
  };
  await submitSource({ fetchImpl: flaky, env: dropped.env, sleep: noSleep });
  assert.deepEqual(inner.log.parts.map((p) => p.n), [1, 2]);
});

test('a 400 part failure aborts without completing', async () => {
  const { env, bytes } = await signFixture(PART + 3);
  const { fetchImpl, log } = center({ size: bytes.length, failParts: [[1, 400]] });
  await assert.rejects(submitSource({ fetchImpl, env, sleep: noSleep }), { code: 'SOURCE_UPLOAD_FAILED' });
  assert.equal(log.completes, 0);
});

test('plan and complete calls retry on 5xx and 429', async () => {
  const { env, bytes } = await signFixture(PART + 3);
  const { fetchImpl, log } = center({ size: bytes.length, beginFailures: [502, 429], completeFailures: [503, 429] });
  await submitSource({ fetchImpl, env, sleep: noSleep });
  assert.equal(log.begins, 3);
  assert.equal(log.completes, 3);
});

test('complete must report accepted_waiting_source', async () => {
  const { env, bytes } = await signFixture(PART + 3);
  const { fetchImpl } = center({ size: bytes.length, completeState: 'failed' });
  await assert.rejects(submitSource({ fetchImpl, env, sleep: noSleep }), { code: 'SIGNING_REQUEST_FAILED' });
});

test('an idempotent replay in accepted_waiting_source uploads nothing and still reports the id', async () => {
  const { env, bytes } = await signFixture(PART + 3);
  const { fetchImpl, log } = center({ size: bytes.length, createState: 'accepted_waiting_source' });
  const result = await submitSource({ fetchImpl, env, sleep: noSleep });
  assert.equal(log.begins, 0);
  assert.equal(result.request_id, ID);
});

test('any other initial state fails', async () => {
  const { env, bytes } = await signFixture(PART + 3);
  const { fetchImpl } = center({ size: bytes.length, createState: 'queued' });
  await assert.rejects(submitSource({ fetchImpl, env, sleep: noSleep }), { code: 'SIGNING_REQUEST_FAILED' });
});

test('the create call is not retried', async () => {
  const { env, bytes } = await signFixture(PART + 3);
  const { fetchImpl, log } = center({ size: bytes.length, createStatus: 503 });
  await assert.rejects(submitSource({ fetchImpl, env, sleep: noSleep }), { code: 'SIGNING_REQUEST_FAILED' });
  assert.equal(log.creates, 1);
});

test('409 run_already_bound fails', async () => {
  const { env, bytes } = await signFixture(PART + 3);
  const { fetchImpl, log } = center({ size: bytes.length, createStatus: 409 });
  await assert.rejects(submitSource({ fetchImpl, env, sleep: noSleep }), { code: 'SIGNING_REQUEST_FAILED' });
  assert.equal(log.begins, 0);
});

test('rejects a request id that is not a UUID', async () => {
  const { env, bytes } = await signFixture(PART + 3);
  const { fetchImpl, log } = center({ size: bytes.length, requestId: '../../v1/admin' });
  await assert.rejects(submitSource({ fetchImpl, env, sleep: noSleep }), { code: 'SIGNING_REQUEST_FAILED' });
  assert.equal(log.begins, 0);
});

test('submit writes exactly the three outputs and prints only an error code on failure', async () => {
  const { env, bytes, temp } = await signFixture(PART + 3);
  const outputFile = path.join(temp, 'github-output');
  await writeFile(outputFile, '');
  env.GITHUB_OUTPUT = outputFile;
  const { fetchImpl } = center({ size: bytes.length });
  const chunks = [];
  assert.equal(await main(['submit'], { env, fetchImpl, sleep: noSleep, stderr: { write: (c) => chunks.push(c) } }), 0);
  const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
  assert.equal(await readFile(outputFile, 'utf8'), `request_id=${ID}\ninput_digest=${digest}\ninput_size=${bytes.length}\n`);
  assert.deepEqual(chunks, []);
  const failing = await signFixture(PART + 3);
  failing.env.SIGNING_API_KEY = 'secret-sentinel';
  failing.env.GITHUB_OUTPUT = outputFile;
  const errors = [];
  const code = await main(['submit'], { env: failing.env, fetchImpl: async () => json(500, { error: 'secret-sentinel' }), sleep: noSleep, stderr: { write: (c) => errors.push(c) } });
  assert.equal(code, 1);
  assert.deepEqual(errors, ['SIGNING_REQUEST_FAILED\n']);
});

// prepare

async function releaseFixture({ asarFor = {}, extraArm = false } = {}) {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'prepare-test-'));
  const workspace = path.join(temp, 'ws');
  const runner = path.join(temp, 'runner');
  await mkdir(runner);
  const archDirs = { arm64: 'mac-arm64', x64: 'mac' };
  for (const [arch, dir] of Object.entries(archDirs)) {
    const app = path.join(workspace, 'release', dir, 'IRIS.app', 'Contents');
    await mkdir(path.join(app, 'MacOS'), { recursive: true });
    await mkdir(path.join(app, 'Resources'), { recursive: true });
    await writeFile(path.join(app, 'Info.plist'), `plist-${arch}`);
    await writeFile(path.join(app, 'MacOS', 'IRIS'), `bin-${arch}`);
    await writeFile(path.join(app, 'Resources', 'app.asar'), asarFor[arch] ?? `asar-${arch}`);
    await writeFile(path.join(workspace, 'release', `IRIS-${VERSION}-mac-${arch}.dmg`), `dmg-${arch}`);
  }
  if (extraArm) await cp(path.join(workspace, 'release', 'mac-arm64'), path.join(workspace, 'release', 'mac-extra'), { recursive: true });
  const output = path.join(temp, 'out');
  await writeFile(output, '');
  const env = { GITHUB_WORKSPACE: workspace, RUNNER_TEMP: runner, GITHUB_OUTPUT: output, GITHUB_RUN_ID: '88', GITHUB_RUN_ATTEMPT: '1', INPUT_VERSION: VERSION, INPUT_SOURCE_SHA: SHA };
  return { env, workspace, runner, temp };
}

function fakeExec({ bundleId = 'io.github.wuyilingwei.iris', shortVersion = VERSION, mountMutate = {}, detachFails = false } = {}) {
  const calls = [];
  const exec = (file, args, { capture = false } = {}) => {
    calls.push([file, ...args]);
    const base = path.basename(file);
    if (base === 'lipo') return args[1].includes(`${path.sep}mac-arm64${path.sep}`) ? 'arm64\n' : args[1].includes(`${path.sep}mac-extra${path.sep}`) ? 'arm64\n' : 'x86_64\n';
    if (base === 'plutil') return `${args[1] === 'CFBundleIdentifier' ? bundleId : shortVersion}\n`;
    if (base === 'hdiutil' && args[0] === 'attach') {
      const mountpoint = args[args.indexOf('-mountpoint') + 1];
      const dmg = args[args.length - 1];
      const arch = dmg.includes('arm64') ? 'arm64' : 'x64';
      const source = path.join(path.dirname(dmg), arch === 'arm64' ? 'mac-arm64' : 'mac', 'IRIS.app');
      return cpSyncInto(source, mountpoint, mountMutate[arch]);
    }
    if (base === 'hdiutil' && args[0] === 'detach') {
      if (detachFails) throw new Error('busy');
      return undefined;
    }
    if (base === 'tar') return writeSync(args[1], 'tar');
    if (base === 'zip') return writeSync(args[4], 'zip');
    throw new Error(`unexpected ${file}`);
  };
  return { exec, calls };
}

function cpSyncInto(source, mountpoint, mutate) {
  cpSync(source, path.join(mountpoint, 'IRIS.app'), { recursive: true });
  if (mutate) mutate(path.join(mountpoint, 'IRIS.app'));
}
function writeSync(file, text) { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, text); }

test('prepare picks each app by lipo output and builds the two bundles', async () => {
  const { env, runner } = await releaseFixture();
  const { exec, calls } = fakeExec();
  const dirs = await prepare({ env, exec });
  assert.deepEqual(Object.keys(dirs), ['arm64', 'x64']);
  for (const [arch, dir] of Object.entries(dirs)) {
    assert.equal(path.dirname(dir), runner);
    assert.match(path.basename(dir), new RegExp(`^iris-shell-sign-88-${arch}-`));
    assert.deepEqual((await readdir(dir)).sort(), ['.iris-shell-sign-run', 'source.zip']);
    assert.equal(await readFile(path.join(dir, '.iris-shell-sign-run'), 'utf8'), `88\n${arch}\n`);
    assert.equal((await stat(path.join(dir, 'source.zip'))).mode & 0o777, 0o600);
  }
  const tars = calls.filter((c) => c[0].endsWith('/tar'));
  assert.ok(tars[0].join(' ').includes(`${path.sep}mac-arm64 -- IRIS.app`));
  assert.ok(tars[1].join(' ').endsWith(`${path.sep}mac -- IRIS.app`));
});

test('prepare zips exactly the three members with the store-only flags and writes source.json in key order', async () => {
  const { env } = await releaseFixture();
  const { exec, calls } = fakeExec();
  const zipped = [];
  const capturing = (file, args, options) => {
    if (file.endsWith('/zip')) {
      zipped.push({ args, source: readFileSync(args[7], 'utf8'), names: args.slice(5).map((a) => path.basename(a)) });
    }
    return exec(file, args, options);
  };
  await prepare({ env, exec: capturing });
  assert.equal(zipped.length, 2);
  assert.deepEqual(zipped[0].args.slice(0, 4), ['-q', '-X', '-j', '-0']);
  assert.deepEqual(zipped[0].names, ['unsigned.tar.gz', 'template.dmg', 'source.json']);
  assert.equal(zipped[0].source, `{"source_sha":"${SHA}","version":"${VERSION}","bundle_id":"io.github.wuyilingwei.iris","architecture":"arm64"}\n`);
  assert.equal(JSON.parse(zipped[1].source).architecture, 'x64');
  assert.ok(calls.length > 0);
});

test('prepare rejects two apps with the same architecture', async () => {
  const { env, runner } = await releaseFixture({ extraArm: true });
  await assert.rejects(prepare({ env, exec: fakeExec().exec }), { code: 'APP_BUNDLE_COUNT_INVALID' });
  assert.deepEqual(await readdir(runner), []);
});

test('prepare rejects a wrong bundle id or version', async () => {
  for (const options of [{ bundleId: 'com.example.other' }, { shortVersion: '9.9.9' }]) {
    const { env, runner } = await releaseFixture();
    await assert.rejects(prepare({ env, exec: fakeExec(options).exec }), { code: 'APP_METADATA_INVALID' });
    assert.deepEqual(await readdir(runner), []);
  }
});

test('prepare rejects a disk image whose app differs from the release app', async () => {
  for (const file of [['Contents', 'Resources', 'app.asar'], ['Contents', 'MacOS', 'IRIS'], ['Contents', 'Info.plist']]) {
    const { env, runner } = await releaseFixture();
    const mountMutate = { arm64: (app) => writeFileSync(path.join(app, ...file), 'tampered') };
    await assert.rejects(prepare({ env, exec: fakeExec({ mountMutate }).exec }), { code: 'DMG_APP_MISMATCH' });
    assert.deepEqual(await readdir(runner), []);
  }
  const { env } = await releaseFixture();
  const mountMutate = { x64: (app) => rmSync(app, { recursive: true }) };
  await assert.rejects(prepare({ env, exec: fakeExec({ mountMutate }).exec }), { code: 'DMG_APP_MISMATCH' });
});

test('a detach failure keeps the work dir and fails', async () => {
  const { env, runner } = await releaseFixture();
  await assert.rejects(prepare({ env, exec: fakeExec({ detachFails: true }).exec }), { code: 'DISK_IMAGE_DETACH_FAILED' });
  assert.equal((await readdir(runner)).length, 1);
});

test('prepare refuses a second run attempt and an unknown version shape', async () => {
  const { env } = await releaseFixture();
  await assert.rejects(prepare({ env: { ...env, GITHUB_RUN_ATTEMPT: '2' }, exec: fakeExec().exec }), { code: 'INVALID_RUN_ATTEMPT' });
  await assert.rejects(prepare({ env: { ...env, INPUT_VERSION: 'v1' }, exec: fakeExec().exec }), { code: 'INVALID_SIGNING_REQUEST' });
});

// context

const CONTEXT_ENV = {
  GITHUB_RUN_ID: '38000000000',
  INPUT_SOURCE_SHA: SHA, INPUT_SHELL_VERSION: '0.5.84', INPUT_INTERNAL_VERSION: '0.5.0', INPUT_CORE_BUILD: '5', INPUT_CORE_VERSION: '26.1010.5',
  INPUT_SHELL_FINGERPRINT: 'b'.repeat(64), INPUT_RELEASE_ID: 'A'.repeat(43), INPUT_RELEASE_ENVELOPE: 'eyJ2IjoxfQ', IRIS_CONTEXT_SEAL_KEY: 'k'.repeat(40),
  INPUT_ARM64_REQUEST_ID: ID, INPUT_ARM64_INPUT_DIGEST: `sha256:${'c'.repeat(64)}`, INPUT_ARM64_INPUT_SIZE: '1234',
  INPUT_X64_REQUEST_ID: ID2, INPUT_X64_INPUT_DIGEST: `sha256:${'d'.repeat(64)}`, INPUT_X64_INPUT_SIZE: '5678',
};

test('buildContext builds the exact schema with the envelope sealed', () => {
  const { sealed_envelope: sealed, ...rest } = buildContext(CONTEXT_ENV);
  assert.deepEqual(rest, {
    schema_version: 1, build_run_id: 38000000000, source_sha: SHA, shell_version: '0.5.84', internal_version: '0.5.0',
    core_build: '5', core_version: '26.1010.5', shell_fingerprint: 'b'.repeat(64), release_id: 'A'.repeat(43),
    macos: {
      arm64: { project_id: 'iris-shell-arm64', request_id: ID, input_digest: `sha256:${'c'.repeat(64)}`, input_size: 1234 },
      x64: { project_id: 'iris-shell-x64', request_id: ID2, input_digest: `sha256:${'d'.repeat(64)}`, input_size: 5678 },
    },
  });
  assert.deepEqual(Object.keys(buildContext(CONTEXT_ENV)), ['schema_version', 'build_run_id', 'source_sha', 'shell_version', 'internal_version', 'core_build', 'core_version', 'shell_fingerprint', 'release_id', 'sealed_envelope', 'macos']);
  assert.equal(sealed.includes('eyJ2IjoxfQ'), false);
});

test('the sealed envelope opens only with the same key and the same context', () => {
  const context = buildContext(CONTEXT_ENV);
  assert.equal(openEnvelope(CONTEXT_ENV.IRIS_CONTEXT_SEAL_KEY, context), 'eyJ2IjoxfQ');
  assert.notEqual(buildContext(CONTEXT_ENV).sealed_envelope, context.sealed_envelope);
  assert.throws(() => openEnvelope('j'.repeat(40), context), { code: 'CONTEXT_INVALID' });
  assert.throws(() => openEnvelope(CONTEXT_ENV.IRIS_CONTEXT_SEAL_KEY, { ...context, release_id: 'B'.repeat(43) }), { code: 'CONTEXT_INVALID' });
  assert.throws(() => openEnvelope(CONTEXT_ENV.IRIS_CONTEXT_SEAL_KEY, { ...context, source_sha: 'f'.repeat(40) }), { code: 'CONTEXT_INVALID' });
  const tampered = Buffer.from(context.sealed_envelope, 'base64url');
  tampered[tampered.length - 1] ^= 1;
  assert.throws(() => openEnvelope(CONTEXT_ENV.IRIS_CONTEXT_SEAL_KEY, { ...context, sealed_envelope: tampered.toString('base64url') }), { code: 'CONTEXT_INVALID' });
});

test('buildContext refuses a missing or short seal key', () => {
  for (const key of [undefined, '', 'k'.repeat(31)]) assert.throws(() => buildContext({ ...CONTEXT_ENV, IRIS_CONTEXT_SEAL_KEY: key }), { code: 'SEAL_KEY_INVALID' }, String(key));
});

test('buildContext rejects equal request ids and every malformed field', () => {
  const bad = {
    INPUT_X64_REQUEST_ID: ID, INPUT_SOURCE_SHA: SHA.toUpperCase(), INPUT_SHELL_VERSION: '1.2', INPUT_INTERNAL_VERSION: 'x', INPUT_CORE_BUILD: '1.5',
    INPUT_CORE_VERSION: '26.1010.6', INPUT_SHELL_FINGERPRINT: 'b'.repeat(63), INPUT_RELEASE_ID: 'A'.repeat(42), INPUT_RELEASE_ENVELOPE: 'a b',
    INPUT_ARM64_REQUEST_ID: 'not-a-uuid', INPUT_ARM64_INPUT_DIGEST: 'sha256:abc', INPUT_ARM64_INPUT_SIZE: '0', INPUT_X64_INPUT_SIZE: '-1', GITHUB_RUN_ID: 'abc',
  };
  for (const [key, value] of Object.entries(bad)) {
    assert.throws(() => buildContext({ ...CONTEXT_ENV, [key]: value }), { code: 'CONTEXT_INVALID' }, key);
  }
  assert.throws(() => buildContext({ ...CONTEXT_ENV, INPUT_ARM64_REQUEST_ID: undefined }), { code: 'CONTEXT_INVALID' });
});

test('validateContext rejects extra keys at every level', () => {
  const ok = buildContext(CONTEXT_ENV);
  assert.throws(() => validateContext({ ...ok, extra: 1 }), { code: 'CONTEXT_INVALID' });
  assert.throws(() => validateContext({ ...ok, macos: { ...ok.macos, universal: ok.macos.x64 } }), { code: 'CONTEXT_INVALID' });
  assert.throws(() => validateContext({ ...ok, macos: { ...ok.macos, x64: { ...ok.macos.x64, token: 'x' } } }), { code: 'CONTEXT_INVALID' });
  assert.throws(() => validateContext({ ...ok, macos: { ...ok.macos, x64: { ...ok.macos.x64, project_id: 'iris-shell-arm64' } } }), { code: 'CONTEXT_INVALID' });
  assert.throws(() => validateContext({ ...ok, schema_version: 2 }), { code: 'CONTEXT_INVALID' });
});

test('the written context never contains secrets from the environment', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'context-test-'));
  const env = {
    ...CONTEXT_ENV, RUNNER_TEMP: temp,
    SIGNING_API_KEY: 'sentinel-signing-key', IRIS_RELEASE_UPLOAD_TOKEN: 'sentinel-upload-token', IRIS_RELEASE_KEY_TRANSFER_KEY: 'sentinel-transfer-key',
  };
  const file = await writeContext({ env });
  assert.equal(file, path.join(temp, 'shell-release-context', 'context.json'));
  const text = await readFile(file, 'utf8');
  for (const secret of ['sentinel-signing-key', 'sentinel-upload-token', 'sentinel-transfer-key', 'eyJ2IjoxfQ', CONTEXT_ENV.IRIS_CONTEXT_SEAL_KEY]) assert.equal(text.includes(secret), false);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  await assert.rejects(writeContext({ env }), { code: 'CONTEXT_WRITE_FAILED' });
});

test('cleanup removes only marked work dirs of this run', async () => {
  const { env, workDir, temp } = await signFixture(PART);
  await cleanup({ env: { ...env, INPUT_WORK_DIRS: `${workDir} ` } });
  assert.deepEqual((await readdir(temp)).filter((n) => n.startsWith('iris-shell-sign')), []);
  await cleanup({ env: { ...env, INPUT_WORK_DIRS: workDir } });
  const other = await signFixture(PART);
  await writeFile(path.join(other.workDir, '.iris-shell-sign-run'), '99\narm64\n');
  await assert.rejects(cleanup({ env: { ...other.env, INPUT_WORK_DIRS: other.workDir } }), { code: 'INVALID_TEMP_DIR' });
  await assert.rejects(cleanup({ env: { ...other.env, INPUT_WORK_DIRS: '/etc' } }), { code: 'INVALID_TEMP_DIR' });
});
