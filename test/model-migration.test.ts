import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import yaml from 'js-yaml';
import { inspectMigrationSource, listMigrationProfiles, migrateModels } from '../src/model-migration.js';

const adapter = 'llm-pi-ai';
const row = (providers: Record<string, unknown>) => ({ id: adapter, name: '@deepseek-ai/dsh-llm-pi-ai', config: { providers } });
const provider = (api: string, ids: string[]) => ({ api, baseURL: `https://${api}.example`, models: ids.map(id => ({ id, name: `Name ${id}`, contextWindow: 123 })) });

test('model migration lists profiles, disables existing IDs, and appends without replacing provider settings', async t => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-migration-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const source = join(home, 'profiles', 'web'), target = join(home, 'profiles', 'dsh_in_codex');
  await Promise.all([mkdir(source, { recursive: true }), mkdir(target, { recursive: true })]);
  await writeFile(join(target, 'package.json'), '{}');
  const sourceRows = [row({ shared: provider('source', ['existing', 'new']), fresh: provider('fresh', ['fresh-model']) }),
    { id: 'agent-default-model', config: { provider: 'shared', model: 'new' } }];
  const targetRows = [row({ shared: provider('target', ['existing']) }), { id: 'other-settings', config: { value: 42 } }];
  await writeFile(join(source, 'cordis.patch.yml'), yaml.dump(sourceRows));
  await writeFile(join(target, 'cordis.patch.yml'), yaml.dump(targetRows));

  assert.deepEqual(await listMigrationProfiles(home), ['web']);
  const inspected = await inspectMigrationSource('web', home);
  assert.deepEqual(inspected.providers.map(item => [item.id, item.models.map(model => [model.id, model.configured])]), [
    ['shared', [['existing', true], ['new', false]]], ['fresh', [['fresh-model', false]]],
  ]);
  const result = await migrateModels('web', [
    { adapter, provider: 'shared', models: ['new'] },
    { adapter, provider: 'fresh', models: ['fresh-model'] },
  ], home);
  assert.equal(result.imported, 2);
  assert.deepEqual(yaml.load(await readFile(result.backup, 'utf8')), targetRows);
  const merged: any = yaml.load(await readFile(join(target, 'cordis.patch.yml'), 'utf8'));
  assert.equal(merged[0].config.providers.shared.api, 'target');
  assert.equal(merged[0].config.providers.shared.baseURL, 'https://target.example');
  assert.deepEqual(merged[0].config.providers.shared.models.map((model: any) => model.id), ['existing', 'new']);
  assert.equal(merged[0].config.providers.shared.models[1].contextWindow, 123);
  assert.equal(merged[0].config.providers.fresh.api, 'fresh');
  assert.deepEqual(merged[1], targetRows[1]);
  assert.equal(merged.some((item: any) => item.id === 'agent-default-model'), false);
  assert.equal((await readdir(target)).filter(name => name.endsWith('.bak')).length, 1);
  assert.equal((await inspectMigrationSource('web', home)).providers[0].models[1].configured, true);
});

test('migration rejects stale duplicate IDs and invalid profile names without changing target', async t => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-migration-errors-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const source = join(home, 'profiles', 'sdk'), target = join(home, 'profiles', 'dsh_in_codex');
  await Promise.all([mkdir(source, { recursive: true }), mkdir(target, { recursive: true })]);
  await writeFile(join(target, 'package.json'), '{}');
  await writeFile(join(source, 'cordis.patch.yml'), yaml.dump([row({ same: provider('source', ['duplicate']) })]));
  const original = yaml.dump([row({ same: provider('target', ['duplicate']) })]);
  await writeFile(join(target, 'cordis.patch.yml'), original);
  await assert.rejects(migrateModels('sdk', [{ adapter, provider: 'same', models: ['duplicate'] }], home), /已配置/);
  await assert.rejects(inspectMigrationSource('../sdk', home), /有效/);
  assert.equal(await readFile(join(target, 'cordis.patch.yml'), 'utf8'), original);
  assert.equal((await readdir(target)).filter(name => name.endsWith('.bak')).length, 0);
});
