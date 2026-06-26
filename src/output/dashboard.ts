import { type Dashboard, ordinalToParts } from '@/memory/stats';
import { groupThousands, hourLabel, humanCount } from '@/output/format';
import {
  hbar,
  heatmap,
  heatmapLegend,
  rule,
  type StatCol,
  section,
  statColumns,
} from '@/output/layout';
import { displayWidth, fit, padStart, stripControl } from '@/output/style';
import { pc } from '@/util/logger';

const W = 70;
const CARD_COLS = 4;
const CARD_GAP = 2;
const CARD_W = (W - (CARD_COLS - 1) * CARD_GAP) / CARD_COLS; // 16
const HEATMAP_WEEKS = 26;
const MODEL_NAME_W = 13;
const MODEL_BAR_W = 22;

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

// Render the full stats dashboard for a window. `now` is injected for tests.
export function renderDashboard(
  dash: Dashboard,
  now: number = Date.now(),
): string {
  const out: string[] = [''];

  // Header: cyan-bold wordmark left, window tag right.
  const title = pc.cyan(pc.bold('  ergo stats'));
  const tag = pc.dim(dash.window.label);
  out.push(rightAlign(title, tag, W + 2));
  out.push(`  ${rule(W)}`);

  if (dash.reviews === 0) {
    const where =
      dash.window.arg === 'all' ? 'yet' : `in the ${dash.window.label}`;
    out.push('');
    out.push(
      pc.dim(`  No reviews recorded ${where}. Run \`ergo review\` to start.`),
    );
    out.push('');
    return out.join('\n');
  }

  // Context subtitle.
  out.push('');
  out.push(
    pc.dim(
      `  ${dash.reviews} reviews across ${dash.activeDays} active day${dash.activeDays === 1 ? '' : 's'}${subtitleRange(dash)}`,
    ),
  );

  // Two rows of borderless cards.
  out.push('');
  pushAll(out, statColumns(rowOne(dash), CARD_W, CARD_GAP));
  out.push('');
  pushAll(out, statColumns(rowTwo(dash), CARD_W, CARD_GAP));

  // Activity heatmap.
  out.push('');
  pushAll(out, section('ACTIVITY', { width: W, right: heatmapLegend() }));
  pushAll(out, heatmap(dash.byDay, new Date(now), heatmapWeeks(dash, now)));

  // Top models bar chart.
  const models = topModels(dash);
  if (models.length > 0) {
    out.push('');
    pushAll(
      out,
      section('MODELS', {
        width: W,
        right: pc.dim(`${dash.reviews} runs`),
      }),
    );
    out.push('');
    const max = Math.max(...models.map((m) => m.reviews));
    for (const m of models) {
      const name = pc.cyan(fit(stripControl(m.name), MODEL_NAME_W));
      const bar = hbar(m.reviews / max, MODEL_BAR_W);
      out.push(`  ${name}  ${bar}  ${padStart(String(m.reviews), 3)}`);
    }
  }

  // Playful comparison.
  const fun = funComparison(dash.totalTokens);
  if (fun) {
    out.push('');
    out.push(`  ${pc.dim(fun)}`);
  }
  out.push('');
  return out.join('\n');
}

function rowOne(dash: Dashboard): StatCol[] {
  const perDay =
    dash.activeDays > 0 ? (dash.reviews / dash.activeDays).toFixed(1) : '—';
  const perReview =
    dash.reviews > 0 ? (dash.findings / dash.reviews).toFixed(1) : '—';
  return [
    {
      label: 'REVIEWS',
      value: groupThousands(dash.reviews),
      sub: `${perDay} / day`,
    },
    {
      label: 'FINDINGS',
      value: groupThousands(dash.findings),
      sub: `${perReview} / review`,
    },
    {
      label: 'TOKENS',
      value: humanCount(dash.totalTokens),
      sub: `${humanCount(dash.tokensInput, 0)} in ${humanCount(dash.tokensOutput, 0)} out`,
    },
    {
      label: 'ACTIVE DAYS',
      value: groupThousands(dash.activeDays),
      sub:
        dash.window.arg === 'all'
          ? dash.firstTs
            ? `since ${monthDay(new Date(dash.firstTs))}`
            : ''
          : `of ${dash.window.label}`,
    },
  ];
}

