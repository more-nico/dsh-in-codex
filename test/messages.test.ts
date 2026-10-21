import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Agent, Message } from '../src/types.js';
import { completedSummary, mergeOlder, mergeWindow, MESSAGE_PAGE, visibleMessages } from '../web/messages.js';

const message = (id: string, text = id, complete = true): Message => ({ id, runId: 'run', role: 'assistant', text, complete, timestamp: 0 });
const agent = (id: string, createdAt: number, messages: Message[]): Agent => ({ id, threadId: 'chat', name: id, cwd: '/tmp', status: 'running', runId: 'run', task: '', activity: 'thinking', createdAt, messages, tokens: 0, toolUses: 0, dialogs: [], queued: [], pendingMessages: 0 });
const sequence = (start: number, count: number) => Array.from({ length: count }, (_, index) => message(`#${String(start + index).padStart(3, '0')}`));

test('completed summaries use the persisted current-run result even outside the message window', () => {
  const item = agent('a', 1, [{ ...message('tool'), role: 'toolResult', text: 'tool output' }]);
  item.status = 'completed'; item.finalText = '**Final summary**';
  assert.equal(completedSummary(item), '**Final summary**');
});

test('partial messages replace in place instead of duplicating', () => {
  const merged = mergeWindow([message('m0'), message('m1', 'half', false)], [message('m0'), message('m1', 'done', true)]);
  assert.equal(merged.length, 2);
  assert.deepEqual(merged[1], message('m1', 'done', true));
});

test('older pages dedupe overlaps and the live tail wins same-id updates', () => {
  const older = mergeOlder([], sequence(50, MESSAGE_PAGE));
  const overlap = mergeOlder(older, sequence(20, MESSAGE_PAGE));
  assert.equal(overlap.length, 80);
  assert.equal(overlap[0].id, '#020');
  assert.equal(overlap.at(-1)!.id, '#099');
  const visible = visibleMessages(overlap, [message('#050', 'updated'), message('#100')]);
  assert.equal(visible.length, 81);
  assert.equal(visible.filter(item => item.id === '#050').length, 1);
  assert.equal(visible.find(item => item.id === '#050')!.text, 'updated');
  assert.equal(visible.at(-1)!.id, '#100');
});
