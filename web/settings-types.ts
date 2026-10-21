import type { ModelChoice } from '../src/types.js';

/** UI-owned settings contract. Kept out of src/ so the panel can ship independently. */
export interface Settings {
  presets: { slot1: ModelChoice | null; slot2: ModelChoice | null };
  maxConcurrent: number;
  maxPerThread: number;
}

/** Runtime limits only: model choice is resolved per dispatch, not globally. */
export interface EffectiveSettings {
  maxConcurrent: number;
  maxPerThread: number;
}

export interface SettingsPayload {
  settings: Settings;
  effective: EffectiveSettings;
}

export interface DiscoveredModel {
  provider: string;
  id: string;
  name?: string;
  contextWindow?: number | null;
  input?: string[] | null;
  reasoningEfforts?: string[] | null;
}

export const LIMIT_MIN = 1;
export const LIMIT_MAX = 32;

export function defaultSettings(): Settings {
  return { presets: { slot1: null, slot2: null }, maxConcurrent: 10, maxPerThread: 5 };
}

const trimmed = (value: unknown) => typeof value === 'string' && value.trim() ? value.trim() : undefined;
const record = (value: unknown): Record<string, any> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {};
const boundedInteger = (value: unknown, fallback: number) => {
  const number = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN;
  return Number.isSafeInteger(number) && number >= LIMIT_MIN && number <= LIMIT_MAX ? number : fallback;
};

/** `null` means "inherit the native DSH choice", never "unknown model". */
export function normalizeModelChoice(value: unknown): ModelChoice | null {
  const item = record(value), provider = trimmed(item.provider), id = trimmed(item.id);
  if (!provider || !id) return null;
  const thinking = trimmed(item.thinking);
  return thinking ? { provider, id, thinking } : { provider, id };
}

/**
 * Accepts the shared settings shape. A legacy plugin-wide `defaultModel` key is
 * deliberately ignored: that field was removed from the shared contract and
 * dispatch now falls back from the selected preset to DSH's native choice.
 */
export function normalizeSettings(value: unknown, fallback: Settings = defaultSettings()): Settings {
  const item = record(value), presets = record(item.presets);
  return {
    presets: {
      slot1: 'slot1' in presets ? normalizeModelChoice(presets.slot1) : normalizeModelChoice(fallback.presets.slot1),
      slot2: 'slot2' in presets ? normalizeModelChoice(presets.slot2) : normalizeModelChoice(fallback.presets.slot2),
    },
    maxConcurrent: boundedInteger(item.maxConcurrent, fallback.maxConcurrent),
    maxPerThread: boundedInteger(item.maxPerThread, fallback.maxPerThread),
  };
}

/** Only runtime limits are effective; a legacy `defaultModel` key is ignored. */
export function normalizeEffective(value: unknown, settings: Settings): EffectiveSettings {
  const item = record(value);
  return {
    maxConcurrent: boundedInteger(item.maxConcurrent, settings.maxConcurrent),
    maxPerThread: boundedInteger(item.maxPerThread, settings.maxPerThread),
  };
}

/** Accepts the shared { settings, effective } shape; partial/missing saves fall back to the submitted values. */
export function readSettingsPayload(value: unknown, fallback: Settings = defaultSettings()): SettingsPayload {
  const item = record(value);
  const settings = normalizeSettings(item.settings, fallback);
  return { settings, effective: normalizeEffective(item.effective, settings) };
}

export function normalizeThinkingLevels(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const levels: string[] = [];
  for (const level of value) {
    const text = trimmed(level);
    if (text && !levels.includes(text)) levels.push(text);
  }
  return levels;
}

export function normalizeModels(value: unknown): DiscoveredModel[] {
  if (!Array.isArray(value)) return [];
  const models: DiscoveredModel[] = [], seen = new Set<string>();
  for (const item of value) {
    const choice = normalizeModelChoice(item);
    if (!choice || seen.has(modelKey(choice))) continue;
    seen.add(modelKey(choice));
    const name = trimmed(record(item).name);
    const model: DiscoveredModel = { provider: choice.provider, id: choice.id };
    if (name) model.name = name;
    if (Number.isSafeInteger(record(item).contextWindow) && record(item).contextWindow > 0) model.contextWindow = record(item).contextWindow;
    if (Array.isArray(record(item).input)) model.input = normalizeThinkingLevels(record(item).input);
    if (Array.isArray(record(item).reasoningEfforts)) model.reasoningEfforts = normalizeThinkingLevels(record(item).reasoningEfforts);
    models.push(model);
  }
  return models;
}

export function modelKey(model: Pick<ModelChoice, 'provider' | 'id'>): string {
  return JSON.stringify([model.provider, model.id]);
}

export function parseModelKey(key: string): { provider: string; id: string } | null {
  try {
    const value = JSON.parse(key);
    return Array.isArray(value) && value.length === 2 && typeof value[0] === 'string' && typeof value[1] === 'string'
      ? { provider: value[0], id: value[1] } : null;
  } catch { return null; }
}

export function sameModel(a?: Pick<ModelChoice, 'provider' | 'id'> | null, b?: Pick<ModelChoice, 'provider' | 'id'> | null) {
  return !!a && !!b && a.provider === b.provider && a.id === b.id;
}

export function sameChoice(a?: ModelChoice | null, b?: ModelChoice | null) {
  return a === b || (sameModel(a, b) && (a?.thinking || '') === (b?.thinking || ''));
}

export interface ModelOption {
  key: string;
  provider: string;
  id: string;
  label: string;
  discovered: boolean;
}

/** Discovered order is preserved; saved choices missing from discovery stay selectable. */
export function modelOptions(models: DiscoveredModel[], selected: Array<ModelChoice | null | undefined>): ModelOption[] {
  const options: ModelOption[] = [], seen = new Set<string>();
  for (const model of models) {
    const key = modelKey(model);
    if (seen.has(key)) continue;
    seen.add(key);
    options.push({ key, provider: model.provider, id: model.id, discovered: true,
      label: model.name && model.name !== model.id ? `${model.name} · ${model.provider}` : `${model.id} · ${model.provider}` });
  }
  for (const choice of selected) {
    if (!choice) continue;
    const key = modelKey(choice);
    if (seen.has(key)) continue;
    seen.add(key);
    options.push({ key, provider: choice.provider, id: choice.id, discovered: false,
      label: `${choice.id} · ${choice.provider}（不在当前发现列表）` });
  }
  return options;
}

export interface ThinkingOption { value: string; label: string; unsupported?: boolean }

/** Keep an already saved level visible when a probe cannot confirm it. */
export function thinkingChoices(levels: string[], current?: string): ThinkingOption[] {
  const options: ThinkingOption[] = normalizeThinkingLevels(levels).map(level => ({ value: level, label: level }));
  if (current && !options.some(option => option.value === current)) {
    options.push({ value: current, label: `${current}（当前保存，未在可用列表）`, unsupported: true });
  }
  return options;
}
