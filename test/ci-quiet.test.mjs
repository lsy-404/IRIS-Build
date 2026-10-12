import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const helper = fileURLToPath(new URL('../scripts/ci-quiet.mjs', import.meta.url));

function runQuiet(source, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [helper, '--', process.execPath, '-e', source], {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (code) => resolve({ code, stdout, stderr }));
  });
}

test('successful commands expose only the success code', async () => {
  const result = await runQuiet("console.log('private success output'); console.log('::add-mask::private value')");

  assert.deepEqual(result, { code: 0, stdout: 'CI_STEP_OK\n', stderr: '' });
});

for (const reportStatus of [201, 403]) test(`failed output stays private when reporting returns ${reportStatus}`, async (t) => {
  let report;
  const server = createServer((request, response) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      report = { authorization: request.headers.authorization, body: JSON.parse(body) };
      response.writeHead(reportStatus).end();
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());

  const address = server.address();
  const result = await runQuiet(
    "console.log(process.env.WORKFLOW_REPORT_TOKEN); console.log(process.env.SOME_API_KEY); console.error('::error::private stderr'); process.exit(17)",
    {
      WORKFLOW_REPORT_API: `http://127.0.0.1:${address.port}/report`,
      WORKFLOW_REPORT_TOKEN: 'private-token',
      SOME_API_KEY: 'secret-value',
      GITHUB_RUN_ID: '12345',
    },
  );

  assert.equal(result.code, 17);
  assert.equal(result.stdout, 'CI_STEP_FAILED_17\n');
  assert.equal(result.stderr, reportStatus === 201 ? '' : 'CI_REPORT_FAILED_403\n');
  assert.equal(report.authorization, 'Bearer private-token');
  assert.equal(report.body.run_id, '12345');
  assert.equal(report.body.status, 'failed');
  assert.equal(report.body.exit_code, 17);
  assert.match(report.body.summary, /\[REDACTED\]/);
  assert.match(report.body.summary, /::error::private stderr/);
  assert.doesNotMatch(report.body.summary, /private-token|secret-value/);
  assert.doesNotMatch(result.stdout + result.stderr, /private-token|secret-value|private stderr|::/);
});
