import { spawn } from 'node:child_process';

export const QA_READ_TOOLS = Object.freeze(['projects_list', 'issues_list', 'issue_files', 'file_url', 'issue_comments', 'issue_process']);
const allowed = new Set(QA_READ_TOOLS);
const error = code => Object.assign(new Error(code), { code });
const integer = (value, name, min = 1, max = Number.MAX_SAFE_INTEGER) => {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw error(`QA_INVALID_${name}`);
  return value;
};
const identifier = value => {
  if (!['string', 'number'].includes(typeof value) || !String(value).trim() || String(value).length > 200) throw error('QA_INVALID_ID');
  return String(value);
};
const numericId = value => {
  const id = identifier(value);
  if (!/^[1-9]\d*$/u.test(id) || !Number.isSafeInteger(Number(id))) throw error('QA_INVALID_NUMERIC_ID');
  return Number(id);
};

/** A local, trusted stdio command. Remote tool names never become executable commands. */
export class QaMcpClient {
  constructor({ command, args = [], cwd, env = {}, timeoutMs = 30000, maxResponseBytes = 2000000 } = {}) {
    if (typeof command !== 'string' || !command.trim() || command.includes('\0') || !Array.isArray(args) || args.some(value => typeof value !== 'string' || value.includes('\0'))) throw error('QA_INVALID_COMMAND');
    if (!env || typeof env !== 'object' || Array.isArray(env) || Object.values(env).some(value => typeof value !== 'string')) throw error('QA_INVALID_ENV');
    this.options = { command, args: [...args], cwd, env: { ...env }, timeoutMs: integer(timeoutMs, 'TIMEOUT', 1, 300000), maxResponseBytes: integer(maxResponseBytes, 'RESPONSE_LIMIT', 128, 16000000) };
    this.pending = new Map(); this.nextId = 0; this.child = null; this.ready = false; this.closed = false; this.failure = null; this.starting = null;
  }

  async start() {
    if (this.closed) throw error('QA_MCP_CLOSED');
    if (this.ready) return this;
    if (this.starting) return this.starting;
    if (this.child) throw this.failure ?? error('QA_MCP_NOT_READY');
    this.starting = this.#start();
    try { return await this.starting; } finally { this.starting = null; }
  }

  async #start() {
    this.failure = null;
    const child = spawn(this.options.command, this.options.args, { cwd: this.options.cwd, env: this.options.env, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child = child;
    let buffered = Buffer.alloc(0);
    this.exited = new Promise(resolve => child.once('close', () => {
      clearTimeout(this.killTimer);
      if (this.child === child) { this.child = null; this.ready = false; }
      this.#fail(error('QA_MCP_EXITED'), child); resolve();
    }));
    child.once('error', () => this.#fail(error('QA_MCP_START_FAILED'), child));
    child.stdin.on('error', () => this.#fail(error('QA_MCP_INPUT_FAILED'), child));
    // The server's stderr may contain authentication or backend response data.
    child.stderr.on('data', () => {});
    child.stdout.on('data', bytes => {
      if (this.child !== child || this.failure) return;
      buffered = Buffer.concat([buffered, bytes]);
      while (buffered.includes(10)) {
        const end = buffered.indexOf(10), line = buffered.subarray(0, end); buffered = buffered.subarray(end + 1);
        if (line.length > this.options.maxResponseBytes) { this.#fail(error('QA_MCP_RESPONSE_LIMIT'), child); return; }
        if (line.length) {
          let message;
          try { message = JSON.parse(line.toString('utf8')); } catch { this.#fail(error('QA_MCP_INVALID_JSON'), child); return; }
          this.#receive(message, child);
        }
      }
      if (buffered.length > this.options.maxResponseBytes) this.#fail(error('QA_MCP_RESPONSE_LIMIT'), child);
    });
    const result = await this.#request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'teamplay-qa-source', version: '0.4.0' } });
    if (!result || !['2024-11-05', '2025-03-26', '2025-06-18'].includes(result.protocolVersion) || !result.capabilities || typeof result.capabilities !== 'object') {
      this.#fail(error('QA_MCP_INVALID_INITIALIZE'), child); throw this.failure;
    }
    this.#write({ jsonrpc: '2.0', method: 'notifications/initialized' });
    this.ready = true; return this;
  }

  #receive(message, child) {
    if (!message || message.jsonrpc !== '2.0' || typeof message !== 'object') { this.#fail(error('QA_MCP_INVALID_ENVELOPE'), child); return; }
    if (message.method) {
      if (Object.hasOwn(message, 'id')) this.#write(message.method === 'ping'
        ? { jsonrpc: '2.0', id: message.id, result: {} }
        : { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Unsupported client method.' } });
      return;
    }
    const pending = this.pending.get(message.id);
    if (!pending) return; // Unknown or duplicate receipts never acknowledge another call.
    this.pending.delete(message.id); clearTimeout(pending.timer);
    if (Object.hasOwn(message, 'error')) pending.reject(error('QA_MCP_RPC_ERROR'));
    else if (!Object.hasOwn(message, 'result')) pending.reject(error('QA_MCP_INVALID_RECEIPT'));
    else pending.resolve(message.result);
  }

  #write(message) {
    if (!this.child || this.failure || this.closed) throw this.failure ?? error('QA_MCP_CLOSED');
    this.child.stdin.write(JSON.stringify(message) + '\n');
  }

  #request(method, params) {
    if (!this.child || this.failure || this.closed) return Promise.reject(this.failure ?? error('QA_MCP_CLOSED'));
    if (this.pending.size >= 16) return Promise.reject(error('QA_MCP_PENDING_LIMIT'));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.#fail(error('QA_MCP_TIMEOUT'), this.child), this.options.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { this.#write({ jsonrpc: '2.0', id, method, params }); }
      catch { this.pending.delete(id); clearTimeout(timer); reject(error('QA_MCP_INPUT_FAILED')); }
    });
  }

  #fail(cause, child) {
    if (child && this.child && child !== this.child) return;
    this.failure ??= cause; this.ready = false;
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(this.failure); }
    this.pending.clear();
    if (child && child.exitCode === null && !child.killed) {
      child.kill();
      this.killTimer = setTimeout(() => { if (this.child === child && child.exitCode === null) child.kill('SIGKILL'); }, 1500);
    }
  }

