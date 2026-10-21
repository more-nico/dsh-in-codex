import { access, chmod, copyFile, mkdir, readdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { getPluginEnabled, projectTrustLevels, setBoolean, TomlEditError } from './toml.js';

export const PLUGIN_NAME = 'dsh-in-codex';
export const MARKETPLACE_NAME = 'local-plugins';
export const PLUGIN_ID = `${PLUGIN_NAME}@${MARKETPLACE_NAME}`;
export const INSTALL_MARKER = '.dsh-in-codex-install.json';
export const TRUST_CONDITION = 'Codex loads project-local config, hooks, and exec policies only for trusted projects. Add the project from Codex\'s trust prompt (or set [projects."<path>"] trust_level = "trusted" in the user config); this tool never marks projects trusted.';

export interface CodexLocations {
  home: string;
  /** True when CODEX_HOME is custom; its marketplace lives inside that home. */
  isolated: boolean;
  destination: string;
  marketplace: string;
  cacheRoot: string;
  userConfig: string;
}

export function defaultCodexHome(): string { return resolve(join(homedir(), '.codex')); }

export function codexLocations(codexHome?: string): CodexLocations {
  const home = resolve(codexHome || process.env.CODEX_HOME || defaultCodexHome());
  const isDefault = home === defaultCodexHome();
  // The personal marketplace belongs to the real user home. A custom CODEX_HOME
  // keeps its own marketplace inside that home and registers it explicitly in
  // that CODEX_HOME's config.toml; HOME is never rewritten.
  const marketplaceRoot = isDefault ? join(homedir(), '.agents') : join(home, '.agents');
  return {
    home, isolated: !isDefault,
    destination: join(home, 'plugins', PLUGIN_NAME),
    marketplace: join(marketplaceRoot, 'plugins', 'marketplace.json'),
    cacheRoot: join(home, 'plugins', 'cache', MARKETPLACE_NAME, PLUGIN_NAME),
    userConfig: join(home, 'config.toml'),
  };
}

export function codexEnvironment(locations: CodexLocations): NodeJS.ProcessEnv {
  // Never repurpose HOME: Codex keeps user-global state under the real home.
  // Isolated invocation is expressed only through an explicit CODEX_HOME and
  // an explicit marketplace source inside that CODEX_HOME.
  return { ...process.env, CODEX_HOME: locations.home };
}

export interface ProjectPaths {
  /** Absolute path as supplied/resolved from cwd. */
  path: string;
  /** Canonical path used for trust lookup (symlinks resolved when possible). */
  canonical: string;
  config: string;
}

export async function projectPaths(project?: string): Promise<ProjectPaths> {
  const path = resolve(project || process.cwd());
  const canonical = await realpath(path).catch(() => path);
  return { path, canonical, config: join(path, '.codex', 'config.toml') };
}

async function readText(path: string): Promise<string | null> {
  try { return await readFile(path, 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}

export interface PluginConfigState { path: string; exists: boolean; enabled: boolean | null }

async function readPluginConfig(path: string): Promise<PluginConfigState> {
  const text = await readText(path);
  if (text === null) return { path, exists: false, enabled: null };
  try { return { path, exists: true, enabled: getPluginEnabled(text, PLUGIN_ID) }; }
  catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Cannot safely read ${path}: ${detail}`);
  }
}

async function readTrust(configPath: string, project: ProjectPaths): Promise<{ trusted: boolean; level: string | null; satisfied: boolean }> {
  const text = await readText(configPath);
  if (text === null) return { trusted: false, level: null, satisfied: false };
  let levels: Map<string, string>;
  try { levels = projectTrustLevels(text); }
  catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Cannot safely read project trust from ${configPath}: ${detail}`);
  }
  let level: string | null = null;
  for (const [key, value] of levels) {
    const canonical = await realpath(key).catch(() => resolve(key));
    if (canonical === project.canonical || resolve(key) === project.path) { level = value; break; }
  }
  return { trusted: level === 'trusted', level, satisfied: level === 'trusted' };
}

async function exists(path: string): Promise<boolean> {
  try { await access(path); return true; } catch { return false; }
}

async function hasCache(locations: CodexLocations): Promise<boolean> {
  try { return (await readdir(locations.cacheRoot, { withFileTypes: true })).some(entry => entry.isDirectory() && !entry.name.startsWith('.')); }
  catch { return false; }
}

export async function pluginInstalled(locations: CodexLocations): Promise<boolean> {
  return await exists(join(locations.destination, INSTALL_MARKER)) || await hasCache(locations);
}

export interface WriteOutcome { path: string; changed: boolean; backup?: string; created: boolean }

async function atomicWrite(path: string, text: string, mode: number): Promise<void> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true });
  const temporary = join(directory, `.${basename(path)}.${randomUUID()}.tmp`);
  await writeFile(temporary, text, { mode });
  try { await chmod(temporary, mode); await rename(temporary, path); }
  catch (error) { await rm(temporary, { force: true }); throw error; }
}

