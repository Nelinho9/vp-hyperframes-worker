// @vitest-environment node
/**
 * llm-step-runner.test.ts — F2 (plano Video-Engine v2): o runner llm-step
 * corre o MESMO motor runStep vendado das edges (paridade por construção).
 * LLM + Supabase 100% mockados (sem rede). Cobre: happy path design,
 * overrides por step, allowlist (audio/quality recusados), credenciais JIT
 * (emenda C) e falhas honestas.
 */
import { describe, expect, it, vi } from 'vitest';
import { runLlmStepJob, stepConfigFor, LLM_STEP_SUPPORTED, createStepAdapters } from './llm-step-runner.js';

const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const CREDS_URL = 'https://orch.example/functions/v1/video-v4-orchestrator/build-credentials';
const LLM_URL = 'https://llm.internal/v1';
const LLM_KEY = 'test-llm-key-123';

const TOKENS_JSON = JSON.stringify({
  source_url: 'https://tasca.example',
  brand_name: 'Tasca do Zé',
  colors: { primary: '#112233', background: '#ffffff', text: '#111111' },
  typography: { heading_font: 'Inter', body_font: 'Inter' },
  assets: [],
});

const DESIGN_OUTPUT = {
  frame_preset: 'editorial',
  palette: { primary: '#112233', secondary: '#445566', background: '#ffffff', text: '#111111', accent: '#ff6600' },
  typography: { heading_font: 'Inter', body_font: 'Inter', heading_weight: '700' },
  frame_md: '# Frame\n\nPalette: primary #112233.\nTypography: Inter.\nLayout grid: 12 cols.\nSpacing scale: 8px base.',
  caption_skin_html: "<div class='caption-skin'><span class='caption-text' style='color:#FFFFFF;background:#0F0F14;'></span></div>",
};

function makeProject() {
  return {
    id: PROJECT_ID,
    user_id: 'user-1',
    metadata: {},
    manifest: {
      brief: 'Brand: Tasca do Zé\nAbout: Restaurante tradicional com novo menu de jantar.',
      steps: { design: { status: 'pending', artifacts: [] } },
      credits: { spent: 0, by_step: {} },
    },
  };
}

/** Supabase mock: storage em memória + video_projects (read/update). */
function makeSupabase(opts: { files?: Record<string, string>; project?: unknown } = {}) {
  const files = new Map<string, string>(Object.entries(opts.files ?? { [`projects/${PROJECT_ID}/capture/extracted/tokens.json`]: TOKENS_JSON }));
  const writes: Array<{ path: string; content: string }> = [];
  let project = opts.project ?? makeProject();
  const manifestUpdates: unknown[] = [];
  const storageApi = {
    download: vi.fn(async (path: string) => {
      const content = files.get(path);
      if (content === undefined) return { data: null, error: { message: 'not found' } };
      return { data: { text: async () => content, type: 'text/plain' }, error: null };
    }),
    upload: vi.fn(async (path: string, body: Blob) => {
      const content = await body.text();
      files.set(path, content);
      writes.push({ path, content });
      return { error: null };
    }),
    list: vi.fn(async () => ({ data: [], error: null })),
  };
  const supabase = {
    storage: { from: vi.fn(() => storageApi) },
    from: vi.fn((table: string) => {
      if (table !== 'video_projects') throw new Error(`unexpected table ${table}`);
      return {
        select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: project, error: null }) }) }),
        update: (patch: { manifest?: unknown }) => ({
          eq: async () => {
            if (patch.manifest) {
              project = { ...(project as object), manifest: patch.manifest };
              manifestUpdates.push(patch.manifest);
            }
            return { error: null };
          },
        }),
      };
    }),
  };
  return { supabase, files, writes, manifestUpdates, getProject: () => project };
}

