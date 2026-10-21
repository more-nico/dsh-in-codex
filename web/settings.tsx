import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { ModelChoice } from '../src/types.js';
import { call } from './bridge.js';
import {
  LIMIT_MAX, LIMIT_MIN, normalizeModels, modelKey, modelOptions, parseModelKey, readSettingsPayload, thinkingChoices,
  type DiscoveredModel, type EffectiveSettings, type ModelOption, type Settings,
} from './settings-types.js';
import {
  beginEffort, draftDirty, draftFromSettings, effortFor, limitError, nextSaveState, PRESET_ROLES,
  normalizeDraft, selectedModels, settleEffort, setDraftModel, setDraftThinking,
  type EffortEntry, type EffortMap, type SettingsDraft, type SaveSnapshot, type SaveStatus,
} from './settings-state.js';

const INHERIT_LABEL = '沿用 DSH 配置';
interface MigrationProvider { id: string; adapter: string; models: Array<{ id: string; name?: string; configured: boolean }> }
const migrationKey = (adapter: string, provider: string, model: string) => JSON.stringify([adapter, provider, model]);

interface ChoiceFieldsProps {
  id: string;
  choice: ModelChoice | null;
  options: ModelOption[];
  effort?: EffortEntry;
  discovering: boolean;
  modelHint: string;
  onModel: (model: Pick<ModelChoice, 'provider' | 'id'> | null) => void;
  onThinking: (thinking: string) => void;
  onRetry: () => void;
}

