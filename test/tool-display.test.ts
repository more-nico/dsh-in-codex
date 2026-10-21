import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Message, ToolCall } from '../src/types.js';
import { toolDisplayMetadata } from '../src/tool-metadata.js';
import { presentTool } from '../web/tool-display.js';

const call = (name: string, args: object, display?: ToolCall['display']): ToolCall => ({ id: 'call', name, arguments: JSON.stringify(args), display });
const result = (text: string, extra: Partial<Message> = {}): Message => ({ id: 'result', runId: 'run', role: 'toolResult', toolCallId: 'call', text,
  timestamp: 2500, complete: true, ...extra });

test('command cards show actions, test totals, duration, exit status, and failure location', () => {
  const tested = presentTool(call('bash', { command: 'npm test' }), result('ℹ tests 24\nℹ pass 24\nℹ fail 0', { exitCode: 0 }), 1000);
  assert.equal(tested.title, '运行测试');
  assert.match(tested.meta, /24 项通过 · 0 失败/);
  assert.match(tested.meta, /约 1\.5 秒/);
  assert.match(tested.meta, /退出码 0/);
  const failed = presentTool(call('exec_command', { cmd: 'npm run build' }), result('src/app.ts:35:9: error TS2322\nother output', { exitCode: 1 }), 1000);
  assert.equal(failed.status, 'failed');
  assert.match(failed.meta, /src\/app\.ts:35:9/);
  assert.equal(failed.errorLine, 'src/app.ts:35:9: error TS2322');
  assert.equal(presentTool(call('bash', { command: 'npm run build' }), result('done')).meta.includes('构建成功'), true);
  const packaged = presentTool(call('bash', { command: 'npm run pack:plugin' }), result('Packaged release/archive.zip', { exitCode: 0 }));
  assert.equal(packaged.title, '打包插件');
  assert.match(packaged.meta, /打包成功/);
});

test('file edits retain paths, counts and a bounded diff when raw arguments are clipped', () => {
  const metadata = toolDisplayMetadata('write', { file_path: 'src/new.ts', content: 'a\n'.repeat(6000) })!;
  assert.deepEqual(metadata.paths, ['src/new.ts']);
  assert.equal(metadata.added, 6000);
  assert.equal(metadata.diffTruncated, true);
  const view = presentTool({ id: 'write', name: 'write', arguments: '{"file_path":"src/new.ts","content":"', display: metadata }, result('ok'));
  assert.equal(view.title, '修改文件');
  assert.match(view.meta, /\+6000 \/ -0 行/);
  assert.equal(view.diff?.startsWith('+a'), true);
  const patch = toolDisplayMetadata('apply_patch', { patch: '*** Update File: src/a.ts\n-old\n+new\n*** Add File: src/b.ts\n+second\n' })!;
  assert.deepEqual(patch.paths, ['src/a.ts', 'src/b.ts']);
  assert.equal(patch.added, 2);
  assert.equal(patch.removed, 1);
});

test('reads, searches and structured tool output receive compact summaries without duplication', () => {
  const read = presentTool(call('read', { file_path: 'src/manager.ts', offset: 323, limit: 63 }), result('source'));
  assert.equal(read.hint, 'src/manager.ts · 323–385 行');
  const search = presentTool(call('rg', { pattern: 'agentId', path: 'src' }), result('src/a.ts:12:first\nsrc/a.ts:20:second\nsrc/b.ts:3:third', { textTotal: 100 }));
  assert.equal(search.title, '搜索代码');
  assert.match(search.meta, /已显示 2 个文件 · 输出截断/);
  assert.deepEqual(search.matches?.map(group => [group.file, group.lines.length]), [['src/a.ts', 2], ['src/b.ts', 1]]);
  const data = presentTool(call('dsh_result', { completionId: 'x' }), result(JSON.stringify({
    content: [{ type: 'text', text: 'duplicate' }], structuredContent: { status: 'completed', text: 'answer' },
  })));
  assert.match(data.output, /"status": "completed"/);
  assert.doesNotMatch(data.output, /duplicate|structuredContent/);
});

test('wait summaries report only new events and tool statuses distinguish pending, partial and interrupted', () => {
  const wait = presentTool(call('dsh_wait', { agentIds: ['a'] }), result(JSON.stringify({
    reason: 'message', events: [{ kind: 'message' }, { kind: 'message' }], agents: [{ agentId: 'a', status: 'running', result: { text: 'old snapshot' } }],
  })));
  assert.equal(wait.title, '等待任务');
  assert.match(wait.meta, /2 条新增变化/);
  assert.doesNotMatch(wait.meta, /old snapshot/);
  const pending = presentTool(call('bash', { command: 'npm test' }));
  assert.equal(pending.status, 'running');
  assert.equal(presentTool(call('bash', { command: 'npm test' }), result('half', { complete: false })).status, 'partial');
  assert.equal(presentTool(call('bash', { command: 'npm test' }), undefined, 1000, 'interrupted').status, 'interrupted');
  assert.equal(presentTool(call('bash', { command: 'npm test' }), result('cancelled', { cancelled: true })).status, 'interrupted');
});
