import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { schemas } from '../src/schemas.js';
import { managerFixture as fixture, waitFor as until } from './helpers.js';
import type { Manager } from '../src/manager.js';
const queueDsh = fileURLToPath(new URL('./fixtures/queue-dsh.mjs', import.meta.url));
const userTexts = (manager: Manager, id: string) => manager.read('a', id, 200, false).messages.filter(message => message.role === 'user').map(message => message.text);

test('dsh_send defaults to followUp and never steers: new tasks wait for full convergence, stay FIFO, and produce one completion per round', async t => {
  const { manager, call } = await fixture(t, { prefixArgs: [queueDsh] });
  assert.equal(schemas.dsh_send.parse({ agentId: 'a', message: 'next task' }).mode, 'followUp');
  const child = await call('dsh_spawn', { name: 'queue', task: 'queue-hold' });
  await until(() => userTexts(manager, child.agentId).includes('queue-hold'));

  const one = await call('dsh_send', { agentId: child.agentId, message: 'TASK_ONE' });
  const two = await call('dsh_send', { agentId: child.agentId, message: 'TASK_TWO' });
  const three = await call('dsh_follow_up', { agentId: child.agentId, message: 'TASK_THREE' });
  for (const sent of [one, two, three]) {
    assert.equal(sent.mode, 'followUp');
    assert.equal(sent.runId, child.runId);
    assert.equal(sent.status, 'running');
  }
  // The current round has not converged, so queued tasks were not injected.
  assert.deepEqual(userTexts(manager, child.agentId), ['queue-hold']);
  assert.equal(manager.store.data.completions.length, 0);
  assert.equal(manager.read('a', child.agentId).status, 'running');

  // Explicit steer remains available for a targeted correction, not a new task.
  const release = await call('dsh_send', { agentId: child.agentId, message: 'RELEASE', mode: 'steer' });
  assert.equal(release.mode, 'steer');
  assert.equal(release.runId, child.runId);

  const waited = await call('dsh_wait', { agentIds: [child.agentId], timeoutMs: 5000 });
  assert.equal(waited.reason, 'completed', JSON.stringify(waited));
  assert.equal(waited.agents[0].status, 'completed');
  assert.equal(waited.agents[0].runId, child.runId);
  assert.deepEqual(userTexts(manager, child.agentId).filter(text => text !== 'RELEASE'), ['queue-hold', 'TASK_ONE', 'TASK_TWO', 'TASK_THREE']);
  const completions = manager.store.data.completions.filter(result => result.runId === child.runId);
  assert.equal(completions.length, 1, 'one round must settle exactly once');
  assert.equal(manager.store.data.events.filter(event => event.completionId === completions[0].id).length, 1);
  assert.ok(completions[0].text.includes('TASK_THREE'));
});
