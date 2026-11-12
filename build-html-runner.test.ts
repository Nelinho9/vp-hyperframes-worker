/**
 * build-html-runner.test.ts — F1 (plano Video-Engine v2): build HTML no worker.
 * Cobre o contrato JIT de credenciais (emenda C), os dois wire contracts do
 * cliente LLM, e o loop completo com módulos vendados (LLM mockado).
 */
import { describe, expect, it, vi } from 'vitest';
import {
  BUILD_LLM_TIMEOUT_MS,
  buildHtmlStoragePath,
  createWorkerLlmClient,
  fetchBuildCredentials,
  runBuildHtmlJob,
} from './build-html-runner.js';
import { buildStoryboardFallbackHtml } from './build-html/vendor/video-v4-steps/buildStep.ts';

const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const CREDS_URL = 'https://orch.example/functions/v1/video-v4-orchestrator/build-credentials';
const API_KEY = 'test-llm-key-123';

function credsResponse(overrides: Record<string, unknown> = {}) {
  return {
    llm: {
      url: 'https://api.kie.ai/codex/v1',
      model: 'gpt-5-6-luna',
      api_key: API_KEY,
      wire: 'responses',
      reasoning_effort: 'high',
      ...overrides,
    },
  };
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** Supabase mock: storage (download/upload/sign/list) + tabelas de vínculo. */
function makeSupabaseMock(files: Map<string, string>) {
  const uploads: Array<{ bucket: string; path: string; content: unknown }> = [];
  const storage = {
    download: vi.fn(async (path: string) => ({ data: files.has(path) ? { text: async () => files.get(path)! } : null, error: null })),
    upload: vi.fn(async (path: string, content: unknown) => {
      uploads.push({ bucket: 'video-artifacts', path, content });
      files.set(path, String(content));
      return { error: null };
    }),
    createSignedUrl: vi.fn(async (path: string) => ({ data: { signedUrl: `https://storage.example/sign/${path}?token=t` }, error: null })),
    list: vi.fn(async () => ({ data: [], error: null })),
  };
  const from = vi.fn((name: string) => {
    if (name === 'video-artifacts' || name === 'video-screenshots' || name === 'video-assets') {
      return { ...storage, from: undefined };
    }
    // Tabelas (video_captures / video_projects): sem vínculo nos testes base.
    const chain: Record<string, unknown> = {};
    for (const m of ['select', 'eq', 'order', 'limit']) chain[m] = vi.fn(() => chain);
    chain.maybeSingle = vi.fn(async () => ({ data: null, error: null }));
    return chain;
  });
  return { supabase: { storage: { from: (bucket: string) => ({ ...storage }) }, from }, uploads, files };
}

function makeFetch(opts: {
  creds?: unknown;
  credsStatus?: number;
  llmContent?: string;
  llmWire?: 'responses' | 'chat';
  llmStatus?: number;
}) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const impl = vi.fn(async (url: string | URL, init?: RequestInit): Promise<Response> => {
    const u = String(url);
    calls.push({ url: u, init });
    if (u.includes('build-credentials')) {
      return jsonResponse(opts.creds ?? credsResponse(), opts.credsStatus ?? 200);
    }
    if (u.includes('/responses') || u.includes('/chat/completions')) {
      if ((opts.llmStatus ?? 200) !== 200) return jsonResponse({ error: 'boom' }, opts.llmStatus);
      const content = opts.llmContent ?? '';
      return opts.llmWire === 'chat'
        ? jsonResponse({ choices: [{ message: { content } }], usage: { prompt_tokens: 100, completion_tokens: 50 } })
        : jsonResponse({
            output: [{ type: 'message', content: [{ type: 'output_text', text: content }] }],
            usage: { input_tokens: 100, output_tokens: 50 },
          });
    }
    return jsonResponse({ error: 'no route' }, 404);
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const STORYBOARD = '## Frame 1: Hook (0-3s)\nOne\n## Frame 2: CTA (3-6s)\nTwo';

function baseFiles() {
  return new Map<string, string>([
    [`projects/${PROJECT_ID}/STORYBOARD.md`, STORYBOARD],
    [`projects/${PROJECT_ID}/frame.md`, '# Design spec'],
    [`projects/${PROJECT_ID}/audio_meta.json`, '{}'],
  ]);
}

function baseBody(inputs: Record<string, unknown> = {}) {
  return {
    job_id: '22222222-2222-4222-8222-222222222222',
    project_id: PROJECT_ID,
    step: 'build',
    mode: 'build-html',
    inputs: { credentials_url: CREDS_URL, brief: 'Video brief', aspect_ratio: '9:16', ...inputs },
  };
}

// ─── fetchBuildCredentials (emenda C: JIT, nunca no payload) ───────────────

describe('fetchBuildCredentials', () => {
  it('POST autenticado devolve config LLM em memória', async () => {
    const { impl, calls } = makeFetch({});
    const creds = await fetchBuildCredentials({ credentialsUrl: CREDS_URL, workerSecret: 'ws', fetchImpl: impl });
    expect(creds.apiKey).toBe(API_KEY);
    expect(creds.wire).toBe('responses');
    expect(calls).toHaveLength(1);
    expect((calls[0].init?.headers as Record<string, string>)['x-worker-secret']).toBe('ws');
  });

  it('recusa URL não-https e secret em falta', async () => {
    const { impl } = makeFetch({});
    await expect(fetchBuildCredentials({ credentialsUrl: 'http://orch.example/x', workerSecret: 'ws', fetchImpl: impl }))
      .rejects.toThrow('BUILD_CREDENTIALS_URL_INVALID');
    await expect(fetchBuildCredentials({ credentialsUrl: CREDS_URL, workerSecret: '', fetchImpl: impl }))
      .rejects.toThrow('BUILD_CREDENTIALS_SECRET_MISSING');
  });

  it('HTTP não-ok e corpo malformado falham com erros nomeados', async () => {
    const bad = makeFetch({ credsStatus: 401 });
    await expect(fetchBuildCredentials({ credentialsUrl: CREDS_URL, workerSecret: 'ws', fetchImpl: bad.impl }))
      .rejects.toThrow('BUILD_CREDENTIALS_HTTP_401');
    const malformed = makeFetch({ creds: { llm: { url: 'x' } } });
    await expect(fetchBuildCredentials({ credentialsUrl: CREDS_URL, workerSecret: 'ws', fetchImpl: malformed.impl }))
      .rejects.toThrow('BUILD_CREDENTIALS_MALFORMED');
  });
});

// ─── createWorkerLlmClient ─────────────────────────────────────────────────

describe('createWorkerLlmClient', () => {
  const config = { url: 'https://api.kie.ai/codex/v1', model: 'gpt-5-6-luna', apiKey: API_KEY, wire: 'responses' as const, reasoningEffort: 'high' };

  it('wire responses: input_text + reasoning.effort, SEM response_format', async () => {
    const { impl, calls } = makeFetch({ llmContent: '<html>ok</html>' });
    const client = createWorkerLlmClient(config, { fetchImpl: impl });
    const result = await client.call([{ role: 'system', content: 's' }, { role: 'user', content: 'u' }]);
    expect(result.content).toBe('<html>ok</html>');
    expect(result.tokens).toEqual({ input: 100, output: 50 });
    expect(calls[0].url).toBe('https://api.kie.ai/codex/v1/responses');
    const body = JSON.parse(String(calls[0].init?.body));
    expect(body.input[1]).toEqual({ role: 'user', content: [{ type: 'input_text', text: 'u' }] });
    expect(body.reasoning).toEqual({ effort: 'high' });
    expect(body.response_format).toBeUndefined();
    expect((calls[0].init?.headers as Record<string, string>).Authorization).toBe(`Bearer ${API_KEY}`);
  });

  it('wire chat: messages + choices/usage (OpenRouter-compat)', async () => {
    const { impl, calls } = makeFetch({ llmContent: '<html>chat</html>', llmWire: 'chat' });
    const client = createWorkerLlmClient(
      { url: 'https://openrouter.ai/api/v1', model: 'autor/slug', apiKey: API_KEY, wire: 'chat', reasoningEffort: 'high' },
      { fetchImpl: impl },
    );
    const result = await client.call([{ role: 'user', content: 'u' }]);
    expect(result.content).toBe('<html>chat</html>');
    expect(calls[0].url).toBe('https://openrouter.ai/api/v1/chat/completions');
    const body = JSON.parse(String(calls[0].init?.body));
    expect(body.messages).toEqual([{ role: 'user', content: 'u' }]);
    expect(body.reasoning).toEqual({ effort: 'high' });
    expect(body.response_format).toBeUndefined();
  });

  it('conteúdo vazio e erro de aplicação kie (code!=200) falham honesto', async () => {
    const empty = makeFetch({ llmContent: '   ' });
    const client = createWorkerLlmClient(config, { fetchImpl: empty.impl, sleep: async () => {} });
    await expect(client.call([{ role: 'user', content: 'u' }])).rejects.toThrow('BUILD_LLM_EMPTY_CONTENT');

    const providerErr = vi.fn(async () => jsonResponse({ code: 429, msg: 'rate limited' })) as unknown as typeof fetch;
    const client2 = createWorkerLlmClient(config, { fetchImpl: providerErr, sleep: async () => {} });
    await expect(client2.call([{ role: 'user', content: 'u' }])).rejects.toThrow('BUILD_LLM_PROVIDER_429');
  });

  it('transientes 524/5xx são absorvidos com backoff (emenda E: retry budget no job)', async () => {
    let n = 0;
    const impl = vi.fn(async () => {
      n += 1;
      if (n <= 2) return new Response('origin timeout', { status: 524 });
      return jsonResponse({ output: [{ type: 'message', content: [{ type: 'output_text', text: '<html>ok</html>' }] }], usage: { input_tokens: 10, output_tokens: 5 } });
    }) as unknown as typeof fetch;
    const delays: number[] = [];
    const client = createWorkerLlmClient(config, { fetchImpl: impl, sleep: async (ms: number) => { delays.push(ms); } });
    const result = await client.call([{ role: 'user', content: 'u' }]);
    expect(result.content).toBe('<html>ok</html>');
    expect(n).toBe(3);
    expect(delays).toEqual([5_000, 15_000]);
  });

  it('transiente persistente esgota as tentativas e falha nomeado; 4xx permanente falha já', async () => {
    let n = 0;
    const impl = vi.fn(async () => { n += 1; return new Response('down', { status: 503 }); }) as unknown as typeof fetch;
    const client = createWorkerLlmClient(config, { fetchImpl: impl, sleep: async () => {} });
    await expect(client.call([{ role: 'user', content: 'u' }])).rejects.toThrow('BUILD_LLM_HTTP_503');
    expect(n).toBe(3);

    let perm = 0;
    const impl401 = vi.fn(async () => { perm += 1; return new Response('unauthorized', { status: 401 }); }) as unknown as typeof fetch;
    const client2 = createWorkerLlmClient(config, { fetchImpl: impl401, sleep: async () => {} });
    await expect(client2.call([{ role: 'user', content: 'u' }])).rejects.toThrow('BUILD_LLM_HTTP_401');
    expect(perm).toBe(1);
  });

  it('orçamento de timeout por omissão = 360s (paridade com o builder edge)', () => {
    expect(BUILD_LLM_TIMEOUT_MS).toBe(360_000);
  });
});

// ─── runBuildHtmlJob (loop completo, módulos vendados) ─────────────────────

describe('runBuildHtmlJob', () => {
  it('sucesso: LLM → lint → grava build-input.html + sha256; resultado SEM credenciais', async () => {
    const validHtml = buildStoryboardFallbackHtml(STORYBOARD, '9:16');
    const { supabase, uploads } = makeSupabaseMock(baseFiles());
    const { impl, calls } = makeFetch({ llmContent: validHtml });
    const result = await runBuildHtmlJob({
      body: baseBody(), supabase, workerOrigin: 'https://worker.example', workerSecret: 'ws', fetchImpl: impl,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.html_path).toBe(buildHtmlStoragePath(PROJECT_ID));
      expect(result.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(result.fallback).toBe(false);
      expect(result.tokens).toEqual({ input: 100, output: 50 });
      expect(JSON.stringify(result)).not.toContain(API_KEY);
    }
    expect(uploads.some((u) => u.path === buildHtmlStoragePath(PROJECT_ID))).toBe(true);
    // Credenciais pedidas JIT (1 chamada) — nunca estiveram no payload.
    expect(calls.filter((c) => c.url.includes('build-credentials'))).toHaveLength(1);
    expect(JSON.stringify(baseBody())).not.toContain(API_KEY);
  });

  it('LLM sempre inválido → esgota retries → fallback de storyboard (fallback:true)', async () => {
    const { supabase } = makeSupabaseMock(baseFiles());
    const { impl, calls } = makeFetch({ llmContent: '<div>not a composition</div>' });
    const result = await runBuildHtmlJob({
      body: baseBody(), supabase, workerOrigin: 'https://worker.example', workerSecret: 'ws', fetchImpl: impl,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.fallback).toBe(true);
      expect(result.fallback_reason).toBe('BUILD_LINT_FAILED');
      expect(result.retries).toBeGreaterThan(0);
    }
    // 1 geração + MAX_BUILD_RETRIES correções = 4 chamadas LLM (loop no worker).
    expect(calls.filter((c) => c.url.includes('/responses'))).toHaveLength(4);
  });

  it('sem supabase / sem credentials_url → falha nomeada, zero chamadas', async () => {
    const { impl, calls } = makeFetch({});
    const noStorage = await runBuildHtmlJob({ body: baseBody(), supabase: null, workerSecret: 'ws', fetchImpl: impl });
    expect(noStorage).toEqual({ ok: false, error: 'BUILD_STORAGE_UNAVAILABLE' });
    const { supabase } = makeSupabaseMock(baseFiles());
    const noUrl = await runBuildHtmlJob({ body: baseBody({ credentials_url: undefined }), supabase, workerSecret: 'ws', fetchImpl: impl });
    expect(noUrl.ok).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it('falha de credenciais → erro nomeado sem eco do corpo', async () => {
    const { supabase } = makeSupabaseMock(baseFiles());
    const { impl } = makeFetch({ credsStatus: 503 });
    const result = await runBuildHtmlJob({ body: baseBody(), supabase, workerSecret: 'ws', fetchImpl: impl });
    expect(result).toEqual({ ok: false, error: 'BUILD_CREDENTIALS_HTTP_503' });
  });
});