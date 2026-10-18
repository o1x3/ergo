import { describe, expect, test } from 'bun:test';

import { completeChatTurn } from '@/chat/turn';
import { parseWebCommand, SEARCH_MCP_URL, type WebOptions } from '@/chat/web';
import { type ErgoConfig, resolveConfig } from '@/config/schema';
import type { CompletionRequest } from '@/inference/types';
import { VERSION } from '@/version';

type SeenRequest = {
  url: string;
  headers: Headers;
  body: Record<string, unknown>;
};

// A scripted MCP peer, exercised through the real SDK HTTP transport. The
// model is scripted separately; these tests do not claim live inference.
function peer(mode = 'ok') {
  const seen: SeenRequest[] = [];
  const fetchImpl: NonNullable<WebOptions['fetchImpl']> = async (url, init) => {
    if (init?.method === 'GET') return new Response(null, { status: 405 });
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    seen.push({ url: String(url), headers: new Headers(init?.headers), body });
    if (body.method === 'notifications/initialized')
      return new Response(null, { status: 202 });
    if (mode === 'hang') {
      return new Promise<Response>((_, reject) => {
        const signal = init?.signal;
        if (signal?.aborted) reject(signal.reason);
        else
          signal?.addEventListener('abort', () => reject(signal.reason), {
            once: true,
          });
      });
    }
    let result: unknown;
    if (body.method === 'initialize') {
      result = {
        protocolVersion: '2025-03-26',
        capabilities: { tools: {} },
        serverInfo: { name: 'scripted-peer', version: '1' },
      };
    } else if (body.method === 'tools/list') {
      result = {
        tools:
          mode === 'missing'
            ? []
            : ['web_search', 'web_fetch'].map((name) => ({
                name,
                inputSchema: { type: 'object' },
              })),
      };
    } else if (body.method === 'tools/call') {
      if (mode === 'http-error')
        return new Response('Unavailable', { status: 503 });
      if (mode === 'malformed')
        return new Response('not JSON', {
          headers: { 'Content-Type': 'application/json' },
        });
      const text = JSON.stringify({
        results: [
          {
            title: 'Bun documentation',
            url: 'https://bun.sh/docs',
            excerpts: ['Bun supports TypeScript.'],
          },
        ],
      });
      result = {
        content:
          mode === 'empty'
            ? []
            : [
                {
                  type: 'text',
                  text: mode === 'error' ? 'Rate limit reached' : text,
                },
              ],
        isError: mode === 'error',
      };
    } else {
      throw new Error(`Unexpected method: ${body.method}`);
    }
    return new Response(
      JSON.stringify({ jsonrpc: '2.0', id: body.id, result }),
      { headers: { 'Content-Type': 'application/json' } },
    );
  };
  return { seen, fetchImpl };
}

function turn(raw: ErgoConfig = {}, mode = 'ok') {
  const server = peer(mode);
  const calls: CompletionRequest[] = [];
  const opts = {
    input: '/search Bun TypeScript documentation',
    system: 'PRIVATE_DIFF stays at the selected model',
    history: [
      { role: 'user' as const, content: 'PRIVATE_HISTORY' },
      { role: 'assistant' as const, content: 'Earlier reply' },
    ],
    resolved: {
      model: 'saved-model',
      provider: 'openai-compatible' as const,
      subscription: false,
      client: {
        provider: 'openai-compatible' as const,
        async complete(req: CompletionRequest) {
          calls.push(req);
          return {
            text: 'Bun supports TypeScript: https://bun.sh/docs',
            finishReason: 'stop',
          };
        },
      },
    },
    config: resolveConfig(raw),
    web: {
      sessionId: 'ergo-test-conversation-unchanged-id',
      model: 'saved-model',
      fetchImpl: server.fetchImpl,
    },
  };
  return { opts, calls, ...server };
}

