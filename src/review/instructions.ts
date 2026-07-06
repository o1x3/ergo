import { readFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';

import { log } from '@/util/logger';

const MAX_INSTRUCTION_BYTES = 40_000;

// Read one or more instruction files (CodeRabbit's `-c/--config`/ergo's
// `--instructions`) and concatenate them into a single focus block. Paths are
// resolved relative to the repo root unless absolute.
export async function readInstructionFiles(
  repoRoot: string,
  files: string[],
): Promise<string | undefined> {
  if (files.length === 0) return undefined;
  const parts: string[] = [];
  let total = 0;
  for (const file of files) {
    const path = isAbsolute(file) ? file : join(repoRoot, file);
    try {
      const content = await readFile(path, 'utf8');
      const capped =
        content.length > MAX_INSTRUCTION_BYTES
          ? `${content.slice(0, MAX_INSTRUCTION_BYTES)}\n…[truncated]`
          : content;
      const block = `--- ${file} ---\n${capped.trim()}`;
      if (total + block.length > MAX_INSTRUCTION_BYTES * 2) break;
      parts.push(block);
      total += block.length;
    } catch {
      // Not fatal, but the user explicitly asked for this file — a silent skip
      // would hide a typo'd --instructions path.
      log.warn(`--instructions: could not read ${file}; skipping.`);
    }
  }
  return parts.length > 0 ? parts.join('\n\n') : undefined;
}
