import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile, rm, realpath, readFile, access } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { Manager } from '../src/manager.js';
import { Store } from '../src/store.js';
import { ensureDshProfile } from '../scripts/profile.mjs';
let executable: string | undefined;
try { executable = execFileSync('/bin/sh', ['-c', 'command -v dsh'], { encoding: 'utf8' }).trim(); } catch {}
const bridge = fileURLToPath(new URL('../extensions/parent.mjs', import.meta.url));
async function fixture(t: any) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-native-'));
  const saved = { home: process.env.DSH_HOME, anchor: process.env.DSH_TEST_ANCHOR, telemetry: process.env.DSH_TELEMETRY_DISABLED };
  process.env.DSH_HOME = join(root, 'home');
  process.env.DSH_TELEMETRY_DISABLED = '1';
  process.env.DSH_TEST_ANCHOR = join(dirname(dirname(await realpath(executable!))), 'package.json');
  const patch = join(root, 'mock.patch.yml');
  await writeFile(patch, JSON.stringify([
    { id: 'agent-default-model', config: { provider: 'codex-test', model: 'mock' } },
    { insert: [{ id: 'codex-test-model', name: fileURLToPath(new URL('./fixtures/native-model.mjs', import.meta.url)) }] },
  ]));
  const manager = new Manager(new Store(join(root, 'data')), { executable, extraArgs: ['--patch', patch], extensionPath: bridge });
  await manager.init(); await manager.register({ threadId: 'native', cwd: root, updatedAt: Date.now() });
  t.after(async () => {
    await manager.close();
    if (saved.home === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = saved.home;
    if (saved.telemetry === undefined) delete process.env.DSH_TELEMETRY_DISABLED; else process.env.DSH_TELEMETRY_DISABLED = saved.telemetry;
    if (saved.anchor === undefined) delete process.env.DSH_TEST_ANCHOR; else process.env.DSH_TEST_ANCHOR = saved.anchor;
    await rm(root, { recursive: true, force: true });
  });
  const wait = async (id: string) => {
    const result = await manager.wait('native', [id], 15000, undefined, { wakeOnMessages: false });
    assert.notEqual(result.reason, 'timeout', JSON.stringify(manager.list('native')));
    return result.agents[0];
  };
  return { root, manager, wait };
}

