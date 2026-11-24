// main.ts is mend, the CLI SPEC.md specifies (MIT). Node 22, standard library alone;
// run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: { oldPath: string; newPath: string }[] = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

type FileLines = { lines: string[]; br: string; final: boolean };
type BodyLine = { kind: ' ' | '-' | '+'; text: string; bareEmpty?: boolean; noNewline?: boolean };
type Chunk = { anchor: string | null; body: BodyLine[]; eof: boolean };

function splitFile(text: string): FileLines {
  if (text === '') return { lines: [], br: '\n', final: false };
  const firstLF = text.indexOf('\n');
  const br = firstLF > 0 && text[firstLF - 1] === '\r' ? '\r\n' : '\n';
  const lines = text.split(br);
  const final = text.endsWith(br);
  if (final) lines.pop();
  return { lines, br, final };
}

function joinFile(file: FileLines): string {
  return file.lines.length === 0 ? '' : file.lines.join(file.br) + (file.final ? file.br : '');
}

const trimRight = (s: string): string => s.replace(/[ \t]+$/, '');
const trimSides = (s: string): string => s.replace(/^[ \t]+|[ \t]+$/g, '');
const trimSpaces = (s: string): string => s.replace(/^ +| +$/g, '');
const indent = (s: string): string => /^[ \t]*/.exec(s)![0];

/** Find all eligible occurrences at the first tier that has one. */
function occurrences(file: string[], old: string[], strict: boolean, min = 0, atEnd = false): { positions: number[]; tier: number } | null {
  for (let tier = 0; tier < (strict ? 1 : 3); tier++) {
    const view = tier === 0 ? (s: string): string => s : tier === 1 ? trimRight : trimSides;
    const wanted = old.map(view);
    const positions: number[] = [];
    for (let i = min; i + old.length <= file.length; i++) {
      if (atEnd && i + old.length !== file.length) continue;
      if (wanted.every((line, j) => line === view(file[i + j]!))) positions.push(i);
    }
    if (positions.length > 0) return { positions, tier };
  }
  return null;
}

function oldLines(body: BodyLine[]): string[] {
  return body.filter((line) => line.kind !== '+').map((line) => line.text);
}

function newLength(body: BodyLine[]): number {
  return body.reduce((count, line) => count + (line.kind === '-' ? 0 : 1), 0);
}

function reindent(line: string, tier: number, patchIndent: string, fileIndent: string): string {
  return tier === 2 && !blank(line) && line.startsWith(patchIndent) ? fileIndent + line.slice(patchIndent.length) : line;
}

/** Context comes from the file, while additions follow tier-2 indentation. */
function writtenLines(body: BodyLine[], file: string[], at: number, tier: number): string[] {
  const old = oldLines(body);
  const patchIndent = old.length ? indent(old[0]!) : '';
  const fileIndent = old.length ? indent(file[at]!) : '';
  const result: string[] = [];
  let read = at;
  for (const line of body) {
    if (line.kind === ' ') result.push(file[read++]!);
    else if (line.kind === '-') read++;
    else result.push(reindent(line.text, tier, patchIndent, fileIndent));
  }
  return result;
}

function bodyLine(raw: string): BodyLine | null {
  if (raw === '') return { kind: ' ', text: '', bareEmpty: true };
  const kind = raw[0];
  return kind === ' ' || kind === '-' || kind === '+' ? { kind, text: raw.slice(1) } : null;
}

type UnifiedHunk = { oldStart: number; body: BodyLine[] };
type UnifiedSection = {
  diffOld: string | undefined;
  diffNew: string | undefined;
  pair: { oldPath: string | null; newPath: string | null } | null;
  renameFrom: string | undefined;
  renameTo: string | undefined;
  newFile: boolean;
  deletedFile: boolean;
  hunks: UnifiedHunk[];
};

function headerPath(raw: string): string | null {
  const p = trimSpaces(raw.split('\t', 1)[0]!);
  const path = p.startsWith('a/') || p.startsWith('b/') ? p.slice(2) : p;
  return path === '/dev/null' ? null : path;
}

