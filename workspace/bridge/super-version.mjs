import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { lstat, readFile, realpath, unlink, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { replaceOwnedFile } from './file-replace.mjs';

const execute = promisify(execFile);
const DEFAULT_JSON = ['workspace/package.json', 'workspace/package-lock.json', 'workspace/bridge/package.json', 'workspace/bridge/package-lock.json'];
const DEFAULT_PYTHON = ['workspace/server/app.py'];

function version(value) {
  const match = typeof value === 'string' && value.length <= 200 && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(value);
  if (!match || match[4]?.split('.').some(item => /^\d+$/.test(item) && item.length > 1 && item[0] === '0')) throw new Error('Version must be strict major.minor.patch with an optional SemVer prerelease.');
  return { value, core: match.slice(1, 4).map(BigInt), prerelease: match[4]?.split('.') };
}
function compare(left, right) {
  for (let index = 0; index < 3; index++) if (left.core[index] !== right.core[index]) return left.core[index] > right.core[index] ? 1 : -1;
  if (!left.prerelease || !right.prerelease) return left.prerelease ? -1 : right.prerelease ? 1 : 0;
  for (let index = 0; index < Math.max(left.prerelease.length, right.prerelease.length); index++) {
    const a = left.prerelease[index], b = right.prerelease[index];
    if (a === undefined || b === undefined) return a === undefined ? -1 : 1;
    if (a === b) continue;
    const numericA = /^\d+$/.test(a), numericB = /^\d+$/.test(b);
    if (numericA && numericB) return BigInt(a) > BigInt(b) ? 1 : -1;
    if (numericA !== numericB) return numericA ? -1 : 1;
    return a > b ? 1 : -1;
  }
  return 0;
}
function relativePath(value) {
  if (typeof value !== 'string' || !value || isAbsolute(value) || /[\0\r\n:]/.test(value)) throw new Error('Version paths must be trusted relative file paths.');
  const parts = value.replaceAll('\\', '/').split('/');
  if (parts.some(part => !part || part === '.' || part === '..' || part.toLowerCase() === '.git')) throw new Error('Invalid version file path.');
  return parts.join('/');
}
async function safeFile(cwd, name) {
  const path = resolve(cwd, name), remainder = relative(cwd, path);
  if (!remainder || isAbsolute(remainder) || remainder === '..' || remainder.startsWith('..' + sep)) throw new Error('Version file escaped the project.');
  let current = cwd;
  for (const part of name.split('/')) {
    current = join(current, part);
    if ((await lstat(current)).isSymbolicLink()) throw new Error('Version files cannot use symbolic links.');
  }
  const canonical = await realpath(path), canonicalRemainder = relative(cwd, canonical), info = await lstat(path);
  if (!canonicalRemainder || isAbsolute(canonicalRemainder) || canonicalRemainder === '..' || canonicalRemainder.startsWith('..' + sep)
    || !info.isFile() || info.nlink > 1) throw new Error('Version file is outside the project or is not an independent regular file.');
  return { path, mode: info.mode };
}
const whitespace = (source, index) => { while (/\s/.test(source[index] ?? '') && index < source.length) index++; return index; };
function stringEnd(source, start) {
  let index = start + 1;
  while (index < source.length) { if (source[index] === '\\') index += 2; else if (source[index++] === '"') return index; }
  throw new Error('Invalid JSON string.');
}
function valueEnd(source, start) {
  if (source[start] === '"') return stringEnd(source, start);
  if (source[start] === '{' || source[start] === '[') {
    let depth = 0, index = start;
    while (index < source.length) {
      const char = source[index];
      if (char === '"') { index = stringEnd(source, index); continue; }
      if (char === '{' || char === '[') depth++;
      if ((char === '}' || char === ']') && --depth === 0) return index + 1;
      index++;
    }
    throw new Error('Invalid JSON object.');
  }
  let end = start;
  while (end < source.length && !/[\s,}\]]/.test(source[end])) end++;
  return end;
}
/** Locate only selected JSON object members; JSON.parse already validates the document. */
function members(source, start = 0) {
  let index = whitespace(source, start);
  if (source[index++] !== '{') throw new Error('Version JSON must contain an object.');
  const result = new Map();
  while (true) {
    index = whitespace(source, index);
    if (source[index] === '}') return result;
    if (source[index] !== '"') throw new Error('Invalid JSON member.');
    const end = stringEnd(source, index), key = JSON.parse(source.slice(index, end));
    if (result.has(key)) throw new Error('Duplicate JSON member in version object.');
    index = whitespace(source, end);
    if (source[index++] !== ':') throw new Error('Invalid JSON member separator.');
    const valueStart = whitespace(source, index), endValue = valueEnd(source, valueStart);
    result.set(key, { start: valueStart, end: endValue });
    index = whitespace(source, endValue);
    if (source[index] === ',') { index++; continue; }
    if (source[index] !== '}') throw new Error('Invalid JSON object terminator.');
    return result;
  }
}
function jsonEdits(source, next) {
  let data;
  try { data = JSON.parse(source.replace(/^\uFEFF/, '')); } catch { throw new Error('Version JSON is invalid.'); }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Version JSON must be an object.');
  version(data.version);
  const top = members(source), target = top.get('version');
  if (!target) throw new Error('Version JSON is missing its top-level version.');
  const edits = [{ ...target, text: JSON.stringify(next) }];
  if (Object.hasOwn(data, 'packages')) {
    if (!data.packages || typeof data.packages !== 'object' || Array.isArray(data.packages) || !Object.hasOwn(data.packages, '')
      || !data.packages[''] || typeof data.packages[''] !== 'object' || Array.isArray(data.packages[''])) throw new Error('Version lockfile is missing packages[""].version.');
    version(data.packages[''].version);
    const rootPackage = members(source, top.get('packages').start).get('');
    const nested = members(source, rootPackage.start).get('version');
    if (!nested) throw new Error('Version lockfile is missing its root version.');
    edits.push({ ...nested, text: JSON.stringify(next) });
  }
  return { data, edits };
}
function pythonEdits(source, next) {
  const assignments = [...source.matchAll(/^VERSION[ \t]*=[^\r\n]*$/gm)];
  if (assignments.length !== 1) throw new Error('Python version file must have exactly one top-level VERSION assignment.');
  const line = assignments[0], parsed = /^(VERSION[ \t]*=[ \t]*)(['"])([^'"\r\n]+)\2([ \t]*(?:#[^\r\n]*)?)$/.exec(line[0]);
  if (!parsed) throw new Error('Python VERSION must be a plain quoted version literal.');
  version(parsed[3]);
  const start = line.index + parsed[1].length + 1;
  return [{ start, end: start + parsed[3].length, text: next }];
}
function edit(source, edits) {
  for (const replacement of edits.sort((a, b) => b.start - a.start)) source = source.slice(0, replacement.start) + replacement.text + source.slice(replacement.end);
  return source;
}

/** Pure local version stamping; its caller owns verified-base sync, tests, commit and publication. */
export async function stampVersion({ cwd, baseRef, versionFile = 'workspace/package.json', jsonVersionFiles = DEFAULT_JSON, pythonVersionFiles = DEFAULT_PYTHON }) {
  cwd = await realpath(cwd);
  if (typeof baseRef !== 'string' || !baseRef || /[\0\r\n]/.test(baseRef)) throw new Error('A trusted Git base reference is required.');
  if (!Array.isArray(jsonVersionFiles) || !jsonVersionFiles.length || !Array.isArray(pythonVersionFiles)) throw new Error('Version paths must be configured arrays.');
  const main = relativePath(versionFile), records = [], seen = new Set();
  for (const [kind, names] of [['json', jsonVersionFiles], ['python', pythonVersionFiles]]) for (const value of names) {
    const name = relativePath(value), checked = await safeFile(cwd, name), key = process.platform === 'win32' ? checked.path.toLowerCase() : checked.path;
    if (seen.has(key)) throw new Error('Version file was configured more than once.');
    seen.add(key); records.push({ kind, name, ...checked, source: await readFile(checked.path, 'utf8') });
  }
  const manifest = records.find(record => record.kind === 'json' && record.name === main);
  if (!manifest) throw new Error('Main version file must be in jsonVersionFiles.');
  const git = async args => (await execute('git', ['--no-replace-objects', '-C', cwd, ...args], { shell: false, windowsHide: true, timeout: 30000, maxBuffer: 4 * 1024 * 1024 })).stdout.trim();
  let base;
  try {
    const sha = await git(['rev-parse', '--verify', '--end-of-options', baseRef + '^{commit}']);
    if (!/^[a-f0-9]{40,64}$/.test(sha)) throw new Error('Invalid commit.');
    base = version(JSON.parse(await git(['show', sha + ':' + main])).version);
  } catch { throw new Error('Cannot read a strict version from the trusted Git base object.'); }
  const current = version(jsonEdits(manifest.source, '0.0.0').data.version);
  const next = compare(current, base) > 0 ? current.value : [base.core[0], base.core[1], base.core[2] + (base.prerelease ? 0n : 1n)].join('.');
  for (const record of records) record.next = edit(record.source, record.kind === 'json' ? jsonEdits(record.source, next).edits : pythonEdits(record.source, next));
  const changed = records.filter(record => record.next !== record.source), staged = [];
  const verify = async record => {
    const current = await safeFile(cwd, record.name);
    if (current.path !== record.path || await readFile(record.path, 'utf8') !== record.source) throw new Error('Version file changed concurrently; inspect before retrying.');
  };
  try {
    for (const record of changed) {
      await verify(record);
      record.temporary = record.path + '.version-' + randomUUID() + '.tmp'; staged.push(record);
      await writeFile(record.temporary, record.next, { flag: 'wx', mode: record.mode, flush: true });
    }
    for (const record of staged) await replaceOwnedFile(record.temporary, record.path, () => verify(record));
  } finally { for (const record of staged) await unlink(record.temporary).catch(cause => { if (cause.code !== 'ENOENT') throw cause; }); }
  return { version: next, files: changed.map(record => record.name) };
}
