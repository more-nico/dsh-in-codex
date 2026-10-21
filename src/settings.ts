import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { ModelChoice, PresetSlot, Settings } from './types.js';

export const MAX_CONCURRENCY = 32;
export const DEFAULT_MAX_CONCURRENT = 10;
export const DEFAULT_MAX_PER_THREAD = 5;

/** Partial update accepted by dsh_settings.update. Nested preset slots merge independently. */
export interface SettingsUpdate {
  presets?: { slot1?: ModelChoice | null; slot2?: ModelChoice | null };
  maxConcurrent?: number;
  maxPerThread?: number;
}

export interface SettingsDefaults { maxConcurrent?: number; maxPerThread?: number }

/** User-facing meaning of the two stable preset keys. The main agent chooses one explicitly. */
export const PRESET_DEFINITIONS = {
  slot1: {
    name: '常规模型',
    description: 'General tasks: routine implementation, review, search, and bounded changes. Choose this slot explicitly for ordinary work. A null model means this slot inherits the DSH profile\'s native model and thinking level at real spawn time; it is not a third plugin default.',
  },
  slot2: {
    name: '增强模型',
    description: 'Complex tasks or deeper reasoning: ambiguous design, hard debugging, high-risk review, or multi-step planning. May use the same model as slot1 with a higher thinking level. A null model means this slot inherits the DSH profile\'s native model and thinking level at real spawn time; it is not a third plugin default.',
  },
} as const;

export interface DiscoveredPreset {
  name: string;
  description: string;
  model: ModelChoice | null;
  source: 'preset' | 'native-dsh';
}

export interface DiscoveredPresets { slot1: DiscoveredPreset; slot2: DiscoveredPreset }

export function cloneModel(model: ModelChoice | null | undefined): ModelChoice | null {
  if (model === null || model === undefined) return null;
  return { provider: model.provider, id: model.id, ...(model.thinking === undefined ? {} : { thinking: model.thinking }) };
}

export function cloneSettings(settings: Settings): Settings {
  return {
    presets: { slot1: cloneModel(settings.presets.slot1), slot2: cloneModel(settings.presets.slot2) },
    maxConcurrent: settings.maxConcurrent,
    maxPerThread: settings.maxPerThread,
  };
}

export function defaultSettings(defaults: SettingsDefaults = {}): Settings {
  return {
    presets: { slot1: null, slot2: null },
    maxConcurrent: concurrencyOr(defaults.maxConcurrent, DEFAULT_MAX_CONCURRENT, 'maxConcurrent'),
    maxPerThread: concurrencyOr(defaults.maxPerThread, DEFAULT_MAX_PER_THREAD, 'maxPerThread'),
  };
}

/** Explicit discovery view; empty slots name their source instead of looking like a third default. */
export function discoverPresets(presets: Settings['presets']): DiscoveredPresets {
  const view = (slot: PresetSlot): DiscoveredPreset => {
    const model = cloneModel(presets[slot]);
    return {
      ...PRESET_DEFINITIONS[slot],
      model,
      source: model ? 'preset' : 'native-dsh',
    };
  };
  return { slot1: view('slot1'), slot2: view('slot2') };
}

/** Environment values seed first-run defaults; a persisted settings file overrides them. */
export function environmentDefaults(): SettingsDefaults {
  const read = (name: string) => {
    const raw = process.env[name];
    if (raw === undefined || raw === '') return undefined;
    const value = Number(raw);
    return Number.isInteger(value) && value >= 1 && value <= MAX_CONCURRENCY ? value : undefined;
  };
  return { maxConcurrent: read('DSH_IN_CODEX_CONCURRENCY'), maxPerThread: read('DSH_IN_CODEX_CHAT_CONCURRENCY') };
}

function concurrencyOr(value: unknown, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  assertConcurrency(value, name);
  return value;
}

export function assertConcurrency(value: unknown, name: string): asserts value is number {
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > MAX_CONCURRENCY) {
    throw new Error(`${name} must be an integer between 1 and ${MAX_CONCURRENCY}`);
  }
}

