import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { readFile, lstat } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { redact } from './triage-report.mjs';

// Analysis-only recipe from the user's installed chery-qa plugin, skill 1.3.2.
// Keep its selection order, effort settings and prompt text together. This does
// not expose its private HTTP routes or alter the installed desktop plugin.
const digest = value => createHash('sha256').update(value).digest('hex');
const failure = code => Object.assign(new Error(code), { code });

function windowArgs(params) {
  const args = ['--json'];
  const date = String(params.get('date') || '').trim();
  const from = String(params.get('from') || '').trim();
  const to = String(params.get('to') || '').trim();
  const types = String(params.get('types') || '').trim();
  const effort = String(params.get('effort') || '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(date)) args.push('--date', date);
  if (/^\d{2}:\d{2}$/.test(from)) args.push('--from', from);
  if (/^\d{2}:\d{2}$/.test(to)) args.push('--to', to);
  if (/^[a-z\-]+(,[a-z\-]+)*$/i.test(types)) args.push('--types', types);
  if (/^(low|mid|high)$/.test(effort)) args.push('--effort', effort);
  return args;
}

function relativePath(value, target) {
  const text = String(value || '').replace(/\\/g, '/');
  const base = String(target || '').replace(/\\/g, '/').replace(/\/+$/, '');
  const index = base ? text.indexOf(base + '/') : -1;
  if (index >= 0) return text.slice(index + base.length + 1);
  const parts = text.split('/');
  return parts.slice(-2).join('/');
}

function relativize(result, target) {
  const findings = (Array.isArray(result.findings) ? result.findings : []).map((finding) => ({
    ...finding,
    evidence: (Array.isArray(finding.evidence) ? finding.evidence : []).map((item) => ({
      ...item,
      file: relativePath(item.file, target),
    })),
  }));
  const filesUsed = (Array.isArray(result.filesUsed) ? result.filesUsed : []).map((item) =>
    typeof item === 'string' ? relativePath(item, target) : { ...item, file: relativePath(item.file, target) },
  );
  return { ...result, findings, filesUsed };
}

  async function evidenceSnippets(baseDir, payload, budget = 44) {
    const out = [];
    const seen = new Set();
    const findings = Array.isArray(payload.findings) ? payload.findings : [];
    for (const finding of findings) {
      for (const item of Array.isArray(finding.evidence) ? finding.evidence : []) {
        if (out.length >= budget) return out;
        const file = String(item.file || '').replace(/\\/g, '/');
        const line = Number(item.line) || 0;
        const key = file + ':' + line;
        if (!file || seen.has(key)) continue;
        seen.add(key);
        const text = await readFile(join(baseDir, file), 'utf8').catch(() => '');
        if (!text) continue;
        const all = text.split(/\r?\n/);
        const at = line > 0 ? Math.min(all.length - 1, line - 1) : 0;
        const from = Math.max(0, at - 5);
        const to = Math.min(all.length, at + 6);
        out.push({
          file,
          line,
          text: all
            .slice(from, to)
            .map((value, index) => String(from + index + 1).padStart(6) + ' | ' + value.slice(0, 180))
            .join('\n'),
        });
      }
    }
    return out;
  }

  function compactVerdict(payload) {
    const findings = (Array.isArray(payload.findings) ? payload.findings : []).slice(0, 12).map((item) => ({
      category: item.category,
      party: item.party,
      confidence: item.confidence,
      summary: item.summary,
      evidence: (Array.isArray(item.evidence) ? item.evidence : [])
        .slice(0, 4)
        .map((e) => ({ file: e.file, line: e.line, detail: e.detail })),
    }));
    return {
      verdict: payload.verdict,
      findings,
      filesUsed: (Array.isArray(payload.filesUsed) ? payload.filesUsed : []).map((f) => f.file || f).slice(0, 30),
      filesExcluded: payload.filesExcluded,
      suggestions: payload.suggestions,
      window: payload.window,
      effort: payload.effort,
    };
  }

  const EFFORT_LEVELS = {
    low: {
      evidence: 16,
      keyLines: 24,
      maxTokens: 5000,
      docs: ['SKILL.md', 'references/verdict-guide.md'],
      brief: '只追能直接解释现象的那条因果链：证据够就下结论，不必穷举旁证，【依据】控制在 4 条以内，【其他可能】最多 2 条。',
    },
    mid: {
      evidence: 44,
      keyLines: 60,
      maxTokens: 6000,
      docs: ['SKILL.md', 'references/verdict-guide.md', 'references/time-alignment.md'],
      brief: '按标准流程输出完整五段，时间线要覆盖现象发生前后的关键节点。',
    },
    high: {
      evidence: 90,
      keyLines: 180,
      maxTokens: 8000,
      docs: [
        'SKILL.md',
        'references/verdict-guide.md',
        'references/time-alignment.md',
        'references/glossary.md',
        'references/vehicle-config.md',
        'references/component-map.md',
      ],
      brief:
        '按根因深挖标准复核：主动找反证，逐条列出你排除过的假设及排除依据；对照 glossary 核对错误码语义、对照 component-map 核对部件地址、对照 vehicle-config 核对云端车型配置；同名/同类历史问题若能从日志看出，一并说明。',
    },
  };

const KEY_LINE = /(no_upgrade_available|strategy_not_found|task\/verify|upgrade\/check|checkUpdateTask|api-ota-[a-z0-9-]+|UPGRADE_FLOW|Install_failed|createDir|RPC\.error|code[=:]\s*\d{3,})/i;

  async function keyLineHits(baseDir, payload, budget = 60) {
    const out = [];
    const seen = new Set();
    const files = (Array.isArray(payload.filesUsed) ? payload.filesUsed : []).map((f) => f.file || f).filter(Boolean).slice(0, 40);
    for (const rel of files) {
      if (out.length >= budget) break;
      const text = await readFile(join(baseDir, rel), 'utf8').catch(() => '');
      if (!text || text.length > 12 * 1024 * 1024) continue;
      const lines = text.split(/\r?\n/);
      for (let index = 0; index < lines.length && out.length < budget; index += 1) {
        if (!KEY_LINE.test(lines[index])) continue;
        const key = rel + ':' + (index + 1);
        if (seen.has(key)) continue;
        const from = Math.max(0, index - 2);
        const to = Math.min(lines.length, index + 3);
        out.push({
          file: rel,
          line: index + 1,
          text: lines
            .slice(from, to)
            .map((value, offset) => String(from + offset + 1).padStart(6) + ' | ' + value.slice(0, 200))
            .join('\n'),
        });
        index = to - 1;
        seen.add(key);
      }
    }
    return out;
  }

export function buildPluginPrompt({ base, docs, evidence, keyLines, symptom = '', effort = 'mid' }) {
  const level = EFFORT_LEVELS[effort];
  const [skill, guide, align] = [docs[0], level.docs[1] ? docs[1] : '', level.docs[2] ? docs[2] : ''];
  const system = [
    '你是车端 OTA（MDA / SDA / TBOX）日志故障初排专家，服务奇瑞、捷途等海外 OTA 项目。',
    '必须严格按照下方 ota-log-triage SKILL 流程复核：先按时间窗口对齐日志，再逐条核对证据，最后做链式归因。',
    'CLI 的 verdict 只是启发式倾向，可以推翻，但必须给出日志证据与推理链，不得编造行号或日志内容。',
    '输出使用中文，标题写「OTA 日志分析报告」，正文结构固定为五段：【结论】【依据】【时间线】【其他可能】【下一步】。',
    '报告中不要出现 CLI、启发式、初判、命中次数等内部术语，也不要写你推翻了什么；只写日志证据、结论与理由。',
    '【结论】写责任方与置信度；【依据】每条都必须带 文件名:行号；【下一步】要可执行、指出要找谁核对什么。',
    '判定次序（必须遵守）：',
    '1) 先回答「哪个环节造成了用户看到的这个现象」，而不是罗列日志里出现的错误。',
    '2) 车-云交互优先：看 upgrade/check、task/verify、checkUpdateTask 的返回码，以及请求打到的域名（api-ota-<环境>-<区域>）。',
    '3) 云端明确返回 no_upgrade_available / strategy_not_found 时，默认判为云端任务配置或发布环境问题；只有车端上报字段（ECU 号、VIN、版本）明显错误才改判车端。',
    '4) 车端本地异常（例如 createDir 传空 path、ADCC 采集被拒）只有能直接解释「现象」时才算主责，否则列为【其他可能】里的次要缺陷，不得据此把责任判给 MDA/SDA。',
    '5) 环境线索（staging/stg/uat 域名、区域 mx/me/ae 等）与任务实际发布环境不一致时，要作为最高优先级疑点写出。',
    '复核强度（' + effort + '）：' + level.brief,
  ].join('\n');
  const user = [
    '## 1. SKILL 主流程\n' + skill,
    '## 2. 判定规则（verdict-guide）\n' + guide,
    '## 3. 时间对齐规则\n' + align,
    '## 4. 缺陷现象（用户/客户描述，判责必须围绕它）\n' + (symptom || '（未提供，只能在报告中说明缺少现象描述）'),
    ...docs.slice(3).map((text, index) => '## 参考 ' + level.docs[index + 3] + '\n' + text),
    '## 5. CLI 启发式初判（可能不准，需复核）\n' + JSON.stringify(compactVerdict(base), null, 2).slice(0, 10000),
    evidence.length
      ? '## 6. 证据原文（from findings，行号前缀为真实行号）\n' +
        evidence.map((item) => '### ' + item.file + ' @ L' + item.line + '\n' + item.text).join('\n\n')
      : '## 6. 证据原文\n（未能回读到原文，只能基于初判 JSON 复核，请降低置信度）',
    keyLines.length
      ? '## 7. 关键行全量扫描（按返回码/域名/升级流程关键词在全量日志里检索，含上下文）\n' +
        keyLines.map((item) => '### ' + item.file + ' @ L' + item.line + '\n' + item.text).join('\n\n')
      : '## 7. 关键行全量扫描\n（未命中关键词）',
    '## 8. 任务\n针对上面的现象与日志，按 SKILL Step 5 / Step 6 输出完整复核报告；【依据】里每条都要标注它是否直接解释现象。',
  ].join('\n\n');
  return { system, user };
}


export async function buildPluginAnalysisInput({ baseDir, base, docs, symptom = '', effort = 'mid' }) {
  const level = EFFORT_LEVELS[effort];
  if (!level) throw failure('PLUGIN_EFFORT_INVALID');
  const snippets = await evidenceSnippets(baseDir, base, level.evidence);
  const keyLines = await keyLineHits(baseDir, base, level.keyLines);
  const prompt = buildPluginPrompt({ base, docs, evidence: snippets, keyLines, symptom, effort });
  return { ...prompt, snippets, keyLines };
}

async function runParser(parser, target, args, signal) {
  signal?.throwIfAborted();
  return await new Promise((resolveResult, reject) => {
    const env = {};
    for (const key of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP'])
      if (process.env[key]) env[key] = process.env[key];
    const child = spawn(process.execPath, [parser, target, ...args], {
      cwd: target, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'], env,
    });
    const chunks = [];
    let failed, aborted = false;
    const abort = () => { aborted = true; child.kill(); };
    signal?.addEventListener('abort', abort, { once: true });
    child.stdout.on('data', chunk => chunks.push(chunk));
    child.stderr.on('data', () => {});
    child.on('error', cause => { failed = cause; });
    child.on('close', code => {
      signal?.removeEventListener('abort', abort);
      if (aborted || signal?.aborted) { reject(signal?.reason ?? failure('PLUGIN_PARSE_CANCELLED')); return; }
      if (failed || code !== 0) { reject(failure('PLUGIN_PARSE_FAILED')); return; }
      try { resolveResult(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(failure('PLUGIN_PARSE_JSON_INVALID')); }
    });
    if (signal?.aborted) abort();
  });
}

function sourceTarget(directory, files) {
  // The extractor namespaces attachments; a single ZIP's contents are the
  // same parser target that the original desktop plugin calls "unpacked".
  const prefix = /^(input-\d+\/contents\/)/u.exec(files[0]?.path ?? '')?.[1];
  return prefix && files.every(file => file.path.startsWith(prefix))
    ? resolve(directory, prefix) : directory;
}

async function inputCatalog(directory, target, files, snippets, base, initial = []) {
  const descriptors = new Map(files.map(file => [file.path, file]));
  const readCache = new Map(), rows = new Map();
  const add = async (displayFile, number) => {
    const full = resolve(target, displayFile), rel = relative(directory, full).split(sep).join('/');
    const descriptor = descriptors.get(rel);
    if (!descriptor || !Number.isSafeInteger(number) || number < 1) throw failure('PLUGIN_EVIDENCE_SCOPE');
    if (!readCache.has(rel)) readCache.set(rel, (await readFile(full, 'utf8')).split(/\r?\n/));
    const line = readCache.get(rel)[number - 1];
    if (line === undefined) throw failure('PLUGIN_EVIDENCE_LINE_INVALID');
    const text = redact(line);
    if (text) rows.set(rel + ':' + number, { file: rel, pluginFile: displayFile, line: number, text,
      sha256: descriptor.sha256, time: '', aligned: false });
  };
  for (const snippet of snippets) {
    for (const row of snippet.text.split('\n')) {
      const parsed = /^\s*(\d+) \| /u.exec(row);
      if (parsed) await add(snippet.file, Number(parsed[1]));
    }
  }
  // These original lines are referenced in the compact verdict that the model
  // receives, even if that reference falls outside the selected context blocks.
  for (const finding of compactVerdict(base).findings)
    for (const item of finding.evidence) if (item.line > 0) await add(item.file, item.line);
  let number = Math.max(0, ...initial.map(item => Number(/^E(\d+)$/u.exec(item.id ?? '')?.[1]) || 0));
  return [...rows.values()].map(item => ({ id: 'E' + String(++number).padStart(4, '0'), ...item }));
}

/** Run the fixed original recipe once, without an Agent choosing a subset. */
export async function preparePluginAnalysis(request, { signal } = {}) {
  const context = request.executionContext;
  if (!isAbsolute(context?.directory ?? '') || !isAbsolute(context?.skillRoot ?? '') || !request.inputFiles?.length)
    throw failure('PLUGIN_INPUT_INVALID');
  signal?.throwIfAborted();
  const { verifySkill } = await import('./log-triage-worker.mjs');
  const skill = await verifySkill(context.skillRoot);
  const directory = resolve(context.directory), target = sourceTarget(directory, request.inputFiles);
  if (!(await lstat(target)).isDirectory()) throw failure('PLUGIN_INPUT_INVALID');
  const parameters = request.parameters ?? {}, params = new URLSearchParams();
  for (const [key, value] of Object.entries({ ...parameters.window, effort: parameters.effort, types: parameters.types }))
    if (['date', 'from', 'to', 'effort', 'types'].includes(key) && value != null) params.set(key, String(value));
  const parser = await runParser(skill.parser, target, windowArgs(params), signal);
  signal?.throwIfAborted();
  const base = relativize(parser, target);
  const symptom = String(parameters.symptom || '').trim().slice(0, 200);
  const effort = ['low', 'mid', 'high'].includes(parameters.effort) ? parameters.effort : 'mid';
  const level = EFFORT_LEVELS[effort];
  const docs = await Promise.all(level.docs.map(file => readFile(join(skill.root, file), 'utf8').catch(() => '')));
  const { system, user, snippets, keyLines } = await buildPluginAnalysisInput({ baseDir: target, base, docs, symptom, effort });
  const evidence = await inputCatalog(directory, target, request.inputFiles, [...snippets, ...keyLines], base, context.payload?.evidence);
  signal?.throwIfAborted();
  return { recipe: 'chery-qa-plugin', system, user, maxTokens: level.maxTokens, effort, symptom, evidence, base,
    proof: { skillLoaded: true, parserRuns: 1, evidenceReadCalls: snippets.length + keyLines.length,
      evidenceLines: evidence.length, filesUsed: base.filesUsed?.length ?? 0, evidenceSnippets: snippets.length,
      keyLineHits: keyLines.length, systemSha256: digest(system), userSha256: digest(user),
      parserOutputSha256: digest(JSON.stringify(base)),
      inputFilesSha256: digest(JSON.stringify(request.inputFiles.map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 })))) } };
}

