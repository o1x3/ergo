import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import { VERSION } from '@/version';

export const SEARCH_MCP_URL = 'https://search.parallel.ai/mcp';

export type WebRequest =
  | { kind: 'search'; query: string }
  | { kind: 'fetch'; url: string };

export type WebOptions = {
  sessionId: string;
  model: string;
  signal?: AbortSignal;
  // Test seams keep requests on the same MCP transport as the real caller.
  fetchImpl?: (
    url: string | URL | Request,
    init?: RequestInit,
  ) => Promise<Response>;
  timeoutMs?: number;
};

export function parseWebCommand(input: string): WebRequest | undefined {
  const match = input.match(/^\/(search|fetch)(?:\s+([\s\S]*))?$/);
  if (!match) return undefined;
  const value = match[2]?.trim();
  if (!value) {
    throw new Error(
      `Usage: /${match[1]} ${match[1] === 'search' ? '<query>' : '<http(s) URL>'}`,
    );
  }
  if (match[1] === 'search') return { kind: 'search', query: value };
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Usage: /fetch <http(s) URL>');
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password
  ) {
    throw new Error(
      '/fetch requires an HTTP(S) URL without embedded credentials.',
    );
  }
  return { kind: 'fetch', url: url.href };
}

// No inference credentials, diff, history, or environment keys are sent here.
// Each deliberate command gets a bounded connection; conversation identity is
// shared across commands, including failures, for anonymous quota accounting.
export async function requestWeb(
  request: WebRequest,
  opts: WebOptions,
): Promise<string> {
  const timeout = AbortSignal.timeout(opts.timeoutMs ?? 30_000);
  const signal = opts.signal
    ? AbortSignal.any([opts.signal, timeout])
    : timeout;
  signal.throwIfAborted();
  const client = new Client({ name: 'ergo', version: VERSION });
  const transport = new StreamableHTTPClientTransport(new URL(SEARCH_MCP_URL), {
    fetch: async (url, init) => {
      const headers = new Headers(init?.headers);
      headers.set('User-Agent', `ergo/${VERSION}`);
      return (opts.fetchImpl ?? fetch)(url, {
        ...init,
        headers,
        signal: init?.signal ? AbortSignal.any([signal, init.signal]) : signal,
      });
    },
  });
  try {
    await client.connect(transport, { signal });
    const tool = request.kind === 'search' ? 'web_search' : 'web_fetch';
    const { tools } = await client.listTools({}, { signal });
    if (!tools.some((t) => t.name === tool)) {
      throw new Error(
        `Parallel Search MCP does not offer ${tool}. Try again later.`,
      );
    }
    const args =
      request.kind === 'search'
        ? { objective: request.query, search_queries: [request.query] }
        : { urls: [request.url] };
    const result = await client.callTool(
      {
        name: tool,
        arguments: {
          ...args,
          session_id: opts.sessionId,
          model_name: opts.model,
        },
      },
      undefined,
      { signal },
    );
    const text = Array.isArray(result.content)
      ? result.content
          .filter((c) => c.type === 'text' && typeof c.text === 'string')
          .map((c) => c.text)
          .join('\n')
      : '';
    if (result.isError) {
      throw new Error(
        `Parallel ${tool} failed: ${text.slice(0, 1_000) || 'Try again later.'}`,
      );
    }
    if (!text.trim())
      throw new Error(
        'Parallel returned no readable web content. Try another query or URL.',
      );
    return text.length > 24_000
      ? `${text.slice(0, 24_000)}\n[Web content truncated]`
      : text;
  } catch (error) {
    if (opts.signal?.aborted) throw opts.signal.reason;
    if (timeout.aborted) throw new Error('Web request timed out. Try again.');
    throw error;
  } finally {
    await client.close().catch(() => {});
  }
}