function applyHunks(source: string, hunks: UnifiedHunk[], path: string, strict: boolean): string {
  const file = splitFile(source);
  let offset = 0;
  for (const hunk of hunks) {
    const old = oldLines(hunk.body);
    let at: number;
    let tier = 0;
    if (old.length === 0) {
      at = Math.max(0, Math.min(file.lines.length, hunk.oldStart + offset));
    } else {
      const match = occurrences(file.lines, old, strict);
      if (match === null) throw new Fail('no-match', path);
      tier = match.tier;
      const expected = hunk.oldStart - 1 + offset;
      at = match.positions.reduce((best, pos) => Math.abs(pos - expected) < Math.abs(best - expected) ? pos : best);
    }
    const touchedEnd = at + old.length === file.lines.length;
    const put = writtenLines(hunk.body, file.lines, at, tier);
    file.lines.splice(at, old.length, ...put);
    if (touchedEnd) {
      const lastOutput = hunk.body.filter((line) => line.kind !== '-').at(-1);
      file.final = lastOutput?.noNewline !== true;
    }
    offset += newLength(hunk.body) - old.length;
  }
  return joinFile(file);
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: UnifiedSection[] = [];
  let section: UnifiedSection | null = null;
  const start = (diffOld?: string, diffNew?: string): UnifiedSection => {
    section = { diffOld, diffNew, pair: null, renameFrom: undefined, renameTo: undefined, newFile: false, deletedFile: false, hunks: [] };
    sections.push(section);
    return section;
  };
  const isPair = (i: number): boolean => lines[i]!.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ');
  const isDiffGit = (line: string): boolean => /^diff --git(?:[ \t]|$)/.test(line);
  for (let i = 0; i < lines.length;) {
    const line = lines[i]!;
    if (isDiffGit(line)) {
      const m = /^diff --git a\/(.*?) b\/(.*)$/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      start(m[1]!, m[2]!);
      i++;
      continue;
    }
    if (isPair(i)) {
      if (section === null || section.hunks.length > 0 || section.pair !== null) start();
      section!.pair = { oldPath: headerPath(line.slice(4)), newPath: headerPath(lines[i + 1]!.slice(4)) };
      i += 2;
      continue;
    }
    if (line.startsWith('@@')) {
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(?:.*)?$/.exec(line);
      if (section === null || m === null) throw new Exit2(`error: parse ${i + 1}`);
      const body: BodyLine[] = [];
      i++;
      while (i < lines.length) {
        const raw = lines[i]!;
        if (isDiffGit(raw) || isPair(i)) break;
        if (raw.startsWith('\\')) {
          if (body.length) body[body.length - 1]!.noNewline = true;
        } else {
          const item = bodyLine(raw);
          if (item === null) break;
          body.push(item);
        }
        i++;
      }
      while (body.at(-1)?.bareEmpty && body.at(-1)?.noNewline !== true) body.pop();
      section.hunks.push({ oldStart: Number(m[1]), body });
      continue;
    }
    if (section !== null && section.hunks.length === 0) {
      if (line.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
      if (line.startsWith('rename from ')) section.renameFrom = line.slice(12);
      else if (line.startsWith('rename to ')) section.renameTo = line.slice(10);
      else if (line.startsWith('new file mode')) section.newFile = true;
      else if (line.startsWith('deleted file mode')) section.deletedFile = true;
    }
    i++;
  }
  return sections.map((s): Edit => {
    const oldPath = s.pair !== null ? s.pair.oldPath : s.renameFrom ?? s.diffOld ?? '';
    const newPath = s.pair !== null ? s.pair.newPath : s.renameTo ?? s.diffNew ?? '';
    return (tree) => {
      if (oldPath !== null && !safe(oldPath)) throw new Fail('unsafe', oldPath);
      if (newPath !== null && !safe(newPath)) throw new Fail('unsafe', newPath);
      if (s.newFile || oldPath === null) {
        if (newPath === null) throw new Fail('unsafe', '/dev/null');
        if (tree.get(newPath) !== null) throw new Fail('exists', newPath);
        const additions = s.hunks.flatMap((h) => h.body.filter((line) => line.kind === '+'));
        const final = additions.at(-1)?.noNewline !== true;
        tree.now.set(newPath, joinFile({ lines: additions.map((line) => line.text), br: '\n', final }));
        return;
      }
      const source = tree.get(oldPath);
      if (source === null) throw new Fail('missing', oldPath);
      if (s.deletedFile || newPath === null) {
        tree.now.set(oldPath, null);
        return;
      }
      const moving = oldPath !== newPath;
      if (moving && tree.get(newPath) !== null) throw new Fail('exists', newPath);
      const result = applyHunks(source, s.hunks, oldPath, strict);
      if (moving) {
        tree.now.set(oldPath, null);
        tree.moves.push({ oldPath, newPath });
      }
      tree.now.set(newPath, result);
    };
  });
}

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  const marker = (s: string): string => s.trimEnd();
  let lastEnd = -1;
  let lastPath: string | undefined;
  for (let i = 0; i < lines.length; i++) {
    if (marker(lines[i]!) !== '<<<<<<< SEARCH') continue;
    let path: string | undefined;
    for (let j = i - 1; j > lastEnd; j--) {
      const candidate = lines[j]!.trim();
      if (candidate !== '' && !candidate.startsWith('```')) {
        path = candidate;
        break;
      }
    }
    path ??= lastPath;
    if (path === undefined) throw new Exit2(`error: parse ${i + 1}`);
    const searchLine = i + 1;
    const old: string[] = [];
    let j = i + 1;
    while (j < lines.length && marker(lines[j]!) !== '=======' && marker(lines[j]!) !== '>>>>>>> REPLACE') old.push(lines[j++]!);
    if (j === lines.length || marker(lines[j]!) !== '=======') throw new Exit2(`error: parse ${searchLine}`);
    j++;
    const replacement: string[] = [];
    while (j < lines.length && marker(lines[j]!) !== '>>>>>>> REPLACE') replacement.push(lines[j++]!);
    if (j === lines.length) throw new Exit2(`error: parse ${searchLine}`);
    const editPath = path;
    const oldCopy = old;
    const newCopy = replacement;
    edits.push((tree) => {
      if (!safe(editPath)) throw new Fail('unsafe', editPath);
      if (oldCopy.length === 0) {
        if (tree.get(editPath) !== null) throw new Fail('exists', editPath);
        tree.now.set(editPath, joinFile({ lines: newCopy, br: '\n', final: true }));
        return;
      }
      const source = tree.get(editPath);
      if (source === null) throw new Fail('missing', editPath);
      const file = splitFile(source);
      const match = occurrences(file.lines, oldCopy, strict);
      if (match === null) throw new Fail('no-match', editPath);
      if (match.positions.length !== 1) throw new Fail('ambiguous', editPath);
      const at = match.positions[0]!;
      const patchIndent = indent(oldCopy[0]!);
      const fileIndent = indent(file.lines[at]!);
      file.lines.splice(at, oldCopy.length, ...newCopy.map((line) => reindent(line, match.tier, patchIndent, fileIndent)));
      tree.now.set(editPath, joinFile(file));
    });
    lastPath = path;
    lastEnd = j;
    i = j;
  }
  return edits;
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((line) => !blank(line));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = lines.length - 1;
  while (last >= 0 && blank(lines[last]!)) last--;
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const sectionType = (line: string): 'add' | 'delete' | 'update' | null =>
    line.startsWith('*** Add File: ') ? 'add' : line.startsWith('*** Delete File: ') ? 'delete' : line.startsWith('*** Update File: ') ? 'update' : null;
  const edits: Edit[] = [];
  for (let i = first + 1; i < last;) {
    if (blank(lines[i]!)) { i++; continue; }
    const type = sectionType(lines[i]!);
    if (type === null) throw new Exit2(`error: parse ${i + 1}`);
    const startLine = i;
    const path = trimSpaces(lines[i]!.slice(type === 'add' ? 14 : type === 'delete' ? 17 : 17));
    let end = i + 1;
    while (end < last && sectionType(lines[end]!) === null) end++;
    const raw = lines.slice(i + 1, end).map((text, k) => ({ text, number: i + k + 2 }));
    while (raw.length && blank(raw[raw.length - 1]!.text)) raw.pop();
    if (type === 'add') {
      const added: string[] = [];
      for (const item of raw) {
        if (item.text === '') added.push('');
        else if (item.text.startsWith('+')) added.push(item.text.slice(1));
        else throw new Exit2(`error: parse ${item.number}`);
      }
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (tree.get(path) !== null) throw new Fail('exists', path);
        tree.now.set(path, joinFile({ lines: added, br: '\n', final: true }));
      });
    } else if (type === 'delete') {
      if (raw.length) throw new Exit2(`error: parse ${raw[0]!.number}`);
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (tree.get(path) === null) throw new Fail('missing', path);
        tree.now.set(path, null);
      });
    } else {
      let k = 0;
      let moveTo: string | undefined;
      if (raw[0]?.text.startsWith('*** Move to: ')) moveTo = trimSpaces(raw[k++]!.text.slice(13));
      const chunks: Chunk[] = [];
      let active: Chunk | null = null;
      let afterEOF = false;
      for (; k < raw.length; k++) {
        const item = raw[k]!;
        if (item.text.startsWith('@@')) {
          active = { anchor: trimSpaces(item.text.slice(2)) || null, body: [], eof: false };
          chunks.push(active);
          afterEOF = false;
        } else if (item.text === '*** End of File') {
          if (active === null) throw new Exit2(`error: parse ${item.number}`);
          active.eof = true;
          active = null;
          afterEOF = true;
        } else {
          const body = bodyLine(item.text);
          if (body === null || afterEOF) throw new Exit2(`error: parse ${item.number}`);
          if (active === null) {
            active = { anchor: null, body: [], eof: false };
            chunks.push(active);
          }
          active.body.push(body);
        }
      }
      if (chunks.length === 0 && moveTo === undefined) throw new Exit2(`error: parse ${startLine + 1}`);
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (moveTo !== undefined && !safe(moveTo)) throw new Fail('unsafe', moveTo);
        const source = tree.get(path);
        if (source === null) throw new Fail('missing', path);
        if (moveTo !== undefined && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
        const file = splitFile(source);
        let cursor = 0;
        for (const chunk of chunks) {
          if (chunk.anchor !== null) {
            const anchor = occurrences(file.lines, [chunk.anchor], strict, cursor);
            if (anchor === null) throw new Fail('no-match', path);
            cursor = anchor.positions[0]! + 1;
          }
          const old = oldLines(chunk.body);
          let at: number;
          let tier = 0;
          if (old.length === 0) at = chunk.eof ? file.lines.length : cursor;
          else {
            const match = occurrences(file.lines, old, strict, cursor, chunk.eof);
            if (match === null) throw new Fail('no-match', path);
            at = match.positions[0]!;
            tier = match.tier;
          }
          const put = writtenLines(chunk.body, file.lines, at, tier);
          file.lines.splice(at, old.length, ...put);
          cursor = at + put.length;
        }
        const result = joinFile(file);
        if (moveTo !== undefined) {
          tree.now.set(path, null);
          tree.now.set(moveTo, result);
          tree.moves.push({ oldPath: path, newPath: moveTo });
        } else tree.now.set(path, result);
      });
    }
    i = end;
  }
  return edits;
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits = kind === 'json' ? jsonEdits(text, lines)
      : kind === 'unified' ? unifiedEdits(lines, strict)
      : kind === 'search-replace' ? searchReplaceEdits(lines, strict)
      : v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const compare = (a: string, b: string): number => Buffer.compare(Buffer.from(a), Buffer.from(b));
  const rows: { key: string; line: string }[] = [];
  const used = new Set<string>();
  for (const { oldPath, newPath } of tree.moves) {
    if (used.has(oldPath) || used.has(newPath)) continue;
    if (tree.original(oldPath) !== null && tree.get(oldPath) === null && tree.original(newPath) === null && tree.get(newPath) !== null) {
      rows.push({ key: newPath, line: `R ${oldPath} -> ${newPath}` });
      used.add(oldPath);
      used.add(newPath);
    }
  }
  for (const p of tree.now.keys()) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now || used.has(p)) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => compare(a.key, b.key));
  for (const p of [...tree.now.keys()].sort(compare)) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    if (check) continue;
    if (now === null) rmSync(p, { force: true });
    else {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, now);
    }
  }
  return { code: 0, out: [...rows.map((row) => row.line), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}


const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
