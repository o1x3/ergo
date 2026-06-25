// Top-level command names. Anything else as the first token implies `review`.
export const KNOWN_COMMANDS = new Set([
  'review',
  'findings',
  'fix',
  'describe',
  'auth',
  'config',
  'doctor',
  'learn',
  'models',
  'stats',
  'update',
  'install-hook',
]);

const HELP_VERSION = new Set(['--help', '-h', '--version', '-v']);

// Normalize raw argv so that:
//   - bare `ergo` and `ergo --flags` run `review`
//   - `ergo review findings` is rewritten to the top-level `findings` command
//     (citty runs a parent's `run` alongside a matched subcommand, so `findings`
//     cannot live as a subcommand of `review`)
//   - `--help` / `--version` pass through untouched
export function withDefaultCommand(argv: string[]): string[] {
  if (argv[0] === 'review' && argv[1] === 'findings') {
    return ['findings', ...argv.slice(2)];
  }
  const first = argv[0];
  if (!first || first.startsWith('-')) {
    if (first && HELP_VERSION.has(first)) return argv;
    return ['review', ...argv];
  }
  if (!KNOWN_COMMANDS.has(first)) return ['review', ...argv];
  return argv;
}
