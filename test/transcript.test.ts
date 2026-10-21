import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Message } from '../src/types.js';
import { Transcript } from '../web/transcript.js';

const invocation = (id = 'call'): Message => ({
  id: 'assistant', runId: 'run', role: 'assistant', text: 'Reading **source**.', complete: true, timestamp: 0,
  toolCalls: [{ id, name: 'read', arguments: '{"path":"first.ts"}' }],
});
const result = (id = 'call', text = 'FIRST_OUTPUT'): Message => ({
  id: 'result', runId: 'run', role: 'toolResult', toolCallId: id, toolName: 'read', text, complete: true, timestamp: 1,
});
const render = (messages: Message[]) => renderToStaticMarkup(React.createElement(Transcript, { messages, defaultExpanded: true }));
const rows = (html: string) => html.match(/<details\b[\s\S]*?<\/details>/g) || [];

test('parallel calls of the same tool match by call ID even when results arrive in reverse order', () => {
  const call = invocation();
  call.toolCalls!.push({ id: 'second', name: 'read', arguments: '{"path":"second.ts"}' });
  const html = render([call, { ...result('second', 'SECOND_OUTPUT'), id: 'second-result' }, result()]);
  const paired = rows(html);
  assert.equal(paired.length, 2);
  assert.match(paired[0], /first\.ts/); assert.match(paired[0], /FIRST_OUTPUT/);
  assert.doesNotMatch(paired[0], /SECOND_OUTPUT/);
  assert.match(paired[1], /second\.ts/); assert.match(paired[1], /SECOND_OUTPUT/);
  assert.doesNotMatch(paired[1], /FIRST_OUTPUT/);
});

test('failed output stays on the paired row and untrusted output is literal text', () => {
  const html = render([invocation(), { ...result('call', '<script>unsafe()</script>'), isError: true }]);
  assert.equal(rows(html).length, 1);
  assert.match(html, /tone-danger/); assert.match(html, /tool-status failed/);
  assert.match(html, /&lt;script&gt;unsafe\(\)&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script>/);
});

test('standalone shell records show the command action and exit status', () => {
  const shell: Message = { id: 'shell', runId: 'run', role: 'bashExecution', command: 'npm run build', text: 'build complete',
    timestamp: 2, complete: true, exitCode: 0 };
  const html = render([shell]);
  assert.match(html, /编译项目/);
  assert.match(html, /退出码 0/);
  assert.match(html, /tool-status success/);
});
