import { execFileSync } from 'node:child_process';
import { mkdir, cp, rm, writeFile, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const manifest = JSON.parse(await readFile('package.json', 'utf8'));
const archive = `dsh-in-codex-${manifest.version}-macos.zip`;
const root = 'release/dsh-in-codex';
execFileSync(process.execPath, ['scripts/build.mjs'], { stdio: 'inherit' });
await rm(root, { recursive: true, force: true }); await mkdir(root, { recursive: true });
for (const entry of manifest.files) {
  await mkdir(`${root}/${entry.includes('/') ? entry.slice(0, entry.lastIndexOf('/')) : '.'}`, { recursive: true });
  await cp(entry, `${root}/${entry}`, { recursive: true });
}
await writeFile(`${root}/INSTALL.txt`, 'Install: node bin/dsh-in-codex.mjs install\nEnable one project: node bin/dsh-in-codex.mjs project enable --project /path/to/project\nThen reload Codex and review/trust its hooks. New projects cannot use DSH until explicitly enabled.\n');
await rm(`release/${archive}`, { force: true });
execFileSync('/usr/bin/zip', ['-qr', archive, 'dsh-in-codex'], { cwd: 'release', stdio: 'inherit' });
const checksum = createHash('sha256').update(await readFile(`release/${archive}`)).digest('hex');
await writeFile('release/SHA256SUMS', `${checksum}  ${archive}\n`);
console.log(`Packaged release/${archive} and release/SHA256SUMS`);
