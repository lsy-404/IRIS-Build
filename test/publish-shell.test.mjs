import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildContext } from '../scripts/submit-macos.mjs';
import {
  assemble, awaitSigning, cleanupArtifacts, fetchSigned, gate, latestMacYml, main, preflight, readContext, resolve, validateVerification, verifyMacos,
} from '../scripts/publish-shell.mjs';

const SHA = 'a5237f77558b8e32886ba4ea0cca90c8c416520c';
const VERSION = '0.5.84';
const BUILD_RUN = '900';
const SEAL_KEY = 'k'.repeat(40);
const ID = { arm64: '3f2b8c1e-0a4d-4e8b-9c55-1d2e3f4a5b6c', x64: '4a2b8c1e-0a4d-4e8b-9c55-1d2e3f4a5b6d' };
const INPUT_DIGEST = { arm64: `sha256:${'c'.repeat(64)}`, x64: `sha256:${'d'.repeat(64)}` };
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

const json = (status, value, headers = {}) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json', ...headers } });

function clock() {
  const state = { t: 1_000_000, sleeps: [] };
  return { state, now: () => state.t, sleep: async (ms) => { state.sleeps.push(ms); state.t += ms; } };
}

async function temp(prefix = 'publish-test-') { return mkdtemp(path.join(os.tmpdir(), prefix)); }

// gate

function githubFake({ artifacts, runs = {}, repo = { default_branch: 'main' }, runArtifacts = {}, deletes = [], deleteStatus = {} } = {}) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    const { pathname, search } = new URL(url);
    calls.push(`${options.method} ${pathname}${search}`);
    if (options.method === 'DELETE') {
      const id = pathname.split('/').pop();
      deletes.push(id);
      const status = deleteStatus[id];
      return status ? new Response(null, { status }) : new Response(null, { status: 204 });
    }
    if (pathname === '/repos/o/r/actions/artifacts') return json(200, { artifacts: typeof artifacts === 'function' ? artifacts() : artifacts });
    if (pathname === '/repos/o/r') return json(200, repo);
    const runMatch = pathname.match(/^\/repos\/o\/r\/actions\/runs\/(\d+)$/);
    if (runMatch) return runs[runMatch[1]] ? json(200, runs[runMatch[1]]) : new Response(null, { status: 404 });
    const listMatch = pathname.match(/^\/repos\/o\/r\/actions\/runs\/(\d+)\/artifacts$/);
    if (listMatch) {
      const all = runArtifacts[listMatch[1]] ?? [];
      const page = Number(new URL(url).searchParams.get('page') ?? 1);
      return json(200, { artifacts: all.slice((page - 1) * 100, page * 100) });
    }
    throw new Error(`unexpected ${url}`);
  };
  return { fetchImpl, calls, deletes };
}

const gateEnv = { GITHUB_TOKEN: 't', GITHUB_REPOSITORY: 'o/r', GITHUB_RUN_ID: '500', INPUT_GATE_TIMEOUT_SECONDS: '600', INPUT_GATE_INTERVAL_SECONDS: '60' };
const contextArtifact = (runId, extra = {}) => ({ id: runId * 10, name: 'shell-release-context', expired: false, workflow_run: { id: runId }, ...extra });
const buildRun = (extra = {}) => ({ id: 400, path: '.github/workflows/build.yml', conclusion: 'success', ...extra });

test('gate waits on a successful build run with an unpublished context, then times out', async () => {
  const { state, now, sleep } = clock();
  const github = githubFake({ artifacts: [contextArtifact(400)], runs: { 400: buildRun() } });
  const summaries = [];
  await assert.rejects(gate({ env: gateEnv, fetchImpl: github.fetchImpl, now, sleep, summary: async (text) => summaries.push(text) }), { code: 'SHELL_PUBLISH_PENDING' });
  assert.equal(state.sleeps.length, 10);
  assert.ok(state.sleeps.every((ms) => ms === 60_000));
  assert.match(summaries.join(''), /400/);
});

test('gate passes when nothing is pending', async () => {
  const cases = {
    'failed run': { artifacts: [contextArtifact(400)], runs: { 400: buildRun({ conclusion: 'failure' }) } },
    'run still in progress': { artifacts: [contextArtifact(400)], runs: { 400: buildRun({ conclusion: null }) } },
    'expired artifact': { artifacts: [contextArtifact(400, { expired: true })], runs: { 400: buildRun() } },
    'the current run': { artifacts: [contextArtifact(500)], runs: { 500: buildRun({ id: 500 }) } },
    'another workflow': { artifacts: [contextArtifact(400)], runs: { 400: buildRun({ path: '.github/workflows/other.yml' }) } },
    'deleted run': { artifacts: [contextArtifact(400)], runs: {} },
    'no artifacts': { artifacts: [], runs: {} },
  };
  for (const [label, setup] of Object.entries(cases)) {
    const { state, now, sleep } = clock();
    await gate({ env: gateEnv, fetchImpl: githubFake(setup).fetchImpl, now, sleep, summary: async () => {} });
    assert.equal(state.sleeps.length, 0, label);
  }
});

test('gate recognises the workflow path with a ref suffix and passes once the artifact disappears', async () => {
  const { state, now, sleep } = clock();
  let listings = 0;
  const github = githubFake({ artifacts: () => (listings++ < 2 ? [contextArtifact(400)] : []), runs: { 400: buildRun({ path: '.github/workflows/build.yml@refs/heads/main' }) } });
  await gate({ env: gateEnv, fetchImpl: github.fetchImpl, now, sleep, summary: async () => {} });
  assert.equal(state.sleeps.length, 2);
});

// resolve

const resolveEnv = { GITHUB_TOKEN: 't', GITHUB_REPOSITORY: 'o/r', GITHUB_REPOSITORY_ID: '1348112782', INPUT_BUILD_RUN_ID: BUILD_RUN };
const goodRun = (extra = {}) => ({ id: 900, path: '.github/workflows/build.yml', repository: { id: 1348112782 }, run_attempt: 1, status: 'completed', conclusion: 'success', head_branch: 'main', event: 'repository_dispatch', ...extra });

test('resolve accepts a clean build run and reports whether it holds a shell release', async () => {
  const noArtifact = githubFake({ runs: { 900: goodRun() }, runArtifacts: { 900: [] } });
  assert.deepEqual(await resolve({ env: resolveEnv, fetchImpl: noArtifact.fetchImpl, sleep: async () => {} }), { shell: false });
  const withArtifact = githubFake({ runs: { 900: goodRun({ event: 'workflow_dispatch' }) }, runArtifacts: { 900: [contextArtifact(900)] } });
  assert.deepEqual(await resolve({ env: resolveEnv, fetchImpl: withArtifact.fetchImpl, sleep: async () => {} }), { shell: true });
});

