import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Agent } from '../src/types.js';
import { selectAgent } from '../web/selection.js';

const agent = (id: string, status: Agent['status'], createdAt: number, extra: Partial<Agent> = {}): Agent => ({
  id, status, createdAt, threadId: 'chat', runId: id, name: id, task: '', cwd: '/tmp',
  activity: status, messages: [], tokens: 0, toolUses: 0, dialogs: [], queued: [], pendingMessages: 0, ...extra,
});

test('new tasks and status changes keep the task the user is already reading', () => {
  const items = [agent('reading', 'completed', 1), agent('live', 'running', 2)];
  assert.equal(selectAgent(items, 'reading'), 'reading');
  assert.equal(selectAgent([...items, agent('newer', 'running', 3)], 'reading'), 'reading');
  assert.equal(selectAgent(items, 'live'), 'live');
});