function reportSections(text) {
  const markers = [...text.matchAll(/^[\t #*_\d.、-]*【(结论|依据|时间线|其他可能|下一步)】(?:[\t ]*\*{1,2})?[\t ]*(?:\r?\n)?/gmu)];
  const sections = {};
  for (let index = 0; index < markers.length; index++) {
    const marker = markers[index], name = marker[1];
    if (Object.hasOwn(sections, name)) throw failure('PLUGIN_REPORT_SECTION_DUPLICATE');
    sections[name] = text.slice(marker.index + marker[0].length, markers[index + 1]?.index ?? text.length).trim();
  }
  if (['结论', '依据', '时间线', '其他可能', '下一步'].some(name => !sections[name])) throw failure('PLUGIN_REPORT_SECTIONS_MISSING');
  return sections;
}

function citedRows(section, evidence, field) {
  const result = [], seen = new Set();
  for (const paragraph of section.split(/\n\s*\n/u)) {
    for (const row of evidence) {
      if (seen.has(row.id)) continue;
      const aliases = [row.pluginFile, row.file, row.pluginFile?.split('/').at(-1), row.file?.split('/').at(-1)].filter(Boolean);
      let cited = false;
      for (const alias of new Set(aliases)) {
        let at = -1;
        while ((at = paragraph.indexOf(alias, at + 1)) !== -1) {
          const tail = paragraph.slice(at + alias.length).replace(/^[`*_\t ]+/u, '');
          const number = /^(?:[:：][\t ]*|[\t ]+@?[\t ]*)L?(\d+)(?:[\t ]*[-–—~至][\t ]*L?(\d+))?/u.exec(tail);
          if (number && row.line >= Number(number[1]) && row.line <= Number(number[2] ?? number[1])) { cited = true; break; }
        }
        if (cited) break;
      }
      if (cited) { seen.add(row.id); result.push({ id: row.id, [field]: paragraph.trim() }); }
    }
  }
  return result;
}

/** Presentation mapping only: all business wording stays in the model report. */
export function mapPluginReport(sourceReport, evidence) {
  if (typeof sourceReport !== 'string' || !Array.isArray(evidence)) throw failure('PLUGIN_REPORT_INVALID');
  const sections = reportSections(redact(sourceReport).trim());
  const plain = sections['结论'].replace(/\*\*|`|__/gu, '');
  const responsibility = /责任方[：:]\s*([^；;\n]+)(?=[；;\n]|$)/u.exec(plain)?.[1]?.trim() ?? plain;
  const confidenceText = /置信度[：:]?\s*(高|中|低)/u.exec(plain)?.[1];
  if (!confidenceText) throw failure('PLUGIN_REPORT_CONFIDENCE_MISSING');
  const refs = citedRows(sections['依据'], evidence, 'interpretation');
  const timeline = citedRows(sections['时间线'], evidence, 'event');
  // The original plugin may write a timeline with times and narrative only.
  // Preserve that wording, binding only to a real line already cited by its
  // own evidence section; no new event or diagnostic sentence is introduced.
  if (!timeline.length && refs.length) timeline.push({ id: refs[0].id, event: sections['时间线'] });
  if (!refs.length) throw failure('PLUGIN_REPORT_EVIDENCE_MISSING');
  return { conclusion: sections['结论'], confidence: { 高: 'high', 中: 'medium', 低: 'low' }[confidenceText], responsibility,
    evidence: refs, timeline, alternatives: [sections['其他可能']], nextSteps: [sections['下一步']], limitations: [] };
}