  async callTool(name, args = {}) {
    if (!allowed.has(name)) throw error('QA_MCP_TOOL_DENIED');
    if (!args || typeof args !== 'object' || Array.isArray(args)) throw error('QA_MCP_INVALID_ARGUMENTS');
    await this.start();
    const result = await this.#request('tools/call', { name, arguments: args });
    if (!result || result.isError || !Array.isArray(result.content) && !result.structuredContent) throw error('QA_MCP_TOOL_FAILED');
    return result;
  }

  async close() {
    this.closed = true;
    const child = this.child, exited = this.exited;
    this.#fail(error('QA_MCP_CLOSED'), child);
    if (!child || !exited) return;
    let timer;
    await Promise.race([exited, new Promise(resolve => { timer = setTimeout(resolve, 1500); })]); clearTimeout(timer);
    if (this.child === child) {
      child.kill('SIGKILL');
      await Promise.race([exited, new Promise((_, reject) => { timer = setTimeout(() => reject(error('QA_MCP_CLOSE_TIMEOUT')), 1500); })]).finally(() => clearTimeout(timer));
    }
  }
}

function payload(result) {
  if (result?.isError) throw error('QA_MCP_TOOL_FAILED');
  if (result?.structuredContent && typeof result.structuredContent === 'object' && !Array.isArray(result.structuredContent)) return result.structuredContent;
  const text = result?.content?.filter(item => item.type === 'text').map(item => item.text).join('\n');
  if (typeof text !== 'string' || !text.length || Buffer.byteLength(text) > 2000000) throw error('QA_MCP_INVALID_PAYLOAD');
  try {
    const data = JSON.parse(text);
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw error('QA_MCP_INVALID_PAYLOAD');
    return data;
  } catch { throw error('QA_MCP_INVALID_PAYLOAD'); }
}

function page(data, pageIndex, pageSize) {
  if (!Array.isArray(data.data) || !Number.isSafeInteger(data.count) || data.count < 0 || data.data.length > pageSize || data.pageIndex !== undefined && Number(data.pageIndex) !== pageIndex || data.pageSize !== undefined && Number(data.pageSize) !== pageSize) throw error('QA_INVALID_PAGE');
  return { data: data.data, count: data.count };
}

export function normalizeQaIssue(raw, projectId) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw error('QA_INVALID_ISSUE');
  const bound = identifier(projectId), supplied = raw.projectId ?? raw.pId ?? raw.project_id;
  if (supplied !== undefined && supplied !== null && identifier(supplied) !== bound) throw error('QA_PROJECT_MISMATCH');
  const text = value => value === undefined || value === null ? '' : String(value);
  const result = { id: identifier(raw.id), projectId: bound, no: text(raw.no), title: text(raw.title), description: text(raw.description ?? raw.body), status: text(raw.status), openedAt: text(raw.openedAt), attachments: [] };
  for (const key of ['level', 'priority', 'module', 'type', 'faultDate', 'faultTime', 'faultStart', 'faultEnd', 'timezone']) if (raw[key] !== undefined && raw[key] !== null) result[key] = text(raw[key]);
  return result;
}

