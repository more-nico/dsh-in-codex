/**
 * A deliberately small, comment-preserving TOML editor.
 *
 * Codex owns `config.toml`; rewriting it with a serializer would drop comments and
 * formatting. This module locates a single dotted key and patches only its value (or
 * appends one missing table). Anything it does not fully understand is rejected
 * before a write, so unknown TOML forms are left intact rather than corrupted.
 */

export class TomlEditError extends Error {
  constructor(message: string) { super(message); this.name = 'TomlEditError'; }
}

export interface TomlTable {
  path: string[];
  array: boolean;
  /** Offset of the first non-space character of the header. */
  headerStart: number;
  /** Offset just after the closing header bracket. */
  headerEnd: number;
  /** Offset of the first byte after the header line. */
  bodyStart: number;
}

export interface TomlAssignment {
  path: string[];
  table: string[];
  start: number;
  lineStart: number;
  lineEnd: number;
  valueStart: number;
  valueEnd: number;
  value: string;
  /** True when the value continues on later lines (arrays, inline tables, multiline strings). */
  multiline: boolean;
}

export interface TomlScan {
  tables: TomlTable[];
  assignments: TomlAssignment[];
  newline: '\n' | '\r\n';
}

const whitespace = /[ \t\uFEFF]/;
const bareKey = /^[A-Za-z0-9_-]+$/;

function fail(message: string): never { throw new TomlEditError(message); }

function unescapeBasic(value: string): string {
  let result = '';
  for (let index = 0; index < value.length; index++) {
    const character = value[index];
    if (character !== '\\') { result += character; continue; }
    const next = value[++index];
    if (next === undefined) fail('Unterminated escape in TOML key or string');
    if (next === 'b') result += '\b';
    else if (next === 't') result += '\t';
    else if (next === 'n') result += '\n';
    else if (next === 'f') result += '\f';
    else if (next === 'r') result += '\r';
    else if (next === '"') result += '"';
    else if (next === '\\') result += '\\';
    else if (next === 'u' || next === 'U') {
      const length = next === 'u' ? 4 : 8;
      const digits = value.slice(index + 1, index + 1 + length);
      if (!new RegExp(`^[0-9A-Fa-f]{${length}}$`).test(digits)) fail('Invalid unicode escape in TOML string');
      result += String.fromCodePoint(parseInt(digits, 16)); index += length;
    } else fail(`Unsupported TOML escape \\${next}`);
  }
  return result;
}

function quoted(value: string): { text: string; end: number } {
  const delimiter = value[0];
  if (delimiter !== '"' && delimiter !== "'") fail('Expected a quoted TOML key');
  let end = 1;
  while (end < value.length) {
    if (delimiter === '"' && value[end] === '\\') { end += 2; continue; }
    if (value[end] === delimiter) {
      const raw = value.slice(1, end);
      return { text: delimiter === '"' ? unescapeBasic(raw) : raw, end: end + 1 };
    }
    end++;
  }
  return fail('Unterminated quoted TOML key');
}

/** Parse `a."b.c".d` into path segments without touching whitespace inside quotes. */
export function parseKeyPath(raw: string): string[] {
  const path: string[] = [];
  let index = 0;
  while (index < raw.length) {
    while (index < raw.length && whitespace.test(raw[index])) index++;
    if (index >= raw.length) break;
    let segment: string;
    if (raw[index] === '"' || raw[index] === "'") {
      const parsed = quoted(raw.slice(index));
      segment = parsed.text; index += parsed.end;
    } else {
      const start = index;
      while (index < raw.length && raw[index] !== '.') index++;
      segment = raw.slice(start, index).trimEnd();
      if (!bareKey.test(segment)) fail(`Unsupported TOML key ${JSON.stringify(segment)}`);
    }
    path.push(segment);
    while (index < raw.length && whitespace.test(raw[index])) index++;
    if (index >= raw.length) break;
    if (raw[index] !== '.') fail(`Unexpected character in TOML key: ${raw[index]}`);
    index++;
    while (index < raw.length && whitespace.test(raw[index])) index++;
    if (index >= raw.length) fail('TOML key ends with a dot');
  }
  if (path.length === 0) fail('Empty TOML key');
  return path;
}

