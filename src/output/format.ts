// Small, dependency-free scalar formatters shared by the stats dashboard and
// the usage view. Pure functions, easy to unit-test.

// 1234567 → "1.2M", 12345 → "12.3K", 999 → "999". Compact, at most `decimals`
// places (default 1). Pass 0 for a tighter form (50.2K → "50K") where space is
// scarce.
export function humanCount(n: number, decimals = 1): string {
  if (!Number.isFinite(n)) return '0';
  const abs = Math.abs(n);
  if (abs < 1000) return String(Math.round(n));
  if (abs < 1_000_000) return `${trim(n / 1000, decimals)}K`;
  if (abs < 1_000_000_000) return `${trim(n / 1_000_000, decimals)}M`;
  return `${trim(n / 1_000_000_000, decimals)}B`;
}

// `decimals` places, dropping trailing zeros (and a bare trailing dot).
function trim(n: number, decimals: number): string {
  const s = n.toFixed(decimals);
  if (!s.includes('.')) return s;
  return s.replace(/\.?0+$/, '');
}

// 1234 → "1,234" (thousands separators, no locale dependence).
export function groupThousands(n: number): string {
  if (!Number.isFinite(n)) return '0';
  const neg = n < 0;
  const digits = String(Math.abs(Math.round(n)));
  let out = '';
  for (let i = 0; i < digits.length; i++) {
    if (i > 0 && (digits.length - i) % 3 === 0) out += ',';
    out += digits[i];
  }
  return neg ? `-${out}` : out;
}

// Hour 0-23 → "12 AM", "9 AM", "2 PM".
export function hourLabel(hour: number): string {
  const h = ((hour % 24) + 24) % 24;
  const period = h < 12 ? 'AM' : 'PM';
  const display = h % 12 === 0 ? 12 : h % 12;
  return `${display} ${period}`;
}

// Seconds → "3h 41m", "2d 4h", "5m", "now". Coarse: shows the two largest units.
export function humanDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return 'now';
  const d = Math.floor(seconds / 86_400);
  const h = Math.floor((seconds % 86_400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return h > 0 ? `${d}d ${h}h` : `${d}d`;
  if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`;
  if (m > 0) return `${m}m`;
  return '<1m';
}

// Absolute reset epoch (seconds) → "resets in 3h 41m" relative to now.
export function resetsIn(
  resetsAtSec: number | undefined,
  nowMs: number,
): string {
  if (resetsAtSec === undefined || !Number.isFinite(resetsAtSec)) {
    return 'reset time unknown';
  }
  const seconds = resetsAtSec - Math.floor(nowMs / 1000);
  if (seconds <= 0) return 'resets now';
  return `resets in ${humanDuration(seconds)}`;
}

// Past timestamp (ms) → "just now", "5m ago", "3h ago", "2d ago".
export function relativeTime(thenMs: number, nowMs: number): string {
  const seconds = Math.floor((nowMs - thenMs) / 1000);
  if (!Number.isFinite(seconds) || seconds < 0) return 'just now';
  if (seconds < 45) return 'just now';
  if (seconds < 3600) return `${Math.max(1, Math.round(seconds / 60))}m ago`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)}h ago`;
  return `${Math.round(seconds / 86_400)}d ago`;
}
