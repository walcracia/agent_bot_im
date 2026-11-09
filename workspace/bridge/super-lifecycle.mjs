import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { lstat, mkdir, open, readFile, readlink, unlink, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const execute = promisify(execFile);

async function watchdogProcess(owner) {
  if (process.platform === 'win32') {
    // The only interpolated value is a validated integer PID. Never interpolate
    // recorded arguments or a command line into PowerShell source.
    const script = String.raw`
$ErrorActionPreference='Stop'
$p=Get-CimInstance Win32_Process -Filter 'ProcessId=${owner.pid}'
if (!$p) { [Console]::Write('null'); exit 0 }
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class RelayWatchdogArgv {
  [DllImport("shell32.dll", SetLastError=true, CharSet=CharSet.Unicode)]
  public static extern IntPtr CommandLineToArgvW(string commandLine, out int count);
  [DllImport("kernel32.dll")] public static extern IntPtr LocalFree(IntPtr memory);
}
'@
$count=0
$memory=[RelayWatchdogArgv]::CommandLineToArgvW([string]$p.CommandLine,[ref]$count)
if ($memory -eq [IntPtr]::Zero) { throw 'Cannot read process arguments' }
try {
  $arguments=@(for($i=0;$i -lt $count;$i++) {
    [Runtime.InteropServices.Marshal]::PtrToStringUni([Runtime.InteropServices.Marshal]::ReadIntPtr($memory,$i*[IntPtr]::Size))
  })
} finally { [void][RelayWatchdogArgv]::LocalFree($memory) }
@{pid=[int]$p.ProcessId;executablePath=[string]$p.ExecutablePath;argv=$arguments;createdAt=$p.CreationDate.ToUniversalTime().ToString('o')} | ConvertTo-Json -Depth 4 -Compress
`;
    const { stdout } = await execute('pwsh', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
      { windowsHide: true, shell: false, timeout: 10000, maxBuffer: 65536 });
    return JSON.parse(stdout.trim());
  }
  if (process.platform === 'linux') {
    try {
      const argv = (await readFile(`/proc/${owner.pid}/cmdline`, 'utf8')).split('\0').filter(Boolean);
      const executablePath = await readlink(`/proc/${owner.pid}/exe`);
      return { pid: owner.pid, executablePath, argv };
    } catch (error) { if (error.code === 'ENOENT' || error.code === 'ESRCH') return null; throw error; }
  }
  throw new Error('Watchdog process identity is unsupported on this platform.');
}

export async function controlSecret(path, supplied) {
  if (supplied) {
    if (supplied.length < 32 || /\s/u.test(supplied)) throw new Error('Invalid controller credential.');
    return supplied;
  }
  await mkdir(dirname(path), { recursive: true });
  try {
    const file = await open(path, 'wx', 0o600);
    try { const value = randomBytes(32).toString('hex'); await file.writeFile(value); await file.sync(); return value; }
    finally { await file.close(); }
  } catch (error) { if (error.code !== 'EEXIST') throw error; }
  const value = (await readFile(path, 'utf8')).trim();
  if (!/^[a-f0-9]{64}$/u.test(value)) throw new Error('Invalid saved controller credential; preserve it.');
  return value;
}

export async function recoverManagedRuntime(runtime) {
  let handle;
  try { handle = await open(runtime.path, 'r'); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  try {
  const raw = await handle.readFile('utf8'), owner = JSON.parse(raw);
  if (owner.instanceId !== runtime.record.instanceId || owner.configPath !== runtime.record.configPath
    || owner.executablePath !== process.execPath || JSON.stringify(owner.args) !== JSON.stringify(process.argv.slice(1))
    || owner.cwd !== process.cwd() || !Number.isSafeInteger(owner.pid) || owner.pid < 1) throw new Error('Managed restart registration mismatch; preserve the previous runtime.');
  if (['stopping', 'stopped'].includes(owner.status)) throw new Error('Controller was intentionally stopped; no automatic restart.');
  try { process.kill(owner.pid, 0); throw new Error('Previous managed controller still exists.'); }
  catch (error) { if (error.code !== 'ESRCH') throw error; }
  // Any explicit stop request wins over automatic recovery, even after a crash.
  try { const stop = JSON.parse(await readFile(runtime.stopPath, 'utf8')); if (stop.instanceId === owner.instanceId) throw new Error('Controller has an explicit stop request.'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
    const original = await handle.stat({ bigint: true });
    await writeFile(`${runtime.path}.crashed-${owner.pid}-${randomUUID()}`, raw, { flag: 'wx', mode: 0o600 });
    const current = await lstat(runtime.path, { bigint: true });
    if (original.dev !== current.dev || original.ino !== current.ino) throw new Error('Managed runtime changed during recovery.');
    await unlink(runtime.path);
    return true;
  } finally { await handle.close(); }
}

export async function reusableWatchdog(path, { token, controllerUrl, statePath, now = Date.now() }) {
  let owner;
  try { owner = JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (!Number.isSafeInteger(owner.pid) || owner.pid < 1 || owner.pid > 0xffffffff || !owner.nonce) throw new Error('Invalid Watchdog ownership record.');
  try { process.kill(owner.pid, 0); }
  catch (error) { if (error.code === 'ESRCH') return null; throw error; }
  if (owner.status === 'stopped') return null;
  if (owner.controllerUrl !== controllerUrl || owner.statePath !== statePath || owner.tokenHash !== createHash('sha256').update(token).digest('hex')
    || owner.executablePath !== process.execPath || !Array.isArray(owner.args) || !owner.args[0]?.replaceAll('\\', '/').endsWith('/super-watchdog.mjs')
    || owner.args.some(value => typeof value !== 'string' || /[\r\n\0]/.test(value)) || !Number.isFinite(Date.parse(owner.startedAt))
    || !Number.isFinite(Date.parse(owner.heartbeat)) || Date.parse(owner.heartbeat) > now + 5000 || now - Date.parse(owner.heartbeat) > 90000) throw new Error('Existing Watchdog could not be verified; preserve it and its state.');
  let actual;
  try { actual = await watchdogProcess(owner); }
  catch { throw new Error('Existing Watchdog process identity could not be verified; preserve it and its state.'); }
  if (!actual) return null; // The process may have exited between the existence check and the identity query.
  const samePath = (a, b) => typeof a === 'string' && typeof b === 'string'
    && (process.platform === 'win32' ? resolve(a).toLowerCase() === resolve(b).toLowerCase() : resolve(a) === resolve(b));
  if (actual.pid !== owner.pid || !samePath(actual.executablePath, owner.executablePath) || !Array.isArray(actual.argv)
    || !samePath(actual.argv[0], owner.executablePath) || JSON.stringify(actual.argv.slice(1)) !== JSON.stringify(owner.args)
    || (process.platform === 'win32' && (!Number.isFinite(Date.parse(actual.createdAt))
      || Date.parse(actual.createdAt) > Date.parse(owner.startedAt) + 1000 || Date.parse(owner.startedAt) - Date.parse(actual.createdAt) > 15000)))
    throw new Error('Existing Watchdog process identity could not be verified; preserve it and its state.');
  return owner;
}

export async function stopWatchdog(path, child, timeoutMs = 15000) {
  let owner;
  try { owner = JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (owner?.status === 'stopped' && !child) return true;
  if (child?.connected) child.send({ type: 'stop-watchdog' });
  if (owner?.pid && owner.nonce) await writeFile(`${path}.stop`, JSON.stringify({ pid: owner.pid, nonce: owner.nonce }), { mode: 0o600 });
  const deadline = Date.now() + timeoutMs;
  do {
    if (child && child.exitCode !== null) return true;
    if (owner) {
      try { process.kill(owner.pid, 0); }
      catch (error) { if (error.code === 'ESRCH') return true; throw error; }
    }
    await delay(100);
  } while (Date.now() < deadline);
  return !owner && !child;
}
