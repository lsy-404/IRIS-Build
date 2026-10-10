import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { submitSource } from '../scripts/import-macos.mjs';

const PART = 5 * 1024 * 1024;
const ID = '3f2b8c1e-0a4d-4e8b-9c55-1d2e3f4a5b6c';
const SHA = 'f6d90bce8063a8c84d715f0950faa5a0fb805538';

async function fixture(size) {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'import-test-'));
  const workDir = path.join(temp, 'iris-macos-import-77-abc');
  await mkdir(workDir);
  await writeFile(path.join(workDir, '.macos-import-run'), '77\niris-arm64\n');
  const bytes = randomBytes(size);
  await writeFile(path.join(workDir, 'source.zip'), bytes);
  const env = {
    RUNNER_TEMP: temp, INPUT_PRODUCT: 'iris-arm64', GITHUB_RUN_ID: '77', GITHUB_RUN_ATTEMPT: '1',
    INPUT_VERSION: '0.5.80', INPUT_SOURCE_SHA: SHA, INPUT_WORK_DIR: workDir, SIGNING_API_KEY: 'test-key',
  };
  return { env, bytes };
}

function json(status, value) {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}

async function drain(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

function center({ size, createState = 'awaiting_upload', received = [], failParts = [], completeState = 'accepted_waiting_source', requestId = ID }) {
  const log = { create: null, createHeaders: null, parts: [], begins: 0, completes: 0, urls: [], options: [] };
  const have = new Set(received);
  const failures = new Map(failParts.map(([part, status]) => [part, status]));
  const count = Math.ceil(size / PART);
  const fetchImpl = async (url, options) => {
    log.urls.push(url);
    log.options.push(options);
    const headers = options.headers;
    if (url === 'https://sign.voidcarve.com/v1/requests') {
      log.create = JSON.parse(options.body);
      log.createHeaders = headers;
      return json(202, { request_id: requestId, state: createState });
    }
    if (url === `https://sign.voidcarve.com/v1/requests/${requestId}/source`) {
      log.begins += 1;
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
      return json(200, { request_id: requestId, state: completeState });
    }
    throw new Error(`unexpected ${url}`);
  };
  return { fetchImpl, log };
}

const noSleep = async () => {};

test('registers the exact bundle digest and size with no artifact id', async () => {
  const { env, bytes } = await fixture(2 * PART + 7);
  const { fetchImpl, log } = center({ size: bytes.length });
  await submitSource({ fetchImpl, env, sleep: noSleep });
  assert.equal(log.create.input_digest, `sha256:${createHash('sha256').update(bytes).digest('hex')}`);
  assert.equal(log.create.input_size, bytes.length);
  assert.equal('artifact_id' in log.create, false);
  assert.equal(log.create.run_attempt, 1);
  assert.equal(log.createHeaders['idempotency-key'], 'import-iris-arm64-77-1');
});

test('uploads exact slices that reassemble to the bundle and then completes', async () => {
  const { env, bytes } = await fixture(2 * PART + 7);
  const { fetchImpl, log } = center({ size: bytes.length });
  await submitSource({ fetchImpl, env, sleep: noSleep });
  assert.deepEqual(log.parts.map((p) => p.body.length), [PART, PART, 7]);
  assert.ok(Buffer.concat(log.parts.map((p) => p.body)).equals(bytes));
  assert.equal(log.completes, 1);
  for (const o of log.options) assert.equal(o.redirect, 'error');
});

test('resume skips parts the center already holds', async () => {
  const { env, bytes } = await fixture(2 * PART + 7);
  const { fetchImpl, log } = center({ size: bytes.length, received: [1, 2] });
  await submitSource({ fetchImpl, env, sleep: noSleep });
  assert.deepEqual(log.parts.map((p) => p.n), [3]);
});

test('retries a transient part failure after re-querying the plan', async () => {
  const { env, bytes } = await fixture(PART + 3);
  const { fetchImpl, log } = center({ size: bytes.length, failParts: [[1, 503]] });
  await submitSource({ fetchImpl, env, sleep: noSleep });
  assert.equal(log.begins, 2);
  assert.deepEqual(log.parts.map((p) => p.n), [1, 2]);
});

test('a non-transient part failure aborts without completing', async () => {
  const { env, bytes } = await fixture(PART + 3);
  const { fetchImpl, log } = center({ size: bytes.length, failParts: [[1, 403]] });
  await assert.rejects(submitSource({ fetchImpl, env, sleep: noSleep }), { code: 'SOURCE_UPLOAD_FAILED' });
  assert.equal(log.completes, 0);
});

test('rejects a request id that is not a UUID', async () => {
  const { env, bytes } = await fixture(PART + 3);
  const { fetchImpl, log } = center({ size: bytes.length, requestId: '../../v1/admin' });
  await assert.rejects(submitSource({ fetchImpl, env, sleep: noSleep }), { code: 'SIGNING_REQUEST_FAILED' });
  assert.equal(log.begins, 0);
  assert.deepEqual(log.urls, ['https://sign.voidcarve.com/v1/requests']);
});

test('complete must report accepted_waiting_source', async () => {
  const { env, bytes } = await fixture(PART + 3);
  const { fetchImpl } = center({ size: bytes.length, completeState: 'failed' });
  await assert.rejects(submitSource({ fetchImpl, env, sleep: noSleep }), { code: 'SIGNING_REQUEST_FAILED' });
});

test('an idempotent replay in accepted_waiting_source uploads nothing', async () => {
  const { env, bytes } = await fixture(PART + 3);
  const { fetchImpl, log } = center({ size: bytes.length, createState: 'accepted_waiting_source' });
  await submitSource({ fetchImpl, env, sleep: noSleep });
  assert.equal(log.begins, 0);
  assert.equal(log.parts.length, 0);
});

test('any other initial state fails', async () => {
  const { env, bytes } = await fixture(PART + 3);
  const { fetchImpl } = center({ size: bytes.length, createState: 'queued' });
  await assert.rejects(submitSource({ fetchImpl, env, sleep: noSleep }), { code: 'SIGNING_REQUEST_FAILED' });
});

test('the workflow publishes no Actions artifact', async () => {
  const text = await readFile(new URL('../.github/workflows/import-macos.yml', import.meta.url), 'utf8');
  assert.doesNotMatch(text, /upload-artifact|INPUT_ARTIFACT_ID|artifact-id/);
});
