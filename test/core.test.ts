import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Manager } from '../src/manager.js';
import { Store } from '../src/store.js';
import { managerFixture as fixture, waitFor as until, fake } from './helpers.js';
import { resolveThread } from '../src/schemas.js';

test('thread identity never falls back to a shared process or project', () => {
  assert.equal(resolveThread({ 'x-codex-turn-metadata': JSON.stringify({ thread_id: 'a' }) }), 'a');
  assert.throws(() => resolveThread({ 'openai/session': 'opaque', cwd: '/same/project' }), /did not supply/);
  assert.throws(() => resolveThread({ threadId: 'a', 'x-codex-turn-metadata': { thread_id: 'b' } }), /Conflicting/);
});

test('same-directory chats cannot list, read, steer, stop, reply to or acknowledge each other', async t => {
  const { manager } = await fixture(t);
  const child = await manager.spawn('a', { name: '隔离', task: 'normal' });
  assert.equal(manager.snapshot('b').agents.length, 0);
  assert.throws(() => manager.read('b', child.agentId), /current conversation/);
  await assert.rejects(manager.send('b', child.agentId, 'x'), /current conversation/);
  await assert.rejects(manager.stop('b', child.agentId), /current conversation/);
  await assert.rejects(manager.reply('b', child.agentId, 'x'), /current conversation/);
  await manager.wait('a', [child.agentId], 3000);
  const completion = manager.store.data.completions[0];
  await assert.rejects(manager.acknowledge('b', [completion.id]), /current conversation/);
});

test('accepted prompts and agent_end do not complete before retry/compaction settles', async t => {
  const { manager } = await fixture(t);
  const child = await manager.spawn('a', { name: 'retry', task: 'retry' });
  const early = await manager.wait('a', [child.agentId], 100);
  assert.equal(early.timedOut, true); assert.equal(manager.store.data.completions.length, 0);
  const settled = await manager.wait('a', [child.agentId], 3000);
  assert.equal(settled.agents[0].status, 'completed'); assert.match(settled.agents[0].result!.text, /你好/);
  assert.equal(manager.store.data.completions.length, 1);
});

test('extension dialogs enter waiting_input and only their owner may respond', async t => {
  const { manager } = await fixture(t);
  const child = await manager.spawn('a', { name: 'input', task: 'dialog' });
  const waiting = await manager.wait('a', [child.agentId], 3000);
  assert.equal(waiting.agents[0].status, 'waiting_input');
  await manager.reply('a', child.agentId, waiting.agents[0].dialogs[0].id, '输入已收到');
  const result = await manager.wait('a', [child.agentId], 3000);
  assert.equal(result.agents[0].result!.text, '输入已收到');
});

test('malformed protocol, provider errors and crashes produce partial failures', async t => {
  const { manager } = await fixture(t);
  for (const scenario of ['malformed', 'fail', 'crash']) {
    const child = await manager.spawn('a', { name: scenario, task: scenario });
    const result = await manager.wait('a', [child.agentId], 3000);
    assert.equal(result.agents[0].status, 'failed', scenario); assert.equal(result.agents[0].result!.partial, true);
  }
});

test('hook delivery is atomic per turn; unacknowledged results reappear on a later turn', async t => {
  const { manager } = await fixture(t);
  const child = await manager.spawn('a', { name: 'delivery', task: 'normal' });
  await manager.wait('a', [child.agentId], 3000);
  const deliveries = await Promise.all([manager.deliveries('a', 'turn-1'), manager.deliveries('a', 'turn-1')]);
  assert.equal(deliveries.flat().length, 1);
  const next = await manager.deliveries('a', 'turn-2'); assert.equal(next.length, 1);
  await manager.acknowledge('a', [next[0].id]); await manager.acknowledge('a', [next[0].id]);
  assert.equal((await manager.deliveries('a', 'turn-3')).length, 0);
});

test('restart restores transcripts and marks unfinished work interrupted', async t => {
  const { manager, root } = await fixture(t);
  const child = await manager.spawn('a', { name: 'restore', task: 'hold' });
  await until(() => manager.snapshot('a').agents[0].messages.length >= 2);
  await manager.store.save();
  const recovered = new Manager(new Store(root), { executable: process.execPath, prefixArgs: [fake] });
  await manager.close(); await recovered.init();
  assert.equal(recovered.read('a', child.agentId).status, 'interrupted');
  assert.ok(recovered.read('a', child.agentId).messages.length > 0);
  const next = await recovered.send('a', child.agentId, 'normal');
  assert.notEqual(next.runId, child.runId);
  await recovered.wait('a', [child.agentId], 3000); await recovered.close();
});

test('soft interrupt retains a responsive DSH process, while stop releases it and preserves history', async t => {
  const { manager, call } = await fixture(t);
  const child = await call('dsh_spawn', { name: 'interrupt', task: 'hold' });
  await until(() => manager.read('a', child.agentId).messages.length > 1);
  const result = await call('dsh_interrupt', { agentId: child.agentId });
  assert.equal(result.status, 'stopped'); assert.equal(result.processRetained, true);
  assert.equal(manager.store.data.completions[0].partial, true);
  await call('dsh_stop', { agentId: child.agentId });
  assert.equal((await call('dsh_interrupt', { agentId: child.agentId })).processRetained, false);
  assert.ok(manager.read('a', child.agentId).messages.length > 0);
});

test('a busy chat cannot consume other chats slots and scheduling alternates eligible chats', async t => {
  const { manager, call } = await fixture(t, { maxConcurrent: 2, maxPerThread: 1 });
  const a1 = await call('dsh_spawn', { name: 'a1', task: 'hold' });
  const a2 = await call('dsh_spawn', { name: 'a2', task: 'hold' });
  const b1 = await call('dsh_spawn', { name: 'b1', task: 'hold' }, 'b');
  const c1 = await call('dsh_spawn', { name: 'c1', task: 'hold' }, 'c');
  await until(() => manager.read('a', a1.agentId).messages.length > 1 && manager.read('b', b1.agentId).messages.length > 1);
  assert.equal(manager.list('a').agents.find(agent => agent.id === a2.agentId)!.queueReason, 'chat_limit');
  await call('dsh_stop', { agentId: a1.agentId });
  await until(() => manager.read('c', c1.agentId).messages.length > 1);
  assert.equal(manager.read('a', a2.agentId).status, 'queued');
});
