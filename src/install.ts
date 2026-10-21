import { access, chmod, copyFile, cp, mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { dirname, delimiter, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dataRoot } from './config.js';
import { stopDaemon, withLifecycleLock } from './client.js';
import { BUILD } from './build.js';
import {
  INSTALL_MARKER, PLUGIN_ID, PLUGIN_NAME, TRUST_CONDITION,
  codexEnvironment, codexLocations, preflightPluginEnabled, projectPaths, pluginScope, setPluginEnabled, setProjectPluginEnabled,
  type CodexLocations,
} from './plugin-scope.js';
import manifest from '../package.json' with { type: 'json' };

const root = fileURLToPath(new URL('../', import.meta.url));
const entries = manifest.files;
const execFileAsync = promisify(execFile);
const CACHE_KEY_FILES = ['dist/build-info.json', 'dist/cli.mjs', 'dist/panel.html', '.dsh-in-codex-install.json', '.mcp.json', 'hooks/hooks.json'];

async function readMarketplace(path: string): Promise<any> {
  try { const value = JSON.parse(await readFile(path, 'utf8')); if (!Array.isArray(value.plugins)) throw new Error('Existing marketplace has no plugins array'); return value; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { name: 'local-plugins', interface: { displayName: 'Local plugins' }, plugins: [] }; throw error; }
}
async function saveMarketplace(path: string, value: any) {
  await mkdir(dirname(path), { recursive: true });
  try { await cp(path, `${path}.dsh-in-codex-backup`, { errorOnExist: false }); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 }); await rename(temporary, path);
}

async function findCodexCli(): Promise<string | undefined> {
  const configured = process.env.DSH_IN_CODEX_CODEX_PATH;
  if (configured !== undefined) {
    try { await access(configured, fsConstants.X_OK); return configured; } catch { return undefined; }
  }
  for (const directory of (process.env.PATH || '').split(delimiter)) {
    if (!directory) continue;
    const candidate = join(directory, 'codex');
    try { await access(candidate, fsConstants.X_OK); return candidate; } catch {}
  }
  const app = '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex';
  try { await access(app, fsConstants.X_OK); return app; } catch { return undefined; }
}

