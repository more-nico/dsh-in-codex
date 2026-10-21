import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Manager, type ManagerOptions } from '../src/manager.js';
import { Store } from '../src/store.js';
import { dispatch } from '../src/daemon.js';

export const fake = fileURLToPath(new URL('./fixtures/fake-dsh.mjs', import.meta.url));

export async function enableProject(root: string) {
  await mkdir(join(root, '.codex'), { recursive: true });
  await writeFile(join(root, '.codex', 'config.toml'), '[plugins."dsh-in-codex@local-plugins"]\nenabled = true\n');
  await appendFile(join(process.env.CODEX_HOME!, 'config.toml'), `\n[projects."${root}"]\ntrust_level = "trusted"\n`);
}

export async function managerFixture(t: any, options: ManagerOptions = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-test-'));
  await enableProject(root);
  const manager = new Manager(new Store(root), { executable: process.execPath, prefixArgs: [fake], idleMs: 1000, ...options });
  await manager.init();
  for (const threadId of ['a', 'b', 'c']) await manager.register({ threadId, cwd: root, updatedAt: Date.now() });
  t.after(async () => { await manager.close(); await rm(root, { recursive: true, force: true }); });
  const call = (method: string, args: Record<string, any> = {}, threadId = 'a') => dispatch(manager, { id: 'test', method, args, threadId });
  return { root, manager, call };
}

export async function waitFor(predicate: () => boolean, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Condition timed out');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