test('resolve rejects each run field that deviates', async () => {
  const mutations = {
    path: { path: '.github/workflows/publish-shell.yml' }, repository: { repository: { id: 5 } }, attempt: { run_attempt: 2 }, status: { status: 'in_progress' },
    conclusion: { conclusion: 'failure' }, branch: { head_branch: 'feature' }, event: { event: 'push' }, id: { id: 901 },
  };
  for (const [label, mutation] of Object.entries(mutations)) {
    const github = githubFake({ runs: { 900: goodRun(mutation) }, runArtifacts: { 900: [contextArtifact(900)] } });
    await assert.rejects(resolve({ env: resolveEnv, fetchImpl: github.fetchImpl, sleep: async () => {} }), { code: 'BUILD_RUN_NOT_ALLOWED' }, label);
  }
});

test('resolve rejects two context artifacts and an expired one', async () => {
  for (const artifacts of [[contextArtifact(900), contextArtifact(900, { id: 1 })], [contextArtifact(900, { expired: true })]]) {
    const github = githubFake({ runs: { 900: goodRun() }, runArtifacts: { 900: artifacts } });
    await assert.rejects(resolve({ env: resolveEnv, fetchImpl: github.fetchImpl, sleep: async () => {} }), { code: 'CONTEXT_INVALID' });
  }
});

// context

const CONTEXT_ENV = {
  GITHUB_RUN_ID: BUILD_RUN,
  INPUT_SOURCE_SHA: SHA, INPUT_SHELL_VERSION: VERSION, INPUT_INTERNAL_VERSION: '0.5.0', INPUT_CORE_BUILD: '5', INPUT_CORE_VERSION: '26.1010.5',
  INPUT_SHELL_FINGERPRINT: 'b'.repeat(64), INPUT_RELEASE_ID: 'A'.repeat(43), INPUT_RELEASE_ENVELOPE: 'eyJ2IjoxfQ', IRIS_CONTEXT_SEAL_KEY: SEAL_KEY,
  INPUT_ARM64_REQUEST_ID: ID.arm64, INPUT_ARM64_INPUT_DIGEST: INPUT_DIGEST.arm64, INPUT_ARM64_INPUT_SIZE: '1234',
  INPUT_X64_REQUEST_ID: ID.x64, INPUT_X64_INPUT_DIGEST: INPUT_DIGEST.x64, INPUT_X64_INPUT_SIZE: '5678',
};

async function contextFile(mutate) {
  const dir = await temp();
  const file = path.join(dir, 'context.json');
  const value = buildContext(CONTEXT_ENV);
  await writeFile(file, typeof mutate === 'string' ? mutate : JSON.stringify(mutate ? mutate(value) ?? value : value));
  return { dir, file };
}

test('context accepts the exact schema and rejects deviations', async () => {
  const { file } = await contextFile();
  assert.equal((await readContext({ env: { INPUT_CONTEXT_FILE: file, INPUT_BUILD_RUN_ID: BUILD_RUN } })).shell_version, VERSION);
  await assert.rejects(readContext({ env: { INPUT_CONTEXT_FILE: file, INPUT_BUILD_RUN_ID: '901' } }), { code: 'CONTEXT_INVALID' });
  const extra = await contextFile((value) => ({ ...value, extra: true }));
  await assert.rejects(readContext({ env: { INPUT_CONTEXT_FILE: extra.file, INPUT_BUILD_RUN_ID: BUILD_RUN } }), { code: 'CONTEXT_INVALID' });
  const oversize = await contextFile((value) => ({ ...value, sealed_envelope: 'a'.repeat(20_000) }));
  await assert.rejects(readContext({ env: { INPUT_CONTEXT_FILE: oversize.file, INPUT_BUILD_RUN_ID: BUILD_RUN } }), { code: 'CONTEXT_INVALID' });
  const garbage = await contextFile('{not json');
  await assert.rejects(readContext({ env: { INPUT_CONTEXT_FILE: garbage.file, INPUT_BUILD_RUN_ID: BUILD_RUN } }), { code: 'CONTEXT_INVALID' });
});

test('context --public never emits the envelope or the release id', async () => {
  const { dir, file } = await contextFile();
  const outputs = {};
  for (const flag of [['context', '--public'], ['context']]) {
    const output = path.join(dir, `out-${flag.length}`);
    await writeFile(output, '');
    assert.equal(await main(flag, { env: { INPUT_CONTEXT_FILE: file, INPUT_BUILD_RUN_ID: BUILD_RUN, GITHUB_OUTPUT: output, IRIS_CONTEXT_SEAL_KEY: SEAL_KEY }, stderr: { write() {} } }), 0);
    outputs[flag.length] = await readFile(output, 'utf8');
  }
  assert.doesNotMatch(outputs[2], /release_envelope|sealed_envelope|release_id|eyJ2IjoxfQ|AAAAAAAAAA/);
  assert.match(outputs[2], /^source_sha=.*\nshell_version=0\.5\.84\narm64_request_id=/);
  assert.match(outputs[1], /release_envelope=eyJ2IjoxfQ\n/);
  assert.match(outputs[1], new RegExp(`release_id=${'A'.repeat(43)}\\n`));
});

test('context cannot be read without the seal key and the file never holds the plaintext envelope', async () => {
  const { dir, file } = await contextFile();
  assert.equal((await readFile(file, 'utf8')).includes('eyJ2IjoxfQ'), false);
  for (const key of [undefined, 'j'.repeat(40)]) {
    const output = path.join(dir, `out-${String(key).length}`);
    await writeFile(output, '');
    const lines = [];
    assert.equal(await main(['context'], { env: { INPUT_CONTEXT_FILE: file, INPUT_BUILD_RUN_ID: BUILD_RUN, GITHUB_OUTPUT: output, IRIS_CONTEXT_SEAL_KEY: key }, stderr: { write: (text) => lines.push(text) } }), 1);
    assert.deepEqual(lines, ['CONTEXT_INVALID\n']);
    assert.equal(await readFile(output, 'utf8'), '');
  }
});

// await

const awaitEnv = () => ({
  SIGNING_API_KEY: 'key', INPUT_BUILD_RUN_ID: BUILD_RUN, INPUT_VERSION: VERSION, INPUT_SOURCE_SHA: SHA,
  INPUT_ARM64_REQUEST_ID: ID.arm64, INPUT_ARM64_INPUT_DIGEST: INPUT_DIGEST.arm64, INPUT_X64_REQUEST_ID: ID.x64, INPUT_X64_INPUT_DIGEST: INPUT_DIGEST.x64,
  INPUT_TIMEOUT_SECONDS: '3600',
});

