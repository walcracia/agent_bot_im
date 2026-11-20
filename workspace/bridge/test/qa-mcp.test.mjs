import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { QaMcpClient, QaAdapter, QA_READ_TOOLS } from '../qa-mcp.mjs';

const server = String.raw`
const { createInterface } = require('node:readline');
const mode = process.env.QA_TEST_MODE;
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line);
  if (request.method === 'initialize') {
    if (mode === 'init-hang') return;
    send({ jsonrpc: '2.0', id: request.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} } } }); return;
  }
  if (request.method !== 'tools/call') return;
  if (mode === 'hang') return;
  if (mode === 'malformed') { process.stdout.write('secret-not-json\n'); return; }
  if (mode === 'oversize') { process.stdout.write('x'.repeat(5000)); return; }
  if (mode === 'rpc-error') { send({ jsonrpc: '2.0', id: request.id, error: { message: 'secret-token', code: -32001 } }); return; }
  if (mode === 'tool-error') { send({ jsonrpc: '2.0', id: request.id, result: { isError: true, content: [{ type: 'text', text: 'secret-token' }] } }); return; }
  if (mode === 'wrong-receipt') { send({ jsonrpc: '2.0', id: request.id + 100, result: {} }); return; }
  process.stderr.write('secret-auth-value\n');
  const reply = { jsonrpc: '2.0', id: request.id, result: { content: [{ type: 'text', text: JSON.stringify({ name: request.params.name, args: request.params.arguments }) }] } };
  if (mode === 'fragmented') { const wire = JSON.stringify(reply) + '\n'; process.stdout.write(wire.slice(0, 18)); setTimeout(() => process.stdout.write(wire.slice(18)), 5); }
  else { send(reply); if (mode === 'duplicate') send(reply); }
});
`;

async function fixture(t, mode = '', extras = {}) {
  const client = new QaMcpClient({ command: process.execPath, args: ['-e', server], env: { QA_TEST_MODE: mode }, timeoutMs: 1000, ...extras });
  t.after(() => client.close()); await client.start(); return client;
}
const receipt = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }] });
const raw = (id, extra = {}) => ({ id, pId: 7, no: `DEMO-${id}`, title: 'Example', status: 'open', ...extra });

test('real stdio initialization and fragmented tool receipt preserve exact arguments', async t => {
  const client = await fixture(t, 'fragmented');
  const result = await client.callTool('issues_list', { pId: 7, pageIndex: 1 });
  assert.deepEqual(JSON.parse(result.content[0].text), { name: 'issues_list', args: { pId: 7, pageIndex: 1 } });
  assert.equal(client.pending.size, 0);
});

test('only the fixed read-only tools are available and no command is built from a tool', async t => {
  const client = await fixture(t);
  assert.deepEqual(QA_READ_TOOLS, ['projects_list', 'issues_list', 'issue_files', 'file_url', 'issue_comments', 'issue_process']);
  for (const name of ['issue_update', 'issues_search', 'run_command', '__proto__']) await assert.rejects(client.callTool(name, {}), { code: 'QA_MCP_TOOL_DENIED' });
});

test('duplicate receipts do not complete or corrupt the next request', async t => {
  const client = await fixture(t, 'duplicate');
  const results = await Promise.all([client.callTool('issue_files', { isId: 1 }), client.callTool('file_url', { id: 2 })]);
  assert.deepEqual(results.map(item => JSON.parse(item.content[0].text).args), [{ isId: 1 }, { id: 2 }]);
});

for (const [mode, code] of [['malformed', 'QA_MCP_INVALID_JSON'], ['oversize', 'QA_MCP_RESPONSE_LIMIT'], ['rpc-error', 'QA_MCP_RPC_ERROR'], ['tool-error', 'QA_MCP_TOOL_FAILED']]) {
  test(`stdio ${mode} fails without exposing backend or authentication text`, async t => {
    const client = await fixture(t, mode, { maxResponseBytes: 1024 });
    await assert.rejects(client.callTool('issues_list'), cause => cause.code === code && !/secret/u.test(cause.message));
  });
}

for (const mode of ['hang', 'wrong-receipt']) test(`stdio ${mode} times out and its child is reaped`, async t => {
  const client = await fixture(t, mode, { timeoutMs: 250 });
  const pid = client.child.pid;
  await assert.rejects(client.callTool('issues_list'), { code: 'QA_MCP_TIMEOUT' });
  await client.close();
  assert.equal(client.child, null);
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
});

test('close rejects a pending request, waits for exit and cannot reopen', async t => {
  const client = await fixture(t, 'hang');
  const pending = assert.rejects(client.callTool('issues_list'), { code: 'QA_MCP_CLOSED' });
  await delay(20); await client.close(); await pending;
  await assert.rejects(client.start(), { code: 'QA_MCP_CLOSED' });
  assert.equal(client.child, null);
});

