export type ExecResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
};

export type ExecOptions = {
  cwd?: string;
  input?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  maxBuffer?: number;
};

// Thin wrapper over Bun.spawn that captures stdout/stderr as text and never
// throws on a non-zero exit (callers inspect exitCode). Used for git and the
// bundled static-analysis tools.
export async function exec(
  cmd: string[],
  options: ExecOptions = {},
): Promise<ExecResult> {
  const proc = Bun.spawn(cmd, {
    cwd: options.cwd,
    env: options.env ? { ...process.env, ...options.env } : process.env,
    stdin: options.input ? new TextEncoder().encode(options.input) : 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });

  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let hardKill: ReturnType<typeof setTimeout> | undefined;
  if (options.timeoutMs && options.timeoutMs > 0) {
    timer = setTimeout(() => {
      timedOut = true;
      proc.kill(); // SIGTERM
      // Escalate to SIGKILL if the child ignores SIGTERM.
      hardKill = setTimeout(() => {
        try {
          proc.kill(9);
        } catch {
          // already gone
        }
      }, 2000);
    }, options.timeoutMs);
  }

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (timer) clearTimeout(timer);
  if (hardKill) clearTimeout(hardKill);

  return {
    stdout,
    stderr: timedOut ? `${stderr}\n[ergo] command timed out` : stderr,
    exitCode: timedOut ? 124 : exitCode,
  };
}

// Whether an executable is resolvable on PATH. Cheap availability probe for the
// optional static-analysis integrations.
const whichCache = new Map<string, boolean>();
export async function commandExists(name: string): Promise<boolean> {
  const cached = whichCache.get(name);
  if (cached !== undefined) return cached;
  const probe = process.platform === 'win32' ? 'where' : 'which';
  const { exitCode } = await exec([probe, name]);
  const ok = exitCode === 0;
  whichCache.set(name, ok);
  return ok;
}