const statusBody = (arch, extra = {}) => ({
  request_id: ID[arch], project_id: `iris-shell-${arch}`, state: 'queued', platform: 'macos', version: VERSION, source_run_id: Number(BUILD_RUN),
  source_sha: SHA, input_digest: INPUT_DIGEST[arch], retry_after_seconds: 30, error: null, output: null, ...extra,
});

const SUCCEEDED = (arch, extra = {}) => statusBody(arch, { state: 'succeeded', output: { archive_digest: `sha256:${'e'.repeat(64)}`, archive_size: 10 }, ...extra });

function centerStatus(script) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    const match = url.match(/^https:\/\/sign\.voidcarve\.com\/v1\/requests\/([0-9a-f-]{36})$/);
    if (!match) throw new Error(`unexpected ${url}`);
    assert.equal(options.headers.authorization, 'Bearer key');
    const arch = Object.keys(ID).find((name) => ID[name] === match[1]);
    calls.push(arch);
    const queue = script[arch];
    const step = queue.length > 1 ? queue.shift() : queue[0];
    if (step instanceof Error) throw step;
    if (typeof step === 'number') return new Response(null, { status: step });
    return json(200, step);
  };
  return { fetchImpl, calls };
}

test('await follows state sequences to success and logs only state changes', async () => {
  const { state, now, sleep } = clock();
  const lines = [];
  const center = centerStatus({
    arm64: [statusBody('arm64'), statusBody('arm64', { state: 'notarizing' }), SUCCEEDED('arm64')],
    x64: [statusBody('x64', { state: 'notarizing' }), statusBody('x64', { state: 'notarizing' }), SUCCEEDED('x64')],
  });
  await awaitSigning({ env: awaitEnv(), fetchImpl: center.fetchImpl, sleep, now, log: (line) => lines.push(line) });
  assert.deepEqual(lines, ['arm64: queued', 'x64: notarizing', 'arm64: notarizing', 'arm64: succeeded', 'x64: succeeded']);
  assert.equal(state.sleeps.length, 2);
  assert.equal(center.calls.filter((arch) => arch === 'arm64').length, 3);
});

test('await maps every terminal failure to its code', async () => {
  for (const [state, code] of [['failed', 'SIGNING_FAILED'], ['cancelled', 'SIGNING_CANCELLED']]) {
    const { now, sleep } = clock();
    const center = centerStatus({ arm64: [statusBody('arm64', { state, error: 'notarization_rejected' })], x64: [statusBody('x64')] });
    await assert.rejects(awaitSigning({ env: awaitEnv(), fetchImpl: center.fetchImpl, sleep, now, log() {} }), { code, detail: 'arm64 notarization_rejected' });
  }
  const { now, sleep } = clock();
  const center = centerStatus({ arm64: [statusBody('arm64', { state: 'failed', error: 'Has Spaces' })], x64: [statusBody('x64')] });
  await assert.rejects(awaitSigning({ env: awaitEnv(), fetchImpl: center.fetchImpl, sleep, now, log() {} }), { code: 'SIGNING_FAILED', detail: 'arm64' });
});

test('await rejects each identity field mismatch', async () => {
  const mutations = {
    request_id: { request_id: ID.x64 }, project_id: { project_id: 'iris-shell-x64' }, platform: { platform: 'linux' }, source_run_id: { source_run_id: 901 },
    version: { version: '9.9.9' }, source_sha: { source_sha: 'f'.repeat(40) }, input_digest: { input_digest: `sha256:${'0'.repeat(64)}` },
  };
  for (const [label, mutation] of Object.entries(mutations)) {
    const { now, sleep } = clock();
    const center = centerStatus({ arm64: [SUCCEEDED('arm64', mutation)], x64: [SUCCEEDED('x64')] });
    await assert.rejects(awaitSigning({ env: awaitEnv(), fetchImpl: center.fetchImpl, sleep, now, log() {} }), { code: 'SIGNING_REQUEST_MISMATCH' }, label);
  }
});

test('await clamps retry_after_seconds between 15 and 300 seconds', async () => {
  for (const [seconds, expected] of [[1, 15_000], [45, 45_000], [9999, 300_000]]) {
    const { state, now, sleep } = clock();
    const center = centerStatus({
      arm64: [statusBody('arm64', { retry_after_seconds: seconds }), SUCCEEDED('arm64')],
      x64: [statusBody('x64', { retry_after_seconds: seconds }), SUCCEEDED('x64')],
    });
    await awaitSigning({ env: awaitEnv(), fetchImpl: center.fetchImpl, sleep, now, log() {} });
    assert.deepEqual(state.sleeps, [expected]);
  }
});

test('await gives up at the deadline', async () => {
  const { now, sleep } = clock();
  const center = centerStatus({ arm64: [statusBody('arm64')], x64: [statusBody('x64')] });
  await assert.rejects(awaitSigning({ env: { ...awaitEnv(), INPUT_TIMEOUT_SECONDS: '100' }, fetchImpl: center.fetchImpl, sleep, now, log() {} }), { code: 'SIGNING_TIMEOUT' });
});

test('await retries 5xx, 429, 408 and network errors but treats 401, 403 and 404 as fatal', async () => {
  const { state, now, sleep } = clock();
  const center = centerStatus({ arm64: [503, 429, 408, new TypeError('fetch failed'), SUCCEEDED('arm64')], x64: [SUCCEEDED('x64')] });
  await awaitSigning({ env: awaitEnv(), fetchImpl: center.fetchImpl, sleep, now, log() {} });
  assert.ok(state.sleeps.length >= 4);
  for (const [status, code] of [[401, 'SIGNING_AUTH_FAILED'], [403, 'SIGNING_AUTH_FAILED'], [404, 'SIGNING_REQUEST_NOT_FOUND']]) {
    const fatal = clock();
    const failing = centerStatus({ arm64: [status], x64: [statusBody('x64')] });
    await assert.rejects(awaitSigning({ env: awaitEnv(), fetchImpl: failing.fetchImpl, sleep: fatal.sleep, now: fatal.now, log() {} }), { code });
    assert.equal(failing.calls.length, 1);
  }
});

test('await requires the output summary on success', async () => {
  const { now, sleep } = clock();
  const center = centerStatus({ arm64: [statusBody('arm64', { state: 'succeeded' })], x64: [SUCCEEDED('x64')] });
  await assert.rejects(awaitSigning({ env: awaitEnv(), fetchImpl: center.fetchImpl, sleep, now, log() {} }), { code: 'SIGNING_OUTPUT_INVALID' });
});

// mac checks

