import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Manager } from '../src/manager.js';
import { Store } from '../src/store.js';
import { managerFixture as fixture, fake } from './helpers.js';
import { dispatch } from '../src/daemon.js';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const choice = (thinking?: string) => ({ provider: 'fake', id: 'test-model', ...(thinking === undefined ? {} : { thinking }) });

async function completed(call: (method: string, args?: Record<string, any>, threadId?: string) => Promise<any>, task: string, extra: Record<string, any> = {}) {
  const child = await call('dsh_spawn', { name: task, task, ...extra });
  const waited = await call('dsh_wait', { agentIds: [child.agentId], timeoutMs: 5000 });
  assert.notEqual(waited.reason, 'timeout', JSON.stringify(waited));
  assert.equal(waited.agents[0].status, 'completed', JSON.stringify(waited));
  return child.agentId;
}

test('unconfigured first start uses the 10/5 factory defaults while the 1..32 range stays adjustable', async t => {
  const previous = { concurrent: process.env.DSH_IN_CODEX_CONCURRENCY, thread: process.env.DSH_IN_CODEX_CHAT_CONCURRENCY };
  delete process.env.DSH_IN_CODEX_CONCURRENCY;
  delete process.env.DSH_IN_CODEX_CHAT_CONCURRENCY;
  const root = await mkdtemp(join(tmpdir(), 'dsh-settings-defaults-'));
  const manager = new Manager(new Store(root));
  t.after(async () => {
    await manager.close().catch(() => {});
    if (previous.concurrent === undefined) delete process.env.DSH_IN_CODEX_CONCURRENCY; else process.env.DSH_IN_CODEX_CONCURRENCY = previous.concurrent;
    if (previous.thread === undefined) delete process.env.DSH_IN_CODEX_CHAT_CONCURRENCY; else process.env.DSH_IN_CODEX_CHAT_CONCURRENCY = previous.thread;
    await rm(root, { recursive: true, force: true });
  });
  await manager.init();
  assert.deepEqual(manager.getSettings(), {
    settings: { presets: { slot1: null, slot2: null }, maxConcurrent: 10, maxPerThread: 5 },
    effective: { maxConcurrent: 10, maxPerThread: 5 },
  });
});

test('model discovery shows configured presets and the catalog without a misleading probe selection', async t => {
  const { call } = await fixture(t);
  await call('dsh_settings', { update: { presets: { slot1: choice('high'), slot2: choice('max') } } });
  const discovered = await call('dsh_models');
  assert.deepEqual(Object.keys(discovered), ['presets', 'settings', 'effective', 'all_models']);
  assert.deepEqual(discovered.presets.slot1.model, choice('high'));
  assert.equal(discovered.presets.slot1.source, 'preset');
  assert.equal(discovered.presets.slot2.name, '增强模型');
  assert.deepEqual(discovered.all_models, [{ provider: 'fake', id: 'test-model', name: 'Test model',
    contextWindow: 1000000, input: ['text', 'image'], reasoningEfforts: ['off', 'high', 'max'] }]);
  const probed = await call('dsh_models', { model: { provider: 'fake', id: 'test-model' } });
  assert.deepEqual(probed.probe, {
    model: { provider: 'fake', id: 'test-model' }, thinkingLevels: ['off', 'high', 'max'],
  });
  assert.equal('selected' in probed, false);
});

test('agent model lookup distinguishes a stored request from a live process', async t => {
  const { call } = await fixture(t, { maxConcurrent: 1, maxPerThread: 1 });
  const active = await call('dsh_spawn', { name: 'active', task: 'hold' });
  const queued = await call('dsh_spawn', { name: 'queued', task: 'fast', model: choice('max') });
  const view = await call('dsh_models', { agentId: queued.agentId });
  assert.deepEqual(view.agent_model, choice('max'));
  assert.equal(view.agent_model_source, 'stored-task-state');
  assert.equal('thinkingLevels' in view, false);
  await call('dsh_stop', { agentId: queued.agentId });
  await call('dsh_stop', { agentId: active.agentId });
});

test('a silently ignored model selection fails the probe and task before prompting', async t => {
  const { call, manager } = await fixture(t, { extraArgs: ['--ignore-set-model'] });
  await assert.rejects(call('dsh_models', { model: { provider: 'fake', id: 'other-model' } }), /did not select the requested model/);
  const child = await call('dsh_spawn', { name: 'wrong model', task: 'fast', model: { provider: 'fake', id: 'other-model' } });
  const waited = await call('dsh_wait', { agentIds: [child.agentId], timeoutMs: 5000 });
  assert.equal(waited.agents[0].status, 'failed');
  assert.match(manager.list('a').agents.find(agent => agent.id === child.agentId)?.error || '', /did not select requested model/);
});

