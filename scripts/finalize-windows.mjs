import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { appendFile, lstat, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

class FinalizeError extends Error { constructor(code) { super(code); this.code = code; } }

const VERSION = /^\d+\.\d+\.\d+$/;

async function fileHash(file, algorithm) {
  const digest = createHash(algorithm);
  let size = 0;
  for await (const chunk of createReadStream(file)) { digest.update(chunk); size += chunk.length; }
  const bytes = digest.digest();
  return { size, hex: bytes.toString('hex'), base64: bytes.toString('base64') };
}

export async function finalizeWindows({ env = process.env, now = Date.now } = {}) {
  const dir = env.INPUT_SIGNED_WINDOWS_DIR;
  const version = env.INPUT_VERSION;
  const blockmapModule = env.INPUT_BLOCKMAP_MODULE;
  if (!dir || !path.isAbsolute(dir) || !VERSION.test(version ?? '') || !blockmapModule || !path.isAbsolute(blockmapModule)) throw new FinalizeError('INVALID_INPUT');
  const installerName = `IRIS-${version}-win-x64.exe`;
  const portableName = `IRIS-${version}-win-x64-portable.exe`;
  const installer = path.join(dir, installerName);
  const portable = path.join(dir, portableName);
  const blockmap = `${installer}.blockmap`;
  const manifestPath = path.join(dir, 'windows-signed.json');
  const reportPath = path.join(dir, 'verification.json');
  const [installerInfo, portableInfo, reportInfo] = await Promise.all([installer, portable, reportPath].map((file) => lstat(file).catch(() => null)));
  if (![installerInfo, portableInfo, reportInfo].every((item) => item?.isFile())) throw new FinalizeError('SIGNED_SET_INVALID');
  let manifest;
  let report;
  try {
    manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    report = JSON.parse(await readFile(reportPath, 'utf8'));
  } catch { throw new FinalizeError('SIGNED_SET_INVALID'); }
  if (manifest.version !== version || report.request_id !== manifest.request_id || report.input_digest !== manifest.input_digest
    || report.nested_signatures_verified !== true || report.stage !== 'windows_sign') throw new FinalizeError('SIGNED_SET_INVALID');
  const { buildBlockMap } = createRequire(import.meta.url)(blockmapModule);
  if (typeof buildBlockMap !== 'function') throw new FinalizeError('BLOCKMAP_UNAVAILABLE');
  await buildBlockMap(installer,'gzip',blockmap);
  const mapInfo = await stat(blockmap).catch(() => null);
  if (!mapInfo?.isFile() || mapInfo.size < 1) throw new FinalizeError('BLOCKMAP_FAILED');
  const files = [];
  for (const name of [installerName, portableName]) {
    const value = await fileHash(path.join(dir, name), 'sha256');
    const sha512 = await fileHash(path.join(dir, name), 'sha512');
    files.push({ name, size: value.size, sha256: value.hex, sha512: sha512.base64 });
  }
  const x64 = files.find((file) => file.name === installerName);
  const yml = [
    `version: ${version}`,
    'files:',
    `  - url: ${installerName}`,
    `    sha512: ${x64.sha512}`,
    `    size: ${x64.size}`,
    `path: ${installerName}`,
    `sha512: ${x64.sha512}`,
    `releaseDate: '${new Date(now()).toISOString()}'`,
    '',
  ].join('\n');
  await writeFile(path.join(dir, 'latest.yml'), yml, { flag: 'wx', mode: 0o600 });
  manifest.files = files;
  manifest.blockmap = { name: path.basename(blockmap), size: mapInfo.size };
  await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`, { flag: 'w', mode: 0o600 });
  const names = (await readdir(dir)).sort();
  const expected = [installerName, `${installerName}.blockmap`, portableName, 'latest.yml', 'verification.json', 'windows-signed.json'].sort();
  if (names.join('\n') !== expected.join('\n')) throw new FinalizeError('SIGNED_SET_INVALID');
  const output = env.GITHUB_OUTPUT;
  if (!output) throw new FinalizeError('OUTPUT_UNAVAILABLE');
  await appendFile(output, `verified_dir=${dir}\n`, { mode: 0o600 });
  return dir;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await finalizeWindows(); }
  catch (error) { process.stderr.write(`${error instanceof FinalizeError ? error.code : 'FINALIZE_FAILED'}\n`); process.exitCode = 1; }
}
