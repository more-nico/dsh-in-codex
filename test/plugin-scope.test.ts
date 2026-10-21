import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pluginScope, setProjectPluginEnabled } from '../src/plugin-scope.js';
import { enableProject, managerFixture } from './helpers.js';

async function fixture(t: any) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-scope-'));
  const home = join(root, 'codex'), project = join(root, 'project'), neighbor = join(root, 'neighbor');
  await mkdir(join(home, 'plugins', 'dsh-in-codex'), { recursive: true });
  await writeFile(join(home, 'plugins', 'dsh-in-codex', '.dsh-in-codex-install.json'), '{"version":"0.1.0"}');
  await mkdir(project); await mkdir(neighbor);
  await writeFile(join(home, 'config.toml'), '[plugins."dsh-in-codex@local-plugins"]\nenabled = true\n' +
    `[projects."${project}"]\ntrust_level = "trusted"\n`);
  t.after(() => rm(root, { recursive: true, force: true }));
  return { home, project, neighbor };
}

test('new projects cannot use DSH even when the global panel is enabled', async t => {
  const { home, project } = await fixture(t);
  const scope = await pluginScope(project, home);
  assert.equal(scope.user.enabled, true);
  assert.equal(scope.effective.enabled, false);
});

test('enable and disable affect only the selected project and keep global discovery enabled', async t => {
  const { home, project, neighbor } = await fixture(t);
  const enabled = await setProjectPluginEnabled('enable', project, home);
  assert.equal(enabled.status.effective.enabled, true);
  assert.equal(enabled.status.user.enabled, true);
  assert.equal((await pluginScope(neighbor, home)).effective.enabled, false);
  const disabled = await setProjectPluginEnabled('disable', project, home);
  assert.equal(disabled.status.effective.enabled, false);
  assert.equal(disabled.status.user.enabled, true);
  assert.match(await readFile(join(project, '.codex', 'config.toml'), 'utf8'), /enabled = false/);
});

test('disabled chats cannot execute tasks, probe models or read history by changing task cwd', async t => {
  const { root, call } = await managerFixture(t);
  const other = join(root, 'other');
  await enableProject(other);
  await setProjectPluginEnabled('disable', root);
  await assert.rejects(call('dsh_spawn', { name: 'blocked', task: 'blocked', cwd: other }), /未启用/);
  await assert.rejects(call('dsh_models'), /未启用/);
  await assert.rejects(call('dsh_read', { agentId: 'not-owned' }), /未启用/);
  assert.equal((await call('dsh_panel')).projectEnabled, false);
});
