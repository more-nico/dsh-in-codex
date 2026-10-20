import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, access, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureDshProfile } from '../scripts/profile.mjs';

test('concurrent first use creates only the dedicated profile and preserves later configuration', async t => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-profile-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const targets = await Promise.all(Array.from({ length: 12 }, () => ensureDshProfile(home)));
  assert.ok(targets.every(target => target === join(home, 'profiles/dsh_in_codex')));
  const target = targets[0];
  assert.deepEqual(JSON.parse(await readFile(join(target, 'package.json'), 'utf8')).dsh.profile.bundles,
    ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-sdk-app']);
  await assert.rejects(access(join(home, 'profiles/sdk')));
  const custom = '- id: agent-default-model\n  config: {provider: my-provider, model: my-model}\n';
  await writeFile(join(target, 'cordis.patch.yml'), custom);
  await Promise.all([ensureDshProfile(home), ensureDshProfile(home)]);
  assert.equal(await readFile(join(target, 'cordis.patch.yml'), 'utf8'), custom);
});