test('real DSH: models, native tools, reports, reply, cancellation, resume and guards', { skip: !executable, timeout: 90000 }, async t => {
  const { manager, root, wait } = await fixture(t);
  const models = await manager.models('native');
  await access(join(root, 'home/profiles/dsh_in_codex/package.json'));
  await assert.rejects(access(join(root, 'home/profiles/sdk')));
  assert.equal(models.selected?.provider, 'codex-test');
  assert.deepEqual(models.thinkingLevels, ['high', 'max']);
  const spawn = async (task: string, profile: 'worker' | 'reviewer' | 'explorer' = 'worker') => manager.spawn('native', { name: task.slice(0, 40), task, profile });
  const first = await spawn('REMEMBER:中文✓');
  let result = await wait(first.agentId);
  assert.equal(result.status, 'completed', JSON.stringify(result));
  assert.match(result.result!.text, /中文✓/);
  assert.ok(manager.list('native').agents[0].tokens >= 12);
  await manager.archive('native', first.agentId);
  await manager.send('native', first.agentId, 'RECALL');
  result = await wait(first.agentId);
  assert.equal(result.status, 'completed', JSON.stringify(result));
  assert.match(result.result!.text, /REMEMBER:中文✓/);
  const write = await spawn('TOOL:write:' + JSON.stringify({ file_path: join(root, 'written.txt'), content: 'NATIVE_WRITE_OK' }));
  result = await wait(write.agentId);
  assert.equal(result.status, 'completed', JSON.stringify(result));
  assert.equal(await readFile(join(root, 'written.txt'), 'utf8').catch(() => JSON.stringify(manager.read('native', write.agentId, 200, true))), 'NATIVE_WRITE_OK');
  const report = await spawn('TOOL:dsh_report:{"message":"NATIVE_REPORT_OK"}');
  result = await wait(report.agentId);
  assert.equal(result.status, 'completed', JSON.stringify(result));
  assert.ok(manager.events('native').events.some(e => e.kind === 'message' && e.text === 'NATIVE_REPORT_OK'));
  const inspect = await spawn('TOOL:write:' + JSON.stringify({ file_path: join(root, 'forbidden.txt'), content: 'NO' }), 'reviewer');
  result = await wait(inspect.agentId);
  assert.equal(result.status, 'completed', JSON.stringify(result));
  await assert.rejects(access(join(root, 'forbidden.txt')));
  assert.ok(manager.read('native', inspect.agentId, 200, true).messages.some(m => m.isError));
  const held = await spawn('HOLD');
  await until(() => manager.read('native', held.agentId, 200).messages.some(m => m.role === 'user'));
  const interrupted = await manager.interrupt('native', held.agentId);
  assert.ok('processRetained' in interrupted); assert.equal(interrupted.processRetained, true);
  await manager.send('native', held.agentId, 'AFTER_INTERRUPT');
  assert.equal((await wait(held.agentId)).status, 'completed');
  const question = await spawn('TOOL:ask_user_question:' + JSON.stringify({ questions: [{ id: 'q1', header: 'Choice', question: 'Choose', options: [{ label: 'A', description: 'First' }, { label: 'B', description: 'Second' }], multi_select: true }] }));
  const waiting = await manager.wait('native', [question.agentId], 15000);
  assert.equal(waiting.reason, 'input', JSON.stringify(waiting));
  const dialog = waiting.agents[0].dialogs[0];
  await assert.rejects(manager.reply('native', question.agentId, dialog.id, '["invalid"]'));
  await manager.reply('native', question.agentId, dialog.id, '["A","B"]');
  result = await wait(question.agentId);
  assert.equal(result.status, 'completed', JSON.stringify(result));
  assert.match(result.result!.text, /A/);
  const batchQuestion = await spawn('TOOL:ask_user_question:' + JSON.stringify({ questions: [{ id: 'one', question: 'First?' }, { id: 'two', question: 'Second?' }] }));
  const batchWait = await manager.wait('native', [batchQuestion.agentId], 15000);
  assert.equal(batchWait.reason, 'input');
  await until(() => manager.list('native').agents.find(a => a.id === batchQuestion.agentId)!.dialogs.length === 2);
  await manager.reply('native', batchQuestion.agentId, batchWait.agents[0].dialogs[0].id, undefined, undefined, true);
  assert.equal((await wait(batchQuestion.agentId)).status, 'completed');
  assert.equal(manager.list('native').agents.find(a => a.id === batchQuestion.agentId)!.dialogs.length, 0);
  const permission = await spawn('TOOL:native_permission:{}');
  const permissionWait = await manager.wait('native', [permission.agentId], 15000);
  assert.equal(permissionWait.reason, 'input', JSON.stringify(permissionWait));
  assert.equal(permissionWait.agents[0].dialogs[0].method, 'confirm');
  await manager.reply('native', permission.agentId, permissionWait.agents[0].dialogs[0].id, undefined, true);
  result = await wait(permission.agentId);
  assert.match(result.result!.text, /allowed-once/);
  const bypass = await spawn('TOOL:bypass_write:' + JSON.stringify({ path: join(root, 'bypass.txt') }), 'explorer');
  result = await wait(bypass.agentId);
  assert.equal(result.status, 'completed', JSON.stringify(result));
  await assert.rejects(access(join(root, 'bypass.txt')));
  assert.match(result.result!.text, /Inspection profile/);
  const override = await manager.spawn('native', { name: 'reasoning', task: 'EFFORT', model: { provider: 'codex-test', id: 'mock', thinking: 'max' } });
  assert.equal((await wait(override.agentId)).status, 'completed');
  assert.equal(manager.list('native').agents.find(a => a.id === override.agentId)?.model?.thinking, 'max');
  const limited = await manager.spawn('native', { name: 'model output cap', task: 'LIMITED', model: { provider: 'codex-test', id: 'limited' } });
  assert.equal((await wait(limited.agentId)).status, 'completed');
  const slow = await spawn('SLOW_ORIGINAL');
  await until(() => manager.read('native', slow.agentId, 200).messages.some(m => m.role === 'user' && m.text === 'SLOW_ORIGINAL'));
  await manager.messageParentToChild('native', slow.agentId, 'STEER_NATIVE_OK');
  await manager.send('native', slow.agentId, 'FOLLOWUP_NATIVE_OK', 'followUp');
  result = await wait(slow.agentId);
  assert.equal(result.status, 'completed', JSON.stringify(result));
  assert.match(result.result!.text, /FOLLOWUP_NATIVE_OK/);
  assert.ok(manager.read('native', slow.agentId, 200).messages.some(m => m.text === 'STEER_NATIVE_OK'));
  await manager.messageParentToChild('native', slow.agentId, 'PARKED_NATIVE');
  assert.equal(manager.list('native').agents.find(a => a.id === slow.agentId)?.status, 'completed');
  await manager.send('native', slow.agentId, 'RECALL');
  assert.match((await wait(slow.agentId)).result!.text, /PARKED_NATIVE/);
  const stopped = await spawn('HOLD');
  await until(() => manager.read('native', stopped.agentId, 200).messages.some(m => m.role === 'user'));
  await manager.stop('native', stopped.agentId);
  await manager.send('native', stopped.agentId, 'AFTER_STOP');
  assert.equal((await wait(stopped.agentId)).status, 'completed');
  const crashed = await spawn('HOLD');
  await until(() => manager.read('native', crashed.agentId, 200).messages.some(m => m.role === 'user'));
  (manager as any).processes.get(crashed.agentId).child.kill('SIGKILL');
  assert.equal((await wait(crashed.agentId)).status, 'failed');
  await manager.send('native', crashed.agentId, 'AFTER_CRASH');
  assert.equal((await wait(crashed.agentId)).status, 'completed');
  const marker = join(root, 'descendant-finished');
  process.env.DSH_TEST_DESCENDANT_MARKER = marker;
  t.after(() => { delete process.env.DSH_TEST_DESCENDANT_MARKER; });
  const nested = await spawn('TOOL:subagent:' + JSON.stringify({ description: 'Native child convergence', prompt: 'SLOW_CHILD' }));
  result = await wait(nested.agentId);
  assert.equal(result.status, 'completed', JSON.stringify(result));
  assert.equal(await readFile(marker, 'utf8').catch(() => JSON.stringify(manager.read('native', nested.agentId, 200, true))), 'CHILD_DONE');
  const failed = await spawn('FAIL');
  assert.equal((await wait(failed.agentId)).status, 'failed');
});
async function until(predicate: () => boolean, timeout = 15000) {
  const end = Date.now() + timeout;
  while (!predicate()) { if (Date.now() > end) throw new Error('Native DSH condition timed out'); await new Promise(resolve => setTimeout(resolve, 20)); }
}

