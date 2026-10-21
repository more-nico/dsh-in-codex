#!/usr/bin/env node
// Minimal DSH bridge double that models native turn closure: followUp prompts
// wait for the current turn to finish, then run FIFO, with one settlement.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

if (process.argv.includes('--version')) { console.log('0.2.1-rc.2'); process.exit(0); }
const option = name => process.argv[process.argv.indexOf(name) + 1];
const directory = process.argv.includes('--session-dir') ? option('--session-dir') : '/tmp';
const sessionFile = process.argv.includes('--session') ? option('--session') : join(directory, 'queue-session.jsonl');
if (!process.argv.includes('--no-session')) { mkdirSync(directory, { recursive: true }); writeFileSync(sessionFile, '{}\n'); }

let buffer = '', running = false, settling = false, releaseTimer, model = { provider: 'fake', id: 'queue-model' }, thinkingLevel = 'high';
const followUps = [], steering = [];
const emit = record => process.stdout.write(JSON.stringify(record) + '\n');
const response = (command, data) => emit({ id: command.id, type: 'response', command: command.type, success: true, data });
const message = (role, text, extra = {}) => ({ role, content: role === 'user' ? text : [{ type: 'text', text }], timestamp: Date.now(), usage: { totalTokens: role === 'assistant' ? 12 : 0 }, ...extra });
const queue = () => emit({ type: 'queue_update', steering: [...steering], followUp: [...followUps] });

function begin(command) {
  running = true;
  response(command, { disposition: 'started' });
  emit({ type: 'agent_start' });
  emit({ type: 'message_start', message: message('user', command.message) });
  emit({ type: 'message_end', message: message('user', command.message) });
  emit({ type: 'message_start', message: message('assistant', '', { stopReason: 'pending' }) });
  if (command.message.startsWith('auto:')) {
    const text = 'FAST:' + command.message;
    emit({ type: 'message_end', message: message('assistant', text) });
    running = false;
    emit({ type: 'agent_settled', aborted: false });
  }
}

function settle() {
  if (!running || settling) return;
  settling = true;
  emit({ type: 'message_end', message: message('assistant', 'CURRENT_TURN_DONE') });
  for (const text of followUps.splice(0)) {
    emit({ type: 'message_start', message: message('user', text) });
    emit({ type: 'message_end', message: message('user', text) });
    emit({ type: 'message_start', message: message('assistant', 'DONE:' + text) });
    emit({ type: 'message_end', message: message('assistant', 'DONE:' + text) });
  }
  running = false; settling = false;
  emit({ type: 'queue_update', steering: [], followUp: [] });
  emit({ type: 'agent_settled', aborted: false });
}

function handle(command) {
  switch (command.type) {
    case 'get_state':
      if (process.argv.includes('--patch')) emit({ type: 'extension_ui_request', method: 'notify', message: 'dsh_in_codex_ready' });
      response(command, { bridgeVersion: 1, sessionFile, sessionId: 'queue-session', model, thinkingLevel,
        isStreaming: running, isCompacting: false, pendingMessageCount: steering.length + followUps.length,
        capabilities: ['resume', 'steer', 'cancel', 'questions', 'tool-guard'] });
      break;
    case 'get_available_models': response(command, { models: [{ provider: 'fake', id: 'queue-model', name: 'Queue model', contextWindow: 128000, input: ['text'], reasoningEfforts: ['off', 'high', 'max'] }] }); break;
    case 'get_available_thinking_levels': response(command, { levels: ['off', 'high', 'max'] }); break;
    case 'set_model': model = { provider: command.provider, id: command.modelId }; response(command, model); break;
    case 'set_thinking_level': thinkingLevel = command.level; response(command, {}); break;
    case 'prompt':
      if (running && command.streamingBehavior) {
        if (command.streamingBehavior === 'followUp') {
          followUps.push(command.message);
          response(command, { disposition: 'queued' });
          queue();
        } else {
          steering.push(command.message);
          response(command, { disposition: 'queued' });
          emit({ type: 'message_start', message: message('user', command.message) });
          emit({ type: 'message_end', message: message('user', command.message) });
          queue();
          if (command.message === 'RELEASE') releaseTimer = setTimeout(settle, 10);
        }
      } else begin(command);
      break;
    case 'steer':
      if (running) {
        steering.push(command.message);
        response(command, { disposition: 'queued' });
        emit({ type: 'message_start', message: message('user', command.message) });
        emit({ type: 'message_end', message: message('user', command.message) });
        queue();
      } else response(command, { disposition: 'queued' });
      break;
    case 'abort':
      clearTimeout(releaseTimer);
      running = false;
      response(command, {});
      emit({ type: 'agent_settled', aborted: true });
      break;
    default: response(command, {});
  }
}

process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  buffer += chunk;
  let end;
  while ((end = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, end);
    buffer = buffer.slice(end + 1);
    if (line.trim()) handle(JSON.parse(line));
  }
});
process.stdin.on('end', () => process.exit(0));