function findUnquoted(line: string, from: number, target: string): number {
  let quote: '"' | "'" | null = null;
  for (let index = from; index < line.length; index++) {
    const character = line[index];
    if (quote === '"') {
      if (character === '\\') index++;
      else if (character === '"') quote = null;
    } else if (quote === "'") {
      if (character === "'") quote = null;
    } else if (character === '"' || character === "'") quote = character;
    else if (character === '#') return -1;
    else if (character === target) return index;
  }
  return -1;
}

interface LineScan {
  valueEnd: number;
  value: string;
  multiline: boolean;
  depth: number;
  multilineString: { delimiter: string; basic: boolean } | null;
}

/** Scan a value beginning at `start`, returning state that continues on the next line. */
function scanValue(line: string, start: number, initialDepth: number, initialMultiline: LineScan['multilineString']): LineScan {
  let depth = initialDepth;
  let multilineString = initialMultiline;
  let valueEnd = start;
  let comment = -1;
  let index = start;
  while (index < line.length) {
    if (multilineString) {
      const delimiter = multilineString.delimiter;
      if (line.startsWith(delimiter, index)) {
        if (multilineString.basic) {
          let backslashes = 0;
          for (let cursor = index - 1; cursor >= 0 && line[cursor] === '\\'; cursor--) backslashes++;
          if (backslashes % 2 === 1) { index += delimiter.length; continue; }
        }
        index += delimiter.length; multilineString = null; valueEnd = index; continue;
      }
      if (multilineString.basic && line[index] === '\\') { index += 2; continue; }
      index++; valueEnd = index; continue;
    }
    const character = line[index];
    if (character === '#') { comment = index; break; }
    if (character === '"' || character === "'") {
      if (line.startsWith(character.repeat(3), index)) {
        multilineString = { delimiter: character.repeat(3), basic: character === '"' };
        index += 3; valueEnd = index; continue;
      }
      const delimiter = character;
      index++;
      while (index < line.length) {
        if (character === '"' && line[index] === '\\') { index += 2; continue; }
        if (line[index] === delimiter) { index++; break; }
        index++;
      }
      valueEnd = index; continue;
    }
    if (character === '[' || character === '{') depth++;
    else if (character === ']' || character === '}') depth = Math.max(0, depth - 1);
    index++; valueEnd = index;
  }
  if (comment >= 0) {
    while (valueEnd > start && whitespace.test(line[valueEnd - 1])) valueEnd--;
  }
  const multiline = depth > 0 || multilineString !== null;
  let valueEndTrimmed = valueEnd;
  while (valueEndTrimmed > start && whitespace.test(line[valueEndTrimmed - 1])) valueEndTrimmed--;
  return { valueEnd: valueEndTrimmed, value: line.slice(start, valueEndTrimmed), multiline, depth, multilineString };
}

function findHeaderEnd(line: string, start: number, array: boolean): number {
  let quote: '"' | "'" | null = null;
  for (let index = start; index < line.length; index++) {
    const character = line[index];
    if (quote === '"') {
      if (character === '\\') index++;
      else if (character === '"') quote = null;
    } else if (quote === "'") {
      if (character === "'") quote = null;
    } else if (character === '"' || character === "'") quote = character;
    else if (character === ']') {
      if (!array) return index;
      if (line[index + 1] === ']') return index;
    }
  }
  return -1;
}

/**
 * Scan enough TOML structure to locate tables and dotted keys. It intentionally
 * does not validate the whole document; editing targets are verified separately.
 */