describe('chat web commands', () => {
  test('fresh config dispatches anonymous search and consumes sources in the selected model', async () => {
    const t = turn();
    const previous = process.env.PARALLEL_API_KEY;
    process.env.PARALLEL_API_KEY = 'ambient-key-must-not-be-sent';
    const output: string[] = [];
    try {
      const answer = await completeChatTurn({
        ...t.opts,
        onTextDelta: (d) => output.push(d),
      });
      expect(answer).toContain('https://bun.sh/docs');
      expect(output.join('')).toBe(answer);
    } finally {
      if (previous === undefined) delete process.env.PARALLEL_API_KEY;
      else process.env.PARALLEL_API_KEY = previous;
    }
    const call = t.seen.find((r) => r.body.method === 'tools/call');
    expect(call?.body.params).toEqual({
      name: 'web_search',
      arguments: {
        objective: 'Bun TypeScript documentation',
        search_queries: ['Bun TypeScript documentation'],
        session_id: t.opts.web.sessionId,
        model_name: 'saved-model',
      },
    });
    expect(t.seen.some((r) => r.body.method === 'tools/list')).toBe(true);
    for (const r of t.seen) {
      expect(r.url).toBe(SEARCH_MCP_URL);
      expect(r.headers.get('User-Agent')).toBe(`ergo/${VERSION}`);
      expect(r.headers.has('Authorization')).toBe(false);
      expect(JSON.stringify(r.body)).not.toMatch(
        /PRIVATE_DIFF|PRIVATE_HISTORY|ambient-key/,
      );
    }
    expect(t.calls).toHaveLength(1);
    expect(t.calls[0]?.model).toBe('saved-model');
    expect(t.calls[0]?.system).toBe(t.opts.system);
    expect(t.calls[0]?.messages.at(-1)?.content).toContain(
      'https://bun.sh/docs',
    );
    expect(t.calls[0]?.messages.at(-1)?.content).toContain('untrusted data');
    expect(t.opts.history.at(-1)?.role).toBe('assistant');
    expect(t.opts.history.at(-1)?.content).toContain('https://bun.sh/docs');
  });

  test('fetch uses only the explicit URL and shares the conversation identity with search', async () => {
    const t = turn();
    await completeChatTurn(t.opts);
    await completeChatTurn({
      ...t.opts,
      input: '/fetch https://bun.sh/docs?topic=typescript',
    });
    const calls = t.seen.filter((r) => r.body.method === 'tools/call');
    expect(calls[1]?.body.params).toEqual({
      name: 'web_fetch',
      arguments: {
        urls: ['https://bun.sh/docs?topic=typescript'],
        session_id: t.opts.web.sessionId,
        model_name: 'saved-model',
      },
    });
    expect(t.calls[1]?.messages.at(-1)?.content).toContain(
      'https://bun.sh/docs',
    );
    for (const r of t.seen) {
      expect(r.url).toBe(SEARCH_MCP_URL);
      expect(r.headers.get('User-Agent')).toBe(`ergo/${VERSION}`);
    }
  });

  test('normal chat preserves the model and history without contacting MCP', async () => {
    const t = turn();
    await completeChatTurn({ ...t.opts, input: 'Explain my diff' });
    expect(t.seen).toHaveLength(0);
    expect(t.calls[0]?.messages.at(-1)).toEqual({
      role: 'user',
      content: 'Explain my diff',
    });
    expect(t.opts.history).toHaveLength(4);
  });

  test('streams model text once and saves the assembled answer', async () => {
    const t = turn();
    t.opts.resolved.client.complete = async (req) => {
      req.onTextDelta?.('A streamed ');
      req.onTextDelta?.('reply');
      return { text: 'A streamed reply', finishReason: 'stop' };
    };
    const deltas: string[] = [];
    expect(
      await completeChatTurn({
        ...t.opts,
        input: 'Explain the diff',
        onTextDelta: (d) => deltas.push(d),
      }),
    ).toBe('A streamed reply');
    expect(deltas).toEqual(['A streamed ', 'reply']);
    expect(t.opts.history.at(-1)?.content).toBe('A streamed reply');
    expect(t.seen).toHaveLength(0);
  });

  for (const config of [
    { knowledge_base: { opt_out: true } },
    { knowledge_base: { web_search: { enabled: false } } },
  ]) {
    test(`honors saved opt-out ${JSON.stringify(config)}`, async () => {
      const t = turn(config);
      for (const input of [
        '/search public docs',
        '/fetch https://bun.sh/docs',
      ]) {
        await expect(completeChatTurn({ ...t.opts, input })).rejects.toThrow(
          'Web access is disabled',
        );
      }
      expect(t.seen).toHaveLength(0);
      expect(t.calls).toHaveLength(0);
      expect(t.opts.history).toHaveLength(2);
    });
  }

  test('explicit enable and model override use the requested model without changing provider', async () => {
    const t = turn({ knowledge_base: { web_search: { enabled: true } } });
    t.opts.resolved.model = 'override-model';
    await completeChatTurn(t.opts);
    expect(t.calls[0]?.model).toBe('override-model');
    expect(t.seen.at(-1)?.body.params).toMatchObject({
      arguments: { model_name: 'override-model' },
    });
    expect(t.opts.resolved.provider).toBe('openai-compatible');
  });

  for (const mode of ['missing', 'empty', 'error', 'http-error', 'malformed']) {
    test(`surfaces ${mode} without fallback or adding history`, async () => {
      const t = turn({}, mode);
      await expect(completeChatTurn(t.opts)).rejects.toThrow();
      expect(t.calls).toHaveLength(0);
      expect(t.opts.history).toHaveLength(2);
      expect(
        t.seen.filter((r) => r.body.method === 'tools/call').length,
      ).toBeLessThanOrEqual(1);
    });
  }

  test('bounds the full MCP operation and leaves history intact on timeout', async () => {
    const t = turn({}, 'hang');
    await expect(
      completeChatTurn({ ...t.opts, web: { ...t.opts.web, timeoutMs: 10 } }),
    ).rejects.toThrow('timed out');
    expect(t.calls).toHaveLength(0);
    expect(t.opts.history).toHaveLength(2);
  });

  test('Ctrl+C signal cancels an in-flight MCP request and preserves history', async () => {
    const t = turn({}, 'hang');
    const controller = new AbortController();
    const response = completeChatTurn({ ...t.opts, signal: controller.signal });
    controller.abort();
    await expect(response).rejects.toThrow();
    expect(t.calls).toHaveLength(0);
    expect(t.opts.history).toHaveLength(2);
  });

  test('an already cancelled request never connects', async () => {
    const t = turn();
    await expect(
      completeChatTurn({ ...t.opts, signal: AbortSignal.abort() }),
    ).rejects.toThrow();
    expect(t.seen).toHaveLength(0);
  });

  test('model failure does not add the query or retrieved pages to history', async () => {
    const t = turn();
    t.opts.resolved.client.complete = async () => {
      throw new Error('model unavailable');
    };
    await expect(completeChatTurn(t.opts)).rejects.toThrow('model unavailable');
    expect(t.opts.history).toHaveLength(2);
  });

  test('validates command boundaries, empty arguments and URL schemes before networking', () => {
    expect(parseWebCommand('/searching is a normal message')).toBeUndefined();
    expect(parseWebCommand('/search\tBun docs')).toEqual({
      kind: 'search',
      query: 'Bun docs',
    });
    for (const input of [
      '/search',
      '/fetch',
      '/fetch not-a-url',
      '/fetch file:///etc/passwd',
      '/fetch https://user:secret@example.com',
    ]) {
      expect(() => parseWebCommand(input)).toThrow();
    }
  });
});