function credentialsResponse(steps?: Record<string, unknown>) {
  return {
    llm: { url: LLM_URL, model: 'base-model', api_key: LLM_KEY, wire: 'chat', reasoning_effort: 'high' },
    ...(steps ? { steps } : {}),
  };
}

/** fetch mock: JIT credentials + chat/completions one-shot (generic kind). */
function makeFetch(opts: { creds?: unknown; llmContent?: string; llmStatus?: number; credsStatus?: number } = {}) {
  const llmCalls: Array<Record<string, unknown>> = [];
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    if (u === CREDS_URL) {
      const status = opts.credsStatus ?? 200;
      return new Response(JSON.stringify(opts.creds ?? credentialsResponse()), { status });
    }
    if (u.startsWith(LLM_URL)) {
      llmCalls.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
      const status = opts.llmStatus ?? 200;
      if (status !== 200) return new Response('provider error', { status });
      return new Response(JSON.stringify({
        choices: [{ message: { role: 'assistant', content: opts.llmContent ?? JSON.stringify(DESIGN_OUTPUT) }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 100, completion_tokens: 50 },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    throw new Error(`unexpected fetch ${u}`);
  });
  return { fetchImpl, llmCalls };
}

function jobBody(step = 'design') {
  return {
    job_id: '22222222-2222-4222-8222-222222222222',
    project_id: PROJECT_ID,
    step,
    mode: 'llm-step',
    inputs: { credentials_url: CREDS_URL, step },
  };
}

describe('runLlmStepJob — happy path (motor runStep vendado)', () => {
  it('design: artefactos escritos na Storage, manifesto done, step_result com tokens/duração', async () => {
    const { supabase, writes, getProject } = makeSupabase();
    const { fetchImpl, llmCalls } = makeFetch();
    const result = await runLlmStepJob({ body: jobBody('design'), supabase, workerSecret: 'ws', fetchImpl, log: () => {} });
    expect(result.ok).toBe(true);
    const sr = (result as { step_result: { artifacts: string[]; tokens: { input: number; output: number }; duration_seconds: number } }).step_result;
    expect(sr.artifacts).toContain('frame.md');
    expect(sr.artifacts).toContain('caption-skin.html');
    expect(sr.tokens).toEqual({ input: 100, output: 50 });
    expect(typeof sr.duration_seconds).toBe('number');
    // Artefactos gravados sob projects/{id}/ (mesmo contrato da edge).
    expect(writes.some((w) => w.path === `projects/${PROJECT_ID}/frame.md` && w.content.includes('Palette'))).toBe(true);
    expect(writes.some((w) => w.path === `projects/${PROJECT_ID}/caption-skin.html`)).toBe(true);
    // Manifesto terminado como done (runStep escreve-o, tal como na edge).
    const manifest = (getProject() as { manifest: { steps: Record<string, { status: string }> } }).manifest;
    expect(manifest.steps.design.status).toBe('done');
    // O pedido LLM usa o modelo base + system prompt do design.
    expect(llmCalls[0].model).toBe('base-model');
    expect(String((llmCalls[0].messages as Array<{ content: string }>)[0].content)).toContain('design director');
  });

  it('overrides por step (LLM_MODEL_<STEP>) vencem o modelo base', async () => {
    const { supabase } = makeSupabase();
    const { fetchImpl, llmCalls } = makeFetch({
      creds: credentialsResponse({ design: { model: 'design-model-x', max_tokens: 4096, reasoning_effort: 'medium' } }),
    });
    const result = await runLlmStepJob({ body: jobBody('design'), supabase, workerSecret: 'ws', fetchImpl, log: () => {} });
    expect(result.ok).toBe(true);
    expect(llmCalls[0].model).toBe('design-model-x');
    expect(llmCalls[0].max_tokens).toBe(4096);
  });

  it('storyboard e visual têm configs espelho das edges; audio usa o pipeline próprio', () => {
    expect(LLM_STEP_SUPPORTED).toEqual(['design', 'storyboard', 'audio', 'visual']);
    const sb = stepConfigFor('storyboard');
    expect(sb?.inputPaths).toEqual(['capture/extracted/tokens.json', 'frame.md']);
    const vs = stepConfigFor('visual');
    expect(vs?.inputPaths).toEqual(['capture/extracted/tokens.json', 'STORYBOARD.md', 'frame.md', 'audio_meta.json']);
    expect(stepConfigFor('audio')).toBeNull(); // runAudioPipeline, não runStep
    expect(stepConfigFor('quality')).toBeNull();
  });
});

describe('runLlmStepJob — guardas e falhas honestas', () => {
  it('quality/build (não portados) → LLM_STEP_UNSUPPORTED, sem rede', async () => {
    const { supabase } = makeSupabase();
    const { fetchImpl } = makeFetch();
    for (const step of ['quality', 'build']) {
      const result = await runLlmStepJob({ body: jobBody(step), supabase, workerSecret: 'ws', fetchImpl, log: () => {} });
      expect(result.ok).toBe(false);
      expect((result as { error: string }).error).toBe(`LLM_STEP_UNSUPPORTED:${step}`);
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('sem credentials_url / sem supabase / sem project_id → erros nomeados', async () => {
    const { supabase } = makeSupabase();
    const { fetchImpl } = makeFetch();
    const noUrl = jobBody();
    delete (noUrl.inputs as Record<string, unknown>).credentials_url;
    expect((await runLlmStepJob({ body: noUrl, supabase, workerSecret: 'ws', fetchImpl })).ok).toBe(false);
    expect((await runLlmStepJob({ body: jobBody(), supabase: null, workerSecret: 'ws', fetchImpl })).ok).toBe(false);
    expect((await runLlmStepJob({ body: { ...jobBody(), project_id: '' }, supabase, workerSecret: 'ws', fetchImpl })).ok).toBe(false);
  });

  it('falha JIT (401) → erro nomeado, sem chamada LLM', async () => {
    const { supabase } = makeSupabase();
    const { fetchImpl, llmCalls } = makeFetch({ credsStatus: 401 });
    const result = await runLlmStepJob({ body: jobBody(), supabase, workerSecret: 'ws', fetchImpl, log: () => {} });
    expect(result.ok).toBe(false);
    expect((result as { error: string }).error).toContain('BUILD_CREDENTIALS_HTTP_401');
    expect(llmCalls.length).toBe(0);
  });

  it('LLM 5xx persistente → step failed no manifesto + erro LLM_STEP_FAILED', async () => {
    const { supabase, getProject } = makeSupabase();
    const { fetchImpl } = makeFetch({ llmStatus: 503 });
    const result = await runLlmStepJob({ body: jobBody(), supabase, workerSecret: 'ws', fetchImpl, log: () => {} });
    expect(result.ok).toBe(false);
    expect((result as { error: string }).error).toContain('LLM_STEP_FAILED');
    const manifest = (getProject() as { manifest: { steps: Record<string, { status: string }> } }).manifest;
    expect(manifest.steps.design.status).toBe('failed');
  });

  it('brief sem substância → BRIEF_SUBSTANCE_MISSING sem chamada LLM (gate F13)', async () => {
    const project = makeProject();
    (project.manifest as { brief: string }).brief = 'curto';
    const { supabase } = makeSupabase({ project, files: {} });
    const { fetchImpl, llmCalls } = makeFetch();
    const result = await runLlmStepJob({ body: jobBody(), supabase, workerSecret: 'ws', fetchImpl, log: () => {} });
    expect(result.ok).toBe(false);
    expect((result as { error: string }).error).toContain('BRIEF_SUBSTANCE_MISSING');
    expect(llmCalls.length).toBe(0);
  });
});

describe('runLlmStepJob — áudio (pipeline vendado, env JIT)', () => {
  const AUDIO_ENV_BLOCK = {
    kie_api_key: 'kie-key-123',
    music_model: 'suno/v4',
    music_suno_model: 'v4',
    tts_lang_default: 'pt',
    tts_budget_ms: 90_000,
    asr_mode: 'auto',
    asr_provider: 'kie',
    asr_model: '',
    asr_budget_ms: 200_000,
    replicate_api_token: '',
  };
  // Seam DI: o wiring (env JIT → pipeline → step_result) é testado com o
  // pipeline injetado; o pipeline real tem cobertura na suite de áudio.
  const pipelineOk = () => vi.fn(async () => ({
    ok: true,
    artifacts: ['audio_meta.json', 'projects/p/audio/vo-1.wav'],
    tokens: { input: 11, output: 22 },
    duration_seconds: 20,
    timing_source: 'acoustic',
    caption_style: 'hormozi',
  }));

  it('mapeia o env JIT para o pipeline e transporta a telemetria no step_result', async () => {
    const { supabase } = makeSupabase();
    const { fetchImpl } = makeFetch({ creds: { ...credentialsResponse(), audio: AUDIO_ENV_BLOCK } });
    const audioPipelineImpl = pipelineOk();
    const result = await runLlmStepJob({ body: jobBody('audio'), supabase, workerSecret: 'ws', fetchImpl, audioPipelineImpl, log: () => {} });
    expect(result.ok).toBe(true);
    expect(audioPipelineImpl).toHaveBeenCalledTimes(1);
    const [deps, projectId, env] = audioPipelineImpl.mock.calls[0];
    expect(projectId).toBe(PROJECT_ID);
    expect(env).toMatchObject({
      kieApiKey: 'kie-key-123', musicModel: 'suno/v4', ttsLangDefault: 'pt',
      ttsBudgetMs: 90_000, asrMode: 'auto', asrProvider: 'kie', asrBudgetMs: 200_000,
    });
    expect(typeof deps.storage.readBinary).toBe('function');
    expect(typeof deps.storage.writeBinary).toBe('function');
    const sr = (result as { step_result: Record<string, unknown> }).step_result;
    expect(sr.artifacts).toContain('audio_meta.json');
    expect(sr.timing_source).toBe('acoustic');
    expect(sr.caption_style).toBe('hormozi');
    expect(sr.duration_seconds).toBe(20);
  });

  it('sem bloco audio nas credenciais → LLM_STEP_AUDIO_ENV_MISSING (nunca env inventado)', async () => {
    const { supabase } = makeSupabase();
    const { fetchImpl } = makeFetch();
    const result = await runLlmStepJob({ body: jobBody('audio'), supabase, workerSecret: 'ws', fetchImpl, log: () => {} });
    expect(result.ok).toBe(false);
    expect((result as { error: string }).error).toBe('LLM_STEP_AUDIO_ENV_MISSING');
  });

  it('falha do pipeline → LLM_STEP_FAILED com o código fiel', async () => {
    const audioPipelineImpl = vi.fn(async () => ({ ok: false, error: 'TTS_ALL_SEGMENTS_FAILED', detail: '0/3' }));
    const { supabase } = makeSupabase();
    const { fetchImpl } = makeFetch({ creds: { ...credentialsResponse(), audio: AUDIO_ENV_BLOCK } });
    const result = await runLlmStepJob({ body: jobBody('audio'), supabase, workerSecret: 'ws', fetchImpl, audioPipelineImpl, log: () => {} });
    expect(result.ok).toBe(false);
    expect((result as { error: string }).error).toContain('TTS_ALL_SEGMENTS_FAILED');
  });
});

describe('createStepAdapters — sem débito (B4)', () => {
  it('o adapter db não expõe deductCredits (orchestrator é a única fonte)', () => {
    const { supabase } = makeSupabase();
    const { db } = createStepAdapters(supabase);
    expect((db as Record<string, unknown>).deductCredits).toBeUndefined();
  });
});