test('a silently ignored thinking level fails the task before prompting', async t => {
  const { call, manager } = await fixture(t, { extraArgs: ['--ignore-set-thinking'] });
  const child = await call('dsh_spawn', { name: 'wrong effort', task: 'fast', model: choice('max') });
  const waited = await call('dsh_wait', { agentIds: [child.agentId], timeoutMs: 5000 });
  assert.equal(waited.agents[0].status, 'failed');
  assert.match(manager.list('a').agents.find(agent => agent.id === child.agentId)?.error || '', /did not select requested thinking level/);
});

test('settings are not saved when DSH ignores the requested thinking level', async t => {
  const { call } = await fixture(t, { extraArgs: ['--ignore-set-thinking'] });
  await assert.rejects(call('dsh_settings', { update: { presets: { slot1: choice('max') } } }), /did not accept thinking level/);
  assert.equal((await call('dsh_settings')).settings.presets.slot1, null);
});

test('settings persist globally, use env/constructor values as first-run defaults, and saved limits win after restart', async t => {
  const { root, manager, call } = await fixture(t, { maxConcurrent: 1, maxPerThread: 1 });
  const initial = await call('dsh_settings', {});
  assert.deepEqual(initial.settings, { presets: { slot1: null, slot2: null }, maxConcurrent: 1, maxPerThread: 1 });
  assert.deepEqual(initial.effective, { maxConcurrent: 1, maxPerThread: 1 });

  const saved = await call('dsh_settings', { update: { maxConcurrent: 2, maxPerThread: 3 } });
  assert.equal(saved.settings.maxConcurrent, 2);
  assert.equal(saved.settings.maxPerThread, 3);
  assert.deepEqual(saved.effective, { maxConcurrent: 2, maxPerThread: 3 });
  assert.deepEqual((await call('dsh_settings', {})).settings, saved.settings);
  const file = JSON.parse(await readFile(join(root, 'settings.json'), 'utf8'));
  assert.equal(file.version, 1);
  assert.deepEqual(file.settings, saved.settings);
  assert.equal((await stat(join(root, 'settings.json'))).mode & 0o777, 0o600);

  await manager.close();
  const restored = new Manager(new Store(root), { executable: process.execPath, prefixArgs: [fake] });
  await restored.init();
  t.after(async () => { await restored.close().catch(() => {}); });
  const payload = await dispatch(restored, { id: 'restored', method: 'dsh_settings', threadId: 'a', args: {} });
  assert.equal(payload.settings.maxConcurrent, 2, 'a persisted setting overrides the 10/5 factory defaults');
  assert.equal(payload.settings.maxPerThread, 3);
  assert.equal(payload.effective.maxConcurrent, 2);


});

test('two presets, native empty-slot fallback, explicit-model precedence, and explicit-model thinking isolation', async t => {
  const { root, manager, call } = await fixture(t);
  await call('dsh_settings', { update: { presets: { slot1: choice('off'), slot2: choice('max') } } });
  const saved = manager.getSettings().settings;
  assert.deepEqual(saved.presets, { slot1: choice('off'), slot2: choice('max') });
  const modelOf = (id: string) => manager.list('a').agents.find(agent => agent.id === id)?.model;

  // No preset and an empty preset both use native DSH; neither is a plugin tier.
  assert.deepEqual(modelOf(await completed(call, 'fast')), choice('high'));
  assert.deepEqual(modelOf(await completed(call, 'fast', { preset: 'slot1' })), choice('off'));
  assert.deepEqual(modelOf(await completed(call, 'fast', { preset: 'slot2' })), choice('max'));
  await call('dsh_settings', { update: { presets: { slot1: null } } });
  assert.deepEqual(modelOf(await completed(call, 'fast', { preset: 'slot1' })), choice('high'));

  // An explicit model without thinking must use this model's native default,
  // never the lower-priority preset's thinking value.
  const explicitNoThinking = await completed(call, 'fast', { preset: 'slot2', model: { provider: 'fake', id: 'test-model' } });
  assert.deepEqual(modelOf(explicitNoThinking), choice('high'));
  const explicitThinking = await completed(call, 'fast', { preset: 'slot2', model: choice('off') });
  assert.deepEqual(modelOf(explicitThinking), choice('off'));

});
