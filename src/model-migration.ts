import { randomUUID } from 'node:crypto';
import { readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import yaml from 'js-yaml';
import { DSH_PROFILE, ensureDshProfile } from '../scripts/profile.mjs';

type Entry = Record<string, any>;
export interface MigrationModel { id: string; name?: string; configured: boolean }
export interface MigrationProvider { id: string; adapter: string; models: MigrationModel[] }
export interface MigrationSource { profile: string; providers: MigrationProvider[] }
export interface MigrationSelection { adapter: string; provider: string; models: string[] }

const profileName = /^[\p{L}\p{N}_.-]+$/u;
const record = (value: unknown): value is Entry => !!value && typeof value === 'object' && !Array.isArray(value);
const own = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key);

function assertProfile(profile: string) {
  if (!profileName.test(profile) || profile === '.' || profile === '..' || profile === DSH_PROFILE) {
    throw new Error('请选择有效的来源 profile');
  }
}

function parsePatch(content: string, label: string): Entry[] {
  let parsed: unknown;
  try { parsed = yaml.load(content, { schema: yaml.JSON_SCHEMA }) ?? []; }
  catch { throw new Error(`${label} 的 cordis.patch.yml 无法解析`); }
  if (!Array.isArray(parsed) || !parsed.every(record)) throw new Error(`${label} 的 cordis.patch.yml 必须是配置列表`);
  return parsed;
}

async function readPatch(home: string, profile: string): Promise<Entry[]> {
  try { return parsePatch(await readFile(join(home, 'profiles', profile, 'cordis.patch.yml'), 'utf8'), profile); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

function providerRows(rows: Entry[]) {
  const result = new Map<string, { row: Entry; provider: Entry }>();
  for (const row of rows) {
    if (typeof row.id !== 'string' || !record(row.config) || !record(row.config.providers)) continue;
    for (const [id, provider] of Object.entries(row.config.providers)) {
      if (record(provider) && Array.isArray(provider.models)) result.set(JSON.stringify([row.id, id]), { row, provider });
    }
  }
  return result;
}

export async function listMigrationProfiles(home = process.env.DSH_HOME || join(homedir(), '.dsh')): Promise<string[]> {
  const directory = join(home, 'profiles');
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  return entries.filter(entry => entry.isDirectory() && entry.name !== DSH_PROFILE && profileName.test(entry.name))
    .map(entry => entry.name).sort((a, b) => a.localeCompare(b));
}

export async function inspectMigrationSource(profile: string, home = process.env.DSH_HOME || join(homedir(), '.dsh')): Promise<MigrationSource> {
  assertProfile(profile);
  if (!(await listMigrationProfiles(home)).includes(profile)) throw new Error('来源 profile 不存在');
  const [source, target] = await Promise.all([readPatch(home, profile), readPatch(home, DSH_PROFILE)]);
  const existing = providerRows(target), providers: MigrationProvider[] = [];
  for (const [key, { row, provider }] of providerRows(source)) {
    const configured = new Set((existing.get(key)?.provider.models || []).filter(record).map((model: Entry) => model.id));
    const seen = new Set<string>(), models: MigrationModel[] = [];
    for (const item of provider.models) {
      if (!record(item) || typeof item.id !== 'string' || !item.id.trim() || seen.has(item.id)) continue;
      seen.add(item.id);
      models.push({ id: item.id, ...(typeof item.name === 'string' ? { name: item.name } : {}), configured: configured.has(item.id) });
    }
    if (models.length) providers.push({ id: JSON.parse(key)[1], adapter: row.id, models });
  }
  return { profile, providers };
}

export async function migrateModels(profile: string, selections: MigrationSelection[], home = process.env.DSH_HOME || join(homedir(), '.dsh')) {
  assertProfile(profile);
  if (!(await listMigrationProfiles(home)).includes(profile)) throw new Error('来源 profile 不存在');
  if (!Array.isArray(selections) || selections.length === 0) throw new Error('请至少选择一个模型');
  const targetDirectory = await ensureDshProfile(home);
  const targetPath = join(targetDirectory, 'cordis.patch.yml');
  const original = await readFile(targetPath, 'utf8');
  const target = parsePatch(original, DSH_PROFILE);
  const source = await readPatch(home, profile);
  const available = providerRows(source);
  const seen = new Set<string>();
  let imported = 0;
  for (const selection of selections) {
    const key = JSON.stringify([selection.adapter, selection.provider]);
    if (seen.has(key) || !Array.isArray(selection.models) || selection.models.length === 0 ||
      new Set(selection.models).size !== selection.models.length) throw new Error('迁移选择包含重复或空的模型');
    seen.add(key);
    const sourceProvider = available.get(key);
    if (!sourceProvider) throw new Error('所选 provider 已不在来源 profile 中');
    const sourceModels = new Map<string, Entry>();
    for (const item of sourceProvider.provider.models) if (record(item) && typeof item.id === 'string' && !sourceModels.has(item.id)) sourceModels.set(item.id, item);
    const chosen = selection.models.map(id => {
      const item = sourceModels.get(id);
      if (!item) throw new Error('所选模型已不在来源 profile 中');
      return structuredClone(item);
    });
    let targetRow = target.find(row => row.id === selection.adapter);
    if (targetRow && targetRow.name !== sourceProvider.row.name) throw new Error('目标 profile 中的适配器 ID 与来源配置冲突');
    if (!targetRow) {
      targetRow = structuredClone(sourceProvider.row);
      targetRow.config = { ...targetRow.config, providers: {} };
      target.push(targetRow);
    }
    if (!record(targetRow.config)) targetRow.config = {};
    if (!record(targetRow.config.providers)) targetRow.config.providers = {};
    const providers = targetRow.config.providers;
    let destination: Entry;
    if (own(providers, selection.provider)) {
      destination = providers[selection.provider];
      if (!record(destination) || !Array.isArray(destination.models)) throw new Error('目标 provider 的模型配置格式不受支持');
      const existingIds = new Set(destination.models.filter(record).map((item: Entry) => item.id));
      if (chosen.some(item => existingIds.has(item.id))) throw new Error('所选模型已配置，请刷新列表');
      destination.models.push(...chosen);
    } else {
      destination = { ...structuredClone(sourceProvider.provider), models: chosen };
      Object.defineProperty(providers, selection.provider, { value: destination, enumerable: true, writable: true, configurable: true });
    }
    imported += chosen.length;
  }
  const backup = `${targetPath}.before-model-migration-${new Date().toISOString().replaceAll(':', '-')}-${randomUUID()}.bak`;
  const temporary = `${targetPath}.${randomUUID()}.tmp`;
  await writeFile(backup, original, { mode: 0o600, flag: 'wx' });
  try {
    await writeFile(temporary, yaml.dump(target, { noRefs: true, lineWidth: -1 }), { mode: 0o600, flag: 'wx' });
    await rename(temporary, targetPath);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
  return { imported, backup };
}
