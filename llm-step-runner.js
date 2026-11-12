/**
 * llm-step-runner.js — F2 (plano Video-Engine v2): steps LLM no worker.
 *
 * Corre o MESMO motor partilhado das edges (`runStep` de
 * video-v4-steps/_steps.ts, vendado tal-e-qual) com as MESMAS StepConfigs
 * (design/storyboard/visual) — paridade por construção, sem ports manuais.
 * O ganho é wall-clock/robustez (emenda H3): o polling/LLM longo corre fora
 * do idle/wall das Supabase edges, na fila `llm` (I/O-bound).
 *
 * Credenciais JUST-IN-TIME (emenda C): o payload durável só transporta o URL
 * do endpoint /build-credentials; a config LLM (incl. overrides por step) é
 * pedida no momento de executar e vive só em memória. Nunca persistida nem
 * logada.
 *
 * audio/quality têm motores próprios (TTS/ASR/VLM) e NÃO estão portados —
 * o runner recusa-os explicitamente (o orchestrator só despacha a allowlist
 * WORKER_LLM_STEP_SUPPORTED; nunca fallback silencioso).
 *
 * Node >= 22.18 (type stripping nativo dos .ts vendados, sem build step).
 */
import { runStep, createLLMClient } from './build-html/vendor/video-v4-steps/_steps.ts';
import {
  DesignOutputSchema,
  DESIGN_SYSTEM_PROMPT,
  buildDesignUserMessage,
  extractDesignArtifacts,
  extractDesignVisionUrls,
} from './build-html/vendor/video-v4-steps/designStep.ts';
import {
  StoryboardOutputSchema,
  STORYBOARD_SYSTEM_PROMPT,
  buildStoryboardUserMessage,
  extractStoryboardArtifacts,
  storyboardDurationSec,
  storyboardLanguage,
} from './build-html/vendor/video-v4-steps/storyboardStep.ts';
import {
  VisualOutputSchema,
  VISUAL_SYSTEM_PROMPT,
  buildVisualUserMessage,
  extractVisualArtifacts,
} from './build-html/vendor/video-v4-steps/visualStep.ts';
import { runAudioPipeline } from './build-html/vendor/video-v4-audio/audioPipeline.ts';
import { fetchBuildCredentials } from './build-html-runner.js';

const ARTIFACTS_BUCKET = 'video-artifacts';

/** Allowlist de runners portados (espelho do orchestrator). */
export const LLM_STEP_SUPPORTED = ['design', 'storyboard', 'audio', 'visual'];

/**
 * StepConfigs — espelho EXATO das edges (video-v4-designer/storyboarder/
 * visual index.ts). Qualquer alteração upstream entra via sync-build-modules.
 */
export function stepConfigFor(step) {
  if (step === 'design') {
    return {
      name: 'design',
      creditCost: 1,
      inputPaths: ['capture/extracted/tokens.json'],
      systemPrompt: DESIGN_SYSTEM_PROMPT,
      buildUserMessage: buildDesignUserMessage,
      buildVisionUrls: (_brief, inputs) =>
        extractDesignVisionUrls(inputs['capture/extracted/tokens.json'] ?? ''),
      outputSchema: DesignOutputSchema,
      extractArtifacts: (output) => extractDesignArtifacts(output),
    };
  }
  if (step === 'storyboard') {
    return {
      name: 'storyboard',
      creditCost: 2,
      inputPaths: ['capture/extracted/tokens.json', 'frame.md'],
      systemPrompt: STORYBOARD_SYSTEM_PROMPT,
      buildUserMessage: (brief, inputs, ctx) => buildStoryboardUserMessage(
        brief,
        inputs,
        storyboardDurationSec(ctx?.metadata),
        storyboardLanguage(ctx?.metadata),
      ),
      outputSchema: StoryboardOutputSchema,
      extractArtifacts: (output) => extractStoryboardArtifacts(output),
    };
  }
  if (step === 'visual') {
    return {
      name: 'visual',
      creditCost: 1,
      inputPaths: ['capture/extracted/tokens.json', 'STORYBOARD.md', 'frame.md', 'audio_meta.json'],
      systemPrompt: VISUAL_SYSTEM_PROMPT,
      buildUserMessage: buildVisualUserMessage,
      outputSchema: VisualOutputSchema,
      extractArtifacts: (output) => extractVisualArtifacts(output),
    };
  }
  return null;
}

