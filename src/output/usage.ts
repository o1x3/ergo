import {
  type RateLimitSnapshot,
  type RateLimitWindow,
  windowLabel,
} from '@/inference/ratelimits';
import { relativeTime, resetsIn } from '@/output/format';
import { gauge, rule } from '@/output/layout';
import { displayWidth, fit } from '@/output/style';
import { pc } from '@/util/logger';

const W = 70;
const LABEL_W = 13;
const BAR_W = 40;

// Render the Codex usage view: a labeled gauge per rate-limit window with used%,
// reset time, and remaining %. `now` is injected for testability.
export function renderUsage(
  snapshot: RateLimitSnapshot | undefined,
  now: number = Date.now(),
): string {
  const out: string[] = [''];
  const title = pc.cyan(pc.bold('  ergo usage'));

  if (!snapshot || (!snapshot.primary && !snapshot.secondary)) {
    out.push(title);
    out.push(`  ${rule(W)}`);
    out.push('');
    out.push(pc.dim('  No rate-limit data yet.'));
    out.push(
      pc.dim('  Run a review on your Codex subscription and ergo records your'),
    );
    out.push(pc.dim('  5h and weekly limits here.'));
    out.push('');
    return out.join('\n');
  }

  const noteParts = [
    snapshot.planType ? `${snapshot.planType} plan` : '',
    `as of ${relativeTime(snapshot.capturedAt, now)}`,
  ].filter(Boolean);
  const note = pc.dim(noteParts.join(' · '));
  out.push(rightAlign(title, note, W + 2));
  out.push(`  ${rule(W)}`);

  for (const win of [snapshot.primary, snapshot.secondary]) {
    if (!win) continue;
    out.push('');
    out.push(`  ${gaugeLine(win)}`);
    out.push(`  ${subLine(win, now)}`);
  }

  out.push('');
  out.push(
    `  ${pc.dim(fit('credits', LABEL_W))} ${pc.dim(creditsText(snapshot))}`,
  );
  out.push('');
  return out.join('\n');
}

// Clamp a possibly-corrupt percent (e.g. a hand-edited ratelimits.json) to 0-100.
function clampPct(p: number): number {
  return Math.max(0, Math.min(100, Number.isFinite(p) ? p : 0));
}

function gaugeLine(win: RateLimitWindow): string {
  const used = clampPct(win.usedPercent);
  const label = pc.bold(
    fit(`${windowLabel(win.windowMinutes)} limit`, LABEL_W),
  );
  const bar = gauge(used, BAR_W, { showPct: false });
  const pct = pc.dim(padStartPlain(`${Math.round(used)}%`, 4));
  return `${label} ${bar}  ${pct}`;
}

function subLine(win: RateLimitWindow, now: number): string {
  const indent = ' '.repeat(LABEL_W + 1);
  const left = `${indent}${pc.dim(resetsIn(win.resetsAt, now))}`;
  const remaining = pc.dim(
    `${Math.round(100 - clampPct(win.usedPercent))}% remaining`,
  );
  return rightAlign(left, remaining, W);
}

function creditsText(snapshot: RateLimitSnapshot): string {
  return snapshot.planType
    ? `included with ${snapshot.planType}`
    : 'included with your subscription';
}

function padStartPlain(s: string, width: number): string {
  return s.length >= width ? s : ' '.repeat(width - s.length) + s;
}

function rightAlign(left: string, right: string, total: number): string {
  const gap = Math.max(1, total - displayWidth(left) - displayWidth(right));
  return `${left}${' '.repeat(gap)}${right}`;
}
