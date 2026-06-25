import { createInterface } from 'node:readline';

// Read a single line from stdin. `mask` hides typed characters (for secrets) by
// suppressing echo while still capturing input.
export async function promptLine(
  question: string,
  opts: { mask?: boolean } = {},
): Promise<string> {
  const input = process.stdin;
  const output = process.stderr;
  const rl = createInterface({ input, output, terminal: true });

  if (opts.mask) {
    // Suppress echo: intercept the readline output writer.
    const rlAny = rl as unknown as {
      _writeToOutput?: (s: string) => void;
      output?: NodeJS.WriteStream;
    };
    let first = true;
    rlAny._writeToOutput = (s: string) => {
      if (first) {
        output.write(s);
        first = false;
      } else if (s.includes('\n')) {
        output.write('\n');
      }
      // otherwise: swallow keystroke echo
    };
  }

  return new Promise<string>((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

export async function confirm(
  question: string,
  defaultYes = false,
): Promise<boolean> {
  const hint = defaultYes ? '[Y/n]' : '[y/N]';
  const answer = (await promptLine(`${question} ${hint} `)).toLowerCase();
  if (answer === '') return defaultYes;
  return answer === 'y' || answer === 'yes';
}
