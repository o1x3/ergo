import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';

import { detectDefaultBase, git, mergeBase, worktreeStatus } from '@/git/repo';
import { exec } from '@/util/exec';

export type ChangeStatus =
  | 'added'
  | 'modified'
  | 'deleted'
  | 'renamed'
  | 'copied';

export type DiffLineType = 'context' | 'add' | 'del';

export interface DiffLine {
  type: DiffLineType;
  content: string;
  oldLine?: number;
  newLine?: number;
}

export interface DiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  header: string;
  lines: DiffLine[];
}

export interface FileDiff {
  path: string;
  oldPath?: string;
  status: ChangeStatus;
  binary: boolean;
  hunks: DiffHunk[];
  additions: number;
  deletions: number;
  language: string;
  isGenerated?: boolean;
}

export type ReviewTarget =
  | { kind: 'working' } // staged + unstaged + untracked vs HEAD
  | { kind: 'staged' } // index vs HEAD
  | { kind: 'branch'; base: string } // three-dot vs base
  | { kind: 'commit'; ref: string } // a single commit
  | { kind: 'range'; range: string }; // arbitrary range expr

export interface DiffSet {
  files: FileDiff[];
  target: ReviewTarget;
  base?: string;
  head?: string;
  totalAdditions: number;
  totalDeletions: number;
}

const EXT_LANGUAGE: Record<string, string> = {
  ts: 'typescript',
  tsx: 'tsx',
  js: 'javascript',
  jsx: 'jsx',
  mjs: 'javascript',
  cjs: 'javascript',
  py: 'python',
  rb: 'ruby',
  go: 'go',
  rs: 'rust',
  java: 'java',
  kt: 'kotlin',
  swift: 'swift',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  cc: 'cpp',
  hpp: 'cpp',
  cs: 'csharp',
  php: 'php',
  scala: 'scala',
  sh: 'shell',
  bash: 'shell',
  zsh: 'shell',
  sql: 'sql',
  html: 'html',
  css: 'css',
  scss: 'scss',
  vue: 'vue',
  svelte: 'svelte',
  json: 'json',
  yaml: 'yaml',
  yml: 'yaml',
  toml: 'toml',
  md: 'markdown',
  dockerfile: 'dockerfile',
  tf: 'terraform',
};

export function inferLanguage(path: string): string {
  const base = path.split('/').pop()?.toLowerCase() ?? '';
  if (base === 'dockerfile') return 'dockerfile';
  if (base === 'makefile') return 'makefile';
  const ext = extname(base).slice(1);
  return EXT_LANGUAGE[ext] ?? ext ?? 'text';
}

const GENERATED_PATTERNS = [
  /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?)$/,
  /(^|\/)(go\.sum|Cargo\.lock|Gemfile\.lock|composer\.lock|poetry\.lock|uv\.lock)$/,
  /(^|\/)dist\//,
  /(^|\/)build\//,
  /(^|\/)node_modules\//,
  /\.min\.(js|css)$/,
  /(^|\/)vendor\//,
  /\.(snap|map)$/,
  /(^|\/)__generated__\//,
  /\.pb\.go$/,
];

export function looksGenerated(path: string): boolean {
  return GENERATED_PATTERNS.some((re) => re.test(path));
}

function parseHunkHeader(line: string): {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  header: string;
} | null {
  // @@ -oldStart,oldLines +newStart,newLines @@ optional section heading
  const m = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/);
  if (!m) return null;
  return {
    oldStart: Number(m[1]),
    oldLines: m[2] === undefined ? 1 : Number(m[2]),
    newStart: Number(m[3]),
    newLines: m[4] === undefined ? 1 : Number(m[4]),
    header: (m[5] ?? '').trim(),
  };
}