export class QaAdapter {
  constructor({ client, pageSize = 100, maxPages = 20, maxIssues = 2000 } = {}) {
    if (!client || typeof client.callTool !== 'function') throw error('QA_INVALID_CLIENT');
    this.client = client;
    this.pageSize = integer(pageSize, 'PAGE_SIZE', 1, 200); this.maxPages = integer(maxPages, 'MAX_PAGES'); this.maxIssues = integer(maxIssues, 'MAX_ISSUES');
  }

  async listProjects({ search = '', pageIndex = 1, pageSize = this.pageSize } = {}) {
    integer(pageIndex, 'PAGE_INDEX'); integer(pageSize, 'PAGE_SIZE', 1, 200);
    if (typeof search !== 'string' || search.length > 200) throw error('QA_INVALID_SEARCH');
    const result = page(payload(await this.client.callTool('projects_list', { search, pageIndex, pageSize, sortBy: 'id', sortOrder: 'ASC' })), pageIndex, pageSize);
    return { ...result, data: result.data.map(raw => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw error('QA_INVALID_PROJECT');
      return { id: identifier(raw.id), name: String(raw.name ?? raw.title ?? ''), code: String(raw.code ?? raw.no ?? '') };
    }) };
  }

  async listIssues({ projectId, pageIndex = 1, pageSize = this.pageSize, id } = {}) {
    integer(pageIndex, 'PAGE_INDEX'); integer(pageSize, 'PAGE_SIZE', 1, 200);
    const args = { pId: numericId(projectId), pageIndex, pageSize, sortBy: 'id', sortOrder: 'ASC' };
    if (id !== undefined) args.id = identifier(id);
    const result = page(payload(await this.client.callTool('issues_list', args)), pageIndex, pageSize);
    return { data: result.data.map(raw => normalizeQaIssue(raw, projectId)), count: result.count };
  }

  async getIssue({ projectId, issueId, no } = {}) {
    if (issueId === undefined && (typeof no !== 'string' || !no.trim() || no.length > 200)) throw error('QA_INVALID_ISSUE_REFERENCE');
    const target = issueId === undefined ? null : identifier(issueId);
    // Finish the complete bounded result before accepting a unique exact match.
    let match = null, count, received = 0;
    const seen = new Set();
    for (let pageIndex = 1; pageIndex <= this.maxPages; pageIndex++) {
      const response = await this.listIssues({ projectId, pageIndex, pageSize: this.pageSize, ...(target ? { id: target } : {}) });
      if (response.count > this.maxIssues || count !== undefined && response.count !== count) throw error('QA_SCAN_CHANGED');
      count = response.count;
      for (const issue of response.data) {
        if (seen.has(issue.id)) throw error('QA_DUPLICATE_ISSUE'); seen.add(issue.id); received++;
        if ((target === null || issue.id === target) && (no === undefined || issue.no === no)) { if (match) throw error('QA_AMBIGUOUS_ISSUE'); match = issue; }
      }
      if (received === count) return match;
      if (received > count || response.data.length === 0) throw error('QA_INCOMPLETE_PAGE');
    }
    throw error('QA_SCAN_LIMIT');
  }

  async listFiles(issue) {
    const result = payload(await this.client.callTool('issue_files', { isId: numericId(issue?.id) }));
    if (!Array.isArray(result.fileIds)) throw error('QA_INVALID_FILES');
    const ids = result.fileIds.map(identifier);
    if (new Set(ids).size !== ids.length) throw error('QA_DUPLICATE_FILE');
    return ids.map(id => ({ id }));
  }

  async getFile(fileId) {
    const id = identifier(fileId), raw = payload(await this.client.callTool('file_url', { id: numericId(id) }));
    if (typeof raw.url !== 'string') throw error('QA_INVALID_FILE');
    const result = { id, url: raw.url };
    for (const key of ['name', 'type', 'md5']) if (raw[key] !== undefined && raw[key] !== null) result[key] = String(raw[key]);
    if (raw.size !== undefined && raw.size !== null) { if (!Number.isSafeInteger(Number(raw.size)) || Number(raw.size) < 0) throw error('QA_INVALID_FILE_SIZE'); result.size = Number(raw.size); }
    return result;
  }
}