export function scanToml(text: string): TomlScan {
  const newline: '\n' | '\r\n' = text.includes('\r\n') ? '\r\n' : '\n';
  const tables: TomlTable[] = [];
  const assignments: TomlAssignment[] = [];
  let table: string[] = [];
  let tableBodyStart = 0;
  let depth = 0;
  let multilineString: LineScan['multilineString'] = null;
  let offset = 0;

  while (offset <= text.length) {
    const newlineIndex = text.indexOf('\n', offset);
    const rawEnd = newlineIndex === -1 ? text.length : newlineIndex;
    const raw = text.slice(offset, rawEnd);
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    const nextOffset = newlineIndex === -1 ? text.length + 1 : newlineIndex + 1;

    if (depth > 0 || multilineString) {
      const continuation = scanValue(line, 0, depth, multilineString);
      depth = continuation.depth; multilineString = continuation.multilineString;
      offset = nextOffset; continue;
    }

    let start = 0;
    while (start < line.length && whitespace.test(line[start])) start++;
    if (start >= line.length || line[start] === '#') { offset = nextOffset; continue; }

    if (line[start] === '[') {
      const array = line[start + 1] === '[';
      const closing = findHeaderEnd(line, start + (array ? 2 : 1), array);
      if (closing < 0) fail(`Unterminated TOML table header on line ${text.slice(0, offset).split('\n').length}`);
      const header = line.slice(start + (array ? 2 : 1), closing).trim();
      const path = parseKeyPath(header);
      table = path;
      tableBodyStart = nextOffset;
      tables.push({ path, array, headerStart: offset + start, headerEnd: offset + closing + (array ? 2 : 1), bodyStart: nextOffset });
      offset = nextOffset; continue;
    }

    const equals = findUnquoted(line, start, '=');
    if (equals < 0) fail(`Unsupported TOML line ${text.slice(0, offset).split('\n').length}: ${line.trim()}`);
    const keyPath = parseKeyPath(line.slice(start, equals));
    let valueStart = equals + 1;
    while (valueStart < line.length && whitespace.test(line[valueStart])) valueStart++;
    const scanned = scanValue(line, valueStart, 0, null);
    depth = scanned.depth; multilineString = scanned.multilineString;
    assignments.push({
      path: [...table, ...keyPath], table: [...table], start: offset + start,
      lineStart: offset, lineEnd: offset + line.length,
      valueStart: offset + valueStart, valueEnd: offset + scanned.valueEnd,
      value: scanned.value, multiline: scanned.multiline,
    });
    offset = nextOffset;
  }
  return { tables, assignments, newline };
}

function matches(path: string[], expected: string[]): boolean {
  return path.length === expected.length && path.every((segment, index) => segment === expected[index]);
}

function pluginAssignments(scan: TomlScan, pluginPath: string[]): TomlAssignment[] {
  return scan.assignments.filter(entry => entry.path.length >= pluginPath.length && pluginPath.every((segment, index) => entry.path[index] === segment));
}

function ensureSupported(scan: TomlScan, pluginPath: string[], editing: boolean): { assignment?: TomlAssignment; table?: TomlTable } {
  const wanted = [...pluginPath, 'enabled'];
  const matchesEnabled = scan.assignments.filter(entry => matches(entry.path, wanted));
  if (matchesEnabled.length > 1) fail(`TOML defines ${wanted.join('.')} more than once`);
  const tables = scan.tables.filter(entry => matches(entry.path, pluginPath));
  if (tables.length > 1) fail(`TOML defines the ${pluginPath.join('.')} table more than once`);
  const inlinePlugins = scan.assignments.find(entry => matches(entry.path, ['plugins']) && entry.value.trimStart().startsWith('{'));
  if (!matchesEnabled.length && !tables.length && inlinePlugins && (editing || inlinePlugins.value.includes(pluginPath[1]))) {
    fail('The [plugins] setting uses an inline table; this editor only supports table or dotted-key plugin settings');
  }
  const inlinePlugin = scan.assignments.find(entry => matches(entry.path, pluginPath) && entry.value.trimStart().startsWith('{'));
  if (inlinePlugin) fail('The plugin setting uses an inline table; this editor only supports table or dotted-key plugin settings');
  if (editing && !matchesEnabled.length && !tables.length) {
    const lingering = pluginAssignments(scan, pluginPath);
    if (lingering.length) fail(`The plugin is configured through ${lingering[0].path.join('.')}; add an explicit enabled key manually`);
  }
  if (matchesEnabled.length) {
    if (matchesEnabled[0].multiline) fail('Plugin enabled uses a multi-line TOML value; refusing to rewrite it');
    const current = matchesEnabled[0].value.trim();
    if (current !== 'true' && current !== 'false') fail(`Plugin enabled is not a boolean (${current || 'empty'}); refusing to rewrite it`);
  }
  return { assignment: matchesEnabled[0], table: tables[0] };
}

export function getBoolean(text: string, path: string[]): boolean | null {
  const scan = scanToml(text);
  const found = scan.assignments.filter(entry => matches(entry.path, path));
  if (found.length > 1) fail(`TOML defines ${path.join('.')} more than once`);
  if (!found.length) return null;
  if (found[0].multiline) fail(`TOML value ${path.join('.')} is multi-line; refusing to interpret it`);
  const value = found[0].value.trim();
  if (value === 'true') return true;
  if (value === 'false') return false;
  fail(`TOML value ${path.join('.')} is not a boolean`);
}