function ChoiceFields({ id, choice, options, effort, discovering, modelHint, onModel, onThinking, onRetry }: ChoiceFieldsProps) {
  const loading = !!choice && (!effort || effort.status === 'loading');
  const levels = effort?.status === 'ready' ? effort.levels : [];
  const thinking = choice?.thinking && effort?.status !== 'ready'
    ? [{ value: choice.thinking, label: choice.thinking }]
    : thinkingChoices(levels, choice?.thinking);
  const unsupported = !!choice?.thinking && effort?.status === 'ready' && !levels.includes(choice.thinking);
  return <>
    <div className="settings-field">
      <label htmlFor={`${id}-model`}>模型</label>
      <select id={`${id}-model`} value={choice ? modelKey(choice) : ''}
        aria-describedby={`${id}-model-hint`}
        onChange={event => onModel(parseModelKey(event.target.value))}>
        <option value="">{INHERIT_LABEL}</option>
        {options.map(option => <option key={option.key} value={option.key}>{option.label}</option>)}
      </select>
      <span id={`${id}-model-hint`} className="settings-inline">{discovering ? '正在发现可用模型；现有选择会保留。' : modelHint}</span>
    </div>
    <div className="settings-field">
      <label htmlFor={`${id}-thinking`}>思考强度</label>
      <select id={`${id}-thinking`} value={choice?.thinking ?? ''} disabled={!choice || loading}
        aria-describedby={`${id}-thinking-hint ${id}-thinking-status`}
        onChange={event => onThinking(event.target.value)}>
        <option value="">沿用模型默认强度</option>
        {thinking.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
      </select>
      <span id={`${id}-thinking-hint`} className="settings-inline">只列出该模型实时支持的等级；未选择强度时沿用模型自身的默认思考等级。</span>
      <span id={`${id}-thinking-status`} className={`settings-inline${unsupported ? ' warn' : ''}`} role="status">
        {!choice && '先选择模型后才能设置思考强度。'}
        {loading && '正在读取该模型支持的思考强度…'}
        {effort?.status === 'error' && <>
          读取思考强度失败：{effort.error || '未知错误'}。
          <button type="button" className="settings-link" onClick={onRetry}>重试</button>
        </>}
        {effort?.status === 'ready' && levels.length === 0 && '该模型未报告可调的思考强度。'}
        {unsupported && '当前保存的等级不在可用列表，保存前可重新选择。'}
      </span>
    </div>
  </>;
}

export function SettingsPage({ active }: { active: boolean }) {
  const titleRef = useRef<HTMLHeadingElement>(null);
  const saveErrorRef = useRef<HTMLDivElement>(null);
  const concurrentRef = useRef<HTMLInputElement>(null);
  const threadRef = useRef<HTMLInputElement>(null);
  const alive = useRef(true), activeRef = useRef(active), savingRef = useRef(false);
  const [baseline, setBaseline] = useState<Settings>();
  const [draft, setDraft] = useState<SettingsDraft>();
  const [effective, setEffective] = useState<EffectiveSettings>();
  const [phase, setPhase] = useState<'loading' | 'ready' | 'error'>('loading');
  const [loadError, setLoadError] = useState('');
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [models, setModels] = useState<DiscoveredModel[]>([]);
  const [modelsState, setModelsState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [modelsError, setModelsError] = useState('');
  const [modelsAttempt, setModelsAttempt] = useState(0);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>('idle');
  const [saveError, setSaveError] = useState('');
  const [profiles, setProfiles] = useState<string[]>([]);
  const [profile, setProfile] = useState('');
  const [migrationProviders, setMigrationProviders] = useState<MigrationProvider[]>([]);
  const [migrationSelected, setMigrationSelected] = useState<string[]>([]);
  const [migrationPhase, setMigrationPhase] = useState<'loading' | 'ready' | 'error'>('loading');
  const [migrationError, setMigrationError] = useState('');
  const [migrationMessage, setMigrationMessage] = useState('');
  const [migrationBusy, setMigrationBusy] = useState(false);
  const [migrationAttempt, setMigrationAttempt] = useState(0);
  const profileRef = useRef(profile);
  profileRef.current = profile;
  const [efforts, setEfforts] = useState<EffortMap>({});
  const effortsRef = useRef(efforts), ticketsRef = useRef<Record<string, number>>({}), controllersRef = useRef(new Map<string, AbortController>());
  effortsRef.current = efforts;
  activeRef.current = active;

  const loadEffort = useCallback((model: Pick<ModelChoice, 'provider' | 'id'>, force = false) => {
    const key = modelKey(model), current = effortsRef.current[key];
    if (!force && current && (current.status === 'loading' || current.status === 'ready')) return;
    const pending = controllersRef.current.get(key);
    pending?.abort();
    const ticket = (ticketsRef.current[key] || 0) + 1;
    ticketsRef.current[key] = ticket;
    const controller = new AbortController();
    controllersRef.current.set(key, controller);
    const started = beginEffort(effortsRef.current, key, ticket);
    effortsRef.current = started;
    setEfforts(started);
    call('dsh_models', { model: { provider: model.provider, id: model.id } }, controller.signal)
      .then(result => {
        if (controller.signal.aborted || controllersRef.current.get(key) !== controller) return;
        controllersRef.current.delete(key);
        const settled = settleEffort(effortsRef.current, key, ticket, { levels: result?.probe?.thinkingLevels });
        effortsRef.current = settled.map;
        setEfforts(settled.map);
      })
      .catch(error => {
        if (controller.signal.aborted || controllersRef.current.get(key) !== controller) return;
        controllersRef.current.delete(key);
        const settled = settleEffort(effortsRef.current, key, ticket, { error: (error as Error).message || '读取思考强度失败' });
        effortsRef.current = settled.map;
        setEfforts(settled.map);
      });
  }, []);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      for (const controller of controllersRef.current.values()) controller.abort();
      controllersRef.current.clear();
    };
  }, []);

  // The pane stays mounted while hidden, so focus is only moved when it becomes visible.
  useEffect(() => {
    if (active) titleRef.current?.focus();
  }, [active]);

  useEffect(() => {
    const controller = new AbortController();
    setPhase('loading'); setLoadError('');
    call('dsh_settings', {}, controller.signal)
      .then(result => {
        if (controller.signal.aborted || !alive.current) return;
        const payload = readSettingsPayload(result);
        setBaseline(payload.settings);
        setDraft(draftFromSettings(payload.settings));
        setEffective(payload.effective);
        setSaveStatus('idle'); setSaveError(''); setPhase('ready');
      })
      .catch(error => {
        if (controller.signal.aborted || !alive.current) return;
        setLoadError((error as Error).message || '加载设置失败');
        setPhase('error');
      });
    return () => controller.abort();
  }, [loadAttempt]);

  useEffect(() => {
    const controller = new AbortController();
    setModelsState('loading'); setModelsError('');
    call('dsh_models', {}, controller.signal)
      .then(result => {
        if (controller.signal.aborted || !alive.current) return;
        setModels(normalizeModels(result?.all_models));
        setModelsState('ready');
      })
      .catch(error => {
        if (controller.signal.aborted || !alive.current) return;
        setModelsError((error as Error).message || '模型列表加载失败');
        setModelsState('error');
      });
    return () => controller.abort();
  }, [modelsAttempt]);

  useEffect(() => {
    if (!draft) return;
    for (const model of selectedModels(draft)) loadEffort(model);
  }, [draft?.presets.slot1, draft?.presets.slot2, loadEffort]);

  useEffect(() => {
    const controller = new AbortController();
    setMigrationPhase('loading'); setMigrationError('');
    call('dsh_model_migration', {}, controller.signal).then(result => {
      if (controller.signal.aborted || !alive.current) return;
      setProfiles(Array.isArray(result?.profiles) ? result.profiles.filter((value: unknown) => typeof value === 'string') : []);
      if (!profileRef.current) setMigrationPhase('ready');
    }).catch(error => {
      if (controller.signal.aborted || !alive.current) return;
      setMigrationError((error as Error).message || '无法读取 profile 列表');
      if (!profileRef.current) setMigrationPhase('error');
    });
    return () => controller.abort();
  }, [migrationAttempt]);

  useEffect(() => {
    if (!profile) { setMigrationProviders([]); setMigrationSelected([]); return; }
    const controller = new AbortController();
    setMigrationPhase('loading'); setMigrationError(''); setMigrationSelected([]);
    call('dsh_model_migration', { profile }, controller.signal).then(result => {
      if (controller.signal.aborted || !alive.current) return;
      setMigrationProviders(Array.isArray(result?.providers) ? result.providers : []);
      setMigrationPhase('ready');
    }).catch(error => {
      if (controller.signal.aborted || !alive.current) return;
      setMigrationProviders([]); setMigrationError((error as Error).message || '无法读取来源模型'); setMigrationPhase('error');
    });
    return () => controller.abort();
  }, [profile, migrationAttempt]);

  async function importSelectedModels() {
    if (!profile || !migrationSelected.length || migrationBusy) return;
    const selections = migrationProviders.flatMap(provider => {
      const models = provider.models.filter(model => migrationSelected.includes(migrationKey(provider.adapter, provider.id, model.id))).map(model => model.id);
      return models.length ? [{ adapter: provider.adapter, provider: provider.id, models }] : [];
    });
    setMigrationBusy(true); setMigrationError(''); setMigrationMessage('');
    try {
      const result = await call('dsh_model_migration', { profile, selections });
      if (!alive.current) return;
      setMigrationMessage(`已迁移 ${result.imported} 个模型；原配置已备份。`);
      setMigrationAttempt(value => value + 1);
      setModelsAttempt(value => value + 1);
    } catch (error) {
      if (!alive.current) return;
      setMigrationError((error as Error).message || '迁移失败');
    } finally { if (alive.current) setMigrationBusy(false); }
  }

  const errors = draft ? normalizeDraft(draft).errors : {};
  const invalid = !!errors.maxConcurrent || !!errors.maxPerThread;
  const dirty = draftDirty(draft, baseline);
  const saving = saveStatus === 'saving';
  const options = modelOptions(models, [draft?.presets.slot1, draft?.presets.slot2]);
  const concurrentError = draft ? (errors.maxConcurrent || limitError(draft.maxConcurrent)) : undefined;
  const threadError = draft ? (errors.maxPerThread || limitError(draft.maxPerThread)) : undefined;

  const updateDraft = (next: SettingsDraft) => {
    setDraft(next);
    setSaveStatus(status => status === 'saved' ? 'idle' : status);
  };

  const cancel = () => {
    if (!baseline || saving) return;
    setDraft(draftFromSettings(baseline)); setSaveStatus('idle'); setSaveError('');
  };

  async function save() {
    if (!draft || !baseline || savingRef.current) return;
    const normalized = normalizeDraft(draft);
    if (!normalized.settings) {
      setSaveStatus('error'); setSaveError('请先修正并发上限。');
      requestAnimationFrame(() => { if (activeRef.current) (normalized.errors.maxConcurrent ? concurrentRef.current : threadRef.current)?.focus(); });
      return;
    }
    savingRef.current = true;
    setSaveStatus('saving'); setSaveError('');
    try {
      const result = await call('dsh_settings', { update: normalized.settings });
      if (!alive.current) return;
      const payload = readSettingsPayload(result, normalized.settings);
      const snapshot: SaveSnapshot = { baseline, draft, status: 'saving' };
      const next = nextSaveState(snapshot, { ok: true, settings: payload.settings });
      setBaseline(next.baseline); setDraft(next.draft); setEffective(payload.effective);
      setSaveStatus(next.status); setSaveError('');
    } catch (error) {
      if (!alive.current) return;
      const snapshot: SaveSnapshot = { baseline, draft, status: 'saving' };
      const next = nextSaveState(snapshot, { ok: false, error: (error as Error).message || '保存设置失败' });
      setSaveStatus(next.status); setSaveError(next.error || '保存设置失败');
      requestAnimationFrame(() => { if (activeRef.current) saveErrorRef.current?.focus(); });
    } finally {
      savingRef.current = false;
    }
  }

  const statusText = saving ? '正在保存…'
    : saveStatus === 'error' ? '保存失败，修改尚未生效'
      : dirty ? '有未保存的修改'
        : saveStatus === 'saved' ? '已保存' : '没有修改';
  const statusClass = saving ? '' : saveStatus === 'error' ? ' error' : dirty ? ' dirty' : '';

  return <section id="settings-page" className="settings-page" aria-labelledby="settings-title" hidden={!active} inert={!active}>
    <div className="settings-heading">
      <div className="settings-title-row">
        <h1 id="settings-title" ref={titleRef} tabIndex={-1}>设置</h1>
        {dirty && <span className="settings-dirty-pill">未保存</span>}
      </div>
    </div>
    <p className="settings-intro">设置只影响之后派发的任务，运行中的任务不会切换模型。主 Agent 会按任务从常规、增强两档中选择，也可在派发时显式指定模型。派发优先级：显式 model &gt; 所选档位 &gt; DSH 原生配置；档位留空则沿用 DSH 配置。</p>

    {phase === 'loading' && <div className="settings-loading" role="status">正在加载设置…</div>}
    {phase === 'error' && <div className="settings-load-error" role="alert">
      <p>无法加载设置：{loadError || '未知错误'}</p>
      <div className="settings-buttons">
        <button type="button" className="settings-button" onClick={() => setLoadAttempt(value => value + 1)}>重试</button>
      </div>
    </div>}

    {phase === 'ready' && draft && baseline && <form noValidate onSubmit={event => { event.preventDefault(); void save(); }}>
      {effective && <div className="settings-summary" aria-label="当前生效的设置">
        <span>当前生效（已保存）</span>
        <span>全局并发：{effective.maxConcurrent}</span>
        <span>每聊天并发：{effective.maxPerThread}</span>
        <span>模型档位由主 Agent 按任务选择</span>
      </div>}

      {modelsState === 'loading' && <p className="settings-inline" role="status">正在发现可用模型…</p>}
      {modelsState === 'error' && <div className="settings-notice" role="alert">
        <span>模型列表加载失败：{modelsError || '未知错误'}。现有配置和已保存的选择不会丢失。</span>
        <button type="button" className="settings-link" onClick={() => setModelsAttempt(value => value + 1)}>重试</button>
      </div>}
      {modelsState === 'ready' && models.length === 0 && <p className="settings-inline">未发现可用模型；现有配置不会被清除。</p>}

      <fieldset className="settings-fieldset" disabled={saving}>
        <section className="settings-section" aria-labelledby="settings-presets-title">
          <h2 id="settings-presets-title">任务模型档位</h2>
          <p className="settings-hint">常规模型用于一般任务，增强模型用于更复杂或需要更深推理的任务。主 Agent 按任务选择档位，也可在派发时显式指定模型；显式 model 优先于档位。两档互相独立，可用同一模型分别设置 high / max，也可完全相同；留空时沿用 DSH 配置。</p>
          <div className="preset-grid">
            {PRESET_ROLES.map(role => <fieldset className="preset-card" key={role.slot}>
              <legend>{role.label}</legend>
              <p className="preset-role">适合{role.purpose}。</p>
              <div className="settings-fields">
                <ChoiceFields id={role.slot} choice={draft.presets[role.slot]}
                  options={options} effort={effortFor(efforts, draft.presets[role.slot])} discovering={modelsState === 'loading'}
                  modelHint="留空时沿用 DSH 配置；只有主 Agent 明确选择该档位时才使用。"
                  onModel={model => updateDraft(setDraftModel(draft, role.slot, model))}
                  onThinking={thinking => updateDraft(setDraftThinking(draft, role.slot, thinking))}
                  onRetry={() => draft.presets[role.slot] && loadEffort(draft.presets[role.slot]!, true)} />
              </div>
            </fieldset>)}
          </div>
        </section>

        <section className="settings-section" aria-labelledby="settings-migration-title">
          <h2 id="settings-migration-title">从 DSH profile 迁移模型</h2>
          <p className="settings-hint">选择来源 profile、provider 和模型。目标中同名 provider 的现有连接配置会保留，只追加所选模型；同 ID 模型不能重复导入。</p>
          <div className="settings-field">
            <label htmlFor="migration-profile">来源 profile</label>
            <select id="migration-profile" value={profile} disabled={migrationBusy}
              onChange={event => { setProfile(event.target.value); setMigrationMessage(''); }}>
              <option value="">请选择 profile</option>
              {profiles.map(name => <option key={name} value={name}>{name}</option>)}
            </select>
          </div>
          {migrationPhase === 'loading' && <p className="settings-inline" role="status">正在读取 profile 和模型…</p>}
          {migrationPhase === 'error' && <div className="settings-notice" role="alert">
            <span>{migrationError}</span>
            <button type="button" className="settings-link" onClick={() => setMigrationAttempt(value => value + 1)}>重试</button>
          </div>}
          {migrationPhase === 'ready' && migrationError && <div className="settings-notice" role="alert"><span>{migrationError}</span></div>}
          {migrationPhase === 'ready' && !profiles.length && <p className="settings-inline">没有找到其他 DSH profile。</p>}
          {migrationPhase === 'ready' && profile && !migrationProviders.length && <p className="settings-inline">该 profile 没有可迁移的 provider 模型配置。</p>}
          {migrationPhase === 'ready' && migrationProviders.map(provider => <div className="migration-provider" key={JSON.stringify([provider.adapter, provider.id])}>
            <div className="migration-provider-title">{provider.id} <span>· {provider.adapter}</span></div>
            {provider.models.map(model => {
              const key = migrationKey(provider.adapter, provider.id, model.id);
              return <label className={`migration-model${model.configured ? ' configured' : ''}`} key={key}>
                <input type="checkbox" checked={model.configured || migrationSelected.includes(key)} disabled={model.configured || migrationBusy}
                  onChange={event => setMigrationSelected(current => event.target.checked ? [...current, key] : current.filter(value => value !== key))} />
                <span>{model.name && model.name !== model.id ? `${model.name} · ` : ''}{model.id}</span>
                {model.configured && <span className="migration-configured">已配置</span>}
              </label>;
            })}
          </div>)}
          {migrationMessage && <p className="settings-inline" role="status">{migrationMessage}</p>}
          <div className="settings-buttons migration-actions">
            <button type="button" className="settings-button primary" disabled={migrationBusy || migrationPhase !== 'ready' || !migrationSelected.length}
              onClick={() => void importSelectedModels()}>{migrationBusy ? '正在迁移…' : `迁移所选模型${migrationSelected.length ? `（${migrationSelected.length}）` : ''}`}</button>
          </div>
        </section>

        <section className="settings-section" aria-labelledby="settings-concurrency-title">
          <h2 id="settings-concurrency-title">并发限制</h2>
          <p className="settings-hint">全局上限约束所有聊天，每个聊天另有独立上限。降低上限只影响后续排队，不会终止正在运行的任务。</p>
          <div className="settings-fields two">
            <div className="settings-field">
              <label htmlFor="settings-max-concurrent">全局最大并发</label>
              <input ref={concurrentRef} id="settings-max-concurrent" type="number" inputMode="numeric" min={LIMIT_MIN} max={LIMIT_MAX} step={1}
                value={draft.maxConcurrent} aria-invalid={!!concurrentError} aria-describedby="settings-max-concurrent-hint settings-max-concurrent-error"
                onChange={event => updateDraft({ ...draft, maxConcurrent: event.target.value })} />
              <span id="settings-max-concurrent-hint" className="settings-inline">整个面板同时运行的任务数。</span>
              {concurrentError && <span id="settings-max-concurrent-error" className="settings-inline error" aria-live="polite">{concurrentError}</span>}
            </div>
            <div className="settings-field">
              <label htmlFor="settings-max-thread">每聊天最大并发</label>
              <input ref={threadRef} id="settings-max-thread" type="number" inputMode="numeric" min={LIMIT_MIN} max={LIMIT_MAX} step={1}
                value={draft.maxPerThread} aria-invalid={!!threadError} aria-describedby="settings-max-thread-hint settings-max-thread-error"
                onChange={event => updateDraft({ ...draft, maxPerThread: event.target.value })} />
              <span id="settings-max-thread-hint" className="settings-inline">单个聊天同时运行的任务数，仍受全局上限约束。</span>
              {threadError && <span id="settings-max-thread-error" className="settings-inline error" aria-live="polite">{threadError}</span>}
            </div>
          </div>
          {!invalid && Number(draft.maxPerThread) > Number(draft.maxConcurrent) && <p className="settings-inline">每聊天上限高于全局上限；实际同时运行数仍受全局上限限制。</p>}
        </section>
      </fieldset>

      {saveStatus === 'error' && <div ref={saveErrorRef} tabIndex={-1} className="settings-save-error" role="alert">
        <p>{saveError || '保存设置失败'}</p>
        <button type="button" className="settings-link" disabled={saving || invalid} onClick={() => void save()}>重试保存</button>
      </div>}

      <div className="settings-actions">
        <span className={`settings-status${statusClass}`} role="status" aria-live="polite">{statusText}</span>
        <div className="settings-buttons">
          <button type="button" className="settings-button" onClick={cancel} disabled={!dirty || saving}>取消修改</button>
          <button type="submit" className="settings-button primary" disabled={!dirty || saving || invalid}>{saving ? '正在保存…' : '保存'}</button>
        </div>
      </div>
    </form>}
  </section>;
}
