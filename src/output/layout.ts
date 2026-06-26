import { center, displayWidth, padEnd, padStart } from '@/output/style';
import { pc } from '@/util/logger';

// lipgloss-lite layout primitives — boxes, stat cards, gauges, and a GitHub-style
// heatmap, built only on picocolors + the ANSI-aware width helpers in style.ts.
// No TUI, no new deps: every function returns plain strings/lines you print once.

// Plain-ASCII mode for dumb terminals (set ERGO_ASCII=1). Defaults to Unicode.
const ASCII = process.env.ERGO_ASCII === '1';

const BOX = ASCII
  ? { tl: '+', tr: '+', bl: '+', br: '+', h: '-', v: '|' }
  : { tl: '╭', tr: '╮', bl: '╰', br: '╯', h: '─', v: '│' };

export function rule(width: number): string {
  return pc.dim((ASCII ? '-' : '─').repeat(Math.max(0, width)));
}

// Draw a bordered box around `lines` (already styled). `innerWidth` is the
// content width inside the 1-space horizontal padding; lines are left-padded to
// it. Returns the bordered lines.
export function box(
  lines: string[],
  innerWidth: number,
  opts: { border?: (s: string) => string } = {},
): string[] {
  const b = opts.border ?? ((s: string) => pc.dim(s));
  const span = innerWidth + 2; // 1 space padding on each side
  const top = b(`${BOX.tl}${BOX.h.repeat(span)}${BOX.tr}`);
  const bottom = b(`${BOX.bl}${BOX.h.repeat(span)}${BOX.br}`);
  const body = lines.map(
    (l) => `${b(BOX.v)} ${padEnd(l, innerWidth)} ${b(BOX.v)}`,
  );
  return [top, ...body, bottom];
}

function truncateLabel(s: string, width: number): string {
  if (displayWidth(s) <= width) return s;
  return `${s.slice(0, Math.max(0, width - 1))}…`;
}

export interface StatCol {
  label: string;
  value: string;
  sub?: string;
  accent?: (s: string) => string;
}

// Hairline stat columns (no boxes): a dim LABEL row, a bold VALUE row, and a dim
// sub-detail row, aligned across `cols` columns of `colWidth`. This is the calm,
// cubic-style alternative to boxed cards.
export function statColumns(
  cols: StatCol[],
  colWidth: number,
  gap = 2,
): string[] {
  const sep = ' '.repeat(gap);
  const cell = (s: string, style: (x: string) => string) =>
    style(padEnd(truncateLabel(s, colWidth), colWidth));
  const labels = cols.map((c) => cell(c.label, pc.dim)).join(sep);
  const values = cols
    .map((c) => cell(c.value, c.accent ?? ((s) => pc.bold(s))))
    .join(sep);
  const subs = cols.map((c) => cell(c.sub ?? '', pc.dim)).join(sep);
  return [labels.trimEnd(), values.trimEnd(), subs.trimEnd()];
}

// A horizontal gauge like ████████░░░░░░  37%, colored by how full it is
// (green → yellow → red). `width` is the bar width in cells (excludes the label).
export function gauge(
  percent: number,
  width: number,
  opts: { showPct?: boolean } = {},
): string {
  const p = Math.max(0, Math.min(100, Number.isFinite(percent) ? percent : 0));
  const filled = Math.round((p / 100) * width);
  const empty = width - filled;
  const fullCh = ASCII ? '#' : '█';
  const emptyCh = ASCII ? '·' : '░';
  const color =
    p >= 90 ? pc.red : p >= 70 ? pc.yellow : p >= 1 ? pc.green : pc.dim;
  const bar = color(fullCh.repeat(filled)) + pc.dim(emptyCh.repeat(empty));
  return opts.showPct === false
    ? bar
    : `${bar} ${padStart(`${Math.round(p)}%`, 4)}`;
}

