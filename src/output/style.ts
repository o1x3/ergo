// lipgloss-lite: dependency-free terminal layout primitives. The foundation is
// ANSI-aware width math so colored strings align correctly in a monospace grid.
// Higher-level pieces (boxes, bars, heatmap) build on these.

// SGR color sequences look like ESC[1m / ESC[38;5;42m. Build the matcher from the
// ESC code point so there's no literal control char in source.
const ESC = String.fromCharCode(27);
const ANSI_GLOBAL = new RegExp(`${ESC}\\[[0-9;]*m`, 'g');
const ANSI_STICKY = new RegExp(`${ESC}\\[[0-9;]*m`, 'y');

export function stripAnsi(s: string): string {
  return s.replace(ANSI_GLOBAL, '');
}

// Remove terminal control / escape characters (keeps tab + newline) from
// untrusted text so it can't move the cursor, recolor, or inject sequences.
// Codepoint-based so no control char appears in source.
export function stripControl(s: string): string {
  let out = '';
  for (const ch of s) {
    const c = ch.codePointAt(0) ?? 0;
    const isControl =
      (c < 0x20 && c !== 0x09 && c !== 0x0a) ||
      c === 0x7f ||
      (c >= 0x80 && c <= 0x9f);
    // Bidi / RTL-override format chars enable Trojan-Source spoofing — strip too.
    const isBidi =
      c === 0x200e ||
      c === 0x200f ||
      c === 0x061c ||
      (c >= 0x202a && c <= 0x202e) ||
      (c >= 0x2066 && c <= 0x2069);
    if (!isControl && !isBidi) out += ch;
  }
  return out;
}

// Whether a codepoint renders as two terminal columns (CJK, fullwidth, emoji).
// Deliberately conservative: the layouts below avoid ambiguous glyphs, so this
// only needs to catch the clearly-wide ranges.
function isWide(cp: number): boolean {
  return (
    (cp >= 0x1100 && cp <= 0x115f) || // Hangul Jamo
    (cp >= 0x2e80 && cp <= 0xa4cf) || // CJK & friends
    (cp >= 0xac00 && cp <= 0xd7a3) || // Hangul syllables
    (cp >= 0xf900 && cp <= 0xfaff) || // CJK compatibility
    (cp >= 0xff00 && cp <= 0xff60) || // fullwidth forms
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1faff) // emoji & pictographs
  );
}

function charWidth(cp: number): number {
  if (cp === 0x200d || (cp >= 0xfe00 && cp <= 0xfe0f)) return 0; // zero-width
  return isWide(cp) ? 2 : 1;
}

// Visible width of a string in terminal columns, ignoring ANSI color codes and
// zero-width joiners / variation selectors.
export function displayWidth(s: string): number {
  let width = 0;
  for (const ch of stripAnsi(s)) {
    width += charWidth(ch.codePointAt(0) ?? 0);
  }
  return width;
}

// Pad a string to `width` visible columns by appending `fill` (left-align).
export function padEnd(s: string, width: number, fill = ' '): string {
  const pad = width - displayWidth(s);
  return pad > 0 ? s + fill.repeat(pad) : s;
}

// Pad a string to `width` visible columns by prepending `fill` (right-align).
export function padStart(s: string, width: number, fill = ' '): string {
  const pad = width - displayWidth(s);
  return pad > 0 ? fill.repeat(pad) + s : s;
}

// Center a string within `width` visible columns.
export function center(s: string, width: number, fill = ' '): string {
  const pad = width - displayWidth(s);
  if (pad <= 0) return s;
  const left = Math.floor(pad / 2);
  return fill.repeat(left) + s + fill.repeat(pad - left);
}

// Truncate-or-pad a string to EXACTLY `width` visible columns.
export function fit(
  s: string,
  width: number,
  align: 'left' | 'right' | 'center' = 'left',
): string {
  if (displayWidth(s) > width) return truncate(s, width);
  if (align === 'right') return padStart(s, width);
  if (align === 'center') return center(s, width);
  return padEnd(s, width);
}

// Word-wrap to `width` visible columns, preserving explicit newlines. Words are
// kept whole (prose); callers add any hanging indent themselves.
export function wrapText(s: string, width: number): string[] {
  const out: string[] = [];
  for (const para of s.split('\n')) {
    if (para.trim() === '') {
      out.push('');
      continue;
    }
    let line = '';
    for (const word of para.split(/\s+/).filter(Boolean)) {
      // Hard-break a single word that can't fit (long path / URL / token) so it
      // never overflows the canvas.
      if (displayWidth(word) > width) {
        if (line !== '') {
          out.push(line);
          line = '';
        }
        const chunks = hardChunks(word, width);
        for (let k = 0; k < chunks.length - 1; k++)
          out.push(chunks[k] as string);
        line = chunks[chunks.length - 1] ?? '';
        continue;
      }
      if (line === '') line = word;
      else if (displayWidth(line) + 1 + displayWidth(word) <= width)
        line += ` ${word}`;
      else {
        out.push(line);
        line = word;
      }
    }
    if (line !== '') out.push(line);
  }
  return out;
}

// Split a word with no break points into chunks of at most `width` columns.
// ANSI-aware: copies SGR sequences through at zero width and never splits one;
// closes any open color at a chunk boundary so it can't bleed onto the next line
// (mirrors truncate()).
function hardChunks(word: string, width: number): string[] {
  const chunks: string[] = [];
  const flush = (s: string) =>
    chunks.push(s.includes(ESC) ? `${s}${ESC}[0m` : s);
  let cur = '';
  let curW = 0;
  let i = 0;
  while (i < word.length) {
    ANSI_STICKY.lastIndex = i;
    const m = ANSI_STICKY.exec(word);
    if (m) {
      cur += m[0]; // copy the whole escape through, no width cost
      i += m[0].length;
      continue;
    }
    const cp = word.codePointAt(i) ?? 0;
    const ch = String.fromCodePoint(cp);
    const w = charWidth(cp);
    if (curW + w > width && cur !== '') {
      flush(cur);
      cur = '';
      curW = 0;
    }
    cur += ch;
    curW += w;
    i += ch.length;
  }
  if (cur !== '') flush(cur);
  return chunks;
}

// Truncate to `width` visible columns, preserving ANSI sequences (copied through
// without counting) and appending an ellipsis when content is dropped.
export function truncate(s: string, width: number, ellipsis = '…'): string {
  if (displayWidth(s) <= width) return s;
  const budget = Math.max(0, width - displayWidth(ellipsis));
  let out = '';
  let used = 0;
  let i = 0;
  while (i < s.length) {
    ANSI_STICKY.lastIndex = i;
    const m = ANSI_STICKY.exec(s);
    if (m) {
      out += m[0]; // copy color codes through, no width cost
      i += m[0].length;
      continue;
    }
    const cp = s.codePointAt(i) ?? 0;
    const ch = String.fromCodePoint(cp);
    const w = charWidth(cp);
    if (used + w > budget) break;
    out += ch;
    used += w;
    i += ch.length;
  }
  // If we cut mid-string after copying color codes, close them so the color
  // doesn't bleed into whatever follows the truncated cell.
  const reset = out.includes(ESC) ? `${ESC}[0m` : '';
  return `${out}${reset}${ellipsis}`;
}
