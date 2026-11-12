/**
 * audioPipeline.ts — F2 (plano Video-Engine v2): o pipeline COMPLETO do step
 * de áudio (LLM → TTS → fit → ASR → BGM → telemetria) como módulo puro com
 * DI/env injetado. A edge `video-v4-audio` e o runner `llm-step` do worker
 * chamam EXATAMENTE este módulo — paridade por construção, sem ports manuais.
 *
 * Extração behavior-preserving do index.ts (2026-11-12): o corpo do task,
 * materializeProjectVoice, makeTtsIo, liteSegments, resolveAsr e audioConfig
 * viviam no index; agora vivem aqui com o env parametrizado (antes Deno.env).
 * O caminho regenerate_segment (E02) continua no index e reutiliza os mesmos
 * helpers exportados.
 */
import {
  runStep,
  type LLMClient,
  type StepConfig,
  type StepDbAdapter,
  type StorageAdapter,
} from '../video-v4-steps/_steps.ts';
import {
  AudioOutputSchema,
  AUDIO_SYSTEM_PROMPT,
  buildAudioUserMessage,
  extractAudioArtifacts,
  type AudioOutput,
  type BgmMeta,
} from '../video-v4-steps/audioStep.ts';
import { resolveProjectAudioSettings, type ProjectAudioSettings } from './settings.ts';
import {
  DEFAULT_TTS_BUDGET_MS,
  materializeVoiceFiles,
  synthesizeSegment,
  type NarrationSegmentLite,
  type TtsIo,
  type VoiceFileEntry,
  voiceMaterializationFailure,
} from './tts.ts';
import { materializeProjectMusic } from './music.ts';
import { charsPerSecForLang, extractSpokenText, fitVoiceFilesToWindows, voiceRewritePrompt, type FitWindow } from './voiceFit.ts';
import { mergeAcousticAlignment } from './acoustic.ts';
import {
  ACOUSTIC_ADAPTER_ID,
  ACOUSTIC_DEFAULT_MODEL,
  createKieAsrTranscriber,
  createReplicateAsrTranscriber,
  KIE_ASR_ADAPTER_ID,
  KIE_ASR_DEFAULT_MODEL,
  type AsrTranscriber,
} from '../video-v4-steps/acousticAligner.ts';

/** Env do pipeline (antes leituras diretas de Deno.env no index). */
export interface AudioPipelineEnv {
  kieApiKey: string;
  musicModel: string;
  musicSunoModel: string;
  ttsLangDefault: string;
  /** V4_TTS_BUDGET_MS (0/undefined = default do módulo tts). */
  ttsBudgetMs?: number;
  /** V4_ASR_ALIGNMENT: off|auto (default auto). */
  asrMode: string;
  /** V4_ASR_PROVIDER: kie|replicate (default kie). */
  asrProvider: string;
  /** V4_ASR_MODEL (vazio = default do provider). */
  asrModel: string;
  /** V4_ASR_BUDGET_MS (default 200s — janela própria do alinhamento). */
  asrBudgetMs: number;
  replicateApiToken: string;
}

export const DEFAULT_ASR_BUDGET_MS = 200_000;

/**
 * C04.1: adapter ASR real. `off` desliga; `auto` liga quando existe a key do
 * provider; sem key degrada honestamente a `estimated`. Devolve o transcriber
 * E o identificador honesto do adapter (kie.ai por omissão, Replicate
 * fallback). Nunca inventa proveniência.
 */
export function resolveAsrFromEnv(env: AudioPipelineEnv, log: (msg: string) => void = () => {}): { transcriber: AsrTranscriber; adapter: string } | null {
  if (env.asrMode === 'off') return null;
  if (env.asrProvider !== 'replicate' && env.kieApiKey) {
    return {
      transcriber: createKieAsrTranscriber({ apiKey: env.kieApiKey, model: env.asrModel || KIE_ASR_DEFAULT_MODEL, log }),
      adapter: KIE_ASR_ADAPTER_ID,
    };
  }
  if (env.replicateApiToken) {
    return {
      transcriber: createReplicateAsrTranscriber({ apiToken: env.replicateApiToken, model: env.asrModel || ACOUSTIC_DEFAULT_MODEL, log }),
      adapter: ACOUSTIC_ADAPTER_ID,
    };
  }
  return null;
}

