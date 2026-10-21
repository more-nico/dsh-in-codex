import React, { memo, useMemo, useState } from 'react';
import type { Message, Status, ToolCall } from '../src/types.js';
import { compactLine, outputSummary, prettyArguments, transcriptMessages, type TranscriptMessage } from './messages.js';
import { MessageContent } from './content.js';
import { presentTool, type ToolStatus } from './tool-display.js';

const statusLabel: Record<ToolStatus, string> = { running: '执行中', success: '成功', failed: '失败', interrupted: '中断', partial: '部分结果' };

function Disclosure({ label, hint, meta, tone, rawName, status, children, defaultOpen = false }: { label: string; hint?: string; meta?: string; tone?: 'danger'; rawName?: string; status?: ToolStatus; children: () => React.ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  return <details open={open} onToggle={event => setOpen(event.currentTarget.open)} className={`disclosure${tone ? ` tone-${tone}` : ''}`}>
    <summary><span className="disclosure-label">{label}{rawName && <small className="tool-raw-name">{rawName}</small>}</span>{hint && <span className="disclosure-hint" title={hint}>{hint}</span>}{meta && <span className="disclosure-meta" title={meta}>{meta}</span>}{status && <span className={`tool-status ${status}`}>{statusLabel[status]}</span>}<span className="disclosure-chevron" aria-hidden="true" /></summary>
    {open && <div className="disclosure-body">{children()}</div>}
  </details>;
}

const ToolCallRow = memo(function ToolCallRow({ call, result, agentId, startedAt, runStatus, defaultOpen }: { call: ToolCall; result?: Message; agentId?: string; startedAt?: number; runStatus?: Status; defaultOpen?: boolean }) {
  const view = presentTool(call, result, startedAt, runStatus);
  const source = result && agentId && !view.transformed ? { agentId, messageId: result.id } : undefined;
  return <Disclosure label={view.title} rawName={view.rawName} hint={view.hint} meta={view.meta} status={view.status}
    tone={view.status === 'failed' ? 'danger' : undefined} defaultOpen={defaultOpen}>{() => <>
    {view.errorLine && <p className="tool-error-focus">{view.errorLine}</p>}
    {view.command && <><div className="tool-section-label">命令</div><pre className="command-line">$ {view.command}</pre></>}
    {!!view.paths?.length && <div className="tool-file-list">{view.paths.map(path => <span key={path}>{path}</span>)}</div>}
    {view.diff && <><div className="tool-section-label">差异预览{view.diffTruncated ? '（已截断）' : ''}</div><pre className="tool-diff">{view.diff}</pre></>}
    {view.matches && view.matches.length > 0 && <div className="tool-search-groups">{view.matches.map(group => <section key={group.file}>
      <h4>{group.file}</h4>{group.lines.map((line, index) => <div className="tool-search-line" key={`${line.number}:${index}`}><span>{line.number}</span><code>{line.text}</code></div>)}
    </section>)}</div>}
    {result ? <>
      {view.kind === 'search' && view.matches?.length ? <details className="tool-secondary"><summary>完整搜索输出</summary>
        <MessageContent text={view.output} total={view.transformed ? undefined : result.textTotal} literal source={source} /></details>
        : <><div className="tool-section-label">{view.kind === 'dispatch' ? '完整任务数据' : '执行结果'}{!result.complete ? '（部分输出）' : ''}</div>
          <MessageContent text={view.output} total={view.transformed ? undefined : result.textTotal} literal source={source} /></>}
    </> : <pre>尚未收到工具结果。</pre>}
    {result?.error && <p className="message-error">{result.error}</p>}
    <details className="tool-secondary"><summary>原始参数</summary><pre>{prettyArguments(call.arguments)}</pre></details>
  </>}</Disclosure>;
});

const auxiliaryLabels: Record<string, string> = { toolResult: '工具结果', bashExecution: '命令', system: '系统', custom: '扩展消息', branchSummary: '分支摘要', compactionSummary: '压缩摘要' };
const auxiliaryLabel = (message: Message) => message.role === 'toolResult' && message.toolName ? `工具 · ${message.toolName}` : auxiliaryLabels[message.role] || `消息 · ${message.role}`;

const MessageItem = memo(function MessageItem({ message, tools, agentId, runStatus, defaultExpanded }: TranscriptMessage & { agentId?: string; runStatus?: Status; defaultExpanded?: boolean }) {
  const time = new Date(message.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (message.role === 'user') return <article className="message user">
    <header className="message-label"><span>指令</span><time>{time}</time></header>
    <MessageContent text={message.text} total={message.textTotal} source={agentId ? { agentId, messageId: message.id } : undefined} />
    {message.error && <p className="message-error">{message.error}</p>}
  </article>;
  if (message.role === 'assistant') return <article className="message assistant">
    <header className="message-label"><span>DSH</span><time>{time}</time>{!message.complete && <i className="typing" aria-label="正在输出" />}</header>
    {message.text ? <MessageContent text={message.text} total={message.textTotal} source={agentId ? { agentId, messageId: message.id } : undefined} /> : !message.complete ? <div className="message-text placeholder">…</div> : null}
    {tools.map(({ call, result }, index) => <ToolCallRow key={call.id || `${message.id}-${index}`} call={call} result={result} agentId={agentId} startedAt={message.timestamp} runStatus={runStatus} defaultOpen={defaultExpanded} />)}
    {!message.text && message.complete && !tools.length && <div className="message-text placeholder">(无文本)</div>}
    {message.error && <p className="message-error">{message.error}</p>}
  </article>;
  const shell = message.role === 'bashExecution' ? presentTool({ id: message.id, name: 'bash', arguments: JSON.stringify({ command: message.command || '' }) }, message, undefined, runStatus) : undefined;
  return <article className={`message auxiliary${message.isError ? ' is-error' : ''}`}>
    <Disclosure label={shell?.title || auxiliaryLabel(message)} rawName={shell?.rawName} hint={shell?.hint || (message.command ? `$ ${message.command}` : compactLine(message.text))}
      meta={shell?.meta || outputSummary(message.text, message.textTotal)} status={shell?.status} tone={message.isError ? 'danger' : undefined} defaultOpen={defaultExpanded}>{() => <>
      {message.command && <pre className="command-line"><span aria-hidden="true">$ </span>{message.command}</pre>}
      <MessageContent text={message.text} total={message.textTotal} literal={['tool', 'toolResult', 'bashExecution'].includes(message.role)} source={agentId ? { agentId, messageId: message.id } : undefined} />
    </>}</Disclosure>
  </article>;
}, (a, b) => a.message === b.message && a.agentId === b.agentId && a.runStatus === b.runStatus && a.defaultExpanded === b.defaultExpanded
  && a.tools.length === b.tools.length && a.tools.every((tool, index) => tool.call === b.tools[index].call && tool.result === b.tools[index].result));

export const Transcript = memo(function Transcript({ messages, agentId, runStatus, defaultExpanded = false }: { messages: Message[]; agentId?: string; runStatus?: Status; defaultExpanded?: boolean }) {
  const rows = useMemo(() => transcriptMessages(messages), [messages]);
  return <>{rows.map(item => <MessageItem key={item.message.id} {...item} agentId={agentId} runStatus={runStatus} defaultExpanded={defaultExpanded} />)}</>;
});