function model(value: unknown, label: string): ModelChoice | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object or null`);
  const record = value as Record<string, unknown>;
  const provider = typeof record.provider === 'string' ? record.provider.trim() : '';
  const id = typeof record.id === 'string' ? record.id.trim() : '';
  if (!provider) throw new Error(`${label}.provider must be a non-empty string`);
  if (!id) throw new Error(`${label}.id must be a non-empty string`);
  let thinking: string | undefined;
  if (record.thinking !== undefined && record.thinking !== null) {
    if (typeof record.thinking !== 'string' || !record.thinking.trim()) throw new Error(`${label}.thinking must be a non-empty string when supplied`);
    thinking = record.thinking.trim();
  }
  return { provider, id, ...(thinking === undefined ? {} : { thinking }) };
}

/** Validate a complete Settings object, including loaded files and direct Manager callers. */
export function assertSettings(value: unknown): Settings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('settings must be an object');
  const record = value as Record<string, unknown>;
  if (!record.presets || typeof record.presets !== 'object' || Array.isArray(record.presets)) throw new Error('presets must be an object');
  const presets = record.presets as Record<string, unknown>;
  assertConcurrency(record.maxConcurrent, 'maxConcurrent');
  assertConcurrency(record.maxPerThread, 'maxPerThread');
  return {
    presets: {
      slot1: model(presets.slot1, 'presets.slot1'),
      slot2: model(presets.slot2, 'presets.slot2'),
    },
    maxConcurrent: record.maxConcurrent,
    maxPerThread: record.maxPerThread,
  };
}

export function mergeSettings(base: Settings, update: SettingsUpdate): Settings {
  if (Object.prototype.hasOwnProperty.call(update, 'defaultModel')) {
    throw new Error('defaultModel is no longer a plugin setting; choose preset slot1 (Regular) or slot2 (Enhanced) instead');
  }
  const next = cloneSettings(base);
  if (update.presets !== undefined) {
    if (update.presets === null || typeof update.presets !== 'object') throw new Error('presets must be an object');
    if (update.presets.slot1 !== undefined) next.presets.slot1 = model(update.presets.slot1, 'presets.slot1');
    if (update.presets.slot2 !== undefined) next.presets.slot2 = model(update.presets.slot2, 'presets.slot2');
  }
  if (update.maxConcurrent !== undefined) { assertConcurrency(update.maxConcurrent, 'maxConcurrent'); next.maxConcurrent = update.maxConcurrent; }
  if (update.maxPerThread !== undefined) { assertConcurrency(update.maxPerThread, 'maxPerThread'); next.maxPerThread = update.maxPerThread; }
  return next;
}

/** Model choices present in this update; only these need an expensive DSH capability probe. */
export function updatedModels(update: SettingsUpdate): ModelChoice[] {
  const choices: Array<ModelChoice | null | undefined> = [];
  if (update.presets !== undefined) {
    if (update.presets.slot1 !== undefined) choices.push(update.presets.slot1);
    if (update.presets.slot2 !== undefined) choices.push(update.presets.slot2);
  }
  return choices.filter((choice): choice is ModelChoice => choice !== null && choice !== undefined)
    .map((choice) => model(choice, 'model setting'))
    .filter((choice): choice is ModelChoice => choice !== null);
}

/**
 * Plugin-owned settings live beside the daemon state, never inside the DSH profile.
 * Only provider/model/effort choices and integer limits are written; credentials
 * remain in the user's DSH profile and are never copied here.
 *
 * Older versions had a separate defaultModel. It is read only while loading and
 * copied into empty preset slots; the rewritten file stores the new shape only.
 */
export class SettingsStore {
  data: Settings;
  readonly path: string;
  private writes = Promise.resolve();

  constructor(readonly root: string, defaults: SettingsDefaults = {}) {
    this.data = defaultSettings(defaults);
    this.path = join(root, 'settings.json');
  }

  async load() {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(this.path, 'utf8'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw new Error(`Could not read settings.json: ${(error as Error).message}`);
    }
    let settings: Settings;
    let migrate = false;
    try {
      const record = parsed as Record<string, unknown>;
      if (!record || typeof record !== 'object' || Array.isArray(record)) throw new Error('settings.json must contain an object');
      if (record.version !== undefined && record.version !== 1) throw new Error(`unsupported settings version ${String(record.version)}`);
      if (record.settings !== undefined && (record.settings === null || typeof record.settings !== 'object' || Array.isArray(record.settings))) {
        throw new Error('settings must be an object');
      }
      // Accept both the versioned envelope and a bare Settings object.
      const source = (record.settings ?? record) as Record<string, unknown>;
      migrate = Object.prototype.hasOwnProperty.call(source, 'defaultModel');
      // legacy defaultModel is read here and nowhere else. It is copied in full
      // (provider/id/thinking) into empty slots so selected-preset behavior is
      // unchanged; slots that already exist are never overwritten.
      const legacy = migrate ? model(source.defaultModel, 'defaultModel') : null;
      const rawPresets = source.presets;
      const presets = rawPresets && typeof rawPresets === 'object' && !Array.isArray(rawPresets)
        ? rawPresets as Record<string, unknown> : {};
      let slot1 = model(presets.slot1, 'presets.slot1');
      let slot2 = model(presets.slot2, 'presets.slot2');
      if (legacy) {
        if (!slot1) slot1 = cloneModel(legacy);
        if (!slot2) slot2 = cloneModel(legacy);
      }
      settings = assertSettings({
        presets: { slot1, slot2 },
        maxConcurrent: source.maxConcurrent ?? this.data.maxConcurrent,
        maxPerThread: source.maxPerThread ?? this.data.maxPerThread,
      });
    } catch (error) {
      throw new Error(`Invalid settings.json: ${(error as Error).message}`);
    }
    this.data = cloneSettings(settings);
    // Persist the new shape immediately so the removed third default cannot be
    // read again by a later daemon start.
    if (migrate) await this.save(settings);
  }

  async save(settings: Settings) {
    const next = assertSettings(settings);
    const text = JSON.stringify({ version: 1, settings: next }, null, 2) + '\n';
    const task = this.writes.then(async () => {
      await mkdir(this.root, { recursive: true, mode: 0o700 });
      const temporary = join(this.root, `settings.${randomUUID()}.tmp`);
      await writeFile(temporary, text, { mode: 0o600 });
      await rename(temporary, this.path);
    });
    this.writes = task.catch(() => {});
    await task;
    this.data = cloneSettings(next);
    return cloneSettings(next);
  }

  flush() { return this.writes; }
}
