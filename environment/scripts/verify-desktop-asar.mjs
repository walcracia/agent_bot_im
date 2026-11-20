/** Check the actual desktop archive against its source and explicit allowlist. No app/model is started. */
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listPackage, extractFile } from '../../workspace/node_modules/@electron/asar/lib/asar.js';

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const source = JSON.parse(await readFile(join(root, 'workspace/package.json'), 'utf8'));
assert.match(source.version, /^\d+\.\d+\.\d+(?:-[\w.-]+)?$/);
const archive = join(root, `outputs/desktop-v${source.version}/TeamRelay-win32-x64/resources/app.asar`);
const files = ['client/app.js', 'client/index.html', 'client/logo.svg', 'client/styles.css', 'client/tokens.css',
  'desktop/main.cjs', 'desktop/shell.cjs', 'desktop/preload.cjs',
  'desktop/assets/app.ico', 'desktop/assets/app.png', 'desktop/assets/tray.png', 'desktop/assets/tray-unread.png'];
const expected = ['/client', '/desktop', '/desktop/assets', '/package.json', ...files.map(name => '/' + name)].sort();
assert.deepEqual(listPackage(archive).map(name => name.replaceAll('\\', '/')).sort(), expected);
for (const name of files) assert.deepEqual(extractFile(archive, join(...name.split('/'))), await readFile(join(root, 'workspace', name)), name);
const manifest = JSON.parse(extractFile(archive, 'package.json'));
assert.equal(manifest.version, source.version); assert.equal(manifest.name, source.name);
assert.match(manifest.description, /同频TeamPlay/);
assert.match(extractFile(archive, 'desktop/main.cjs').toString(), /app.setName\('同频'\)/);
const report = { status: 'passed', version: source.version, entries: expected, sourceFiles: files };
const output = join(root, 'environment/verification', `desktop-artifacts-v${source.version}`);
await mkdir(output, { recursive: true }); await writeFile(join(output, 'asar-report.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ status: report.status, entries: expected.length, sourceFiles: files.length }));