/** Validate that an edit is possible before any side effects are performed. */
export async function preflightPluginEnabled(configPath: string, enabled: boolean): Promise<void> {
  const actualPath = await realpath(configPath).catch(() => configPath);
  const before = await readText(actualPath);
  try { setBoolean(before ?? '', ['plugins', PLUGIN_ID, 'enabled'], enabled); }
  catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Cannot safely update ${configPath}: ${detail}`);
  }
}

/** Set only [plugins."dsh-in-codex@local-plugins"] enabled, preserving everything else. */
export async function setPluginEnabled(configPath: string, enabled: boolean): Promise<WriteOutcome> {
  const actualPath = await realpath(configPath).catch(() => configPath);
  const before = await readText(actualPath);
  let after: string;
  try { after = setBoolean(before ?? '', ['plugins', PLUGIN_ID, 'enabled'], enabled).text; }
  catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Cannot safely update ${configPath}: ${detail}`);
  }
  if (before !== null && after === before) return { path: configPath, changed: false, created: false };
  const info = before === null ? undefined : await stat(actualPath);
  const mode = info ? info.mode & 0o777 : 0o600;
  let backup: string | undefined;
  if (before !== null) {
    backup = `${actualPath}.dsh-in-codex-backup`;
    await copyFile(actualPath, backup);
    await chmod(backup, mode);
  }
  await atomicWrite(actualPath, after, mode);
  return { path: configPath, changed: true, backup, created: before === null };
}

export interface PluginScope {
  target: string;
  canonicalProject: string;
  codexHome: string;
  user: { config: string; exists: boolean; enabled: boolean | null };
  project: { path: string; config: string; exists: boolean; enabled: boolean | null };
  trust: { trusted: boolean; level: string | null; required: true; satisfied: boolean; source: string; condition: string };
  installed: boolean;
  effective: { enabled: boolean; source: 'project' | 'user' | 'none'; reason: string };
  warnings: string[];
}

export async function pluginScope(projectArg?: string, codexHomeArg?: string): Promise<PluginScope> {
  const locations = codexLocations(codexHomeArg);
  const project = await projectPaths(projectArg);
  const user = await readPluginConfig(locations.userConfig);
  const projectState = await readPluginConfig(project.config);
  const trust = await readTrust(locations.userConfig, project);
  const installed = user.enabled !== null && await pluginInstalled(locations);
  const warnings: string[] = [];
  let enabled: boolean;
  let source: 'project' | 'user' | 'none';
  let reason: string;
  const projectApplies = projectState.enabled !== null && trust.satisfied;
  if (!installed) {
    enabled = false; source = 'none';
    reason = user.enabled === null ? 'The plugin has no user-level install marker.' : 'The plugin files/cache are not installed.';
    if (projectState.enabled === true) warnings.push('This project enables the plugin, but the plugin is not installed; run dsh-in-codex install first.');
  } else if (projectApplies) {
    enabled = projectState.enabled === true;
    source = 'project';
    reason = enabled ? 'The trusted project overrides the user-level switch.' : 'The trusted project explicitly disables the plugin.';
  } else {
    enabled = false;
    source = 'none';
    reason = projectState.enabled === null ? 'DSH tasks are off until this project explicitly opts in.' : 'The project override is ignored because the project is not trusted.';
  }
  if (projectState.enabled !== null && !trust.satisfied) warnings.push('The project switch is present but ignored until the project is trusted.');
  if (user.enabled === null && projectState.enabled === true) warnings.push('A project switch alone does not install the plugin.');
  return {
    target: project.path,
    canonicalProject: project.canonical,
    codexHome: locations.home,
    user: { config: locations.userConfig, exists: user.exists, enabled: user.enabled },
    project: { path: project.path, config: project.config, exists: projectState.exists, enabled: projectState.enabled },
    trust: {
      trusted: trust.trusted, level: trust.level, required: true, satisfied: trust.satisfied,
      source: locations.userConfig, condition: TRUST_CONDITION,
    },
    installed,
    effective: { enabled, source, reason },
    warnings,
  };
}

export interface ScopeChange { action: 'enable' | 'disable'; user?: WriteOutcome; project: WriteOutcome; status: PluginScope }

export async function projectEnabled(cwd: string): Promise<boolean> {
  return (await pluginScope(cwd)).effective.enabled;
}

export const PROJECT_DISABLED = '当前项目未启用 DSH in Codex。请在主会话中说“为当前项目启用 dsh in codex”。';

export async function setProjectPluginEnabled(action: 'enable' | 'disable', projectArg?: string, codexHomeArg?: string): Promise<ScopeChange> {
  const locations = codexLocations(codexHomeArg);
  const project = await projectPaths(projectArg);
  const info = await stat(project.path).catch(() => undefined);
  if (!info?.isDirectory()) throw new Error(`Project path is not a directory: ${project.path}`);
  if (action === 'enable') await preflightPluginEnabled(locations.userConfig, true);
  await preflightPluginEnabled(project.config, action === 'enable');
  const user = action === 'enable' ? await setPluginEnabled(locations.userConfig, true) : undefined;
  const written = await setPluginEnabled(project.config, action === 'enable');
  const status = await pluginScope(project.path, codexHomeArg);
  return { action, user, project: written, status };
}

export function describeConfigError(error: unknown): string {
  if (error instanceof TomlEditError) return error.message;
  return error instanceof Error ? error.message : String(error);
}