export function getPluginEnabled(text: string, pluginId: string): boolean | null {
  const scan = scanToml(text);
  const { assignment } = ensureSupported(scan, ['plugins', pluginId], false);
  if (!assignment) return null;
  const value = assignment.value.trim();
  if (value === 'true') return true;
  if (value === 'false') return false;
  fail(`Plugin enabled is not a boolean (${value || 'empty'})`);
}

export function getString(text: string, path: string[]): string | null {
  const scan = scanToml(text);
  const found = scan.assignments.filter(entry => matches(entry.path, path));
  if (found.length > 1) fail(`TOML defines ${path.join('.')} more than once`);
  if (!found.length) return null;
  if (found[0].multiline) fail(`TOML value ${path.join('.')} is multi-line; refusing to interpret it`);
  const value = found[0].value.trim();
  if (value.startsWith('"') && value.endsWith('"') && !value.startsWith('"""')) {
    const parsed = quoted(value); if (parsed.end !== value.length) fail(`Unexpected text after ${path.join('.')}`);
    return parsed.text;
  }
  if (value.startsWith("'") && value.endsWith("'") && !value.startsWith("'''")) {
    return value.slice(1, -1);
  }
  fail(`TOML value ${path.join('.')} is not a string`);
}

export interface BooleanEdit { text: string; changed: boolean }

/** Set a boolean dotted key while preserving every unrelated byte of the file. */
export function setBoolean(text: string, path: string[], enabled: boolean): BooleanEdit {
  const scan = scanToml(text);
  const pluginPath = path.slice(0, -1);
  const key = path[path.length - 1];
  if (key !== 'enabled') fail('This editor only sets enabled flags');
  const { assignment, table } = ensureSupported(scan, pluginPath, true);
  const rendered = enabled ? 'true' : 'false';
  if (assignment) {
    if (assignment.value.trim() === rendered) return { text, changed: false };
    return { text: text.slice(0, assignment.valueStart) + rendered + text.slice(assignment.valueEnd), changed: true };
  }
  const header = `[plugins.${JSON.stringify(pluginPath[1] ?? '')}]`;
  if (pluginPath.length !== 2 || pluginPath[0] !== 'plugins') fail('Only [plugins.<id>] settings are supported');
  if (table) {
    if (table.array) fail('The plugin table is an array of tables; refusing to edit it');
    const newline = scan.newline;
    const needsLeadingNewline = table.bodyStart === text.length && !text.endsWith('\n');
    const insertion = `${needsLeadingNewline ? newline : ''}enabled = ${rendered}${newline}`;
    return { text: text.slice(0, table.bodyStart) + insertion + text.slice(table.bodyStart), changed: true };
  }
  const newline = scan.newline;
  let prefix = '';
  if (text.length) {
    if (!text.endsWith('\n')) prefix = newline + newline;
    else if (!text.endsWith(newline + newline)) prefix = newline;
  }
  return { text: text + prefix + header + newline + `enabled = ${rendered}` + newline, changed: true };
}

/** Read all [projects."path"] trust_level values without rewriting anything. */
export function projectTrustLevels(text: string): Map<string, string> {
  const scan = scanToml(text);
  const levels = new Map<string, string>();
  for (const entry of scan.assignments) {
    if (entry.path.length !== 3 || entry.path[0] !== 'projects' || entry.path[2] !== 'trust_level') continue;
    if (levels.has(entry.path[1])) fail(`TOML defines projects.${JSON.stringify(entry.path[1])}.trust_level more than once`);
    const value = entry.multiline ? null : entry.value.trim();
    if (!value) continue;
    if (value.startsWith('"') && value.endsWith('"') && !value.startsWith('"""')) {
      const parsed = quoted(value); if (parsed.end !== value.length) fail('Unexpected text after project trust_level');
      levels.set(entry.path[1], parsed.text);
    } else if (value.startsWith("'") && value.endsWith("'") && !value.startsWith("'''")) {
      levels.set(entry.path[1], value.slice(1, -1));
    } else fail('project trust_level is not a string');
  }
  return levels;
}
