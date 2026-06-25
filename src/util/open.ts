import { spawn } from 'node:child_process';

// Best-effort "open this URL in the user's browser". Never throws — if it fails
// (headless box, no DISPLAY) the caller has already printed the URL to paste.
export function openBrowser(url: string): void {
  try {
    const platform = process.platform;
    const [cmd, args] =
      platform === 'darwin'
        ? ['open', [url]]
        : platform === 'win32'
          ? ['cmd', ['/c', 'start', '', url]]
          : ['xdg-open', [url]];
    const child = spawn(cmd, args, {
      stdio: 'ignore',
      detached: true,
    });
    child.on('error', () => {
      // swallow: user can open the URL manually
    });
    child.unref();
  } catch {
    // swallow
  }
}
