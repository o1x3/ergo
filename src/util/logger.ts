import pc from 'picocolors';

// ergo writes human output to stderr and machine output (json / prompt) to
// stdout, so `ergo review --format json | jq` stays clean. These helpers all
// target stderr; formatters write structured results to stdout directly.

let quiet = false;
export function setQuiet(value: boolean): void {
  quiet = value;
}

// Apply the config's `output.color` (always | never | auto). Every module
// imports `pc` from here, so swapping the formatter set in place affects all
// rendering. `auto` keeps picocolors' own tty/NO_COLOR detection.
export function setColorMode(mode: 'auto' | 'always' | 'never'): void {
  if (mode === 'auto') return;
  Object.assign(pc, pc.createColors(mode === 'always'));
}

function write(line: string): void {
  if (!quiet) process.stderr.write(`${line}\n`);
}

export const log = {
  info(msg: string): void {
    write(msg);
  },
  step(msg: string): void {
    write(`${pc.cyan('›')} ${msg}`);
  },
  success(msg: string): void {
    write(`${pc.green('✓')} ${msg}`);
  },
  warn(msg: string): void {
    write(`${pc.yellow('!')} ${msg}`);
  },
  error(msg: string): void {
    process.stderr.write(`${pc.red('✗')} ${msg}\n`);
  },
  dim(msg: string): void {
    write(pc.dim(msg));
  },
  raw(msg: string): void {
    write(msg);
  },
};

export { pc };
