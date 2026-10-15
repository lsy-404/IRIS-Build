import { createRequire } from 'node:module';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

const workspace=process.env.GITHUB_WORKSPACE;
const temp=process.env.RUNNER_TEMP;
if (!workspace||!path.isAbsolute(workspace)||!temp||!path.isAbsolute(temp)) throw new Error('BUILD_PATH_UNAVAILABLE');
const source=createRequire(path.join(workspace,'package.json'));
const builder=createRequire(source.resolve('electron-builder/package.json'));
const entry=builder.resolve('app-builder-lib/out/targets/blockmap/blockmap.js');
const output=path.join(temp,'blockmap-tool');
await mkdir(output,{recursive:true,mode:0o700});
const { build }=source('esbuild');
await build({entryPoints:[entry],outfile:path.join(output,'blockmap.cjs'),bundle:true,platform:'node',format:'cjs',target:'node24',logLevel:'warning'});