export function makeTtsIo(storage: StorageAdapter, projectId: string, settings: ProjectAudioSettings, env: AudioPipelineEnv, remainingMs = DEFAULT_TTS_BUDGET_MS): TtsIo {
  return {
    fetchImpl: fetch,
    apiKey: env.kieApiKey,
    lang: settings.lang,
    voiceName: settings.voiceName,
    writeBinary: (path, bytes, contentType) => storage.writeBinary!(path, bytes, contentType),
    basePathFor: (ordinal) => `projects/${projectId}/audio/vo-${ordinal}`,
    budgetMs: Math.max(0, Math.min(remainingMs, env.ttsBudgetMs || DEFAULT_TTS_BUDGET_MS)),
    log: (msg) => console.log(`[video-v4-audio] ${msg}`),
  };
}

export function liteSegments(meta: Record<string, unknown>): NarrationSegmentLite[] {
  const segments = Array.isArray(meta?.narration_segments) ? meta.narration_segments : [];
  return segments
    .map((s) => ({ frame_number: Number(s?.frame_number), text: String(s?.text ?? '') }))
    .filter((s) => Number.isInteger(s.frame_number) && s.frame_number > 0 && s.text.trim());
}

export const audioConfig: StepConfig = {
  name: 'audio',
  creditCost: 1,
  inputPaths: ['STORYBOARD.md', 'SCRIPT.md'],
  systemPrompt: AUDIO_SYSTEM_PROMPT,
  buildUserMessage: buildAudioUserMessage,
  outputSchema: AudioOutputSchema as StepConfig['outputSchema'],
  extractArtifacts: (output) => extractAudioArtifacts(output as AudioOutput),
};

/**
 * Corre o TTS por segmento e escreve `files[]` de volta no audio_meta.json
 * (restantes campos intactos). Devolve null quando nada há para fazer.
 * Falhas individuais são best-effort; a política terminal 0/N é
 * aplicada no payload do pipeline, depois de persistir files[] para diagnóstico.
 *
 * Reparo voz F12: após materializar, cada VO medida é confrontada com a
 * janela da cena — overflow reescreve o script mais curto (LLM) e regenera
 * o TTS (máx. 2 tentativas); o que continuar a exceder falha EXPLÍCITO por
 * segmento (VO_WINDOW_OVERFLOW), nunca corte mudo no render.
 */