const IDENTITY = `Executable=/x\nIdentifier=io.github.wuyilingwei.iris\nCodeDirectory v=20500 size=1 flags=0x10000(runtime) hashes=1+7 location=embedded\nAuthority=Developer ID Application: Test (76DMUAK6J5)\nTimestamp=Oct 10, 2026 at 10:00:00\nTeamIdentifier=76DMUAK6J5\n`;
const DMG_IDENTITY = `Identifier=IRIS\nAuthority=Developer ID Application: Test (76DMUAK6J5)\nTimestamp=Oct 10, 2026 at 10:00:00\nTeamIdentifier=76DMUAK6J5\n`;
const ENTITLEMENTS = REQUIRED().map((key) => `<key>${key}</key><true/>`).join('');
function REQUIRED() { return ['com.apple.security.cs.allow-jit', 'com.apple.security.device.audio-input', 'com.apple.security.device.camera', 'com.apple.security.device.bluetooth']; }

function macExec({ arch = 'arm64', version = VERSION, bundleId = 'io.github.wuyilingwei.iris', override = () => undefined } = {}) {
  const calls = [];
  const exec = (file, args) => {
    calls.push([file, ...args]);
    const forced = override(file, args);
    if (forced instanceof Error) throw forced;
    if (forced !== undefined) return forced;
    const tool = path.basename(file);
    const joined = args.join(' ');
    if (tool === 'codesign') {
      if (args[0] === '-dv') return args[2].endsWith('.dmg') ? DMG_IDENTITY : IDENTITY;
      if (args[0] === '-d') return `<?xml version="1.0"?><plist><dict>${ENTITLEMENTS}</dict></plist>`;
      return '';
    }
    if (tool === 'xcrun') return 'The validate action worked!\n';
    if (tool === 'spctl') return `${args.at(-1)}: accepted\nsource=Notarized Developer ID\n`;
    if (tool === 'hdiutil' && args[0] === 'attach') { mkdirSync(path.join(args[args.indexOf('-mountpoint') + 1], 'IRIS.app'), { recursive: true }); return ''; }
    if (tool === 'hdiutil') return '';
    if (tool === 'plutil') return `${args[1] === 'CFBundleIdentifier' ? bundleId : version}\n`;
    if (tool === 'lipo') return `${arch === 'arm64' ? 'arm64' : 'x86_64'}\n`;
    if (tool === 'ditto') { mkdirSync(args[1], { recursive: true }); return ''; }
    if (tool === 'xattr') return '';
    throw new Error(`unexpected ${tool} ${joined}`);
  };
  return { exec, calls };
}

const CHECKS = [
  ['dmg-codesign', (f, a) => f.endsWith('codesign') && a[0] === '--verify' && a.at(-1).endsWith('.dmg')],
  ['dmg-identity', (f, a) => f.endsWith('codesign') && a[0] === '-dv' && a.at(-1).endsWith('.dmg')],
  ['dmg-staple', (f, a) => f.endsWith('xcrun') && a.at(-1).endsWith('.dmg')],
  ['dmg-gatekeeper', (f, a) => f.endsWith('spctl') && a.at(-1).endsWith('.dmg')],
  ['dmg-mount', (f, a) => f.endsWith('hdiutil') && a[0] === 'attach'],
  ['app-codesign', (f, a) => f.endsWith('codesign') && a.includes('--deep') && a.some((x) => x.startsWith('-R='))],
  ['app-identity', (f, a) => f.endsWith('codesign') && a[0] === '-dv' && a.at(-1).endsWith('IRIS.app')],
  ['app-entitlements', (f, a) => f.endsWith('codesign') && a[0] === '-d'],
  ['app-metadata', (f) => f.endsWith('plutil')],
  ['app-notarization', (f, a) => f.endsWith('xcrun') && a.at(-1).endsWith('IRIS.app')],
  ['app-notarization', (f, a) => f.endsWith('spctl') && a.at(-1).endsWith('IRIS.app')],
  ['updater-copy', (f) => f.endsWith('ditto')],
  ['updater-copy', (f) => f.endsWith('xattr')],
  ['updater-copy', (f, a) => f.endsWith('codesign') && a.includes('--deep') && !a.some((x) => x.startsWith('-R='))],
  ['dmg-detach', (f, a) => f.endsWith('hdiutil') && a[0] === 'detach'],
];

async function runChecks(options = {}) {
  const dir = await temp();
  const { exec, calls } = macExec(options);
  await verifyMacos({ exec, dmg: path.join(dir, 'product.dmg'), arch: options.arch ?? 'arm64', version: VERSION, tmpRoot: dir });
  return calls;
}

test('every check runs in order and the app is verified against the Team ID requirement', async () => {
  const calls = await runChecks();
  const flat = calls.map((c) => `${path.basename(c[0])} ${c.slice(1).join(' ')}`);
  const app = flat.find((line) => line.includes('--deep') && line.includes('-R='));
  assert.ok(app.includes('anchor apple generic and identifier "io.github.wuyilingwei.iris" and certificate leaf[subject.OU] = "76DMUAK6J5"'));
  assert.ok(app.includes('--strict'));
  const order = ['--verify --strict', '-dv --verbose=4', 'stapler validate', 'spctl', 'hdiutil attach', '-R=', '-d --entitlements', 'plutil', 'lipo', 'spctl --assess --type execute', 'ditto', 'xattr -cr', 'hdiutil detach'];
  let cursor = -1;
  for (const needle of order) {
    const index = flat.findIndex((line, i) => i > cursor && line.includes(needle));
    assert.ok(index > cursor, `missing or out of order: ${needle}`);
    cursor = index;
  }
  assert.ok(flat.some((line) => line.startsWith('xattr -cr') ));
  assert.ok(flat.filter((line) => line.includes('--deep --strict')).length >= 2);
});

test('each failing check maps to its own error code', async () => {
  for (const [name, matches] of CHECKS) {
    let thrown = false;
    const override = (file, args) => (matches(file, args) ? new Error('boom') : undefined);
    await assert.rejects(runChecks({ override }), { code: `MACOS_VERIFICATION_FAILED:${name}` }, name);
    thrown = true;
    assert.ok(thrown);
  }
});

