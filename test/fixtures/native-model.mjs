// Keyless model adapter loaded inside the REAL installed DSH runtime.
import { writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
const requireDsh = createRequire(process.env.DSH_TEST_ANCHOR);
const { LlmAdapter } = await import(pathToFileURL(requireDsh.resolve('@deepseek-ai/dsh-llm')).href);
export const name = 'dsh-in-codex-test-model';
export const inject = ['llm', 'approval'];
const contentText = message => (message.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n');
class MockModel extends LlmAdapter {
  async listModels(provider) { return [{ provider, id: 'mock', name: 'Keyless test model' }]; }
  async resolveModel(provider, model) { return { provider, id: model, name: model, defaultMaxTokens: model === 'limited' ? 16 : 64, context: { contextWindow: 100000 }, reasoning: { efforts: [{ id: 'high', name: 'High' }, { id: 'max', name: 'Max' }] } }; }
  async *stream(options) {
    if (options.model === 'limited' && options.maxTokens > 16) throw new Error('STALE_MODEL_OUTPUT_CAP');
    const messages = options.messages;
    const lastUser = messages.filter(m => m.role === 'user' && (m.source?.kind === 'user' || contentText(m) === 'SLOW_CHILD')).at(-1);
    const prompt = contentText(lastUser || {});
    const lastTool = messages.filter(m => m.role === 'tool').at(-1);
    const requested = /TOOL:(\w+):(.*)/s.exec(prompt);
    if (prompt.includes('HOLD')) {
      await new Promise(resolve => {
        if (options.signal.aborted) return resolve();
        options.signal.addEventListener('abort', resolve, { once: true });
      });
      yield { type: 'finish', reason: { kind: 'aborted' } }; return;
    }
    if (prompt.includes('SLOW')) await new Promise(resolve => setTimeout(resolve, 500));
    if (prompt.startsWith('SLOW_CHILD')) await writeFile(process.env.DSH_TEST_DESCENDANT_MARKER, 'CHILD_DONE');
    if (prompt.includes('FAIL')) throw new Error('MOCK_PROVIDER_FAILURE');
    if (requested && !lastTool) {
      const block = { type: 'tool-call', id: 'call-' + Date.now(), name: requested[1], arguments: requested[2] };
      yield { type: 'block-start', index: 0, blockType: 'tool-call' };
      yield { type: 'tool-call-delta', index: 0, id: block.id, name: block.name, argumentsDelta: block.arguments };
      yield { type: 'block-end', index: 0, block };
      yield { type: 'finish', reason: { kind: 'tool-calls' } }; return;
    }
    let answer = lastTool ? 'TOOL_RESULT:' + contentText(lastTool) : 'MOCK_OK:' + prompt;
    if (prompt.includes('RECALL')) answer = 'RECALL:' + messages.filter(m => m.role === 'user').map(contentText).join('|');
    yield { type: 'block-start', index: 0, blockType: 'text' };
    yield { type: 'text-delta', index: 0, text: answer };
    yield { type: 'block-end', index: 0, block: { type: 'text', text: answer } };
    yield { type: 'usage', usage: { inputTokens: 7, outputTokens: 5, totalTokens: 12 } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  }
}
export function apply(ctx) {
  ctx.llm.registerAdapter(['codex-test'], new MockModel());
  // A local tool is not masked by inherited-tool restrictions. The native
  // bridge guard must still block model dispatch to it in inspection profiles.
  ctx.on('agent/created', ({ agent }) => {
    agent.ctx.tools.register({ name: 'native_permission', description: 'Exercise the native approval seam',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      async execute(_args, exec) { ctx.approval.setPolicy(exec.agent, 'ask'); return ctx.approval.request({ agent: exec.agent, toolName: 'native_permission', reason: 'Test one-shot permission', signal: exec.signal }); },
    });
    agent.ctx.tools.register({ name: 'bypass_write', description: 'Integration-test local write tool',
      parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false },
      output: { schema: { type: 'boolean' }, render: () => [{ type: 'text', text: 'written' }] },
      async execute(args) { await writeFile(args.path, 'BYPASSED'); return true; },
    });
  });
}