test('model migration imports adapter/default rows into the dedicated profile and preserves other profiles', { skip: !executable }, async t => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-model-import-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const env = { ...process.env, DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1', DSH_IN_CODEX_DSH_PATH: executable };
  const { mkdir, stat } = await import('node:fs/promises');
  await mkdir(join(home, 'profiles/web'), { recursive: true });
  await mkdir(join(home, 'profiles/sdk'), { recursive: true });
  await writeFile(join(home, 'profiles/sdk/cordis.patch.yml'), 'SDK_PROFILE_UNCHANGED');
  await ensureDshProfile(home);
  const before = JSON.stringify([{ id: 'unrelated-setting', config: { retain: true } }, { id: 'llm-pi-ai', config: { providers: { old: { apiKeyEnv: 'OLD_TEST_KEY', models: [] } } } }]);
  await writeFile(join(home, 'profiles/dsh_in_codex/cordis.patch.yml'), before);
  await writeFile(join(home, 'profiles/web/cordis.patch.yml'), JSON.stringify([
    { id: 'ui-settings-general', name: '@deepseek-ai/dsh-client-ui-settings-general', config: { irrelevant: true } },
    { id: 'llm-pi-ai', name: '@deepseek-ai/dsh-llm-pi-ai', config: { providers: { imported: { apiKeyEnv: 'MIGRATION_TEST_KEY', models: [] } } } },
    { id: 'agent-default-model', name: '@deepseek-ai/dsh-agent-default-model', config: { provider: 'imported', model: 'test' } },
  ]));
  const output = execFileSync(process.execPath, [fileURLToPath(new URL('../scripts/import-web-models.mjs', import.meta.url))], { env, encoding: 'utf8' });
  const report = JSON.parse(output);
  assert.equal(report.target, join(home, 'profiles/dsh_in_codex/cordis.patch.yml'));
  assert.equal(await readFile(join(home, 'profiles/sdk/cordis.patch.yml'), 'utf8'), 'SDK_PROFILE_UNCHANGED');
  assert.deepEqual(report.importedIds, ['llm-pi-ai', 'agent-default-model']);
  assert.equal(await readFile(report.backup, 'utf8'), before);
  assert.equal((await stat(report.target)).mode & 0o777, 0o600);
  const target = await readFile(report.target, 'utf8');
  assert.match(target, /unrelated-setting/); assert.match(target, /OLD_TEST_KEY/); assert.match(target, /MIGRATION_TEST_KEY/);
  assert.doesNotMatch(target, /ui-settings-general/);
  assert.doesNotMatch(output, /OLD_TEST_KEY|MIGRATION_TEST_KEY/);
});
