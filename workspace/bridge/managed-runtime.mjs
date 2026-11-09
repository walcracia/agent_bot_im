import { randomUUID } from 'node:crypto';
import { link, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';

/** Local control channel: unique run identity, atomic status, graceful stop only. */
export class ManagedRuntime {
  constructor(path, instanceId, configPath) {
    if (!isAbsolute(path) || /[\r\n\0]/.test(path) || !/\.json$/i.test(path)) throw new Error('runtime-file must be an absolute JSON path.');
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(instanceId)) throw new Error('instance-id must be a UUID.');
    this.path = resolve(path);
    this.stopPath = `${this.path}.stop`;
    this.record = { version: 1, instanceId, pid: process.pid, configPath, status: 'starting', startedAt: new Date().toISOString() };
    this.writes = Promise.resolve();
  }

  async start(onStop) {
    this.onStop = onStop;
    await mkdir(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(this.record), { flag: 'wx', mode: 0o600, flush: true });
    try { await link(temporary, this.path); } // Publish complete JSON without overwriting an existing run.
    finally { await unlink(temporary); }
    this.timer = setInterval(() => { this.checkStop().catch(() => this.onStop()); }, 200);
    this.timer.unref();
  }

  publish(status, details = {}) {
    this.writes = this.writes.then(async () => {
      const current = JSON.parse(await readFile(this.path, 'utf8'));
      if (current.instanceId !== this.record.instanceId || current.pid !== process.pid) throw new Error('Managed runtime ownership changed.');
      this.record = { ...this.record, ...details, status, updatedAt: new Date().toISOString() };
      const temporary = `${this.path}.${randomUUID()}.tmp`;
      await writeFile(temporary, JSON.stringify(this.record), { flag: 'wx', mode: 0o600, flush: true });
      await rename(temporary, this.path);
    });
    return this.writes;
  }

  async checkStop() {
    if (this.finishing) return Boolean(this.stopAccepted);
    this.checking ??= this.readStop().finally(() => { this.checking = undefined; });
    return this.checking;
  }

  async readStop() {
    if (this.stopAccepted) return true;
    let request;
    try { request = JSON.parse(await readFile(this.stopPath, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT' || error instanceof SyntaxError) return false; throw error; }
    if (request?.instanceId !== this.record.instanceId) return false;
    this.stopAccepted = true;
    this.onStop();
    await this.publish('stopping');
    return true;
  }

  async finish(failed) {
    this.finishing = true;
    clearInterval(this.timer);
    await this.checking;
    await this.publish(failed ? 'failed' : 'stopped', failed ? { error: 'Listener failed; inspect this instance local logs. No task was automatically retried.' } : {});
  }
}

export async function validateManagedBinding(api, bot, config) {
  if (config.executor !== 'installed-headless' || config.triggerMode !== 'auto') throw new Error('Managed startup requires installed-headless automatic routing.');
  for (const name of ['conversationIds', 'senderIds']) {
    const ids = config[name];
    if (!Array.isArray(ids) || !ids.length || ids.some(id => typeof id !== 'string' || !id) || new Set(ids).size !== ids.length)
      throw new Error(`Managed startup requires nonempty unique ${name}.`);
  }
  const conversations = await api.request('/api/conversations');
  if (!Array.isArray(conversations)) throw new Error('Invalid IM conversation list.');
  const humans = new Set();
  for (const id of config.conversationIds) {
    const conversation = conversations.find(item => item.id === id);
    if (!Array.isArray(conversation?.members) || !conversation.members.some(member => member.id === bot.id && member.is_bot))
      throw new Error('Bound conversation is unavailable or no longer contains the bot.');
    for (const member of conversation.members) if (member.id && !member.is_bot) humans.add(member.id);
  }
  if (config.senderIds.some(id => !humans.has(id))) throw new Error('An authorized sender is no longer a human member of the bound conversations.');
}