test('identity, notarization, runtime flag and entitlement evidence is required', async () => {
  const cases = [
    ['dmg-gatekeeper', (f, a) => (f.endsWith('spctl') && a.at(-1).endsWith('.dmg') ? 'accepted\nsource=Developer ID\n' : undefined)],
    ['app-notarization', (f, a) => (f.endsWith('spctl') && a.at(-1).endsWith('IRIS.app') ? 'accepted\nsource=Developer ID\n' : undefined)],
    ['dmg-identity', (f, a) => (f.endsWith('codesign') && a[0] === '-dv' && a.at(-1).endsWith('.dmg') ? DMG_IDENTITY.replace('76DMUAK6J5\n', 'ZZZZZZZZZZ\n') : undefined)],
    ['app-identity', (f, a) => (f.endsWith('codesign') && a[0] === '-dv' && a.at(-1).endsWith('IRIS.app') ? IDENTITY.replace(/TeamIdentifier=.*/, 'TeamIdentifier=ZZZZZZZZZZ') : undefined)],
    ['app-identity', (f, a) => (f.endsWith('codesign') && a[0] === '-dv' && a.at(-1).endsWith('IRIS.app') ? IDENTITY.replace('(runtime)', '(0x0)') : undefined)],
    ['app-identity', (f, a) => (f.endsWith('codesign') && a[0] === '-dv' && a.at(-1).endsWith('IRIS.app') ? IDENTITY.replace('Timestamp=Oct 10, 2026 at 10:00:00', 'Timestamp=none') : undefined)],
    ['app-identity', (f, a) => (f.endsWith('codesign') && a[0] === '-dv' && a.at(-1).endsWith('IRIS.app') ? IDENTITY.replace('Developer ID Application', 'Apple Development') : undefined)],
    ['dmg-identity', (f, a) => (f.endsWith('codesign') && a[0] === '-dv' && a.at(-1).endsWith('.dmg') ? DMG_IDENTITY.replace(/Timestamp=.*\n/, '') : undefined)],
  ];
  for (const key of ['com.apple.security.cs.allow-jit', 'com.apple.security.device.audio-input', 'com.apple.security.device.camera']) {
    cases.push(['app-entitlements', (f, a) => (f.endsWith('codesign') && a[0] === '-d' ? ENTITLEMENTS.replace(`<key>${key}</key>`, '') : undefined)]);
  }
  for (const [name, override] of cases) await assert.rejects(runChecks({ override }), { code: `MACOS_VERIFICATION_FAILED:${name}` }, name);
});

test('metadata checks reject the wrong bundle id, version and architecture', async () => {
  await assert.rejects(runChecks({ bundleId: 'com.example.other' }), { code: 'MACOS_VERIFICATION_FAILED:app-metadata' });
  await assert.rejects(runChecks({ version: '9.9.9' }), { code: 'MACOS_VERIFICATION_FAILED:app-metadata' });
  const dir = await temp();
  const { exec } = macExec({ arch: 'x64' });
  await assert.rejects(verifyMacos({ exec, dmg: path.join(dir, 'product.dmg'), arch: 'arm64', version: VERSION, tmpRoot: dir }), { code: 'MACOS_VERIFICATION_FAILED:app-metadata' });
});

test('a disk image with two apps or a differently named app is rejected', async () => {
  const cases = [
    (mount) => { mkdirSync(path.join(mount, 'Other.app')); },
  ];
  for (const extra of cases) {
    const override = (file, args) => {
      if (file.endsWith('hdiutil') && args[0] === 'attach') {
        const mount = args[args.indexOf('-mountpoint') + 1];
        mkdirSync(path.join(mount, 'IRIS.app'), { recursive: true });
        extra(mount);
        return '';
      }
      return undefined;
    };
    await assert.rejects(runChecks({ override }), { code: 'MACOS_VERIFICATION_FAILED:dmg-mount' });
  }
});

// fetch

function product() {
  const dmg = randomBytes(64);
  const zip = randomBytes(300);
  return { dmg, zip, zipDigest: `sha256:${sha256(zip)}` };
}

function report(arch, dmg, extra = {}) {
  return {
    schema_version: 1, request_id: ID[arch], generation: 1, stage: 'dmg_finalize', input_digest: `sha256:${'3'.repeat(64)}`, recipe_sha: SHA, policy_digest: `sha256:${'1'.repeat(64)}`,
    team_id: '76DMUAK6J5', bundle_id: 'io.github.wuyilingwei.iris', version: VERSION, architecture: arch, codesign_verified: true, timestamp_verified: true,
    asar_integrity_verified: true, notarization_id: '5a2b8c1e-0a4d-4e8b-9c55-1d2e3f4a5b6e', notarization_status: 'Accepted', notary_archive_sha256: '2'.repeat(64),
    gatekeeper_verified: true, staple_verified: true, files: [{ path: 'product.dmg', size: dmg.length, sha256: sha256(dmg) }], ...extra,
  };
}

async function fetchHarness({ download = {}, reportExtra = {}, entries = ['product.dmg', 'verification.json'], statusOverride = {}, execOverride } = {}) {
  const dir = await temp();
  const products = { arm64: product(), x64: product() };
  const calls = { download: [], status: 0 };
  let attempts = { arm64: 0, x64: 0 };
  const fetchImpl = async (url, options) => {
    const match = url.match(/\/v1\/requests\/([0-9a-f-]{36})(\/download)?$/);
    const arch = Object.keys(ID).find((name) => ID[name] === match?.[1]);
    if (!arch) throw new Error(`unexpected ${url}`);
    const item = products[arch];
    if (!match[2]) {
      calls.status += 1;
      return json(200, SUCCEEDED(arch, { output: { archive_digest: item.zipDigest, archive_size: item.zip.length }, ...statusOverride }));
    }
    calls.download.push({ arch, range: options.headers.range ?? null });
    attempts[arch] += 1;
    const mode = download[arch]?.[attempts[arch] - 1] ?? download.default ?? 'ok';
    const headers = { 'x-signing-archive-digest': download.headerDigest ?? item.zipDigest, 'content-type': 'application/zip' };
    if (mode === 'gone') return json(410, { error: 'signed_output_expired' });
    if (mode === 'unavailable') return json(503, {});
    let body = item.zip;
    if (download.flip) { body = Buffer.from(item.zip); body[0] ^= 0xff; }
    const range = options.headers.range ? Number(/bytes=(\d+)-/.exec(options.headers.range)[1]) : 0;
    if (mode === 'truncate' || mode === 'truncate-error') {
      const cut = body.subarray(0, 100);
      let sent = false;
      const stream = new ReadableStream({ pull(controller) {
        if (!sent) { sent = true; controller.enqueue(cut); return; }
        if (mode === 'truncate-error') controller.error(new Error('reset')); else controller.close();
      } });
      return new Response(stream, { status: 200, headers });
    }
    if (mode === 'ok-ignore-range' || !range) return new Response(body, { status: 200, headers });
    return new Response(body.subarray(range), { status: 206, headers: { ...headers, 'content-range': `bytes ${range}-${body.length - 1}/${body.length}` } });
  };
  const mac = (arch) => macExec({ arch, override: execOverride });
  let current = 'arm64';
  const exec = (file, args) => {
    const tool = path.basename(file);
    if (tool === 'unzip' && args[0] === '-Z1') return `${entries.join('\n')}\n`;
    if (tool === 'unzip') {
      const target = args[args.indexOf('-d') + 1];
      const arch = path.basename(target);
      writeFileSync(path.join(target, 'product.dmg'), products[arch].dmg);
      writeFileSync(path.join(target, 'verification.json'), JSON.stringify(report(arch, products[arch].dmg, reportExtra)));
      return '';
    }
    if (tool === 'hdiutil' && args[0] === 'attach') current = args.at(-1).includes(`${path.sep}x64${path.sep}`) ? 'x64' : 'arm64';
    return mac(current).exec(file, args);
  };
  const env = { ...awaitEnv(), RUNNER_TEMP: dir, GITHUB_RUN_ID: '901' };
  const { now, sleep, state } = clock();
  const run = () => fetchSigned({ env, fetchImpl, sleep, now, exec });
  return { dir, run, products, calls, state };
}

