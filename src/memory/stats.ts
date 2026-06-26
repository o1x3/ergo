import type { UsageRecord } from '@/memory/usage';

// Stats time-window. `sinceMs` is an inclusive lower bound (start of the
// earliest included calendar day); undefined means all-time.
export interface StatsWindow {
  sinceMs?: number;
  label: string;
  arg: string;
}

const DAY_MS = 86_400_000;

// Local calendar-day key, e.g. "2026-06-26".
export function localDateKey(ms: number): string {
  const d = new Date(ms);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// Integer day number for a "YYYY-MM-DD" key. Uses Date.UTC so consecutive local
// days always differ by exactly 1 — DST-safe (avoids 23h/25h day drift).
export function dayOrdinal(key: string): number {
  const [y, m, d] = key.split('-').map(Number);
  return Math.round(Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1) / DAY_MS);
}

// A day ordinal back to its calendar parts (UTC midnight of that day).
export function ordinalToParts(ord: number): {
  year: number;
  month: number; // 0-11
  day: number;
} {
  const d = new Date(ord * DAY_MS);
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth(),
    day: d.getUTCDate(),
  };
}

// Start-of-day (local) ms for `n-1` days before `now`, i.e. the lower bound that
// includes today plus the previous n-1 calendar days. DST-safe via setDate.
function nDaysAgoStart(now: number, days: number): number {
  const d = new Date(now);
  d.setDate(d.getDate() - (days - 1));
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

// Start-of-day (local) ms for `n` calendar months before `now`.
function nMonthsAgoStart(now: number, months: number): number {
  const d = new Date(now);
  d.setMonth(d.getMonth() - months);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

// Parse a window arg: undefined/"all" → all-time; N followed by d(ays)/w(eeks)
// or m(onths, real calendar months — distinct from "30d"). Returns null for an
// unrecognized arg so the caller can report it.
export function parseStatsWindow(
  arg: string | undefined,
  now: number = Date.now(),
): StatsWindow | null {
  const raw = (arg ?? 'all').trim().toLowerCase();
  if (raw === '' || raw === 'all' || raw === 'alltime' || raw === 'all-time') {
    return { sinceMs: undefined, label: 'all time', arg: 'all' };
  }
  const m = /^(\d+)\s*(d|w|m)$/.exec(raw);
  if (!m) return null;
  const n = Number(m[1]);
  const unit = m[2];
  if (!Number.isFinite(n) || n <= 0) return null;
  const noun = unit === 'd' ? 'day' : unit === 'w' ? 'week' : 'month';
  const sinceMs =
    unit === 'm'
      ? nMonthsAgoStart(now, n)
      : nDaysAgoStart(now, unit === 'w' ? n * 7 : n);
  return {
    sinceMs,
    label: `last ${n} ${noun}${n === 1 ? '' : 's'}`,
    arg: `${n}${unit}`,
  };
}

export interface Dashboard {
  window: StatsWindow;
  reviews: number;
  findings: number;
  tokensInput: number;
  tokensOutput: number;
  totalTokens: number;
  costUsd: number;
  subscriptionReviews: number;
  activeDays: number;
  currentStreak: number;
  longestStreak: number;
  longestStreakStartOrd?: number;
  longestStreakEndOrd?: number;
  peakHour?: number; // 0-23
  peakHourCount: number;
  topModel?: string;
  topModelReviews: number;
  byModel: Record<string, { reviews: number; tokens: number; costUsd: number }>;
  byDay: Record<string, number>; // "YYYY-MM-DD" → review count (local)
  firstTs?: string;
  lastTs?: string;
}

const fin = (v: unknown): number =>
  typeof v === 'number' && Number.isFinite(v) ? v : 0;

// Compute the dashboard for a window. Window-scoped: reviews, findings, tokens,
// active days, peak hour, top model, heatmap. Full-history (NOT window-scoped):
// current/longest streak — a streak is a property of your whole activity, so it
// reads the same in `stats` and `stats 7d`. Pure: parameterized by `now`.
export function computeDashboard(
  records: UsageRecord[],
  window: StatsWindow,
  now: number = Date.now(),
): Dashboard {
  const inWindow: Array<{ record: UsageRecord; ms: number }> = [];
  const allDayKeys = new Set<string>();
  for (const r of records) {
    const ms = Date.parse(r.ts);
    if (Number.isNaN(ms)) continue; // skip malformed timestamps
    allDayKeys.add(localDateKey(ms));
    if (window.sinceMs !== undefined && ms < window.sinceMs) continue;
    inWindow.push({ record: r, ms });
  }
  inWindow.sort((a, b) => a.ms - b.ms);

  const dash: Dashboard = {
    window,
    reviews: 0,
    findings: 0,
    tokensInput: 0,
    tokensOutput: 0,
    totalTokens: 0,
    costUsd: 0,
    subscriptionReviews: 0,
    activeDays: 0,
    currentStreak: 0,
    longestStreak: 0,
    peakHourCount: 0,
    topModelReviews: 0,
    byModel: {},
    byDay: {},
  };

  const hourCounts = new Array(24).fill(0);
  for (const { record: r, ms } of inWindow) {
    dash.reviews += 1;
    dash.findings += fin(r.findings);
    dash.tokensInput += fin(r.tokensInput);
    dash.tokensOutput += fin(r.tokensOutput);
    dash.costUsd += fin(r.costUsd);
    if (r.subscription) dash.subscriptionReviews += 1;

    const model = r.model || 'unknown';
    const bm = dash.byModel[model] ?? { reviews: 0, tokens: 0, costUsd: 0 };
    bm.reviews += 1;
    bm.tokens += fin(r.tokensInput) + fin(r.tokensOutput);
    bm.costUsd += fin(r.costUsd);
    dash.byModel[model] = bm;

    const key = localDateKey(ms);
    dash.byDay[key] = (dash.byDay[key] ?? 0) + 1;
    hourCounts[new Date(ms).getHours()] += 1;
  }
  dash.totalTokens = dash.tokensInput + dash.tokensOutput;
  dash.firstTs = inWindow[0]?.record.ts;
  dash.lastTs = inWindow[inWindow.length - 1]?.record.ts;
  dash.activeDays = Object.keys(dash.byDay).length;

  // Peak hour (tie → earliest hour).
  if (dash.reviews > 0) {
    let best = 0;
    for (let h = 1; h < 24; h++) {
      if (hourCounts[h] > hourCounts[best]) best = h;
    }
    if (hourCounts[best] > 0) {
      dash.peakHour = best;
      dash.peakHourCount = hourCounts[best];
    }
  }

  // Top model (tie → most tokens).
  for (const [model, m] of Object.entries(dash.byModel)) {
    const better =
      m.reviews > dash.topModelReviews ||
      (m.reviews === dash.topModelReviews &&
        dash.topModel !== undefined &&
        m.tokens > (dash.byModel[dash.topModel]?.tokens ?? 0));
    if (dash.topModel === undefined || better) {
      dash.topModel = model;
      dash.topModelReviews = m.reviews;
    }
  }

  // Streaks over the FULL history (not the window).
  const allOrdinals = [...allDayKeys].map(dayOrdinal).sort((a, b) => a - b);
  const longest = longestRunRange(allOrdinals);
  dash.longestStreak = longest.length;
  dash.longestStreakStartOrd = longest.startOrd;
  dash.longestStreakEndOrd = longest.endOrd;
  dash.currentStreak = currentRun(allOrdinals, dayOrdinal(localDateKey(now)));

  return dash;
}

// Longest run of consecutive integers; returns its length and inclusive bounds.
function longestRunRange(sorted: number[]): {
  length: number;
  startOrd?: number;
  endOrd?: number;
} {
  if (sorted.length === 0) return { length: 0 };
  let bestLen = 1;
  let bestStart = sorted[0] as number;
  let bestEnd = sorted[0] as number;
  let curStart = sorted[0] as number;
  let curLen = 1;
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1] as number;
    const cur = sorted[i] as number;
    if (cur === prev) continue;
    if (cur === prev + 1) curLen += 1;
    else {
      curStart = cur;
      curLen = 1;
    }
    if (curLen > bestLen) {
      bestLen = curLen;
      bestStart = curStart;
      bestEnd = cur;
    }
  }
  return { length: bestLen, startOrd: bestStart, endOrd: bestEnd };
}

// Current streak: consecutive active days ending today, or ending yesterday if
// today isn't active yet (grace), else 0.
function currentRun(sortedOrdinals: number[], todayOrd: number): number {
  if (sortedOrdinals.length === 0) return 0;
  const set = new Set(sortedOrdinals);
  let end: number;
  if (set.has(todayOrd)) end = todayOrd;
  else if (set.has(todayOrd - 1)) end = todayOrd - 1;
  else return 0;
  let streak = 0;
  let d = end;
  while (set.has(d)) {
    streak += 1;
    d -= 1;
  }
  return streak;
}
