import type { DiffSet, FileDiff } from '@/git/diff';

// Render a single file's diff with explicit NEW-file line numbers so the model
// can reference exact lines in its findings. Deletions are shown (marked `-`)
// but carry the old line number; additions/context carry the new line number.
export function renderFileDiff(file: FileDiff): string {
  const head = `### ${file.path} (${file.status}, ${file.language}) +${file.additions}/-${file.deletions}`;
  if (file.binary) {
    return `${head}\n[binary file — not shown]`;
  }
  if (file.oldPath && file.oldPath !== file.path) {
    // renamed/copied
  }
  const lines: string[] = [head];
  if (file.oldPath && file.oldPath !== file.path) {
    lines.push(`(was: ${file.oldPath})`);
  }
  for (const hunk of file.hunks) {
    lines.push(hunk.header ? `@@ ${hunk.header} @@` : '@@');
    for (const l of hunk.lines) {
      if (l.type === 'add') {
        lines.push(`${String(l.newLine).padStart(6)} + ${l.content}`);
      } else if (l.type === 'del') {
        lines.push(`${' '.repeat(6)} - ${l.content}`);
      } else {
        lines.push(`${String(l.newLine).padStart(6)}   ${l.content}`);
      }
    }
  }
  return lines.join('\n');
}

export type SerializeOptions = {
  // Approx character budget for the whole diff payload. Files past it are
  // listed but not expanded, so huge changesets degrade gracefully.
  maxChars?: number;
  includeGenerated?: boolean;
};

export type SerializedDiff = {
  text: string;
  includedFiles: FileDiff[];
  skippedFiles: FileDiff[];
};

// Rank files so the highest-signal ones are included first when over budget:
// non-generated source before generated/lock files, larger churn before tiny.
function priority(file: FileDiff): number {
  let score = file.additions + file.deletions;
  if (file.isGenerated) score -= 100_000;
  if (file.binary) score -= 200_000;
  if (file.language === 'markdown' || file.language === 'text') score -= 50;
  return score;
}

export function serializeDiffSet(
  diff: DiffSet,
  options: SerializeOptions = {},
): SerializedDiff {
  const maxChars = options.maxChars ?? 180_000;
  const candidates = diff.files.filter(
    (f) => options.includeGenerated || !f.isGenerated,
  );
  const ranked = [...candidates].sort((a, b) => priority(b) - priority(a));

  const included: FileDiff[] = [];
  const skipped: FileDiff[] = diff.files.filter(
    (f) => !options.includeGenerated && f.isGenerated,
  );
  const parts: string[] = [];
  let used = 0;

  for (const file of ranked) {
    const rendered = renderFileDiff(file);
    if (used + rendered.length > maxChars && included.length > 0) {
      skipped.push(file);
      continue;
    }
    parts.push(rendered);
    used += rendered.length + 1;
    included.push(file);
  }

  return {
    text: parts.join('\n\n'),
    includedFiles: included,
    skippedFiles: skipped,
  };
}
