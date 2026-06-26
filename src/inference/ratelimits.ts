// Rate-limit snapshot parsed from the Codex `/responses` HTTP response headers.
//
// Ground truth: the official openai/codex CLI reads these headers off the
// streaming POST response (NOT the SSE body) on the ChatGPT-subscription path.
//   x-codex-{primary,secondary}-used-percent   f64, 0-100
//   x-codex-{primary,secondary}-window-minutes  i64, rolling-window length
//   x-codex-{primary,secondary}-reset-at        i64, ABSOLUTE unix epoch SECONDS
// reset-at is an absolute timestamp, not seconds-from-now — never add Date.now().

export interface RateLimitWindow {
  /** Percentage of the window consumed, 0-100. */
  usedPercent: number;
  /** Rolling-window length in minutes (e.g. 300 ≈ 5h, 10080 ≈ weekly). */
  windowMinutes?: number;
  /** Absolute unix epoch (seconds) when the window resets. */
  resetsAt?: number;
}

export interface RateLimitSnapshot {
  primary?: RateLimitWindow;
  secondary?: RateLimitWindow;
  /** Plan name from `x-codex-plan-type` (e.g. "plus", "pro"), when reported. */
  planType?: string;
  /** Unix epoch (ms) when ergo read these headers. */
  capturedAt: number;
}

// Minimal structural type so the parser works with both the WHATWG `Headers`
// object and plain maps in tests. Header lookups are case-insensitive on the
// real `Headers`; the backend sends them lowercase.
export interface HeaderLike {
  get(name: string): string | null;
}

function readNumber(headers: HeaderLike, name: string): number | undefined {
  const raw = headers.get(name);
  if (raw === null || raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return undefined;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : undefined;
}

function readWindow(
  headers: HeaderLike,
  slot: 'primary' | 'secondary',
  capturedAt: number,
): RateLimitWindow | undefined {
  const usedPercent = readNumber(headers, `x-codex-${slot}-used-percent`);
  // The used-percent header is the anchor: if it's absent, the backend didn't
  // report this window at all.
  if (usedPercent === undefined) return undefined;
  const window: RateLimitWindow = {
    usedPercent: Math.max(0, Math.min(100, usedPercent)),
  };
  const windowMinutes = readNumber(headers, `x-codex-${slot}-window-minutes`);
  if (windowMinutes !== undefined && windowMinutes > 0) {
    window.windowMinutes = windowMinutes;
  }
  // Prefer the absolute reset timestamp; fall back to the relative
  // reset-after-seconds (the ChatGPT backend sends both) so we still get a
  // reset time even if the absolute header is ever dropped.
  const resetsAt = readNumber(headers, `x-codex-${slot}-reset-at`);
  if (resetsAt !== undefined && resetsAt > 0) {
    window.resetsAt = resetsAt;
  } else {
    const after = readNumber(headers, `x-codex-${slot}-reset-after-seconds`);
    if (after !== undefined && after >= 0) {
      window.resetsAt = Math.floor(capturedAt / 1000) + after;
    }
  }
  return window;
}

// Parse a rate-limit snapshot from response headers. Returns undefined when no
// rate-limit headers are present (e.g. an API-key provider, or a backend that
// doesn't report them), so callers can cleanly say "unknown".
export function parseRateLimitHeaders(
  headers: HeaderLike,
  capturedAt: number = Date.now(),
): RateLimitSnapshot | undefined {
  const primary = readWindow(headers, 'primary', capturedAt);
  const secondary = readWindow(headers, 'secondary', capturedAt);
  if (!primary && !secondary) return undefined;
  const snapshot: RateLimitSnapshot = { primary, secondary, capturedAt };
  const planType = headers.get('x-codex-plan-type')?.trim();
  if (planType) snapshot.planType = planType;
  return snapshot;
}

// Map a rolling-window length (minutes) to a human label, matching codex's own
// ±5% thresholds. Falls back to a humanized duration for unusual windows.
export function windowLabel(minutes: number | undefined): string {
  if (minutes === undefined || !Number.isFinite(minutes) || minutes <= 0) {
    return 'usage';
  }
  const near = (target: number) =>
    minutes >= target * 0.95 && minutes <= target * 1.05;
  if (near(300)) return '5h';
  if (near(1440)) return 'daily';
  if (near(10080)) return 'weekly';
  if (near(43200)) return 'monthly';
  if (near(525600)) return 'annual';
  if (minutes % 1440 === 0) return `${minutes / 1440}d`;
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  return `${Math.round(minutes)}m`;
}
