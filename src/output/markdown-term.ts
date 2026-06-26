import { pc } from '@/util/logger';

// A tiny, dependency-free markdown → ANSI renderer for the terminal output —
// inspired by charmbracelet/glamour, but ergo stays minimal-dep (and TS/Bun, so
// the Go libs aren't an option). It handles the small slice of markdown that the
// model actually emits in summaries/walkthroughs: ATX headings, bullet and
// numbered lists, blockquotes, fenced code blocks, and inline **bold** / `code`
// / _italic_ / [links](url). Unknown syntax falls through as plain text.
//
// Input is expected to be control-char-clean already (see terminal.ts `clean`),
// so the only escape sequences in the output are the ones picocolors adds — and
// picocolors no-ops when color is unsupported, so this degrades to plain text.

// Inline spans. Order matters: links first (they contain []/() that the others
// shouldn't touch), then code (so ** inside a code span isn't bolded), then bold
// before italic (so ** isn't eaten by the single-* / _ italic rules).
function inline(s: string): string {
  let out = s;
  out = out.replace(
    /\[([^\]]+)\]\(([^)]+)\)/g,
    (_m, text, url) => `${pc.underline(pc.cyan(text))}${pc.dim(` (${url})`)}`,
  );
  out = out.replace(/`([^`]+)`/g, (_m, code) => pc.cyan(code));
  out = out.replace(/\*\*([^*]+)\*\*/g, (_m, b) => pc.bold(b));
  // _italic_ only when underscores hug a word boundary, so snake_case survives.
  out = out.replace(
    /(^|[\s(])_([^_\n]+)_(?=[\s.,;:)]|$)/g,
    (_m, pre, it) => `${pre}${pc.italic(it)}`,
  );
  return out;
}

const HEADING = /^(#{1,6})\s+(.*)$/;
const BULLET = /^(\s*)[-*+]\s+(.*)$/;
const NUMBERED = /^(\s*)(\d+)\.\s+(.*)$/;
const QUOTE = /^>\s?(.*)$/;
const RULE = /^\s*([-*_])(?:\s*\1){2,}\s*$/;
// A fence line: 3+ backticks or tildes, then an optional info string. We track
// the opening marker char and only close on a *bare* fence of the same char, so
// a `~~~` line inside a ```-fenced block (or vice versa) is treated as content
// rather than prematurely closing the block.
const FENCE = /^\s*(`{3,}|~{3,})\s*(\S.*)?$/;

// Render markdown to a terminal-styled string. Heading levels 1-2 get an accent
// color; deeper headings are bold. Bullets become `•`, code blocks are dimmed
// and indented, blockquotes get a left rule.
export function renderMarkdownTerminal(md: string): string {
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  const out: string[] = [];
  let fenceChar: string | null = null; // '`' or '~' while inside a code fence
  let blanks = 0;

  for (const raw of lines) {
    const fence = FENCE.exec(raw);
    if (fence) {
      const marker = (fence[1] ?? '')[0] ?? '';
      const info = (fence[2] ?? '').trim();
      if (fenceChar === null) {
        fenceChar = marker; // open; drop the fence line, indent/dim signals code
        continue;
      }
      if (marker === fenceChar && info === '') {
        fenceChar = null; // bare closing fence of the matching char
        continue;
      }
      // otherwise: a fence-looking line inside a block — render it as code
    }
    if (fenceChar !== null) {
      out.push(`  ${pc.dim(raw)}`);
      blanks = 0;
      continue;
    }

    if (raw.trim() === '') {
      // collapse runs of blank lines to a single separator
      if (blanks === 0 && out.length > 0) out.push('');
      blanks++;
      continue;
    }
    blanks = 0;

    const heading = HEADING.exec(raw);
    if (heading) {
      const level = (heading[1] ?? '').length;
      const text = inline((heading[2] ?? '').trim());
      if (out.length > 0 && out[out.length - 1] !== '') out.push('');
      // Content headings get ergo's cyan accent so they read as distinct from
      // the white-bold section chrome (Summary / Walkthrough / …) around them.
      out.push(level <= 2 ? pc.bold(pc.cyan(text)) : pc.bold(pc.dim(text)));
      continue;
    }

    if (RULE.test(raw)) {
      out.push(pc.dim('─'.repeat(40)));
      continue;
    }

    const quote = QUOTE.exec(raw);
    if (quote) {
      out.push(`${pc.dim('▏')} ${pc.dim(inline(quote[1] ?? ''))}`);
      continue;
    }

    const bullet = BULLET.exec(raw);
    if (bullet) {
      out.push(`${bullet[1] ?? ''}${pc.dim('•')} ${inline(bullet[2] ?? '')}`);
      continue;
    }

    const numbered = NUMBERED.exec(raw);
    if (numbered) {
      const [, lead = '', num = '', rest = ''] = numbered;
      out.push(`${lead}${pc.dim(`${num}.`)} ${inline(rest)}`);
      continue;
    }

    out.push(inline(raw));
  }

  // trim a trailing blank the collapse logic may have left
  while (out.length > 0 && out[out.length - 1] === '') out.pop();
  return out.join('\n');
}

export { inline as renderInlineMarkdown };
