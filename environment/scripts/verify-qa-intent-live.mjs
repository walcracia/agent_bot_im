import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { ImApi } from '../../workspace/bridge/core.mjs';

// Explicit local acceptance only. Accounts, message content and receipts stay ignored.
assert.ok(process.argv.includes('--live'), '需要显式 --live。');
const send = process.argv.includes('--send');
assert.notEqual(send, process.argv.includes('--check'), '请选择 --send 或 --check。');
const read = async path => JSON.parse(await readFile(path, 'utf8'));
const directory = resolve('environment/verification/v055/intent-live');
await mkdir(directory, { recursive: true });
const file = resolve(directory, 'requests.json');
const config = await read('environment/config/bridge-installed.local.json');
const stateFile = resolve('environment/config', config.superAgent.statePath);
const ledger = await read(stateFile), task = ledger.superAgent.tasks.T000001;
const account = (await read('environment/config/demo-accounts.json')).accounts.find(value => config.senderIds.includes(value.user?.id) && value.user.is_admin);
assert.ok(account && task?.kind === 'log-triage');
let requests = await read(file).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
const login = await new ImApi(config.baseUrl).request('/api/login', { username: account.username, password: account.password });
const api = new ImApi(config.baseUrl, login.token);
try {
  if (send) {
    if (!requests) {
      requests = { at: new Date().toISOString(), project: task.externalIssueNo.replace(/-\d+$/u, ''),
        tasksBefore: Object.fromEntries(Object.values(ledger.superAgent.tasks).map(value => [value.id, [value.inputRevision, value.attempt]])),
        cases: [{ text: `${task.externalIssueNo.replace(/-\d+$/u, '')}这几天消停了吗？`, kind: 'recent_issues' }, { text: '日志分析到哪一步了？', kind: 'analysis_status' }]
          .map(value => ({ ...value, clientId: `intent-live-${randomUUID()}` })) };
      await writeFile(file, JSON.stringify(requests, null, 2), { flag: 'wx' });
    }
    for (const item of requests.cases) {
      if (item.messageId) continue;
      const result = await api.request(`/api/conversations/${task.conversationId}/messages`, { text: item.text, client_id: item.clientId });
      item.messageId = result.id; await writeFile(file, JSON.stringify(requests, null, 2));
    }
    console.log(JSON.stringify({ status: 'sent-once', ids: requests.cases.map(value => value.messageId) }));
  } else {
    assert.ok(requests);
    const data = ledger.superAgent, messages = await api.request(`/api/conversations/${task.conversationId}/messages?limit=100`);
    const results = [];
    for (const item of requests.cases) {
      const intake = data.inbox[`im:${item.messageId}`];
      assert.equal(intake?.status, 'routed'); assert.equal(intake.decision?.kind, item.kind);
      const replies = Object.entries(data.outbox).filter(([key]) => key.startsWith(`triage-query:im:${item.messageId}:`)).map(([, value]) => value);
      assert.equal(replies.length, 1); assert.equal(replies[0].status, 'sent');
      assert.ok(messages.some(message => message.text === replies[0].text && message.sender?.is_bot));
      results.push({ messageId: item.messageId, kind: item.kind, sent: true, bodySha256: createHash('sha256').update(replies[0].text).digest('hex') });
    }
    assert.deepEqual(Object.fromEntries(Object.values(data.tasks).map(value => [value.id, [value.inputRevision, value.attempt]])), requests.tasksBefore, '查询期间任务版本/执行次数发生变化，需核对来源。');
    const original = data.inbox['im:147'];
    assert.equal(original?.decision?.kind, 'recent_issues');
    assert.ok(Object.entries(data.outbox).some(([key, value]) => key.startsWith('triage-query:im:147:') && value.status === 'sent'));
    const receipt = { status: 'passed', at: new Date().toISOString(), originalMessage147Answered: true, noAnalysisStarted: true, results };
    await writeFile(resolve(directory, 'receipt.json'), JSON.stringify(receipt, null, 2));
    console.log(JSON.stringify(receipt));
  }
} finally { await api.request('/api/logout', {}); }