test('initialization timeout and spawn failure expose fixed errors and leave no process', async () => {
  const client = new QaMcpClient({ command: process.execPath, args: ['-e', server], env: { QA_TEST_MODE: 'init-hang' }, timeoutMs: 250 });
  try { await assert.rejects(client.start(), { code: 'QA_MCP_TIMEOUT' }); } finally { await client.close(); }
  assert.equal(client.child, null);
  const missing = new QaMcpClient({ command: 'teamplay-missing-command-qa-test', timeoutMs: 250 });
  try { await assert.rejects(missing.start(), { code: 'QA_MCP_START_FAILED' }); } finally { await missing.close(); }
  assert.equal(missing.child, null);
});

test('adapter normalizes project-scoped issues and only passes trusted query fields', async () => {
  const calls = [];
  const adapter = new QaAdapter({ client: { callTool: async (name, args) => { calls.push({ name, args }); return receipt({ data: [raw(1, { description: 'Details' })], count: 1, pageIndex: 1, pageSize: 100 }); } } });
  const result = await adapter.listIssues({ projectId: '7' });
  assert.equal(result.data[0].id, '1'); assert.equal(result.data[0].description, 'Details');
  assert.deepEqual(calls, [{ name: 'issues_list', args: { pId: 7, pageIndex: 1, pageSize: 100, sortBy: 'id', sortOrder: 'ASC' } }]);
  await assert.rejects(adapter.listIssues({ projectId: 7, pageSize: 201 }), { code: 'QA_INVALID_PAGE_SIZE' });
});

test('adapter rejects cross-project rows, malformed pages and failed MCP payloads', async () => {
  for (const [data, code] of [[{ data: [raw(1, { pId: 8 })], count: 1 }, 'QA_PROJECT_MISMATCH'], [{ data: [], count: '1' }, 'QA_INVALID_PAGE'], [{ data: [], count: 0, pageIndex: 2 }, 'QA_INVALID_PAGE']]) {
    const adapter = new QaAdapter({ client: { callTool: async () => receipt(data) } });
    await assert.rejects(adapter.listIssues({ projectId: 7 }), { code });
  }
  const adapter = new QaAdapter({ client: { callTool: async () => ({ isError: true, content: [{ type: 'text', text: 'secret' }] }) } });
  await assert.rejects(adapter.listIssues({ projectId: 7 }), { code: 'QA_MCP_TOOL_FAILED' });
});

test('adapter exact number lookup scans bounded pages and does not accept a partial match', async () => {
  const calls = [];
  const rows = [raw(1), raw(2), raw(3)];
  const adapter = new QaAdapter({ pageSize: 2, client: { callTool: async (name, args) => { calls.push(args); return receipt({ data: rows.slice((args.pageIndex - 1) * 2, args.pageIndex * 2), count: 3 }); } } });
  assert.equal((await adapter.getIssue({ projectId: 7, no: 'DEMO-3' })).id, '3');
  assert.equal(calls.length, 2); assert.ok(calls.every(call => call.pId === 7 && !Object.hasOwn(call, 'id')));
  assert.equal(await adapter.getIssue({ projectId: 7, no: 'DEMO' }), null);
});

test('adapter exact ID lookup cannot accept an unrelated filtered row', async () => {
  const calls = [];
  const adapter = new QaAdapter({ client: { callTool: async (name, args) => { calls.push(args); return receipt({ data: [raw(2)], count: 1 }); } } });
  assert.equal(await adapter.getIssue({ projectId: 7, issueId: '1' }), null);
  assert.equal(calls[0].id, '1');
});

test('adapter fails closed on ambiguous numbers and pagination errors', async () => {
  const adapter = new QaAdapter({ client: { callTool: async () => receipt({ data: [raw(1), raw(2, { no: 'DEMO-1' })], count: 2 }) } });
  await assert.rejects(adapter.getIssue({ projectId: 7, no: 'DEMO-1' }), { code: 'QA_AMBIGUOUS_ISSUE' });
  const incomplete = new QaAdapter({ client: { callTool: async () => receipt({ data: [], count: 1 }) } });
  await assert.rejects(incomplete.getIssue({ projectId: 7, no: 'DEMO-1' }), { code: 'QA_INCOMPLETE_PAGE' });
});

test('adapter returns attachment IDs separately from privileged file resolution', async () => {
  const calls = [];
  const adapter = new QaAdapter({ client: { callTool: async (name, args) => { calls.push({ name, args }); return receipt(name === 'issue_files' ? { fileIds: [12, 13] } : { url: 'https://qa.example.invalid/files?id=12', name: 'example.log', size: '42', extra: 'discard' }); } } });
  assert.deepEqual(await adapter.listFiles({ id: '1' }), [{ id: '12' }, { id: '13' }]);
  assert.deepEqual(await adapter.getFile('12'), { id: '12', url: 'https://qa.example.invalid/files?id=12', name: 'example.log', size: 42 });
  assert.deepEqual(calls.map(call => call.name), ['issue_files', 'file_url']);
});

test('adapter projects contain bounded identifiers and display fields only', async () => {
  const adapter = new QaAdapter({ client: { callTool: async () => ({ structuredContent: { data: [{ id: 7, name: 'Example', code: 'DEMO', private: 'discard' }], count: 1 } }) } });
  assert.deepEqual(await adapter.listProjects({ search: 'DEMO' }), { data: [{ id: '7', name: 'Example', code: 'DEMO' }], count: 1 });
});