// Aligned key → value rows ("label   value"), keys padded to the widest key.
export function kvRows(pairs: Array<[string, string]>): string[] {
  const keyW = Math.max(0, ...pairs.map(([k]) => displayWidth(k)));
  return pairs.map(([k, v]) => `${pc.dim(padEnd(k, keyW))}   ${v}`);
}

// A bold section label with an optional right-aligned dim note and an optional
// trailing hairline rule (used above the Findings list).
export function section(
  title: string,
  opts: { width?: number; right?: string; rule?: boolean } = {},
): string[] {
  const w = opts.width ?? 70;
  let header = pc.bold(title);
  if (opts.right) {
    const gap = Math.max(
      1,
      w - displayWidth(pc.bold(title)) - displayWidth(opts.right),
    );
    header = `${pc.bold(title)}${' '.repeat(gap)}${opts.right}`;
  }
  return opts.rule ? [header, rule(w)] : [header];
}

// A proportional horizontal bar (filled green, dim track) — used for model runs.
export function hbar(fraction: number, width: number): string {
  const f = Math.max(0, Math.min(1, Number.isFinite(fraction) ? fraction : 0));
  const filled = Math.round(f * width);
  const fullCh = ASCII ? '#' : '█';
  const emptyCh = ASCII ? '.' : '░';
  return (
    pc.green(fullCh.repeat(filled)) + pc.dim(emptyCh.repeat(width - filled))
  );
}

// Shared severity/label vocabulary (single source for review + stats).
export type Tone =
  | 'critical'
  | 'major'
  | 'minor'
  | 'suggestion'
  | 'info'
  | 'accent'
  | 'good'
  | 'warn'
  | 'muted';

const CHIP_STYLE: Record<Tone, (s: string) => string> = {
  critical: (s) => pc.bgRed(pc.white(pc.bold(s))),
  major: (s) => pc.red(pc.bold(s)),
  minor: (s) => pc.yellow(pc.bold(s)),
  suggestion: (s) => pc.blue(pc.bold(s)),
  info: (s) => pc.dim(s),
  accent: (s) => pc.cyan(s),
  good: (s) => pc.green(s),
  warn: (s) => pc.yellow(s),
  muted: (s) => pc.dim(s),
};

// A colored severity/label chip. No interior padding — visible width equals the
// word, so callers pad the column themselves and alignment holds.
export function chip(label: string, tone: Tone): string {
  return (CHIP_STYLE[tone] ?? ((s: string) => s))(label);
}

const GLYPH_STYLE: Partial<Record<Tone, (s: string) => string>> = {
  critical: (s) => pc.red(pc.bold(s)),
  major: (s) => pc.red(s),
  minor: (s) => pc.yellow(s),
  suggestion: (s) => pc.blue(s),
  info: (s) => pc.dim(s),
};

// Severity glyph whose SHAPE encodes severity even with color stripped:
// ◆ critical, ● major/minor/suggestion, ○ info.
export function sevGlyph(tone: Tone): string {
  const ch = ASCII
    ? tone === 'info'
      ? 'o'
      : '*'
    : tone === 'critical'
      ? '◆'
      : tone === 'info'
        ? '○'
        : '●';
  return (GLYPH_STYLE[tone] ?? ((s: string) => s))(ch);
}

// A 5-dot confidence meter, round(conf*5) filled (●●●○○).
export function confMeter(conf: number): string {
  const filled = Math.max(
    0,
    Math.min(5, Math.round((Number.isFinite(conf) ? conf : 0) * 5)),
  );
  const full = ASCII ? '#' : '●';
  const empty = ASCII ? '.' : '○';
  return pc.dim(full.repeat(filled) + empty.repeat(5 - filled));
}

// Intensity ramp glyphs for the heatmap, dim → bright.
const RAMP = ASCII ? ['·', '░', '▒', '▓', '#'] : ['·', '░', '▒', '▓', '█'];

// "Less ·░▒▓█ More" legend for the heatmap, colored to match the cells.
export function heatmapLegend(): string {
  const ramp = RAMP.map((g, i) => colorForLevel(i)(g)).join('');
  return `${pc.dim('Less ')}${ramp}${pc.dim(' More')}`;
}