test('fetch downloads, verifies and stages both images with a regenerated latest-mac.yml', async () => {
  const harness = await fetchHarness();
  const out = await harness.run();
  assert.equal(out, path.join(harness.dir, 'signed-macos'));
  assert.deepEqual((await readdir(out)).sort(), [`IRIS-${VERSION}-mac-arm64.dmg`, `IRIS-${VERSION}-mac-x64.dmg`, 'latest-mac.yml', 'signed-macos.json']);
  assert.ok((await readFile(path.join(out, `IRIS-${VERSION}-mac-x64.dmg`))).equals(harness.products.x64.dmg));
  const manifest = JSON.parse(await readFile(path.join(out, 'signed-macos.json'), 'utf8'));
  assert.deepEqual(manifest.files.map((f) => [f.name, f.arch, f.request_id, f.size, f.sha256]), ['arm64', 'x64'].map((arch) => [`IRIS-${VERSION}-mac-${arch}.dmg`, arch, ID[arch], 64, sha256(harness.products[arch].dmg)]));
  const yml = await readFile(path.join(out, 'latest-mac.yml'), 'utf8');
  assert.ok(yml.includes(createHash('sha512').update(harness.products.x64.dmg).digest('base64')));
  assert.deepEqual(await readdir(path.join(harness.dir, 'iris-signed-901')).catch(() => []), []);
});

test('fetch rejects a header digest that differs from the status digest', async () => {
  const harness = await fetchHarness({ download: { headerDigest: `sha256:${'0'.repeat(64)}` } });
  await assert.rejects(harness.run(), { code: 'SIGNED_OUTPUT_MISMATCH' });
});

test('fetch rejects a body whose digest differs from the header', async () => {
  const harness = await fetchHarness({ download: { flip: true } });
  await assert.rejects(harness.run(), { code: 'SIGNED_OUTPUT_MISMATCH' });
});

test('fetch resumes a truncated stream with a range request and a reset connection', async () => {
  for (const mode of ['truncate', 'truncate-error']) {
    const harness = await fetchHarness({ download: { arm64: [mode] } });
    const out = await harness.run();
    assert.ok((await readFile(path.join(out, `IRIS-${VERSION}-mac-arm64.dmg`))).equals(harness.products.arm64.dmg));
    const arm = harness.calls.download.filter((c) => c.arch === 'arm64');
    assert.deepEqual(arm.map((c) => c.range), [null, 'bytes=100-']);
    assert.deepEqual(harness.state.sleeps, [2000]);
  }
});

test('fetch restarts the file when a resume is answered with 200', async () => {
  const harness = await fetchHarness({ download: { arm64: ['truncate', 'ok-ignore-range'] } });
  const out = await harness.run();
  assert.ok((await readFile(path.join(out, `IRIS-${VERSION}-mac-arm64.dmg`))).equals(harness.products.arm64.dmg));
});

test('fetch does not retry a 410 and gives up after repeated transient failures', async () => {
  const gone = await fetchHarness({ download: { default: 'gone' } });
  await assert.rejects(gone.run(), { code: 'SIGNED_OUTPUT_UNAVAILABLE' });
  assert.equal(gone.calls.download.length, 1);
  assert.deepEqual(gone.state.sleeps, []);
  const down = await fetchHarness({ download: { default: 'unavailable' } });
  await assert.rejects(down.run(), { code: 'SIGNED_OUTPUT_UNAVAILABLE' });
  assert.equal(down.calls.download.length, 5);
  assert.deepEqual(down.state.sleeps, [2000, 4000, 8000, 16000]);
});

test('fetch rejects an archive with an extra entry or a missing entry', async () => {
  for (const entries of [['product.dmg', 'verification.json', 'extra.txt'], ['product.dmg'], ['product.dmg', 'verification.json/../x']]) {
    const harness = await fetchHarness({ entries });
    await assert.rejects(harness.run(), { code: 'SIGNED_ARCHIVE_INVALID' });
  }
});

test('fetch requires the request to be succeeded', async () => {
  const harness = await fetchHarness({ statusOverride: { state: 'queued', output: null } });
  await assert.rejects(harness.run(), { code: 'SIGNED_OUTPUT_UNAVAILABLE' });
});

test('every verification.json field is enforced', async () => {
  const dmg = randomBytes(64);
  const context = { requestId: ID.arm64, version: VERSION, arch: 'arm64', productSize: dmg.length, productSha256: sha256(dmg) };
  validateVerification(report('arm64', dmg), context);
  const mutations = {
    schema_version: 2, request_id: ID.x64, generation: 0, stage: 'dmg_sign', input_digest: 'sha256:short', recipe_sha: 'z', policy_digest: 'x', team_id: 'ZZZZZZZZZZ',
    bundle_id: 'com.example.other', version: '9.9.9', architecture: 'x64', codesign_verified: false, timestamp_verified: false, asar_integrity_verified: 'yes',
    notarization_id: 'nope', notarization_status: 'Submitted', notary_archive_sha256: 'short', gatekeeper_verified: false, staple_verified: false,
    files: [], extra_key: true,
  };
  for (const [key, value] of Object.entries(mutations)) {
    const mutated = { ...report('arm64', dmg), [key]: value };
    assert.throws(() => validateVerification(mutated, context), { code: 'VERIFICATION_REPORT_INVALID' }, key);
  }
  for (const key of Object.keys(report('arm64', dmg))) {
    const missing = report('arm64', dmg);
    delete missing[key];
    assert.throws(() => validateVerification(missing, context), { code: 'VERIFICATION_REPORT_INVALID' }, `missing ${key}`);
  }
  const fileMutations = [{ path: 'signed.dmg' }, { size: dmg.length + 1 }, { sha256: '0'.repeat(64) }, { extra: 1 }];
  for (const mutation of fileMutations) {
    const mutated = report('arm64', dmg);
    mutated.files = [{ ...mutated.files[0], ...mutation }];
    assert.throws(() => validateVerification(mutated, context), { code: 'VERIFICATION_REPORT_INVALID' });
  }
  const two = report('arm64', dmg);
  two.files = [two.files[0], two.files[0]];
  assert.throws(() => validateVerification(two, context), { code: 'VERIFICATION_REPORT_INVALID' });
});

