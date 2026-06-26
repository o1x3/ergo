const HELP_VERSION = new Set(['--help', '-h', '--version', '-v']);

// Normalize raw argv before handing it to citty:
//   - bare `ergo` and `ergo --flags` run the default `review` command
//   - `ergo help [cmd]` / `ergo version` map to the `--help` / `--version` flags
//   - `ergo review findings` is rewritten to the top-level `findings` command
//     (citty runs a parent's `run` alongside a matched subcommand, so `findings`
//     cannot live as a subcommand of `review`)
//   - any other first token is left untouched so citty routes it: a real command
//     runs, an unknown one errors with "Unknown command" (exit 1) rather than
//     silently starting a review that spends Codex/API tokens on a typo.
export function withDefaultCommand(argv: string[]): string[] {
  if (argv[0] === 'review' && argv[1] === 'findings') {
    return ['findings', ...argv.slice(2)];
  }
  const first = argv[0];

  // bare `ergo` or `ergo --flags` → review (but let --help / --version through).
  if (!first || first.startsWith('-')) {
    if (first && HELP_VERSION.has(first)) return argv;
    return ['review', ...argv];
  }

  // `ergo help` / `ergo help <cmd>` / `ergo version` are natural spellings of
  // the flags; route them so they show help instead of running a review.
  if (first === 'help') {
    const rest = argv.slice(1);
    return rest.length > 0 ? [...rest, '--help'] : ['--help'];
  }
  if (first === 'version') return ['--version'];

  // A registered command runs as-is; an unknown first token falls through to
  // citty, which reports it. Never coerce it into an implicit review.
  return argv;
}
