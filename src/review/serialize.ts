import type { DiffSet, FileDiff } from '@/git/diff';

// Render a single file's diff with explicit NEW-file line numbers so the model
// can reference exact lines in its findings. Deletions are shown (marked `-`)
// but carry the old line number; additions/context carry the new line number.
export function renderFileDiff(file: FileDiff): string {
  const head = `### ${file.path} (${file.status}, ${file.language}) +${file.additions}/-${file.deletions}`;
  if (file.binary) {
    return `${head}\n[binary file — not shown]`;
  }
  const lines: string[] = [head];
  if (file.oldPath && file.oldPath !== file.path) {
    lines.push(`(was: ${file.oldPath})`);
  }
  for (const hunk of file.hunks) {
    // Keep the real `@@ -old,n +new,m @@` ranges so pure-deletion hunks still
    // carry a usable new-file anchor for findings.
    const range = `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`;
    lines.push(hunk.header ? `${range} ${hunk.header}` : range);
    for (const l of hunk.lines) {
      if (l.type === 'add') {
        lines.push(`${String(l.newLine).padStart(6)} + ${l.content}`);
      } else if (l.type === 'del') {
        // Show the old line number (labeled) so deletions are anchorable.
        lines.push(`${`-${l.oldLine}`.padStart(6)} - ${l.content}`);
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

  // Minimum useful budget for a single file before we bother including it.
  const MIN_FILE_BUDGET = 2_000;

  for (const file of ranked) {
    const rendered = renderFileDiff(file);
    const remaining = maxChars - used;
    if (rendered.length > remaining) {
      // Hard-cap a single oversized file by truncating it (even the first one),
      // so `maxChars` is a real bound — not "first file emitted in full".
      if (remaining < MIN_FILE_BUDGET) {
        skipped.push(file);
        continue;
      }
      const truncated = `${rendered.slice(0, remaining - 40)}\n[diff truncated — file too large]`;
      parts.push(truncated);
      used += truncated.length + 2;
      included.push(file);
      continue;
    }
    parts.push(rendered);
    used += rendered.length + 2;
    included.push(file);
  }

  return {
    text: parts.join('\n\n'),
    includedFiles: included,
    skippedFiles: skipped,
  };
}