test('fetch rejects a report that does not match the image it came with', async () => {
  const harness = await fetchHarness({ reportExtra: { team_id: 'ZZZZZZZZZZ' } });
  await assert.rejects(harness.run(), { code: 'VERIFICATION_REPORT_INVALID' });
});

test('fetch surfaces a failing platform check with its name', async () => {
  const harness = await fetchHarness({ execOverride: (file, args) => (file.endsWith('spctl') && args.at(-1).endsWith('.dmg') ? 'rejected\n' : undefined) });
  await assert.rejects(harness.run(), { code: 'MACOS_VERIFICATION_FAILED:dmg-gatekeeper' });
});

test('latest-mac.yml is generated byte for byte without blockmap keys', () => {
  const text = latestMacYml({
    version: VERSION, now: () => Date.UTC(2026, 9, 10, 12, 0, 0),
    x64: { sha512: 'X64SHA512==', size: 111 }, arm64: { sha512: 'ARMSHA512==', size: 222 },
  });
  assert.equal(text, [
    'version: 0.5.84', 'files:', '  - url: IRIS-0.5.84-mac-x64.dmg', '    sha512: X64SHA512==', '    size: 111',
    '  - url: IRIS-0.5.84-mac-arm64.dmg', '    sha512: ARMSHA512==', '    size: 222',
    'path: IRIS-0.5.84-mac-x64.dmg', 'sha512: X64SHA512==', "releaseDate: '2026-10-10T12:00:00.000Z'", '',
  ].join('\n'));
  assert.doesNotMatch(text, /blockMap/i);
});

// assemble

async function assembleFixture(mutate) {
  const root = await temp();
  const staged = path.join(root, 'staged');
  const signed = path.join(root, 'signed');
  await mkdir(staged);
  await mkdir(signed);
  const others = {
    [`IRIS-${VERSION}-win-x64.exe`]: 'win', [`IRIS-${VERSION}-linux-x86_64.AppImage`]: 'lx', [`IRIS-${VERSION}-linux-arm64.AppImage`]: 'la',
    'latest.yml': `version: ${VERSION}\n`, 'latest-linux.yml': `version: ${VERSION}\n`, 'latest-linux-arm64.yml': `version: ${VERSION}\n`,
  };
  for (const [name, text] of Object.entries(others)) await writeFile(path.join(staged, name), text);
  const files = [];
  for (const arch of ['arm64', 'x64']) {
    const name = `IRIS-${VERSION}-mac-${arch}.dmg`;
    const bytes = Buffer.from(`signed-${arch}`);
    await writeFile(path.join(signed, name), bytes);
    files.push({ name, size: bytes.length, sha256: sha256(bytes), sha512: 'x', arch, request_id: ID[arch] });
  }
  await writeFile(path.join(signed, 'latest-mac.yml'), 'version: x\n');
  await writeFile(path.join(signed, 'signed-macos.json'), JSON.stringify({ version: VERSION, files }));
  if (mutate) await mutate({ staged, signed, files });
  return { env: { IRIS_STAGED_DIR: staged, INPUT_SIGNED_DIR: signed, INPUT_VERSION: VERSION }, staged, signed };
}

test('assemble copies the signed images into the exact nine-file set', async () => {
  const { env, staged } = await assembleFixture();
  await assemble({ env });
  assert.deepEqual((await readdir(staged)).sort(), [
    `IRIS-${VERSION}-linux-arm64.AppImage`, `IRIS-${VERSION}-linux-x86_64.AppImage`, `IRIS-${VERSION}-mac-arm64.dmg`, `IRIS-${VERSION}-mac-x64.dmg`,
    `IRIS-${VERSION}-win-x64.exe`, 'latest-linux-arm64.yml', 'latest-linux.yml', 'latest-mac.yml', 'latest.yml',
  ]);
  assert.equal(await readFile(path.join(staged, `IRIS-${VERSION}-mac-x64.dmg`), 'utf8'), 'signed-x64');
});

test('assemble rejects stray, missing and unsigned files and mismatched hashes or versions', async () => {
  const cases = {
    blockmap: ({ staged }) => writeFile(path.join(staged, `IRIS-${VERSION}-win-x64.exe.blockmap`), 'x'),
    'unsigned dmg': ({ staged }) => writeFile(path.join(staged, `IRIS-${VERSION}-mac-arm64.dmg`), 'unsigned'),
    'missing yml': async ({ staged }) => { const { rm } = await import('node:fs/promises'); await rm(path.join(staged, 'latest-linux-arm64.yml')); },
    'hash mismatch': ({ signed }) => writeFile(path.join(signed, `IRIS-${VERSION}-mac-x64.dmg`), 'tampered'),
    'yml version': ({ staged }) => writeFile(path.join(staged, 'latest.yml'), 'version: 0.5.83\n'),
    'extra signed file': ({ signed }) => writeFile(path.join(signed, 'extra.dmg'), 'x'),
    'manifest version': ({ signed, files }) => writeFile(path.join(signed, 'signed-macos.json'), JSON.stringify({ version: '9.9.9', files })),
    'manifest lists one image': ({ signed, files }) => writeFile(path.join(signed, 'signed-macos.json'), JSON.stringify({ version: VERSION, files: files.slice(0, 1) })),
  };
  for (const [label, mutate] of Object.entries(cases)) {
    const { env } = await assembleFixture(mutate);
    await assert.rejects(assemble({ env }), { code: 'STAGED_SET_INVALID' }, label);
  }
});

// preflight

const preflightEnv = { IRIS_RELEASE_UPLOAD_TOKEN: 'upload', IRIS_LICENSE_API_URL: 'https://iris.voidcarve.com', INPUT_VERSION: VERSION, INPUT_RELEASE_ID: 'A'.repeat(43) };

const SERVED = { release_id: 'A'.repeat(43), compatibility_tag: '3.1' };

// Scripts the side record and the served release separately; either may be a list of steps.
function metaFake(meta, current = [404]) {
  const calls = [];
  const scripts = { 'shell-release-meta': [...[meta].flat()], current: [...[current].flat()] };
  const fetchImpl = async (url, options) => {
    calls.push(url);
    assert.equal(options.headers.authorization, 'Bearer upload');
    const route = url.replace('https://iris.voidcarve.com/api/v1/internal/releases/', '');
    const responses = scripts[route];
    if (!responses) throw new Error(`unexpected ${url}`);
    const step = responses.length > 1 ? responses.shift() : responses[0];
    if (step instanceof Error) throw step;
    return typeof step === 'number' ? new Response(null, { status: step }) : json(200, step);
  };
  return { fetchImpl, calls };
}

const recorded = (extra = {}) => ({ version: VERSION, release_id: 'A'.repeat(43), ...extra });

