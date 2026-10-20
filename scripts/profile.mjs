import { access, mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';

export const DSH_PROFILE = 'dsh_in_codex';

// Compose the dedicated profile from DSH's shipped bundles. Publish a complete
// directory atomically so concurrent first launches cannot reset user settings.
export async function ensureDshProfile(home = process.env.DSH_HOME || join(homedir(), '.dsh')) {
  const profiles = join(home, 'profiles');
  const target = join(profiles, DSH_PROFILE);
  const manifest = join(target, 'package.json');
  try { await access(manifest); return target; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  await mkdir(profiles, { recursive: true, mode: 0o700 });
  const stage = await mkdtemp(join(profiles, `.${DSH_PROFILE}-`));
  try {
    await writeFile(join(stage, 'package.json'), JSON.stringify({
      name: `dsh-profile-${DSH_PROFILE}`, private: true, dependencies: {},
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-sdk-app'] } },
    }, null, 2) + '\n', { mode: 0o600 });
    await writeFile(join(stage, 'cordis.patch.yml'), '[]\n', { mode: 0o600 });
    await writeFile(join(stage, 'pnpm-workspace.yaml'), 'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n', { mode: 0o600 });
    try { await rename(stage, target); }
    catch (error) {
      if (!['EEXIST', 'ENOTEMPTY'].includes(error.code)) throw error;
      await access(manifest); // Another initializer published a complete profile.
    }
    return target;
  } finally { await rm(stage, { recursive: true, force: true }); }
}