function rowTwo(dash: Dashboard): StatCol[] {
  const topPct =
    dash.reviews > 0
      ? `${Math.round((dash.topModelReviews / dash.reviews) * 100)}% of runs`
      : '';
  return [
    {
      label: 'CURRENT STREAK',
      value: dayStr(dash.currentStreak),
      sub: dash.currentStreak > 0 ? 'going strong' : '—',
    },
    {
      label: 'LONGEST STREAK',
      value: dayStr(dash.longestStreak),
      sub: streakRange(dash),
    },
    {
      label: 'PEAK HOUR',
      value: dash.peakHour === undefined ? '—' : hourLabel(dash.peakHour),
      sub: dash.peakHourCount > 0 ? `${dash.peakHourCount} reviews` : '',
    },
    {
      label: 'TOP MODEL',
      value: dash.topModel ? stripControl(dash.topModel) : '—',
      sub: topPct,
    },
  ];
}

function topModels(dash: Dashboard): Array<{ name: string; reviews: number }> {
  return Object.entries(dash.byModel)
    .map(([name, m]) => ({ name, reviews: m.reviews }))
    .sort((a, b) => b.reviews - a.reviews)
    .slice(0, 5);
}

function dayStr(n: number): string {
  return `${n} day${n === 1 ? '' : 's'}`;
}

function monthDay(d: Date): string {
  return `${MONTHS[d.getMonth()]} ${d.getDate()}`;
}

function subtitleRange(dash: Dashboard): string {
  if (!dash.firstTs || !dash.lastTs) return '';
  const a = monthDay(new Date(dash.firstTs));
  const b = monthDay(new Date(dash.lastTs));
  return a === b ? ` · ${a}` : ` · ${a} – ${b}`;
}

// "Apr 6–16" / "Apr 6 – May 2" for the longest-streak date range.
function streakRange(dash: Dashboard): string {
  if (
    dash.longestStreak <= 1 ||
    dash.longestStreakStartOrd === undefined ||
    dash.longestStreakEndOrd === undefined
  ) {
    return '';
  }
  const s = ordinalToParts(dash.longestStreakStartOrd);
  const e = ordinalToParts(dash.longestStreakEndOrd);
  if (s.month === e.month) {
    return `${MONTHS[s.month]} ${s.day}–${e.day}`;
  }
  return `${MONTHS[s.month]} ${s.day} – ${MONTHS[e.month]} ${e.day}`;
}

// Right-align `right` after `left` within `total` visible columns.
function rightAlign(left: string, right: string, total: number): string {
  const gap = Math.max(1, total - displayWidth(left) - displayWidth(right));
  return `${left}${' '.repeat(gap)}${right}`;
}

function pushAll(out: string[], lines: string[]): void {
  for (const line of lines) out.push(`  ${line}`);
}

// Show fewer heatmap weeks for short windows so the grid isn't mostly empty.
function heatmapWeeks(dash: Dashboard, now: number): number {
  if (dash.window.sinceMs === undefined) return HEATMAP_WEEKS;
  const days = Math.ceil((now - dash.window.sinceMs) / 86_400_000);
  return Math.max(4, Math.min(HEATMAP_WEEKS, Math.ceil(days / 7) + 1));
}

const REFERENCES = [
  { name: 'a blog post', tokens: 1_500 },
  { name: 'the US Constitution', tokens: 10_000 },
  { name: 'The Great Gatsby', tokens: 63_000 },
  { name: "Harry Potter and the Philosopher's Stone", tokens: 100_000 },
  { name: 'the Lord of the Rings trilogy', tokens: 600_000 },
  { name: 'War and Peace', tokens: 780_000 },
];

// "You've burned ~N× the tokens in <book>." Picks the largest reference the
// total exceeds, so the multiplier reads naturally (≥ ~1×).
function funComparison(totalTokens: number): string | undefined {
  if (totalTokens < 1_000) return undefined;
  let ref = REFERENCES[0];
  for (const r of REFERENCES) {
    if (totalTokens >= r.tokens) ref = r;
  }
  if (!ref) return undefined;
  const mult = totalTokens / ref.tokens;
  const m = mult >= 10 ? Math.round(mult) : mult.toFixed(1);
  return `You've burned ~${m}× the tokens in ${ref.name}.`;
}
