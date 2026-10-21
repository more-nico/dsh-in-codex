import type { Message, Status, ToolCall } from '../src/types.js';
import { compactLine, outputSummary } from './messages.js';

type Fields = Record<string, unknown>;
export type ToolStatus = 'running' | 'success' | 'failed' | 'interrupted' | 'partial';
export interface SearchMatch { file: string; lines: Array<{ number: number; text: string }> }
export interface ToolView {
  title: string; hint: string; meta: string; status: ToolStatus; rawName: string;
  kind: 'command' | 'file' | 'search' | 'dispatch' | 'other';
  command?: string; paths?: string[]; diff?: string; diffTruncated?: boolean;
  output: string; transformed: boolean; matches?: SearchMatch[];
  errorLine?: string;
}

const asRecord = (value: unknown): Fields | undefined => value && typeof value === 'object' && !Array.isArray(value) ? value as Fields : undefined;
const str = (value: unknown) => typeof value === 'string' ? value : undefined;
const num = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? value : undefined;
const truncate = (value: string, max = 100) => compactLine(value, max);

export function parseToolArgs(raw: string): Fields {
  try { return asRecord(JSON.parse(raw)) || {}; } catch {
    // Older histories may contain a clipped JSON argument. Important fields
    // precede large content in DSH's serialized tool arguments.
    const file = /"(?:file_path|filePath|path)":"((?:\\.|[^"\\])*)"/.exec(raw);
    if (file) { try { return { file_path: JSON.parse(`"${file[1]}"`) }; } catch { /* leave unknown */ } }
    return {};
  }
}

function unwrapOutput(result?: Message): { text: string; data?: Fields; transformed: boolean } {
  if (!result) return { text: '', transformed: false };
  const text = result.text;
  if (result.textTotal && result.textTotal > text.length || text.length > 16_000) return { text, transformed: false };
  let parsed: unknown = text;
  for (let depth = 0; depth < 2 && typeof parsed === 'string'; depth++) {
    try { parsed = JSON.parse(parsed); } catch { break; }
  }
  const data = asRecord(parsed);
  if (!data) return { text, transformed: false };
  const structured = asRecord(data.structuredContent);
  if (structured) {
    const formatted = JSON.stringify(structured, null, 2);
    return formatted.length <= 16_000 ? { text: formatted, data: structured, transformed: true }
      : { text, data: structured, transformed: false };
  }
  if (Array.isArray(data.content)) {
    const blocks = data.content.filter(asRecord).filter(block => block.type === 'text').map(block => str(block.text) || '');
    if (blocks.length) {
      const formatted = blocks.join('\n');
      return formatted.length <= 16_000 ? { text: formatted, data, transformed: true }
        : { text, data, transformed: false };
    }
  }
  const formatted = JSON.stringify(data, null, 2);
  return formatted.length <= 16_000 ? { text: formatted, data, transformed: true }
    : { text, data, transformed: false };
}

function statusOf(result: Message | undefined, runStatus?: Status): ToolStatus {
  if (!result) return runStatus === 'stopped' || runStatus === 'interrupted' ? 'interrupted'
    : runStatus === 'failed' ? 'failed' : runStatus === 'completed' ? 'partial' : 'running';
  if (result.cancelled) return 'interrupted';
  if (result.isError || result.exitCode !== undefined && result.exitCode !== 0) return 'failed';
  return result.complete ? 'success' : 'partial';
}

function duration(startedAt: number | undefined, result?: Message) {
  if (!result || !startedAt || !result.timestamp || result.timestamp < startedAt) return '';
  const elapsed = result.timestamp - startedAt;
  return elapsed < 1000 ? `约 ${elapsed} 毫秒` : `约 ${(elapsed / 1000).toFixed(1)} 秒`;
}

function testResult(text: string) {
  const pass = /(?:^|\n)(?:#|ℹ)?\s*pass\s+(\d+)/im.exec(text)?.[1]
    ?? /\b(\d+)\s+passed\b/i.exec(text)?.[1];
  const fail = /(?:^|\n)(?:#|ℹ)?\s*fail\s+(\d+)/im.exec(text)?.[1]
    ?? /\b(\d+)\s+failed\b/i.exec(text)?.[1];
  return [pass !== undefined ? `${pass} 项通过` : '', fail !== undefined ? `${fail} 失败` : ''].filter(Boolean).join(' · ') || undefined;
}

function firstError(text: string) {
  const lines = text.split('\n');
  return (lines.find(line => /(?:\S+\.(?:ts|tsx|js|jsx|py|go|rs|mjs|json):\d+|\S+\.(?:ts|tsx|js)\(\d+,\d+\))/.test(line))
    || lines.find(line => /(?:^|\s)(?:Error:|error TS\d+|FAIL\b|failed\b)/i.test(line)))?.slice(0, 300);
}

function commandAction(command: string) {
  if (/\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|check)\b|\b(?:pytest|vitest|jest|go\s+test|cargo\s+test)\b/.test(command)) return '运行测试';
  if (/\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:build|typecheck|compile)\b|\b(?:tsc|esbuild|vite\s+build)\b/.test(command)) return '编译项目';
  if (/\bpack:plugin\b|\bscripts\/package\.mjs\b/.test(command)) return '打包插件';
  if (/\bdsh-in-codex(?:\.mjs)?\s+install\b/.test(command)) return '安装插件';
  if (/\b(?:npm|pnpm|yarn|bun)\s+(?:ci|install|add)\b/.test(command)) return '安装依赖';
  return '执行命令';
}

