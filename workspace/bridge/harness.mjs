import { randomUUID } from 'node:crypto';
/** Only this module imports the official SDK. Tests never silently replace the production executor. */
export class OfficialExecutor {
  constructor(options, report) { this.options = options; this.report = report; this.sessions = new Map(); }
  async start() {
    if (this.harness) return;
    const { DeepSeekHarness } = await import('@deepseek-ai/dsh-sdk-client');
    const harness = new DeepSeekHarness({ ...this.options, approvalRequests: true,
      onUserQuestion: async request => {
        await this.report?.(`DSH 需要补充信息，请发送新消息继续：\n${request.questions.map(q => `${q.question ?? q.header ?? q.id}${q.options ? `\n${q.options.map(o => o.label).join(' / ')}` : ''}`).join('\n')}`,
          `question-${request.requestId}`);
        return { cancelled: true };
      },
    });
    harness.client.start();
    harness.client.onRequest(async method => {
      if (method !== 'approval/request') throw new Error(`Unsupported Harness request: ${method}`);
      await this.report?.('DSH 遇到需要额外权限的操作，已暂停该操作。请在 DSH 中检查权限并处理；IM 不会自动批准。', 'approval');
      return { outcome: 'rejected' };
    });
    try { await harness.start(); this.harness = harness; }
    catch (error) { await harness.close(); throw error; }
  }
  async handshake() {
    const { HarnessClient } = await import('@deepseek-ai/dsh-sdk-client');
    const client = new HarnessClient(this.options);
    const sessionId = `team-relay-handshake-${randomUUID()}`;
    let serverInfo, cwd;
    try {
      const result = await client.initialize({ cwd: this.options.cwd, provider: this.options.provider ?? 'deepseek-official',
        model: this.options.model ?? 'deepseek-v4-flash' });
      if (result.serverInfo.name !== 'deepseek-harness-sdk-runtime') throw new Error('Unexpected SDK peer identity.');
      serverInfo = result.serverInfo;
      cwd = await client.getWorkingDirectory(sessionId);
    } finally { await client.close(); }
    const restarted = new HarnessClient(this.options);
    try {
      await restarted.initialize({ cwd: this.options.cwd, provider: this.options.provider ?? 'deepseek-official',
        model: this.options.model ?? 'deepseek-v4-flash' });
      await restarted.resumeSession(sessionId);
      if (await restarted.getWorkingDirectory(sessionId) !== cwd) throw new Error('Restored session changed workspace.');
    } finally { await restarted.close(); }
    return { protocol: 'official-stdio-jsonrpc', serverInfo, cwd, sessionPersistence: 'resumed-after-process-restart', modelRequests: 0 };
  }
  async session(id, restore) {
    await this.start();
    if (this.sessions.has(id)) return this.sessions.get(id);
    const session = restore ? await this.harness.resumeSession(id) : this.harness.session(id);
    await session.getWorkingDirectory();
    const wrapper = { run: async (blocks, event) => {
      this.activeEvent = event;
      try { return await session.run(blocks); }
      finally { this.activeEvent = undefined; }
    } };
    this.sessions.set(id, wrapper); return wrapper;
  }
  async close() { await this.harness?.close(); this.harness = undefined; this.sessions.clear(); }
}