/** Adapters Supabase — espelho do createStorage/createDb das edges de step. */
export function createStepAdapters(supabase) {
  const storage = {
    async readText(path) {
      const { data, error } = await supabase.storage.from(ARTIFACTS_BUCKET).download(path);
      if (error || !data) return null;
      return await data.text();
    },
    async writeText(path, content) {
      const { error } = await supabase.storage.from(ARTIFACTS_BUCKET).upload(path, new Blob([content]), { upsert: true });
      if (error) throw new Error(`storage write failed: ${error.message}`);
    },
    async list(prefix) {
      const dir = prefix.replace(/\/[^/]+$/, '');
      const { data } = await supabase.storage.from(ARTIFACTS_BUCKET).list(dir);
      return (data ?? []).map((f) => `${dir}/${f.name}`);
    },
    // F2 (áudio): binários de voz TTS + leitura para o alinhamento ASR —
    // espelho do createStorage da edge video-v4-audio.
    async writeBinary(path, bytes, contentType) {
      const { error } = await supabase.storage.from(ARTIFACTS_BUCKET).upload(path, bytes, { contentType, upsert: true });
      if (error) throw new Error(`storage binary write failed: ${error.message}`);
    },
    async readBinary(path) {
      const { data, error } = await supabase.storage.from(ARTIFACTS_BUCKET).download(path);
      if (error || !data) return null;
      const bytes = new Uint8Array(await data.arrayBuffer());
      return { bytes, mimeType: data.type || 'audio/mpeg' };
    },
  };
  const db = {
    async getProject(id) {
      const { data, error } = await supabase.from('video_projects').select('id, user_id, manifest, metadata').eq('id', id).maybeSingle();
      if (error) throw new Error(`project read failed: ${error.message}`);
      return data;
    },
    async updateManifest(id, manifest) {
      const { error } = await supabase.from('video_projects').update({ manifest, updated_at: new Date().toISOString() }).eq('id', id);
      if (error) throw new Error(`manifest update failed: ${error.message}`);
    },
    // Sem deductCredits — o orchestrator é a única fonte de débito (B4).
  };
  return { storage, db };
}

/**
 * Corre um step LLM no worker. Nunca lança: devolve sempre um resultado
 * terminal ({ok:true, step_result} | {ok:false, error}) para o callback.
 * O `step_result` espelha o StepEdgeResponse das edges (artifacts/tokens) —
 * o orchestrator aplica a mesma telemetria ao manifesto.
 */