// Parse a `git diff` (unified) blob into structured FileDiffs. Robust to added,
// deleted, renamed, copied, and binary files.
export function parseUnifiedDiff(raw: string): FileDiff[] {
  if (!raw.trim()) return [];
  const lines = raw.split('\n');
  const files: FileDiff[] = [];
  let current: FileDiff | null = null;
  let hunk: DiffHunk | null = null;
  let oldLineNo = 0;
  let newLineNo = 0;

  const pushHunk = () => {
    if (current && hunk) current.hunks.push(hunk);
    hunk = null;
  };
  const pushFile = () => {
    pushHunk();
    if (current) files.push(current);
    current = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';

    if (line.startsWith('diff --git ')) {
      pushFile();
      // diff --git a/<old> b/<new>
      const m = line.match(/^diff --git a\/(.+) b\/(.+)$/);
      const path = m?.[2] ?? '';
      current = {
        path,
        status: 'modified',
        binary: false,
        hunks: [],
        additions: 0,
        deletions: 0,
        language: inferLanguage(path),
        isGenerated: looksGenerated(path),
      };
      continue;
    }

    if (!current) continue;

    // A new hunk header. `diff --git` (handled above) and `@@` never carry a
    // body marker, so they are unambiguous even mid-hunk.
    if (line.startsWith('@@')) {
      pushHunk();
      const parsed = parseHunkHeader(line);
      if (parsed) {
        hunk = { ...parsed, lines: [] };
        oldLineNo = parsed.oldStart;
        newLineNo = parsed.newStart;
      }
      continue;
    }

    // Inside a hunk body, process content lines BEFORE any file-header matching:
    // a deleted line whose content starts with "-- " serializes to "--- ", and
    // an added line starting with "++ " serializes to "+++ ". Matching those as
    // headers would drop lines and corrupt line numbers. Body lines always carry
    // a leading marker (space/+/-/\), so this is unambiguous.
    if (hunk) {
      const marker = line[0];
      if (marker === '+') {
        hunk.lines.push({
          type: 'add',
          content: line.slice(1),
          newLine: newLineNo++,
        });
        current.additions++;
        continue;
      }
      if (marker === '-') {
        hunk.lines.push({
          type: 'del',
          content: line.slice(1),
          oldLine: oldLineNo++,
        });
        current.deletions++;
        continue;
      }
      if (marker === ' ') {
        hunk.lines.push({
          type: 'context',
          content: line.slice(1),
          oldLine: oldLineNo++,
          newLine: newLineNo++,
        });
        continue;
      }
      if (marker === '\\') {
        // "\ No newline at end of file" — nothing to record.
        continue;
      }
      // Not a body line — the hunk has ended; fall through to header detection.
      pushHunk();
    }

    // File-header region (no active hunk).
    if (line.startsWith('new file mode')) {
      current.status = 'added';
      continue;
    }
    if (line.startsWith('deleted file mode')) {
      current.status = 'deleted';
      continue;
    }
    if (line.startsWith('rename from ')) {
      current.oldPath = line.slice('rename from '.length);
      current.status = 'renamed';
      continue;
    }
    if (line.startsWith('rename to ')) {
      current.path = line.slice('rename to '.length);
      current.language = inferLanguage(current.path);
      current.isGenerated = looksGenerated(current.path);
      continue;
    }
    if (line.startsWith('copy from ')) {
      current.oldPath = line.slice('copy from '.length);
      current.status = 'copied';
      continue;
    }
    if (line.startsWith('copy to ')) {
      current.path = line.slice('copy to '.length);
      continue;
    }
    if (
      line.startsWith('Binary files') ||
      line.startsWith('GIT binary patch')
    ) {
      current.binary = true;
      continue;
    }
    if (line.startsWith('--- ')) {
      const p = line.slice(4);
      if (p !== '/dev/null' && p.startsWith('a/')) {
        current.oldPath ??= p.slice(2);
      }
      continue;
    }
    if (line.startsWith('+++ ')) {
      const p = line.slice(4);
      if (p !== '/dev/null' && p.startsWith('b/')) {
        current.path = p.slice(2);
        current.language = inferLanguage(current.path);
      }
    }
  }

  pushFile();
  return files;
}

// Build a synthetic FileDiff for an untracked file (all lines added).
async function untrackedFileDiff(
  root: string,
  path: string,
): Promise<FileDiff | null> {
  // Use git's own no-index diff so binary detection and large-file handling
  // match everything else. It exits 1 when files differ (expected).
  const { stdout } = await exec(
    ['git', 'diff', '--no-index', '--no-color', '--', '/dev/null', path],
    { cwd: root },
  );
  const parsed = parseUnifiedDiff(stdout);
  const file = parsed[0];
  if (!file) return null;
  file.status = 'added';
  file.path = path;
  file.language = inferLanguage(path);
  file.isGenerated = looksGenerated(path);
  return file;
}

export type CollectOptions = {
  cwd?: string;
  includeUntracked?: boolean;
  contextLines?: number;
};

// Collect a structured DiffSet for a review target.
export async function collectDiff(
  target: ReviewTarget,
  options: CollectOptions = {},
): Promise<DiffSet> {
  const cwd = options.cwd;
  const ctx = options.contextLines ?? 3;
  const diffArgs = ['diff', '--no-color', `--unified=${ctx}`, '-M', '-C'];

  let raw = '';
  let base: string | undefined;
  let head: string | undefined;

  switch (target.kind) {
    case 'working': {
      raw = await git([...diffArgs, 'HEAD'], cwd);
      head = 'HEAD';
      break;
    }
    case 'staged': {
      raw = await git([...diffArgs, '--cached'], cwd);
      head = 'HEAD';
      break;
    }
    case 'branch': {
      const baseRef =
        target.base === 'auto' ? await detectDefaultBase(cwd) : target.base;
      const mb = (await mergeBase(baseRef, 'HEAD', cwd)) ?? baseRef;
      raw = await git([...diffArgs, `${mb}..HEAD`], cwd);
      base = baseRef;
      head = 'HEAD';
      break;
    }
    case 'commit': {
      raw = await git([...diffArgs, `${target.ref}^!`], cwd);
      base = `${target.ref}^`;
      head = target.ref;
      break;
    }
    case 'range': {
      raw = await git([...diffArgs, target.range], cwd);
      head = target.range;
      break;
    }
  }

  const files = parseUnifiedDiff(raw);

  if (target.kind === 'working' && options.includeUntracked !== false) {
    const status = await worktreeStatus(cwd);
    const root = cwd ?? '.';
    for (const path of status.untracked) {
      if (looksGenerated(path)) continue;
      try {
        const f = await untrackedFileDiff(root, path);
        if (f) files.push(f);
      } catch {
        // ignore unreadable untracked files
      }
    }
  }

  const totalAdditions = files.reduce((n, f) => n + f.additions, 0);
  const totalDeletions = files.reduce((n, f) => n + f.deletions, 0);

  return { files, target, base, head, totalAdditions, totalDeletions };
}

// Read full file content at a ref (for richer context). Returns undefined if the
// file does not exist at that ref.
export async function fileAtRef(
  path: string,
  ref: string,
  cwd?: string,
): Promise<string | undefined> {
  const { stdout, exitCode } = await exec(['git', 'show', `${ref}:${path}`], {
    cwd,
  });
  return exitCode === 0 ? stdout : undefined;
}

export async function workingFileContent(
  root: string,
  path: string,
): Promise<string | undefined> {
  try {
    return await readFile(`${root}/${path}`, 'utf8');
  } catch {
    return undefined;
  }
}
