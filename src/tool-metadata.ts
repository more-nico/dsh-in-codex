import type { ToolCall } from './types.js';

const DIFF_LIMIT = 16_000;
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const string = (value: unknown) => typeof value === 'string' ? value : undefined;
const lines = (value: string) => value ? value.replace(/\n$/, '').split('\n') : [];

function cappedDiff(value: string) {
  return { diff: value.slice(0, DIFF_LIMIT), diffTruncated: value.length > DIFF_LIMIT };
}

/** Keep useful file metadata even when a large write argument is clipped for transport. */
export function toolDisplayMetadata(name: string, input: unknown): ToolCall['display'] {
  if (name === 'apply_patch' && typeof input === 'string') input = { patch: input };
  if (!record(input)) return undefined;
  const path = string(input.file_path) || string(input.filePath) || string(input.path);
  const command = string(input.command) || string(input.cmd) || string(input.script);
  const base = { ...(path ? { paths: [path] } : {}),
    ...(command ? { command: command.slice(0, DIFF_LIMIT), commandTruncated: command.length > DIFF_LIMIT } : {}) };
  if (name === 'edit') {
    const before = string(input.old_string) ?? string(input.oldText);
    const after = string(input.new_string) ?? string(input.newText);
    if (before === undefined || after === undefined) return base;
    const removed = lines(before), added = lines(after);
    return { ...base, added: added.length, removed: removed.length,
      ...cappedDiff([...removed.map(line => `-${line}`), ...added.map(line => `+${line}`)].join('\n')) };
  }
  if (name === 'write') {
    const content = string(input.content) ?? string(input.text);
    if (content === undefined) return base;
    const added = lines(content);
    return { ...base, added: added.length, removed: 0, ...cappedDiff(added.map(line => `+${line}`).join('\n')) };
  }
  if (name === 'apply_patch') {
    const patch = string(input.patch) ?? string(input.input);
    if (patch === undefined) return base;
    const paths = [...patch.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)].map(match => match[1]);
    const changes = patch.split('\n').filter(line => !line.startsWith('+++') && !line.startsWith('---'));
    return { paths, added: changes.filter(line => line.startsWith('+')).length,
      removed: changes.filter(line => line.startsWith('-')).length, ...cappedDiff(patch) };
  }
  return base;
}