test('preflight reports not published, already served and superseded', async () => {
  const sleep = async () => {};
  assert.deepEqual(await preflight({ env: preflightEnv, fetchImpl: metaFake([404]).fetchImpl, sleep }), { already: false });
  assert.deepEqual(await preflight({ env: preflightEnv, fetchImpl: metaFake(recorded(), SERVED).fetchImpl, sleep }), { already: true });
  assert.deepEqual(await preflight({ env: preflightEnv, fetchImpl: metaFake([{ version: '0.5.83', release_id: 'B'.repeat(43) }]).fetchImpl, sleep }), { already: false });
  for (const version of [VERSION, '0.5.85', '0.6.0']) {
    await assert.rejects(preflight({ env: preflightEnv, fetchImpl: metaFake([{ version, release_id: 'B'.repeat(43) }]).fetchImpl, sleep }), { code: 'RELEASE_SUPERSEDED' }, version);
  }
});

test('a side record of this release that the service does not serve is retried, not skipped', async () => {
  const sleep = async () => {};
  const notServed = {
    'another release is served': { release_id: 'B'.repeat(43), compatibility_tag: '3.1' },
    'the release is mid-publish': { release_id: 'A'.repeat(43), compatibility_tag: 'publishing:5f0c' },
    'nothing is served yet': 404,
  };
  for (const [label, current] of Object.entries(notServed)) {
    assert.deepEqual(await preflight({ env: preflightEnv, fetchImpl: metaFake(recorded(), current).fetchImpl, sleep }), { already: false }, label);
  }
  const failing = metaFake(recorded(), 503);
  await assert.rejects(preflight({ env: preflightEnv, fetchImpl: failing.fetchImpl, sleep }), { code: 'RELEASE_META_UNAVAILABLE' });
  assert.equal(failing.calls.filter((url) => url.endsWith('/current')).length, 3);
});

test('preflight does not ask for the served release when the side record is absent or another release', async () => {
  const sleep = async () => {};
  for (const meta of [[404], [{ version: '0.5.83', release_id: 'B'.repeat(43) }]]) {
    const fake = metaFake(meta, SERVED);
    await preflight({ env: preflightEnv, fetchImpl: fake.fetchImpl, sleep });
    assert.equal(fake.calls.length, 1);
  }
});

test('preflight retries server errors three times and then fails', async () => {
  const sleeps = [];
  const failing = metaFake([503]);
  await assert.rejects(preflight({ env: preflightEnv, fetchImpl: failing.fetchImpl, sleep: async (ms) => sleeps.push(ms) }), { code: 'RELEASE_META_UNAVAILABLE' });
  assert.equal(failing.calls.length, 3);
  const recovering = metaFake([502, new TypeError('x'), 404]);
  assert.deepEqual(await preflight({ env: preflightEnv, fetchImpl: recovering.fetchImpl, sleep: async () => {} }), { already: false });
});

test('preflight writes the already output', async () => {
  const dir = await temp();
  const output = path.join(dir, 'out');
  await writeFile(output, '');
  const code = await main(['preflight'], { env: { ...preflightEnv, GITHUB_OUTPUT: output }, fetchImpl: metaFake([404]).fetchImpl, sleep: async () => {}, stderr: { write() {} } });
  assert.equal(code, 0);
  assert.equal(await readFile(output, 'utf8'), 'already=false\n');
});

// cleanup-artifacts

const cleanupEnv = { GITHUB_TOKEN: 't', GITHUB_REPOSITORY: 'o/r', GITHUB_RUN_ID: '901', INPUT_BUILD_RUN_ID: BUILD_RUN };

test('cleanup deletes the context artifact last and across pages', async () => {
  const build = [{ id: 1, name: 'shell-release-context' }, ...Array.from({ length: 120 }, (_, i) => ({ id: 100 + i, name: 'installers-x' }))];
  const github = githubFake({ runArtifacts: { 900: build, 901: [{ id: 2, name: 'signed-macos' }] } });
  await cleanupArtifacts({ env: cleanupEnv, fetchImpl: github.fetchImpl, sleep: async () => {}, log() {} });
  assert.equal(github.deletes.at(-1), '1');
  assert.equal(github.deletes.length, 122);
  assert.ok(github.deletes.includes('2'));
});

test('cleanup also removes signed images left by finished publish runs but not by running ones', async () => {
  const signed = (id, runId) => ({ id, name: 'signed-macos', workflow_run: { id: runId } });
  const github = githubFake({
    artifacts: [signed(10, 700), signed(11, 701), signed(12, 702), signed(13, 901)],
    runs: { 700: { id: 700, status: 'completed' }, 701: { id: 701, status: 'in_progress' } },
    runArtifacts: { 900: [{ id: 1, name: 'shell-release-context' }], 901: [] },
  });
  await cleanupArtifacts({ env: cleanupEnv, fetchImpl: github.fetchImpl, sleep: async () => {}, log() {} });
  assert.deepEqual(github.deletes, ['10', '12', '1']);
});

test('a failing signed image listing still deletes the context artifact', async () => {
  const lines = [];
  const base = githubFake({ runArtifacts: { 900: [{ id: 1, name: 'shell-release-context' }], 901: [] } });
  const fetchImpl = async (url, options) => (new URL(url).pathname === '/repos/o/r/actions/artifacts' ? new Response(null, { status: 403 }) : base.fetchImpl(url, options));
  await cleanupArtifacts({ env: cleanupEnv, fetchImpl, sleep: async () => {}, log: (line) => lines.push(line) });
  assert.deepEqual(base.deletes, ['1']);
  assert.deepEqual(lines, ['ARTIFACT_DELETE_FAILED 1']);
});

test('a failure to delete the context artifact fails the command, other failures do not', async () => {
  const sleeps = [];
  const stuck = githubFake({ runArtifacts: { 900: [{ id: 1, name: 'shell-release-context' }], 901: [] }, deleteStatus: { 1: 500 } });
  await assert.rejects(cleanupArtifacts({ env: cleanupEnv, fetchImpl: stuck.fetchImpl, sleep: async (ms) => sleeps.push(ms), log() {} }), { code: 'CONTEXT_DELETE_FAILED' });
  const lines = [];
  const loose = githubFake({ runArtifacts: { 900: [{ id: 1, name: 'shell-release-context' }, { id: 3, name: 'core-payload' }], 901: [] }, deleteStatus: { 3: 403 } });
  await cleanupArtifacts({ env: cleanupEnv, fetchImpl: loose.fetchImpl, sleep: async () => {}, log: (line) => lines.push(line) });
  assert.equal(loose.deletes.at(-1), '1');
  assert.deepEqual(lines, ['ARTIFACT_DELETE_FAILED 1']);
});

test('main prints only the error code', async () => {
  const lines = [];
  const code = await main(['bogus'], { env: {}, stderr: { write: (text) => lines.push(text) } });
  assert.equal(code, 1);
  assert.deepEqual(lines, ['INVALID_COMMAND\n']);
});