function readCommand(command: string) {
  const sed = /\bsed\s+-n\s+['"]?(\d+),(\d+)p['"]?\s+([^\s;&|]+)/.exec(command);
  if (sed) return { paths: [sed[3]], range: `${sed[1]}–${sed[2]} 行` };
  const cat = /^\s*cat\s+([^;&|]+)/.exec(command);
  if (cat) return { paths: cat[1].trim().split(/\s+/).filter(path => !path.startsWith('-')), range: '' };
  return undefined;
}

function searchCommand(command: string) {
  const match = /\b(rg|grep|find|ls)\b\s+(.+)/.exec(command);
  if (!match) return undefined;
  const remainder = match[2].split(/\s*(?:&&|\|)\s*/)[0];
  const quoted = /['"]([^'"]+)['"]/.exec(remainder)?.[1];
  const tokens = remainder.trim().split(/\s+/);
  const pattern = quoted || tokens.find(part => !part.startsWith('-')) || '';
  const scope = quoted ? remainder.slice(remainder.indexOf(quoted) + quoted.length + 1).trim() : tokens.slice(tokens.indexOf(pattern) + 1).join(' ');
  return { tool: match[1], pattern, scope: truncate(scope, 60) };
}

function searchMatches(text: string): SearchMatch[] {
  const groups = new Map<string, SearchMatch>();
  for (const line of text.split('\n')) {
    const match = /^(.+?):(\d+):\s?(.*)$/.exec(line);
    if (!match) continue;
    const group = groups.get(match[1]) || { file: match[1], lines: [] };
    group.lines.push({ number: Number(match[2]), text: match[3] }); groups.set(match[1], group);
  }
  return [...groups.values()];
}

function dshSummary(name: string, args: Fields, data?: Fields) {
  const states: Record<string, string> = { queued: '排队中', starting: '启动中', running: '运行中', waiting_input: '等待输入',
    completed: '已完成', failed: '失败', stopped: '已停止', interrupted: '已中断', message: '有新消息', input: '等待输入', timeout: '超时', cancelled: '已取消' };
  const task = str(args.name) || str(args.task) || str(data?.name);
  const reason = str(data?.reason), state = str(data?.status);
  if (/spawn$/.test(name)) return { title: '派发任务', hint: task || str(data?.agentId) || '', meta: state ? states[state] || state : '已接受' };
  if (/wait$/.test(name)) {
    const events = Array.isArray(data?.events) ? data.events.filter(asRecord) : [];
    const changed = events.filter(event => event.kind === 'message' || event.kind === 'completion' || event.kind === 'input');
    const agents = Array.isArray(data?.agents) ? data.agents.filter(asRecord) : [];
    return { title: '等待任务', hint: task || str(agents[0]?.name) || '',
      meta: changed.length ? `${changed.length} 条新增变化${reason ? ` · ${states[reason] || reason}` : ''}` : reason === 'timeout' ? '暂无新增变化' : reason ? states[reason] || reason : '等待中' };
  }
  if (/result$/.test(name)) return { title: '读取任务结果', hint: task || '', meta: state ? states[state] || state : '已读取' };
  return { title: '读取任务', hint: task || '', meta: state ? states[state] || state : '已读取' };
}

export function presentTool(call: ToolCall, result?: Message, startedAt?: number, runStatus?: Status): ToolView {
  const args = parseToolArgs(call.arguments), name = call.name, raw = unwrapOutput(result);
  const status = statusOf(result, runStatus), elapsed = duration(startedAt, result);
  const base = { rawName: name, status, output: raw.text, transformed: raw.transformed };
  const command = str(args.command) || str(args.cmd) || str(args.script) || call.display?.command;
  const isShell = name === 'bash' || name === 'exec_command' || name === 'shell';
  const failed = status === 'failed' ? firstError(raw.text || result?.error || '') : undefined;
  if (isShell && command) {
    const read = readCommand(command), search = searchCommand(command);
    if (read && !/\b(?:test|build|install)\b/.test(command)) {
      const hint = `${read.paths.join('、')}${read.range ? ` · ${read.range}` : ''}`;
      return { ...base, kind: 'file', title: '读取文件', hint, paths: read.paths,
        meta: [elapsed, result ? outputSummary(result.text, result.textTotal) : '执行中'].filter(Boolean).join(' · '), command,
        errorLine: failed };
    }
    if (search && !/\b(?:test|build|install)\b/.test(command)) {
      const matches = searchMatches(raw.text);
      const partial = !!result?.truncated || !!result?.textTotal && result.textTotal > result.text.length;
      const count = matches.length ? `${partial ? '已显示' : '命中'} ${matches.length} 个文件` : !raw.text.trim() || /^(?:No matches found|无匹配结果)/i.test(raw.text.trim()) ? '无结果' : outputSummary(raw.text, result?.textTotal);
      return { ...base, kind: 'search', title: search.tool === 'ls' || search.tool === 'find' ? '查找文件' : '搜索代码',
        hint: [search.pattern, search.scope].filter(Boolean).join(' · ') || truncate(command), meta: [count, partial ? '输出截断' : '', elapsed].filter(Boolean).join(' · '), matches, command,
        errorLine: failed };
    }
    const title = commandAction(command);
    const summary = title === '运行测试' ? testResult(raw.text)
      : status === 'success' && title === '编译项目' ? '构建成功'
        : status === 'success' && title === '安装插件' ? '已安装'
          : status === 'success' && title === '打包插件' ? '打包成功' : undefined;
    const exit = result?.exitCode !== undefined ? `退出码 ${result.exitCode}` : result ? `退出：${status === 'failed' ? '失败' : status === 'interrupted' ? '中断' : status === 'partial' ? '部分结果' : '成功'}` : '执行中';
    return { ...base, kind: 'command', title, hint: truncate(command), command,
      meta: [failed ? truncate(failed, 75) : summary, elapsed, exit, call.display?.commandTruncated ? '命令截断' : '', result?.truncated ? '输出截断' : ''].filter(Boolean).join(' · '), errorLine: failed };
  }
  if (['edit', 'write', 'apply_patch'].includes(name)) {
    const path = str(args.file_path) || str(args.filePath) || str(args.path);
    const paths = call.display?.paths || (path ? [path] : []);
    const changes = call.display?.added !== undefined ? `+${call.display.added} / -${call.display.removed ?? 0} 行` : '';
    return { ...base, kind: 'file', title: '修改文件', hint: paths.join('、') || '文件', paths,
      diff: call.display?.diff, diffTruncated: call.display?.diffTruncated,
      meta: [changes, paths.length > 1 ? `${paths.length} 个文件` : '', elapsed].filter(Boolean).join(' · '), errorLine: failed };
  }
  if (['read', 'read_file'].includes(name)) {
    const path = str(args.file_path) || str(args.filePath) || str(args.path) || call.display?.paths?.[0] || '';
    const offset = num(args.offset) ?? num(args.start_line) ?? num(args.startLine);
    const limit = num(args.limit) ?? num(args.num_lines) ?? num(args.numLines);
    const start = offset !== undefined ? Math.max(1, offset) : undefined;
    const range = start !== undefined ? `${start}${limit !== undefined ? `–${start + limit - 1}` : ''} 行` : '';
    return { ...base, kind: 'file', title: '读取文件', hint: [path, range].filter(Boolean).join(' · '), paths: path ? [path] : [],
      meta: result ? outputSummary(result.text, result.textTotal) : '读取中', errorLine: failed };
  }
  if (['grep', 'rg', 'glob', 'find', 'ls'].includes(name)) {
    const matches = searchMatches(raw.text), pattern = str(args.pattern) || str(args.query) || '';
    const scope = str(args.path) || str(args.cwd) || '';
    const partial = !!result?.truncated || !!result?.textTotal && result.textTotal > result.text.length;
    const count = matches.length ? `${partial ? '已显示' : '命中'} ${matches.length} 个文件` : !raw.text.trim() || /^(?:No matches found|无匹配结果)/i.test(raw.text.trim()) ? '无结果' : outputSummary(raw.text, result?.textTotal);
    return { ...base, kind: 'search', title: name === 'find' || name === 'ls' || name === 'glob' ? '查找文件' : '搜索代码',
      hint: [pattern, scope].filter(Boolean).join(' · '), meta: [count, partial ? '输出截断' : ''].filter(Boolean).join(' · '), matches, errorLine: failed };
  }
  if (/^(?:dsh_)?(?:spawn|wait|read|result)$/.test(name)) {
    const dsh = dshSummary(name, args, raw.data);
    return { ...base, kind: 'dispatch', title: dsh.title, hint: dsh.hint, meta: dsh.meta, errorLine: failed };
  }
  return { ...base, kind: 'other', title: '调用工具', hint: truncate(str(args.name) || name),
    meta: [result ? outputSummary(result.text, result.textTotal) : '执行中', elapsed].filter(Boolean).join(' · '), errorLine: failed };
}