async function runCodex(locations: CodexLocations, args: string[], timeout = 90_000, cwd = locations.home): Promise<{ ok: boolean; cli?: string; stdout?: string; stderr?: string; error?: string }> {
  const cli = await findCodexCli();
  if (!cli) return { ok: false, error: 'Codex CLI not found' };
  try {
    const result = await execFileAsync(cli, args, { cwd, env: codexEnvironment(locations), timeout, maxBuffer: 16 * 1024 * 1024 });
    return { ok: true, cli, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const detail = error as NodeJS.ErrnoException & { stderr?: string; killed?: boolean; signal?: string };
    return { ok: false, cli, stderr: detail.stderr, error: detail.killed ? `Codex CLI timed out after ${timeout}ms` : (detail.message || String(error)) };
  }
}

function parseJsonOutput(stdout: string | undefined): any | undefined {
  if (!stdout) return undefined;
  const start = stdout.indexOf('{'), end = stdout.lastIndexOf('}');
  if (start < 0 || end <= start) return undefined;
  try { return JSON.parse(stdout.slice(start, end + 1)); } catch { return undefined; }
}

async function pluginVersion(directory: string): Promise<string> {
  for (const candidate of [join(directory, '.codex-plugin', 'plugin.json'), join(directory, 'package.json')]) {
    try { const value = JSON.parse(await readFile(candidate, 'utf8')); if (typeof value.version === 'string' && value.version) return value.version; } catch {}
  }
  throw new Error('Installed plugin has no version; refusing to guess its cache path');
}

async function directoryExists(path: string): Promise<boolean> {
  try { await access(path); return true; } catch { return false; }
}

/** Compare every staged plugin file (and the build marker) against Codex's cache. */
async function cacheMatchesInstall(cachePath: string, destination: string): Promise<{ matches: boolean; detail?: string }> {
  const compare = async (relative: string): Promise<{ matches: boolean; detail?: string }> => {
    let cached: Buffer, staged: Buffer;
    try { cached = await readFile(join(cachePath, relative)); }
    catch { return { matches: false, detail: `cache is missing ${relative}` }; }
    try { staged = await readFile(join(destination, relative)); }
    catch { return { matches: false, detail: `staged installation is missing ${relative}` }; }
    return cached.equals(staged) ? { matches: true } : { matches: false, detail: `cache differs at ${relative}` };
  };
  for (const key of CACHE_KEY_FILES) {
    const result = await compare(key);
    if (!result.matches) return result;
  }
  const walk = async (relative: string): Promise<{ matches: boolean; detail?: string }> => {
    let entries;
    try { entries = await readdir(join(destination, relative), { withFileTypes: true }); }
    catch (error) { return { matches: false, detail: `cannot read staged directory ${relative}: ${String(error)}` }; }
    for (const entry of entries) {
      const child = join(relative, entry.name);
      if (entry.isDirectory()) { const result = await walk(child); if (!result.matches) return result; }
      else if (entry.isFile()) { const result = await compare(child); if (!result.matches) return result; }
    }
    return { matches: true };
  };
  return walk('.');
}

/** Copy the staged installation into Codex's real per-version cache. */
async function directCacheRefresh(locations: CodexLocations, destination: string, version: string): Promise<string> {
  const cachePath = join(locations.cacheRoot, version);
  const stage = `${cachePath}.stage-${randomUUID()}`;
  const previous = `${cachePath}.previous`;
  await mkdir(dirname(cachePath), { recursive: true });
  await cp(destination, stage, { recursive: true });
  await rm(previous, { recursive: true, force: true });
  let moved = false;
  if (await directoryExists(cachePath)) { await rename(cachePath, previous); moved = true; }
  try {
    await rename(stage, cachePath);
  } catch (error) {
    if (moved) await rename(previous, cachePath).catch(() => {});
    await rm(stage, { recursive: true, force: true });
    throw error;
  }
  await rm(previous, { recursive: true, force: true });
  return cachePath;
}

interface CacheRefresh {
  method: 'codex plugin add' | 'direct cache copy';
  version: string;
  path: string;
  cli?: string;
  fallbackReason?: string;
  verified: boolean;
  checkedFiles: string[];
  marketplaceRegistration: { ok: boolean; skipped?: boolean; error?: string };
}

async function registerIsolatedMarketplace(locations: CodexLocations, marketplaceRoot: string): Promise<{ ok: boolean; skipped?: boolean; error?: string }> {
  if (!locations.isolated) return { ok: true, skipped: true };
  const added = await runCodex(locations, ['plugin', 'marketplace', 'add', marketplaceRoot, '--json'], 30_000);
  return added.ok ? { ok: true } : { ok: false, error: added.error };
}

async function refreshCache(locations: CodexLocations, destination: string, marketplaceRoot: string): Promise<CacheRefresh> {
  const version = await pluginVersion(destination);
  const expected = join(locations.cacheRoot, version);
  const registered = await registerIsolatedMarketplace(locations, marketplaceRoot);
  const added = await runCodex(locations, ['plugin', 'add', PLUGIN_ID, '--json']);
  if (added.ok) {
    const parsed = parseJsonOutput(added.stdout);
    const installedPath = typeof parsed?.installedPath === 'string' ? resolve(parsed.installedPath) : undefined;
    const candidate = await directoryExists(expected) ? expected : (installedPath && await directoryExists(installedPath) ? installedPath : undefined);
    if (candidate) {
      const compared = await cacheMatchesInstall(candidate, destination);
      if (compared.matches) return { method: 'codex plugin add', version, path: candidate, cli: added.cli, verified: true, checkedFiles: CACHE_KEY_FILES, marketplaceRegistration: registered };
    }
  }
  const contentReason = added.ok ? 'Codex CLI reported success but the cache did not match the staged bundle' : added.error;
  const reason = contentReason;
  const path = await directCacheRefresh(locations, destination, version);
  const compared = await cacheMatchesInstall(path, destination);
  if (!compared.matches) throw new Error(`Cache refresh did not produce the staged bundle (${compared.detail}); installation is incomplete.`);
  return { method: 'direct cache copy', version, path, cli: added.cli, fallbackReason: reason, verified: true, checkedFiles: CACHE_KEY_FILES, marketplaceRegistration: registered };
}

export interface InstallOptions { project?: string }

export async function install(codexHome?: string, options: InstallOptions = {}) {
  return withLifecycleLock(async () => {
    const locations = codexLocations(codexHome);
    const { destination, marketplace } = locations;
    // Validate both config edits before replacing files, refreshing the cache or
    // changing the marketplace. Unsupported TOML aborts with zero side effects.
    await preflightPluginEnabled(locations.userConfig, true);
    const originalUserConfig = await readFile(locations.userConfig, 'utf8').catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error;
    });
    const originalUserMode = originalUserConfig === null ? 0o600 : (await stat(locations.userConfig)).mode & 0o777;
    if (options.project) {
      const project = await projectPaths(options.project);
      const info = await stat(project.path).catch(() => undefined);
      if (!info?.isDirectory()) throw new Error(`Project path is not a directory: ${project.path}`);
      await preflightPluginEnabled(project.config, true);
    }
    await access(join(root, 'dist', 'panel.html'));
    const catalog = await readMarketplace(marketplace);
    const stage = `${destination}.stage-${randomUUID()}`;
    await mkdir(stage, { recursive: true });
    try {
      for (const entry of entries) { await mkdir(dirname(join(stage, entry)), { recursive: true }); await cp(join(root, entry), join(stage, entry), { recursive: true }); }
      // Codex 26.1013 loads the compatibility manifest. Resolve paths at install
      // time: its legacy MCP loader does not expand the portable PLUGIN_ROOT token.
      const mcp = JSON.parse(await readFile(join(stage, '.mcp.json'), 'utf8'));
      mcp.mcpServers.dsh_in_codex.command = '/bin/sh';
      mcp.mcpServers.dsh_in_codex.args = [join(destination, 'scripts/launch.sh'), 'mcp'];
      await writeFile(join(stage, '.mcp.json'), JSON.stringify(mcp, null, 2) + '\n');
      const hooks = JSON.parse(await readFile(join(stage, 'hooks/hooks.json'), 'utf8'));
      const shellPath = "'" + join(destination, 'scripts/launch.sh').replace(/'/g, "'\\''") + "'";
      for (const groups of Object.values(hooks.hooks) as any[][]) for (const group of groups) for (const hook of group.hooks) hook.command = `/bin/sh ${shellPath} hook`;
      await writeFile(join(stage, 'hooks/hooks.json'), JSON.stringify(hooks, null, 2) + '\n');
      await writeFile(join(stage, INSTALL_MARKER), JSON.stringify({ ...BUILD, node: process.execPath }), { mode: 0o600 });
      await writeFile(join(stage, 'node-path'), process.execPath + '\n', { mode: 0o600 });
      try {
        await access(destination);
        const marker = JSON.parse(await readFile(join(destination, INSTALL_MARKER), 'utf8'));
        if (!marker.version) throw new Error('Installation ownership marker is missing');
        // Stop the old bundle before replacing files. Running tasks are preserved as interrupted.
        await stopDaemon();
        const backup = `${destination}.previous`;
        await rm(backup, { recursive: true, force: true }); await rename(destination, backup);
        try { await rename(stage, destination); } catch (error) { await rename(backup, destination); throw error; }
        await rm(backup, { recursive: true, force: true });
      } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') await rename(stage, destination); else throw error; }
      // source.path resolves from the root containing .agents/, not from the catalog folder.
      const marketplaceRoot = resolve(dirname(marketplace), '../..');
      const path = './' + relative(marketplaceRoot, destination).split('\\').join('/');
      catalog.plugins = catalog.plugins.filter((plugin: any) => plugin.name !== PLUGIN_NAME);
      catalog.plugins.push({ name: PLUGIN_NAME, source: { source: 'local', path }, policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' }, category: 'Productivity', interface: { displayName: 'DSH in Codex', shortDescription: 'Conversation-scoped DSH agents' } });
      await saveMarketplace(marketplace, catalog);
      if (originalUserConfig !== null) {
        const backup = `${await realpath(locations.userConfig).catch(() => locations.userConfig)}.dsh-in-codex-backup`;
        await copyFile(locations.userConfig, backup);
        await chmod(backup, originalUserMode);
      }

      // Refresh the cache Codex actually reads. `codex plugin add` also refreshes
      // the same version, but its success is not trusted until the cache content
      // matches this staged bundle; otherwise replace it atomically.
      let cache: CacheRefresh;
      try { cache = await refreshCache(locations, destination, marketplaceRoot); }
      catch (error) {
        // `codex plugin add` may have enabled the plugin before failing. Never
        // leave a failed install enabled for the whole user.
        await setPluginEnabled(locations.userConfig, false).catch(() => {});
        throw error;
      }
      // Keep UI discovery available; task execution requires a project opt-in.
      const user = await setPluginEnabled(locations.userConfig, true);
      /* Keep the backup as the user config before install, not after the CLI's
         intermediate enabled=true write. */
      if (user.backup && originalUserConfig !== null) {
        await writeFile(user.backup, originalUserConfig, { mode: originalUserMode });
        await chmod(user.backup, originalUserMode);
      }
      const project = options.project ? await setProjectPluginEnabled('enable', options.project, codexHome) : undefined;
      const cacheBuild = { matches: cache.verified, buildId: BUILD.buildId, path: cache.path, checkedFiles: cache.checkedFiles };
      const warnings: string[] = [];
      if (cache.fallbackReason) warnings.push(`Codex CLI plugin add did not leave the verified cache (${cache.fallbackReason}); copied the bundle directly instead.`);
      if (!cache.marketplaceRegistration.ok && cache.marketplaceRegistration.error !== 'Codex CLI not found') warnings.push(`Could not register the isolated marketplace in ${locations.userConfig}: ${cache.marketplaceRegistration.error}. The explicit CODEX_HOME cache was still refreshed.`);
      if (project) warnings.push(...project.status.warnings);
      const next = options.project
        ? `Project ${options.project} is enabled, but Codex must trust it before project-local config loads. Restart/reload Codex, approve the project trust prompt if shown, then review/trust the plugin hooks. If the project is already trusted, reopen the project or Codex so it reloads config.toml.`
        : `The panel is installed. DSH tasks stay off until a project opts in with: dsh-in-codex project enable --project "<path>". Reload Codex and review/trust the plugin hooks.`;
      return {
        destination, marketplace, cache, userConfig: locations.userConfig, userEnabled: true,
        userInstall: user, project: project?.status, cacheBuild, warnings, next,
        trust: { required: true, condition: TRUST_CONDITION },
      };
    } finally { await rm(stage, { recursive: true, force: true }); }
  });
}

export async function uninstall(codexHome?: string) {
  return withLifecycleLock(async () => {
    const locations = codexLocations(codexHome);
    const { destination, marketplace } = locations;
    const catalog = await readMarketplace(marketplace);
    const marker = JSON.parse(await readFile(join(destination, INSTALL_MARKER), 'utf8'));
    if (!marker.version) throw new Error('Refusing to remove an unrecognized directory');
    await stopDaemon();
    const removed = await runCodex(locations, ['plugin', 'remove', PLUGIN_ID, '--json'], 30_000);
    const warnings: string[] = [];
    if (!removed.ok) warnings.push(`Codex CLI plugin remove was unavailable (${removed.error}); removed the source, cache, and marketplace entry directly. The user config may retain a disabled plugin block.`);
    catalog.plugins = catalog.plugins.filter((plugin: any) => plugin.name !== PLUGIN_NAME);
    await saveMarketplace(marketplace, catalog); await rm(destination, { recursive: true });
    if (!removed.ok) await rm(locations.cacheRoot, { recursive: true, force: true });
    return { removed: destination, cacheRemoved: locations.cacheRoot, preservedData: dataRoot(), warnings };
  });
}

export async function projectCommand(action: 'enable' | 'disable' | 'status', project?: string, codexHome?: string) {
  if (action === 'status') return pluginScope(project, codexHome);
  return setProjectPluginEnabled(action, project, codexHome);
}
