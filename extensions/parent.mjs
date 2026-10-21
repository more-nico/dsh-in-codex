// DSH-native Cordis plugin. The private JSONL protocol feeds the existing
// scheduler/panel event contract; no Pi runtime or Pi extension is involved.
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import { once } from 'node:events';

export const name = 'dsh-in-codex-bridge';
export const inject = ['agents', 'llm', 'tools', 'sessions', 'sessionPersistence', 'permissionPresets', 'agentDefaultModel', 'systemPrompt', 'userQuestions'];
export const BRIDGE_VERSION = 1;
export const READ_TOOLS = ['read', 'grep', 'find', 'glob', 'ls', 'dsh_report'];
const text = blocks => (blocks || []).filter(b => b.type === 'text').map(b => b.text).join('\n');
const userMessage = value => Object.freeze({ id: randomUUID(), role: 'user', source: Object.freeze({ kind: 'user' }), content: Object.freeze([Object.freeze({ type: 'text', text: value })]) });
const errorText = error => String(error?.message || error);

export function createNativeBridge(ctx, config, emit) {
  let handle, initializing, selection, modelInfo, active = false, generation = 0;
  let failure, endReason, partial = '', lastAnswer = '', closing = false, controls = Promise.resolve(), settling = Promise.resolve();
  const pending = new Map(), calls = new Map();
  const notify = message => emit({ type: 'extension_ui_request', method: 'notify', message });
  const queue = () => {
    if (handle) emit({ type: 'queue_update', steering: handle.agent.inbox.nextStep, followUp: handle.agent.inbox.nextTurn });
  };
  const nativeMessage = (message, usage, time) => ({ ...message, timestamp: time || Date.now(),
    role: message.role === 'tool' ? 'toolResult' : message.role,
    content: message.content.map(block => block.type === 'tool-call' ? { type: 'toolCall', id: block.id, name: block.name, arguments: parseArguments(block.arguments) } : block),
    ...(message.role === 'tool' ? { toolName: calls.get(message.toolCallId) || message.source?.name } : {}),
    ...(usage ? { usage: { totalTokens: usage.totalTokens ?? usage.inputTokens + usage.outputTokens } } : {}),
  });
  const publishMessage = (message, usage, time) => emit({ type: 'message_end', message: nativeMessage(message, usage, time) });
  const checkCapabilities = () => {
    for (const [service, methods] of Object.entries({ agents: ['create', 'resume'], llm: ['listProviders', 'listModels', 'resolveModelInfo', 'resolveCallConfig'],
      sessions: ['flush'], tools: ['register', 'restrict', 'guard'], permissionPresets: ['set'], agentDefaultModel: ['currentSelection'] })) {
      if (methods.some(method => typeof ctx[service]?.[method] !== 'function')) throw new Error(`DSH bridge incompatible: missing ${service} native capability`);
    }
  };
  async function resolveSelection(candidate) {
    const info = await ctx.llm.resolveModelInfo(candidate.provider, candidate.model);
    const resolved = await ctx.llm.resolveCallConfig(candidate);
    selection = { ...candidate, ...resolved }; modelInfo = info;
  }
  async function initialize() {
    if (initializing) return initializing;
    initializing = (async () => {
      await ctx.get('loader')?.await();
      checkCapabilities();
      await resolveSelection(ctx.agentDefaultModel.currentSelection());
      if (!config.probe) {
        if (!config.id || !config.cwd) throw new Error('Missing DSH session identity or working directory');
        const setup = (agentCtx, agent) => {
          if (typeof agent.send !== 'function' || typeof agent.cancel !== 'function' || typeof agent.whenIdle !== 'function') throw new Error('DSH bridge incompatible: missing Agent controls');
          agentCtx.systemPrompt.section({ name: 'dsh-in-codex-profile', order: 999, interpolate: false,
            text: `Agent profile (${config.profile || 'worker'}): ${config.instructions || ''}\nUse dsh_report for progress or blockers. The parent supplies explicit context; finish with a concrete result.` });
          // The SDK bundle has the native question service but no interactive
          // frontend tool. Supply that entry point only when none is inherited.
          if (!ctx.tools.get('ask_user_question')) agentCtx.tools.register({
            name: 'ask_user_question', description: 'Ask the parent Codex conversation for missing information or a decision. Wait for its answers before continuing.',
            parameters: { type: 'object', required: ['questions'], additionalProperties: false, properties: { questions: { type: 'array', minItems: 1,
              items: { type: 'object', required: ['id', 'question'], additionalProperties: false, properties: {
                id: { type: 'string' }, question: { type: 'string' }, header: { type: 'string' }, multi_select: { type: 'boolean' },
                options: { type: 'array', items: { type: 'object', required: ['label'], additionalProperties: false, properties: { label: { type: 'string' }, description: { type: 'string' } } } },
              } } } } },
            output: { schema: { type: 'object', required: ['answers'], additionalProperties: false, properties: { answers: { type: 'array', items: {
              type: 'object', required: ['id', 'selected'], additionalProperties: false,
              properties: { id: { type: 'string' }, selected: { type: 'array', items: { type: 'string' } }, custom: { type: 'string' } },
            } } } }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
            async execute(args, exec) {
              return ctx.userQuestions.ask({ agent: exec.agent, signal: exec.signal,
                questions: args.questions.map(({ multi_select, ...question }) => ({ ...question, ...(multi_select === undefined ? {} : { multiSelect: multi_select }) })) });
            },
          });
          agentCtx.tools.register({ name: 'dsh_report', description: 'Report progress, a finding, or a blocker to the parent Codex conversation without ending this task.',
            parameters: { type: 'object', properties: { message: { type: 'string', minLength: 1, maxLength: 12000 } }, required: ['message'], additionalProperties: false },
            output: { schema: { type: 'object', properties: { queued: { type: 'boolean' } }, required: ['queued'], additionalProperties: false }, render: () => [{ type: 'text', text: 'Report queued for the parent.' }] },
            async execute(args) { if (typeof args.message !== 'string' || !args.message.trim() || args.message.length > 12000) throw new Error('Invalid report'); notify('dsh_in_codex_report:' + JSON.stringify({ message: args.message })); return { queued: true }; },
          });
          if (config.profile === 'reviewer' || config.profile === 'explorer') {
            const allowed = new Set(READ_TOOLS);
            agentCtx.tools.restrict({ allow: READ_TOOLS.filter(tool => ctx.tools.get(tool)) });
            agentCtx.tools.guard(exec => allowed.has(exec.name) ? undefined : 'Inspection profile: shell, writes, delegation and unlisted tools are disabled.');
          }
          agentCtx.on('approval/request', async request => {
            if (request.agent !== agent) throw new Error('Unowned approval request');
            const result = await dialog({ method: 'confirm', title: `Permission: ${request.toolName}`, message: request.reason || 'Allow this operation once?' }, request.signal);
            return result.cancelled ? 'cancelled' : result.confirmed ? 'allowed-once' : 'rejected';
          });
          agentCtx.on('user-questions/request', async request => {
            if (request.agent && request.agent !== agent) throw new Error('Unowned question request');
            const batch = new AbortController();
            const signal = request.signal ? AbortSignal.any([batch.signal, request.signal]) : batch.signal;
            try {
            const answers = await Promise.all(request.questions.map(async question => {
              const options = question.options?.map(option => option.label);
              const result = await dialog({ method: 'input', title: question.header || question.question || question.prompt,
                message: [question.question || question.prompt, question.detail, options?.length ? `Choices: ${options.join(', ')}` : '',
                  question.multiSelect ? 'Reply with a JSON array of choice labels. Free text may use {"selected":[...],"custom":"..."}.' : 'Reply with a choice label or free text.'].filter(Boolean).join('\n') }, signal,
                value => parseAnswer(question, value));
              if (result.cancelled) throw new Error('Question cancelled');
              return { id: question.id, ...parseAnswer(question, result.value) };
            }));
            return { answers };
            } finally { batch.abort(); }
          });
        };
        handle = await (config.resume ? ctx.agents.resume({ resumeSessionId: config.id, agentOptions: selection, setup })
          : ctx.agents.create({ sessionId: config.id, meta: { cwd: config.cwd }, agentOptions: selection, setup }));
        // Apply after native session initialization, before any model prompt.
        ctx.permissionPresets.set(handle.agent.session, ['reviewer', 'explorer'].includes(config.profile) ? 'read-only' : 'danger-full-access');
      }
      notify('dsh_in_codex_ready');
    })();
    return initializing;
  }
  function dialog(fields, signal, validate = () => {}) {
    if (signal?.aborted || closing) return Promise.resolve({ cancelled: true });
    const id = randomUUID();
    return new Promise(resolve => {
      const finish = result => { signal?.removeEventListener('abort', cancel); pending.delete(id); emit({ type: 'dialog_closed', id }); resolve(result); };
      const cancel = () => finish({ cancelled: true });
      pending.set(id, { finish, validate });
      signal?.addEventListener('abort', cancel, { once: true });
      emit({ type: 'extension_ui_request', id, ...fields });
    });
  }
  const disposers = [
    ctx.on('session/event', (session, event) => {
      if (!handle || session !== handle.agent.session || !active) return;
      const data = event.data;
      switch (event.type) {
        case 'user/message': publishMessage(data, undefined, event.time); break;
        case 'assistant/message':
          lastAnswer = text(data.message.content); partial = '';
          publishMessage(data.message, data.usage, event.time); break;
        case 'tool/call': calls.set(data.callId, data.name); emit({ type: 'tool_execution_start', toolName: data.name, toolCallId: data.callId }); break;
        case 'tool/result': publishMessage(data.message, undefined, event.time); emit({ type: 'tool_execution_end', toolName: calls.get(data.message.toolCallId), toolCallId: data.message.toolCallId }); break;
        case 'turn/end': endReason = data.reason; if (data.reason.kind === 'completed') failure = undefined; break;
        case 'agent/inbox/spliced': queue(); break;
      }
    }),
    ctx.on('agent/assistant-stream', ({ agent, frame }) => {
      if (!handle || agent !== handle.agent || !active) return;
      if (frame.type === 'start') { partial = ''; emit({ type: 'message_start', message: { role: 'assistant', content: [] } }); }
      if (frame.type === 'chunk' && frame.chunk.type === 'text-delta') {
        partial += frame.chunk.text; emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: frame.chunk.text } });
      } else if (frame.type === 'chunk' && frame.chunk.type === 'reasoning-delta') emit({ type: 'message_update', assistantMessageEvent: { type: 'thinking_delta' } });
    }),
    ctx.on('agent/error', ({ agent, error }) => { if (handle && agent === handle.agent) failure = error; }),
  ];
  async function settle(epoch) {
    const agent = handle.agent, subagents = ctx.get('subagents');
    try {
      while (!closing && active && generation === epoch) {
        await agent.whenIdle();
        const seq = agent.session.seq;
        const children = await subagents?.waitForChildren(agent);
        if (children || agent.status !== 'idle' || agent.session.seq !== seq) continue;
        await ctx.sessions.flush(agent.session);
        // Commands admitted during flush belong to the ongoing activity interval.
        if (generation !== epoch) return;
        if (agent.status !== 'idle' || agent.session.seq !== seq) continue;
        const error = failure || (endReason?.kind === 'error' ? endReason.error :
          ['blocked', 'max-tokens', 'interrupted'].includes(endReason?.kind) ? new Error(`DSH turn ended: ${endReason.kind}`) : undefined);
        if (error) emit({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: partial || lastAnswer }], errorMessage: errorText(error), stopReason: 'error' } });
        active = false;
        emit({ type: 'agent_settled', aborted: endReason?.kind === 'aborted' });
        return;
      }
    } catch (error) {
      if (closing || generation !== epoch) return;
      active = false;
      emit({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: partial || lastAnswer }], errorMessage: errorText(error), stopReason: 'error' } });
      emit({ type: 'agent_settled', aborted: false });
    }
  }
  async function execute(command) {
    if (command.type === 'reply') {
      const entry = pending.get(command.requestId);
      if (!entry) throw new Error('This input request has expired');
      if (!command.cancelled) entry.validate(command.value);
      entry.finish(command); return { accepted: true };
    }
    await initialize();
    const agent = handle?.agent;
    switch (command.type) {
      case 'get_state': return { bridgeVersion: BRIDGE_VERSION, capabilities: ['resume', 'steer', 'cancel', 'questions', 'tool-guard'],
        sessionFile: config.probe ? undefined : config.id, sessionId: config.id, model: { provider: selection.provider, id: selection.model }, thinkingLevel: selection.reasoningEffort,
        isStreaming: active || agent?.status === 'running', isCompacting: false, pendingMessageCount: agent ? agent.inbox.nextStep.length + agent.inbox.nextTurn.length : 0 };
      case 'get_available_models': {
        const models = [];
        for (const provider of ctx.llm.listProviders()) for (const model of await ctx.llm.listModels(provider.id)) {
          const info = await ctx.llm.resolveModelInfo(provider.id, model.id);
          models.push({ provider: provider.id, id: model.id, name: model.name,
            contextWindow: info.context?.contextWindow ?? null,
            input: info.inputModalities ?? model.inputModalities ?? null,
            reasoningEfforts: info.reasoning?.efforts?.map(effort => effort.id) ?? [] });
        }
        return { models };
      }
      case 'get_available_thinking_levels': return { levels: modelInfo.reasoning?.efforts.map(e => e.id) || [] };
      case 'set_model': case 'set_thinking_level': {
        if (active) throw new Error('Cannot change model during execution');
        const candidate = command.type === 'set_model' ? { provider: command.provider, model: command.modelId } : { ...selection, reasoningEffort: command.level };
        await resolveSelection(candidate);
        if (agent) {
          agent.options.provider = selection.provider; agent.options.model = selection.model;
          agent.options.reasoningEffort = selection.reasoningEffort;
          // A new route must not retain the former model's materialized cap.
          agent.options.maxTokens = selection.maxTokens;
        }
        return {};
      }
      case 'prompt': case 'steer': case 'follow_up': {
        if (!agent) throw new Error('Model probes cannot execute tasks');
        if (typeof command.message !== 'string' || !command.message.trim()) throw new Error('Missing message');
        if (!active && command.type === 'steer') { agent.inject(userMessage(command.message)); queue(); return { disposition: 'queued' }; }
        const wasActive = active;
        if (!active) { active = true; failure = undefined; endReason = undefined; partial = ''; lastAnswer = ''; emit({ type: 'agent_start' }); }
        const epoch = ++generation;
        const followup = command.type === 'follow_up' || command.streamingBehavior === 'followUp';
        agent.send(userMessage(command.message), followup ? 'next-turn' : 'next-step', true);
        queue(); settling = settle(epoch);
        return { disposition: wasActive ? 'queued' : 'started' };
      }
      case 'abort':
        agent?.cancel({ kind: 'user' });
        await agent?.whenIdle();
        await settling;
        return {};
      default: throw new Error(`Unknown bridge command: ${command.type}`);
    }
  }
  return {
    command(command) {
      // Replies and cancellation must bypass initialization waiting on an input.
      if (command.type === 'reply' || command.type === 'abort') return execute(command);
      const result = controls.then(() => execute(command)); controls = result.catch(() => {}); return result;
    },
    async close() {
      closing = true; generation++;
      for (const request of pending.values()) request.finish({ cancelled: true });
      if (handle) { handle.agent.cancel({ kind: 'disposed' }); await ctx.get('subagents')?.drainDescendants([handle.agent]); await handle.dispose(); }
      for (const dispose of disposers) dispose();
    },
  };
}
function parseArguments(value) { try { return typeof value === 'string' ? JSON.parse(value || '{}') : value; } catch { return value; } }
export function parseAnswer(question, value) {
  if (typeof value !== 'string') throw new Error('An input value is required');
  const options = question.options?.map(option => option.label) || [];
  if (!question.multiSelect) return options.includes(value) ? { selected: [value] } : { selected: [], custom: value };
  let parsed; try { parsed = JSON.parse(value); } catch { throw new Error('Multi-select answers require a JSON array or {selected,custom}'); }
  const answer = Array.isArray(parsed) ? { selected: parsed } : parsed;
  if (!answer || !Array.isArray(answer.selected) || answer.selected.some(v => !options.includes(v)) || new Set(answer.selected).size !== answer.selected.length || (answer.custom !== undefined && typeof answer.custom !== 'string')) throw new Error('Invalid multi-select answer');
  return { selected: answer.selected, ...(answer.custom === undefined ? {} : { custom: answer.custom }) };
}
export function apply(ctx) {
  const config = JSON.parse(process.env.DSH_IN_CODEX_SESSION || '{}');
  let writing = Promise.resolve();
  const emit = record => {
    writing = writing.then(async () => { if (!process.stdout.write(JSON.stringify(record) + '\n')) await once(process.stdout, 'drain'); });
    writing.catch(error => { process.stderr.write(errorText(error) + '\n'); process.exitCode = 1; });
  };
  const bridge = createNativeBridge(ctx, config, emit);
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  input.on('line', line => {
    let command; try { command = JSON.parse(line); } catch { emit({ type: 'protocol_error', error: 'Invalid bridge JSON' }); return; }
    bridge.command(command).then(data => emit({ type: 'response', id: command.id, success: true, data }), error => emit({ type: 'response', id: command.id, success: false, error: errorText(error) }));
  });
  ctx.effect(() => async () => { input.close(); await bridge.close(); await writing; });
}