export async function materializeProjectVoice(
  storage: StorageAdapter,
  projectId: string,
  settings: ProjectAudioSettings,
  remainingMs: number,
  env: AudioPipelineEnv,
  fit?: { llm: LLMClient; io: TtsIo },
): Promise<{
  files: VoiceFileEntry[];
  okCount: number;
  fitFailures: Array<{ frame_number: number; code: string; detail: string }>;
  fitWarnings: Array<{ frame_number: number; code: string; detail: string }>;
  rewrote: number;
  timingSource: 'acoustic' | 'estimated';
  alignment: Awaited<ReturnType<typeof mergeAcousticAlignment>>['alignment'];
} | null> {
  const metaPath = `projects/${projectId}/audio_meta.json`;
  const metaRaw = await storage.readText(metaPath);
  if (!metaRaw) throw new Error('AUDIO_META_MISSING');
  const meta = JSON.parse(metaRaw) as Record<string, unknown>;
  // Reparo de dados (incidente 2026-10-12): reescritas que guardaram o blob
  // JSON em vez da frase — recupera a frase válida antes de sintetizar.
  if (Array.isArray(meta.narration_segments)) {
    meta.narration_segments = (meta.narration_segments as Array<Record<string, unknown>>).map((s) => {
      const text = String(s?.text ?? '');
      if (/^\s*[{[]/.test(text)) {
        const recovered = extractSpokenText(text, 500);
        if (recovered) {
          console.warn(`[video-v4-audio] segmento frame ${String(s?.frame_number)} recuperado de blob JSON (${text.length} → ${recovered.length} chars)`);
          return { ...s, text: recovered };
        }
      }
      return s;
    });
  }
  const segments = liteSegments(meta);
  if (segments.length === 0 || meta.narration_enabled === false) return null;
  const io = makeTtsIo(storage, projectId, settings, env, remainingMs);
  // E02/I1: prazo global congelado — materialização e resíntese do fit
  // consomem o MESMO deadline do step; nunca reiniciar 90s por tentativa.
  const frozenDeadlineMs = Date.now() + (io.budgetMs ?? DEFAULT_TTS_BUDGET_MS);
  const { files, okCount } = await materializeVoiceFiles({ ...io, deadlineMs: frozenDeadlineMs }, segments);
  if (okCount < files.length) console.warn(`[video-v4-audio] TTS partial: ${okCount}/${files.length} segments ok`);

  let fitted: VoiceFileEntry[] = files;
  let fitFailures: Array<{ frame_number: number; code: string; detail: string }> = [];
  let fitWarnings: Array<{ frame_number: number; code: string; detail: string }> = [];
  let rewrote = 0;
  const rawSegs = Array.isArray(meta.narration_segments) ? meta.narration_segments as Array<Record<string, unknown>> : [];
  let finalSegs: Array<Record<string, unknown>> = rawSegs;
  if (fit?.llm && fit?.io && okCount > 0) {
    const sorted = [...segments].sort((a, b) => a.frame_number - b.frame_number);
    const windows: FitWindow[] = rawSegs
      .filter((s) => Number.isInteger(Number(s.frame_number)) && typeof s.start === 'number' && typeof s.end === 'number')
      .map((s) => ({
        frame_number: Number(s.frame_number),
        text: String(s.text ?? ''),
        windowStart: s.start as number,
        windowEnd: s.end as number,
      }));
    const res = await fitVoiceFilesToWindows(windows, files, {
      llmRewrite: async (frameNumber, text, maxChars) => {
        const win = windows.find((w) => w.frame_number === frameNumber);
        const windowSec = win ? Math.max(0.5, Math.round((win.windowEnd - win.windowStart) * 10) / 10) : Math.round((maxChars / 13) * 10) / 10;
        try {
          const rewriteLang = settings.lang && settings.lang !== 'auto' ? settings.lang : 'the same language as the input';
          const r = await fit.llm.call([
            { role: 'system', content: `You are a narration editor for short video scenes. Reply in ${rewriteLang} with exactly one plain-text sentence of at most ${maxChars} characters (hard limit — shorter is always acceptable). Preserve meaning; never add quotes, labels or JSON.` },
            { role: 'user', content: voiceRewritePrompt(text, windowSec, maxChars) },
          ], { timeoutMs: 30000 });
          const rawLen = String(r?.content ?? '').length;
          const spoken = extractSpokenText(String(r?.content ?? ''), maxChars);
          if (!spoken) {
            console.error(`[video-v4-audio] voice-fit rewrite rejeitada (frame ${frameNumber}): resposta fora do contrato (in=${text.length} raw=${rawLen} max=${maxChars})`);
            return null;
          }
          if (spoken.length >= text.length) {
            console.error(`[video-v4-audio] voice-fit rewrite rejeitada (frame ${frameNumber}): não encurtou (${text.length} → ${spoken.length} chars)`);
            return null;
          }
          return spoken;
        } catch (err) {
          // F2 T10: transiente (timeout/rede) → THROW para retry com backoff
          // no voiceFit; `null` fica reservado a rejeição permanente do
          // contrato (fora de orçamento/JSON/não encurtou) sem retry.
          console.error(`[video-v4-audio] voice-fit rewrite LLM transiente (frame ${frameNumber}):`, err);
          throw err;
        }
      },
      resynthesize: async (frameNumber, text) => {
        const ordinal = sorted.findIndex((s) => s.frame_number === frameNumber) + 1;
        if (ordinal === 0) throw new Error(`SEGMENT_NOT_FOUND frame ${frameNumber}`);
        const win = windows.find((w) => w.frame_number === frameNumber);
        const entry = await synthesizeSegment(
          { ...io, deadlineMs: frozenDeadlineMs },
          { ordinal, frameNumber, text, windowStart: win?.windowStart, windowEnd: win?.windowEnd },
        );
        return { ...entry } as Record<string, unknown>;
      },
      log: (msg) => console.log(`[video-v4-audio] ${msg}`),
      charsPerSec: charsPerSecForLang(settings.lang),
    });
    fitted = res.files as unknown as VoiceFileEntry[];
    fitFailures = res.failures;
    fitWarnings = res.warnings ?? [];
    rewrote = res.rewrote;
    // Textos finais falados voltam aos narration_segments (captions = áudio).
    finalSegs = rawSegs.map((s) => {
      const frame = Number(s.frame_number);
      const final = res.finalTexts[frame];
      if (typeof final === 'string' && final && final !== s.text) {
        return { ...s, text: final, voice_rewritten: true };
      }
      return s;
    });
  }

  // ── C04.1: alinhamento acústico REAL sobre os bytes materializados ──────
  // Corre DEPOIS do fit (que pode resintetizar) para nunca medir áudio
  // substituído. Cada segmento degrada isoladamente; o agregado só é
  // `acoustic` quando todos os segmentos com texto têm medição válida.
  const asr = resolveAsrFromEnv(env, (msg) => console.log(`[video-v4-audio] ${msg}`));
  const alignment = await mergeAcousticAlignment({
    segments: finalSegs
      .map((s) => ({
        frame_number: Number(s.frame_number),
        text: String(s.text ?? ''),
        start: Number(s.start ?? 0),
        end: Number(s.end ?? 0),
        ...(Array.isArray(s.word_timings)
          ? { word_timings: s.word_timings as Array<{ word: string; start: number; end: number }> }
          : {}),
      }))
      .filter((s) => Number.isInteger(s.frame_number) && s.frame_number > 0 && s.end > s.start),
    files: fitted,
    readBinary: (path) => storage.readBinary ? storage.readBinary(path) : Promise.resolve(null),
    transcribe: asr ? asr.transcriber : undefined,
    adapter: asr ? asr.adapter : ACOUSTIC_ADAPTER_ID,
    nowIso: () => new Date().toISOString(),
    // Janela própria do ASR (não clipped pelo deadline do TTS): o alinhamento
    // corre DEPOIS da materialização/fit e precisa de tempo para o provider.
    budgetMs: env.asrBudgetMs,
    log: (msg) => console.log(`[video-v4-audio] ${msg}`),
  });
  const alignedByFrame = new Map(alignment.narration_segments.map((s) => [s.frame_number, s]));
  const mergedSegs = finalSegs.map((s) => alignedByFrame.get(Number(s.frame_number)) ?? s);
  await storage.writeText(metaPath, JSON.stringify({
    ...meta,
    narration_segments: mergedSegs,
    files: fitted,
    timing_source: alignment.timing_source,
    alignment: alignment.alignment,
    ...(fit?.llm && fit?.io && okCount > 0 ? { voice_fit: { rewrote, failures: fitFailures, warnings: fitWarnings } } : {}),
  }));
  return {
    files: fitted,
    okCount: fitted.filter((f) => f.status === 'ok').length,
    fitFailures,
    fitWarnings,
    rewrote,
    timingSource: alignment.timing_source,
    alignment: alignment.alignment,
  };
}

/** Payload público do step de áudio (espelho do StepEdgeResponse da edge). */
export type AudioPipelinePayload =
  | { ok: false; error: string; detail?: string | null }
  | {
      ok: true;
      artifacts: string[];
      tokens: { input: number; output: number };
      voice_files_ok?: number;
      voice_files_total?: number;
      voice_rewrites?: number;
      timing_source?: 'acoustic' | 'estimated';
      caption_style?: string;
      alignment?: unknown;
      voice_fit_failures?: Array<{ frame_number: number; code: string; detail: string }>;
      voice_fit_warnings?: Array<{ frame_number: number; code: string; detail: string }>;
      needs_attention?: boolean;
      duration_seconds?: number;
    };

/**
 * Pipeline completo do step de áudio — o MESMO corpo que a edge corria no
 * task keep-alive. Orçamento wall de 350s (a edge deixava 50s para I/O dentro
 * do teto de 400s; no worker não há teto da plataforma, mas o orçamento
 * mantém-se por paridade de comportamento dos providers).
 */
export async function runAudioPipeline(
  deps: { db: StepDbAdapter; storage: StorageAdapter; llm: LLMClient },
  projectId: string,
  env: AudioPipelineEnv,
): Promise<AudioPipelinePayload> {
  const startedAt = Date.now();
  const project = await deps.db.getProject(projectId);
  const settings = resolveProjectAudioSettings(project?.metadata, env.ttsLangDefault || 'pt');
  // C04.2: clone herda a BGM materializada do pai (copiada para o prefixo
  // do clone antes do pipeline arrancar). Sem a flag, nada muda.
  const cloneReuseBgm = (project?.metadata as { clone_reuse_bgm?: unknown } | null)?.clone_reuse_bgm === true;
  let reuseBgm: BgmMeta | null = null;
  if (cloneReuseBgm) {
    try {
      const seededRaw = await deps.storage.readText(`projects/${projectId}/audio_meta.json`);
      const seeded = seededRaw ? JSON.parse(seededRaw) as { bgm?: unknown } : null;
      const candidate = seeded?.bgm as BgmMeta | undefined;
      reuseBgm = candidate && typeof candidate.path === 'string' ? candidate : null;
    } catch {
      reuseBgm = null;
    }
  }
  const result = await runStep(deps, projectId, {
    ...audioConfig,
    extractArtifacts: (output) => extractAudioArtifacts(output as AudioOutput, settings, {
      generateMusic: Boolean(env.musicModel),
      ...(reuseBgm ? { reuseBgm } : {}),
    }),
    outputSchema: AudioOutputSchema.superRefine((output, ctx) => {
      if (settings.narration === 'on' && !output.narration_segments.some((s) => s.text.trim())) {
        ctx.addIssue({ code: 'custom', path: ['narration_segments'], message: 'Narration is required by the project settings' });
      }
    }) as StepConfig['outputSchema'],
  });
  // V4-3g.2 (B5): detalhe fiel (zod issues / msg) para o manifesto.
  if (result.ok === false) return { ok: false, error: result.code, detail: result.detail ?? null };

  // V5-P5A: voz REAL — um ficheiro por segmento + files[] no audio_meta.
  const remaining = 350_000 - (Date.now() - startedAt);
  const voice = await materializeProjectVoice(deps.storage, projectId, settings, remaining, env, {
    llm: deps.llm,
    io: makeTtsIo(deps.storage, projectId, settings, env, Math.max(0, remaining - 60_000)),
  });
  const voiceFailure = voice ? voiceMaterializationFailure(voice) : null;
  if (voiceFailure) {
    return { ok: false, error: voiceFailure.code, detail: voiceFailure.detail };
  }
  const okPaths = (voice?.files ?? [])
    .filter((f) => f.status === 'ok' && f.path)
    .map((f) => f.path as string);
  try {
    const music = await materializeProjectMusic({
      storage: deps.storage, apiKey: env.kieApiKey,
      model: env.musicModel,
      variant: env.musicSunoModel,
      budgetMs: Math.max(0, Math.min(150_000, 350_000 - (Date.now() - startedAt))),
    }, projectId, settings.music);
    if (music.path) okPaths.push(music.path);
  } catch (error) {
    const code = error instanceof Error ? error.message : 'MUSIC_PROVIDER_FAILED';
    const explicitDetail = (error as { detail?: unknown } | null)?.detail;
    const detail = typeof explicitDetail === 'string' && explicitDetail
      ? explicitDetail
      : 'Music generation did not complete; the paid task is preserved for retry.';
    console.error(`[video-v4-audio] ${code} — ${detail}`);
    return { ok: false, error: code, detail };
  }

  // V4-04B §2.4: duration telemetry — total_duration_sec rides on the
  // response so the orchestrator records it on steps.audio for the
  // divergence warning in TaskFeedV2. Read back the just-persisted
  // audio_meta.json (best-effort).
  let durationSeconds: number | undefined;
  try {
    const metaRaw = await deps.storage.readText(`projects/${projectId}/audio_meta.json`);
    if (metaRaw) {
      const parsed = JSON.parse(metaRaw) as { total_duration_sec?: number };
      if (typeof parsed.total_duration_sec === 'number') durationSeconds = parsed.total_duration_sec;
    }
  } catch {
    /* telemetry is best-effort */
  }
  return {
    ok: true,
    artifacts: ['audio_meta.json', ...okPaths],
    tokens: result.tokens,
    ...(voice ? {
      voice_files_ok: voice.okCount,
      voice_files_total: voice.files.length,
      voice_rewrites: voice.rewrote,
      // C04.1: proveniência REAL das captions (acoustic só com medição).
      timing_source: voice.timingSource,
      caption_style: settings.captionStyle,
      alignment: voice.alignment,
      ...(voice.fitFailures.length > 0 ? { voice_fit_failures: voice.fitFailures } : {}),
      ...((voice.fitWarnings?.length ?? 0) > 0 ? { voice_fit_warnings: voice.fitWarnings } : {}),
      // E01-B voz 12–18s: materialização parcial é aceitável para o pipeline
      // (4/5 válidos), mas NÃO pode ser reportada como sucesso completo — o
      // manifesto transporta needs_attention para o feed sinalizar o segmento
      // omitido. Sem regressão de render/regeneração (política injeta só ok).
      ...(voice.fitFailures.length > 0 ? { needs_attention: true } : {}),
    } : {}),
    ...(durationSeconds != null ? { duration_seconds: durationSeconds } : {}),
  };
}