// Map a count to a 0-4 intensity level given the window's max count.
function level(count: number, max: number): number {
  if (count <= 0) return 0;
  if (max <= 1) return 4;
  const r = count / max;
  if (r > 0.75) return 4;
  if (r > 0.5) return 3;
  if (r > 0.25) return 2;
  return 1;
}

function colorForLevel(lvl: number): (s: string) => string {
  switch (lvl) {
    case 0:
      return (s) => pc.dim(s);
    case 1:
      return (s) => pc.green(pc.dim(s));
    case 4:
      return (s) => pc.bold(pc.green(s));
    default:
      return (s) => pc.green(s);
  }
}

// A GitHub-style contributions heatmap. `byDay` maps "YYYY-MM-DD" → count. Renders
// 7 weekday rows × up to `maxWeeks` week-columns ending at `to` (local). Returns
// the month-label line plus the seven weekday rows.
export function heatmap(
  byDay: Record<string, number>,
  to: Date,
  maxWeeks: number,
): string[] {
  // Anchor the right-most column on the week containing `to`; walk back maxWeeks.
  const end = new Date(to.getFullYear(), to.getMonth(), to.getDate());
  // JS getDay(): 0=Sun..6=Sat. We use Mon-first rows, so map to 0=Mon..6=Sun.
  const mondayIndex = (end.getDay() + 6) % 7;
  const lastColStart = new Date(end);
  lastColStart.setDate(end.getDate() - mondayIndex); // Monday of the last column

  const weeks: Array<Array<{ key: string; count: number }>> = [];
  let max = 0;
  for (let w = maxWeeks - 1; w >= 0; w--) {
    const col: Array<{ key: string; count: number }> = [];
    for (let d = 0; d < 7; d++) {
      const day = new Date(lastColStart);
      day.setDate(lastColStart.getDate() - w * 7 + d);
      const key = dateKey(day);
      const count = day > end ? -1 : (byDay[key] ?? 0); // -1 = future (blank)
      if (count > max) max = count;
      col.push({ key, count });
    }
    weeks.push(col);
  }

  const WEEKDAY = ['Mon', '', 'Wed', '', 'Fri', '', ''];
  const rows: string[] = [];
  for (let d = 0; d < 7; d++) {
    let line = `${pc.dim(padEnd(WEEKDAY[d] ?? '', 3))} `;
    for (const col of weeks) {
      const cell = col[d];
      if (!cell || cell.count < 0) {
        line += ' ';
        continue;
      }
      const lvl = level(cell.count, max);
      line += colorForLevel(lvl)(RAMP[lvl] ?? '·');
    }
    rows.push(line);
  }
  return [monthLabels(weeks), ...rows];
}

function monthLabels(
  weeks: Array<Array<{ key: string; count: number }>>,
): string {
  // One cell per week column. Place each month's 3-char label at the column
  // where that month first appears. Skip the leading partial month (seed
  // lastMonth from column 0) and enforce a no-overlap gap so close month
  // boundaries don't garble (e.g. "DJan").
  const cells: string[] = new Array(weeks.length).fill(' ');
  const monthAt = (i: number): number => {
    const first = weeks[i]?.[0];
    return first ? Number(first.key.slice(5, 7)) - 1 : -1;
  };
  let lastMonth = monthAt(0);
  let nextFree = 0;
  for (let i = 1; i < weeks.length; i++) {
    const month = monthAt(i);
    if (month < 0 || month === lastMonth) continue;
    lastMonth = month;
    const label = MONTHS[month] ?? '';
    if (i < nextFree || i + label.length > cells.length) continue; // no room
    for (let j = 0; j < label.length; j++) cells[i + j] = label[j] as string;
    nextFree = i + label.length + 1; // one blank column before the next label
  }
  return pc.dim(`    ${cells.join('')}`); // 4-space gutter matches weekday rows
}

const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

function dateKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// re-export width helpers some callers want alongside layout.
export { center, displayWidth, padEnd, padStart };
