import type { ModelChoice } from '../src/types.js';
import {
  LIMIT_MAX, LIMIT_MIN, modelKey, normalizeModelChoice, normalizeThinkingLevels,
  sameChoice, type Settings,
} from './settings-types.js';

export type SettingsContext = 'slot1' | 'slot2';

/** slot1/slot2 are stable API keys; the labels are user-facing task roles. */
export const PRESET_ROLES = [
  { slot: 'slot1', label: '常规模型', purpose: '一般任务' },
  { slot: 'slot2', label: '增强模型', purpose: '更复杂或需要更深推理的任务' },
] as const;

export interface SettingsView { mounted: boolean; open: boolean }

/** The settings pane mounts lazily and stays mounted after its first open so
 * unsaved drafts and save results survive toggling without background probes. */
export function initialSettingsView(open = false): SettingsView {
  return { mounted: open, open };
}

export function toggleSettingsView(view: SettingsView): SettingsView {
  return view.open ? { mounted: view.mounted, open: false } : { mounted: true, open: true };
}

/** Numeric fields stay strings while editing so an empty/invalid value never becomes NaN silently. */
export interface SettingsDraft {
  presets: { slot1: ModelChoice | null; slot2: ModelChoice | null };
  maxConcurrent: string;
  maxPerThread: string;
}

export interface DraftErrors {
  maxConcurrent?: string;
  maxPerThread?: string;
}

export function draftFromSettings(settings: Settings): SettingsDraft {
  return {
    presets: {
      slot1: normalizeModelChoice(settings.presets.slot1),
      slot2: normalizeModelChoice(settings.presets.slot2),
    },
    maxConcurrent: String(settings.maxConcurrent),
    maxPerThread: String(settings.maxPerThread),
  };
}

export function choiceFor(draft: SettingsDraft, context: SettingsContext): ModelChoice | null {
  return draft.presets[context];
}

export function selectedModels(draft: SettingsDraft): ModelChoice[] {
  return [draft.presets.slot1, draft.presets.slot2]
    .filter((choice): choice is ModelChoice => !!choice);
}

function withChoice(draft: SettingsDraft, context: SettingsContext, choice: ModelChoice | null): SettingsDraft {
  return { ...draft, presets: { ...draft.presets, [context]: choice } };
}

/** Switching a model always clears the previous model's thinking level. */
export function setDraftModel(draft: SettingsDraft, context: SettingsContext, model: Pick<ModelChoice, 'provider' | 'id'> | null): SettingsDraft {
  return withChoice(draft, context, model ? { provider: model.provider, id: model.id } : null);
}

export function setDraftThinking(draft: SettingsDraft, context: SettingsContext, thinking: string): SettingsDraft {
  const current = choiceFor(draft, context);
  if (!current) return draft;
  const value = thinking.trim();
  return withChoice(draft, context, value
    ? { provider: current.provider, id: current.id, thinking: value }
    : { provider: current.provider, id: current.id });
}

export function limitError(value: string): string | undefined {
  const text = value.trim();
  if (!/^\d+$/.test(text)) return `请输入 ${LIMIT_MIN}–${LIMIT_MAX} 的整数`;
  const number = Number(text);
  return Number.isSafeInteger(number) && number >= LIMIT_MIN && number <= LIMIT_MAX
    ? undefined : `请输入 ${LIMIT_MIN}–${LIMIT_MAX} 的整数`;
}

export interface NormalizedDraft { settings?: Settings; errors: DraftErrors }

/** Presets are intentionally independent: identical slots and empty slots are both valid. */
export function normalizeDraft(draft: SettingsDraft): NormalizedDraft {
  const errors: DraftErrors = {};
  const concurrentError = limitError(draft.maxConcurrent), threadError = limitError(draft.maxPerThread);
  if (concurrentError) errors.maxConcurrent = concurrentError;
  if (threadError) errors.maxPerThread = threadError;
  if (concurrentError || threadError) return { errors };
  return {
    settings: {
      presets: {
        slot1: normalizeModelChoice(draft.presets.slot1),
        slot2: normalizeModelChoice(draft.presets.slot2),
      },
      maxConcurrent: Number(draft.maxConcurrent.trim()),
      maxPerThread: Number(draft.maxPerThread.trim()),
    },
    errors,
  };
}

export function draftDirty(draft: SettingsDraft | undefined, baseline: Settings | undefined): boolean {
  if (!draft || !baseline) return false;
  return !sameChoice(draft.presets.slot1, baseline.presets.slot1)
    || !sameChoice(draft.presets.slot2, baseline.presets.slot2)
    || draft.maxConcurrent.trim() !== String(baseline.maxConcurrent)
    || draft.maxPerThread.trim() !== String(baseline.maxPerThread);
}

export type EffortStatus = 'loading' | 'ready' | 'error';
export interface EffortEntry {
  status: EffortStatus;
  levels: string[];
  ticket: number;
  error?: string;
}
export type EffortMap = Record<string, EffortEntry>;

/** Effort results are cached per model key and guarded by a monotonic ticket. */
export function beginEffort(map: EffortMap, key: string, ticket: number): EffortMap {
  const current = map[key];
  if (current?.ticket === ticket && current.status === 'loading') return map;
  return { ...map, [key]: { status: 'loading', levels: [], ticket } };
}

export interface EffortOutcome { levels?: unknown; error?: string }

export function settleEffort(map: EffortMap, key: string, ticket: number, outcome: EffortOutcome): { map: EffortMap; applied: boolean } {
  const current = map[key];
  // A result for an older request (or a different model) must never replace the current selection's options.
  if (!current || current.ticket !== ticket || current.status !== 'loading') return { map, applied: false };
  if (outcome.error) {
    return { map: { ...map, [key]: { status: 'error', levels: [], ticket, error: outcome.error } }, applied: true };
  }
  return { map: { ...map, [key]: { status: 'ready', levels: normalizeThinkingLevels(outcome.levels), ticket } }, applied: true };
}

export function effortFor(map: EffortMap, choice: ModelChoice | null): EffortEntry | undefined {
  return choice ? map[modelKey(choice)] : undefined;
}

export type SaveStatus = 'idle' | 'saving' | 'saved' | 'error';
export interface SaveSnapshot {
  baseline: Settings;
  draft: SettingsDraft;
  status: SaveStatus;
  error?: string;
}

export type SaveOutcome = { ok: true; settings: Settings } | { ok: false; error: string };

/** A failed save keeps both the last saved baseline and every unsaved form value. */
export function nextSaveState(current: SaveSnapshot, outcome: SaveOutcome): SaveSnapshot {
  if (!outcome.ok) return { ...current, status: 'error', error: outcome.error || '保存设置失败' };
  return { baseline: outcome.settings, draft: draftFromSettings(outcome.settings), status: 'saved', error: undefined };
}
