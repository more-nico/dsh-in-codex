// Explicit, local-only model migration. No credentials/configuration are
// emitted to stdout or written into this repository or release artifacts.
import { readFile, writeFile, mkdir, realpath, access, rename } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, join, delimiter } from 'node:path';
import { homedir } from 'node:os';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { ensureDshProfile } from './profile.mjs';
const adapters = new Set(['@deepseek-ai/dsh-llm-pi-ai', '@deepseek-ai/dsh-llm-deepseek-api-key', '@deepseek-ai/dsh-llm-deepseek-account']);
async function main() {
  const configured = process.env.DSH_IN_CODEX_DSH_PATH || 'dsh';
  let executable = configured;
  if (!configured.includes('/')) {
    executable = undefined;
    for (const directory of (process.env.PATH || '').split(delimiter)) {
      const candidate = join(directory, configured);
      try { await access(candidate, constants.X_OK); executable = candidate; break; } catch {}
    }
    if (!executable) throw new Error('Cannot find the installed dsh executable');
  }
  const anchor = join(dirname(dirname(await realpath(executable))), 'package.json');
  const yaml = createRequire(anchor)('js-yaml');
  const home = process.env.DSH_HOME || join(homedir(), '.dsh');
  const source = join(home, 'profiles/web/cordis.patch.yml');
  let web;
  try { web = yaml.load(await readFile(source, 'utf8')) || []; } catch { throw new Error('Cannot parse the Web profile; migration accepts plain YAML overrides only'); }
  if (!Array.isArray(web)) throw new Error('Web profile patch must be a list');
  const imported = web.filter(row => row.id === 'agent-default-model' || adapters.has(row.name));
  if (!imported.length) throw new Error('No explicit Web model overrides found');
  const target = join(await ensureDshProfile(home), 'cordis.patch.yml');
  let original = '', overrides;
  try { original = await readFile(target, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  try { overrides = yaml.load(original) || []; } catch { throw new Error('Cannot parse the dsh_in_codex profile; no model overrides were changed'); }
  if (!Array.isArray(overrides)) throw new Error('dsh_in_codex profile patch must be a list');
  for (const row of imported) {
    const existing = overrides.find(entry => entry.id === row.id);
    if (existing) {
      const providers = row.config?.providers ? { providers: { ...existing.config?.providers, ...row.config.providers } } : {};
      Object.assign(existing, row, { config: { ...existing.config, ...row.config, ...providers } });
    } else overrides.push(row);
  }
  const backup = target + `.before-dsh-in-codex-${new Date().toISOString().replaceAll(':', '-')}-${randomUUID()}.bak`;
  await mkdir(dirname(target), { recursive: true });
  if (original) await writeFile(backup, original, { mode: 0o600, flag: 'wx' });
  const temporary = target + '.' + randomUUID() + '.tmp';
  await writeFile(temporary, yaml.dump(overrides, { noRefs: true, lineWidth: -1 }), { mode: 0o600 });
  await rename(temporary, target);
  console.log(JSON.stringify({ target, backup: original ? backup : undefined, importedIds: imported.map(row => row.id), credentials: 'Existing DSH credential store retained; no credentials exported' }, null, 2));
}
main().catch(error => {
  // YAML/parser and subprocess errors may carry source text; never print them.
  console.error(error.code ? `Migration failed (${error.code}); original profile retained where replacement did not complete.` :
    error.message.startsWith('Cannot ') || error.message.startsWith('No ') || error.message.endsWith('must be a list') ? error.message : 'Model migration failed; inspect the local profiles without sharing secrets.');
  process.exitCode = 1;
});