export async function runLlmStepJob(args) {
  const { body, supabase, workerSecret } = args;
  const log = args.log ?? (() => {});
  const fetchImpl = args.fetchImpl ?? fetch;
  // Seam de teste (DI, padrão do codebase): o pipeline de áudio pode ser
  // injetado; em produção é o módulo vendado tal-e-qual.
  const audioPipelineImpl = args.audioPipelineImpl ?? runAudioPipeline;
  const projectId = body?.project_id;
  const step = body?.inputs?.step ?? body?.step;
  if (!projectId) return { ok: false, error: 'LLM_STEP_PROJECT_ID_MISSING' };
  if (!LLM_STEP_SUPPORTED.includes(step)) return { ok: false, error: `LLM_STEP_UNSUPPORTED:${step}` };
  if (!supabase) return { ok: false, error: 'LLM_STEP_STORAGE_UNAVAILABLE' };
  const credentialsUrl = body?.inputs?.credentials_url;
  if (typeof credentialsUrl !== 'string' || !credentialsUrl) {
    return { ok: false, error: 'LLM_STEP_CREDENTIALS_URL_MISSING' };
  }

  let credentials;
  try {
    credentials = await fetchBuildCredentials({ credentialsUrl, workerSecret, fetchImpl });
  } catch (err) {
    return { ok: false, error: String(err?.message ?? err).slice(0, 200) };
  }

  // Overrides por step (LLM_MODEL_<STEP> etc. resolvidos pelo orchestrator);
  // sem eles, fallback para a config base — paridade com resolveStepModel.
  const stepCfg = credentials.steps?.[step] ?? null;
  const model = stepCfg?.model || credentials.model;
  const reasoningEffort = stepCfg?.reasoning_effort || credentials.reasoningEffort || 'high';
  const maxTokens = typeof stepCfg?.max_tokens === 'number' && stepCfg.max_tokens > 0 ? stepCfg.max_tokens : undefined;

  const { storage, db } = createStepAdapters(supabase);
  let llm;
  try {
    llm = createLLMClient({
      apiUrl: credentials.url,
      apiKey: credentials.apiKey,
      model,
      reasoningEffort,
      ...(maxTokens ? { maxTokens } : {}),
      fetcher: fetchImpl,
    });
  } catch (err) {
    return { ok: false, error: `LLM_STEP_CONFIG: ${String(err?.message ?? err)}`.slice(0, 200) };
  }

  const config = stepConfigFor(step);
  const startedAt = Date.now();
  let result;
  try {
    if (step === 'audio') {
      // F2 (plano v2): pipeline COMPLETO de áudio (LLM → TTS → fit → ASR →
      // BGM) — o mesmo módulo puro que a edge video-v4-audio executa. O env
      // vem JIT do endpoint de credenciais (emenda C), nunca do payload.
      const a = credentials.audio;
      if (!a || typeof a !== 'object') {
        return { ok: false, error: 'LLM_STEP_AUDIO_ENV_MISSING' };
      }
      const audioEnv = {
        kieApiKey: typeof a.kie_api_key === 'string' ? a.kie_api_key : '',
        musicModel: typeof a.music_model === 'string' ? a.music_model : '',
        musicSunoModel: typeof a.music_suno_model === 'string' ? a.music_suno_model : '',
        ttsLangDefault: typeof a.tts_lang_default === 'string' && a.tts_lang_default ? a.tts_lang_default : 'pt',
        ttsBudgetMs: typeof a.tts_budget_ms === 'number' && a.tts_budget_ms > 0 ? a.tts_budget_ms : undefined,
        asrMode: typeof a.asr_mode === 'string' && a.asr_mode ? a.asr_mode : 'auto',
        asrProvider: typeof a.asr_provider === 'string' && a.asr_provider ? a.asr_provider : 'kie',
        asrModel: typeof a.asr_model === 'string' ? a.asr_model : '',
        asrBudgetMs: typeof a.asr_budget_ms === 'number' && a.asr_budget_ms >= 0 ? a.asr_budget_ms : 200_000,
        replicateApiToken: typeof a.replicate_api_token === 'string' ? a.replicate_api_token : '',
      };
      const payload = await audioPipelineImpl({ db, storage, llm }, projectId, audioEnv);
      const durationSeconds = Math.round((Date.now() - startedAt) / 100) / 10;
      if (payload.ok === false) {
        log(`[llm-step] job step=audio project=${projectId} failed: ${payload.error}`);
        return { ok: false, error: `LLM_STEP_FAILED:${payload.error}${payload.detail ? `: ${payload.detail}` : ''}`.slice(0, 450) };
      }
      log(`[llm-step] job step=audio project=${projectId} done (${durationSeconds}s, artifacts=${payload.artifacts.length})`);
      return {
        ok: true,
        step_result: {
          artifacts: payload.artifacts,
          tokens: payload.tokens,
          duration_seconds: typeof payload.duration_seconds === 'number' ? payload.duration_seconds : durationSeconds,
          ...(payload.timing_source ? { timing_source: payload.timing_source } : {}),
          ...(payload.caption_style ? { caption_style: payload.caption_style } : {}),
          ...(payload.needs_attention === true ? { needs_attention: true } : {}),
          ...(Array.isArray(payload.voice_fit_failures) && payload.voice_fit_failures.length > 0
            ? { voice_fit_failures: payload.voice_fit_failures } : {}),
        },
      };
    }
    result = await runStep({ db, storage, llm }, projectId, config);
  } catch (err) {
    return { ok: false, error: `LLM_STEP_FAILED: ${String(err?.message ?? err)}`.slice(0, 300) };
  }
  const durationSeconds = Math.round((Date.now() - startedAt) / 100) / 10;
  if (result.ok === false) {
    log(`[llm-step] job step=${step} project=${projectId} failed: ${result.code}`);
    return {
      ok: false,
      error: `LLM_STEP_FAILED:${result.code}${result.detail ? `: ${result.detail}` : ''}`.slice(0, 450),
    };
  }
  log(`[llm-step] job step=${step} project=${projectId} done (${durationSeconds}s, artifacts=${result.artifacts.length})`);
  return {
    ok: true,
    step_result: {
      artifacts: result.artifacts,
      tokens: result.tokens,
      duration_seconds: durationSeconds,
    },
  };
}