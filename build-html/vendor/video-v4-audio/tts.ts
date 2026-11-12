/**
 * tts.ts — V5-P5A §2.1: materialização de voz REAL (kie.ai TTS) para o passo
 * de áudio V4. Módulo PURO dual-runtime: todo o I/O é injetado
 * (fetchImpl/sleep/now/writeBinary), testável em vitest e em Deno.
 *
 * Reusa o contrato kie.ai já validado em `video-voice/logic.ts` (V2/V3):
 * createTask → poll recordInfo → resultUrls[]. Política de falha: um
 * segmento falhado não derruba o step, mas 0 sucessos causados por HTTP 402
 * falham com código dedicado para o orquestrador reembolsar o crédito.
 */
import { measureAudioDuration } from "./audioMeasure.ts";
import { createRespanFetch } from "../_shared/respanTracing.ts";
import { fitWavTailToWindow } from "./audioTrim.ts";
import {
  TTS_CREATE_TASK_URL,
  TTS_MAX_RETRIES,
  TTS_RECORD_INFO_URL,
  buildTtsRequestBody,
  parseVoiceoverRecord,
  shouldRetry,
  type VoiceoverRecord,
} from '../video-voice/logic.ts';

export const DEFAULT_TTS_BUDGET_MS = 100_000;
export const DEFAULT_TTS_CONCURRENCY = 2;
export const TTS_PROVIDER_CREDITS_INSUFFICIENT = 'TTS_PROVIDER_CREDITS_INSUFFICIENT';
/**
 * F0.3 (emenda E, plano v2): janela de graça após um fail transiente — nº de
 * re-polls da MESMA taskId e delay base (backoff linear) antes de recriar.
 */
export const TTS_FAIL_GRACE_POLLS = 3;
export const TTS_FAIL_GRACE_DELAY_MS = 5000;

// ─── Tipos ─────────────────────────────────────────────────────────────────

export interface NarrationSegmentLite {
  frame_number: number;
  text: string;
  start?: number;
  end?: number;
}

export interface VoiceFileEntry {
  /** ordinal 1-based na ordem por frame_number */
  segment: number;
  frame_number: number;
  path?: string;
  duration_est_sec?: number;
  measured_duration_sec?: number | null;
  duration_source?: "measured-wav" | "measured-mp3" | "estimated-mp3" | "unknown";
  /** E02/I1: N samples por canal + taxa (decode completo) — base do fit exato. */
  measured_sample_count?: number | null;
  measured_sample_rate?: number | null;
  decode_complete?: boolean;
  window_start?: number;
  window_end?: number;
  /** E07: cortou apenas silêncio final para caber na janela (auditoria). */
  tail_trim?: {
    applied: boolean;
    reason: string;
    original_sample_count: number;
    kept_sample_count: number;
    speech_end_sample: number;
    trimmed_ms: number;
    max_samples: number;
  };
  status: 'ok' | 'failed' | 'skipped';
  code?: typeof TTS_PROVIDER_CREDITS_INSUFFICIENT;
  error?: string;
}

export interface TtsIo {
  fetchImpl: typeof fetch;
  apiKey: string;
  lang: string;
  voiceName?: string;
  writeBinary(path: string, bytes: Uint8Array, contentType: string): Promise<void>;
  /** caminho base SEM extensão (a ext é detetada do payload) */
  basePathFor(ordinal: number, frameNumber: number): string;
  budgetMs?: number;
  concurrency?: number;
  pollIntervalMs?: number;
  pollMaxAttempts?: number;
  /** F0.3: re-polls da MESMA taskId após fail transiente antes de recriar. */
  failGracePolls?: number;
  failGraceDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  deadlineMs?: number;
  log?: (msg: string) => void;
}

const TRANSIENT_RETRY_DELAY_MS = 2000;

/** Deadline covers headers AND body, including audio downloads. */
async function boundedFetch(io: TtsIo, url: string, init?: RequestInit): Promise<Response> {
  const remaining = io.deadlineMs == null ? 30_000 : io.deadlineMs - (io.now ?? Date.now)();
  if (remaining <= 0) throw new Error('TTS_BUDGET_EXHAUSTED');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.min(30_000, remaining));
  try {
    const response = await createRespanFetch(io.fetchImpl, { name: 'video.tts.submit' })(url, { ...init, signal: controller.signal });
    const body = await response.arrayBuffer();
    return new Response(response.status === 204 ? null : body, { status: response.status, headers: response.headers });
  } finally {
    clearTimeout(timer);
  }
}

// ─── Utilitários ───────────────────────────────────────────────────────────

/** Mesma heurística do V3 (15 chars/s), clamp [1.5, 60]s. */
export function estimateSpeechSeconds(text: string): number {
  const secs = (text?.length ?? 0) / 15;
  return Math.min(60, Math.max(1.5, Math.round(secs * 100) / 100));
}

/** Container de áudio detetado por magic bytes; null quando desconhecido. */
export function detectAudioExtFromBytes(bytes: Uint8Array): 'mp3' | 'wav' | 'm4a' | null {
  if (!bytes || bytes.length < 12) return bytes?.length >= 3 ? maybeMp3Sync(bytes) : null;
  if (bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) return 'mp3'; // "ID3"
  const sync = maybeMp3Sync(bytes);
  if (sync) return sync;
  if (
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 && // "RIFF"
    bytes[8] === 0x57 && bytes[9] === 0x41 && bytes[10] === 0x56 && bytes[11] === 0x45 // "WAVE"
  ) {
    return 'wav';
  }
  // MP4/M4A container: size uint32 + "ftyp" @4.
  if (bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70) return 'm4a';
  return null;
}

function maybeMp3Sync(bytes: Uint8Array): 'mp3' | null {
  // MPEG frame sync: 11111111 111xxxyy (primeiros 11 bits a 1).
  if (bytes.length >= 2 && bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0) return 'mp3';
  return null;
}

/** MIME canônico para Supabase Storage (padrão video-voice). */
export function normalizeAudioContentType(contentType: string): string {
  const mime = (contentType ?? '').split(';')[0].trim().toLowerCase();
  if (mime === 'audio/x-wav' || mime === 'audio/wave') return 'audio/wav';
  if (mime === 'audio/x-mpeg' || mime === 'audio/mp3') return 'audio/mpeg';
  return mime;
}

function defaultMimeForExt(ext: 'mp3' | 'wav' | 'm4a'): string {
  if (ext === 'wav') return 'audio/wav';
  if (ext === 'm4a') return 'audio/mp4';
  return 'audio/mpeg';
}

function capError(msg: string): string {
  return String(msg ?? '').slice(0, 200);
}

// ─── Pipeline kie.ai (createTask / poll / download) ────────────────────────

async function sleepMs(io: TtsIo, ms: number): Promise<void> {
  await (io.sleep ? io.sleep(ms) : new Promise<void>((r) => setTimeout(r, ms)));
}

interface CreateTaskResult {
  taskId?: string;
  error?: string;
  code?: typeof TTS_PROVIDER_CREDITS_INSUFFICIENT;
}

/** POST createTask com exatamente 1 retry em falhas transientes (padrão V3). */
export async function createTtsTask(io: TtsIo, body: Record<string, unknown>): Promise<CreateTaskResult> {
  for (let attempt = 0; attempt <= TTS_MAX_RETRIES; attempt++) {
    try {
      const res = await boundedFetch(io, TTS_CREATE_TASK_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${io.apiKey}`,
        },
        body: JSON.stringify(body),
      });
      if (res.status === 429 || res.status >= 500) {
        if (attempt < TTS_MAX_RETRIES) {
          await sleepMs(io, TRANSIENT_RETRY_DELAY_MS * (attempt + 1));
          continue;
        }
        return { error: `createTask transient failure (HTTP ${res.status})` };
      }
      if (!res.ok) {
        const detail = capError(`createTask failed (HTTP ${res.status}): ${await res.text()}`);
        if (res.status === 402) {
          return {
            code: TTS_PROVIDER_CREDITS_INSUFFICIENT,
            error: capError(`${TTS_PROVIDER_CREDITS_INSUFFICIENT}: ${detail}`),
          };
        }
        return { error: detail };
      }
      const data = (await res.json()) as { code?: number; msg?: string; data?: { taskId?: string } };
      // Kie reports application errors inside HTTP 200 (observed on real jobs).
      if (Number(data?.code) === 402) {
        return { code: TTS_PROVIDER_CREDITS_INSUFFICIENT, error: TTS_PROVIDER_CREDITS_INSUFFICIENT };
      }
      if (Number(data?.code) === 429 || Number(data?.code) >= 500) {
        if (attempt < TTS_MAX_RETRIES) {
          await sleepMs(io, TRANSIENT_RETRY_DELAY_MS * (attempt + 1));
          continue;
        }
      }
      if (data?.code !== 200 || !data?.data?.taskId) {
        return { error: capError(`createTask rejected: ${JSON.stringify(data)}`) };
      }
      return { taskId: data.data.taskId };
    } catch (err) {
      if (attempt < TTS_MAX_RETRIES) {
        await sleepMs(io, TRANSIENT_RETRY_DELAY_MS * (attempt + 1));
        continue;
      }
      return { error: capError(`createTask network failure: ${(err as Error)?.message ?? err}`) };
    }
  }
  return { error: 'createTask failed' };
}

async function queryRecordInfo(io: TtsIo, taskId: string): Promise<Record<string, unknown>> {
  const res = await boundedFetch(io, `${TTS_RECORD_INFO_URL}?taskId=${encodeURIComponent(taskId)}`, {
    headers: { Authorization: `Bearer ${io.apiKey}` },
  });
  if (!res.ok) return { state: 'fail', failCode: String(res.status), failMsg: `recordInfo HTTP ${res.status}` };
  try {
    const payload = (await res.json()) as Record<string, unknown>;
    if (payload.code != null && Number(payload.code) !== 200) {
      return { state: 'fail', failCode: String(payload.code), failMsg: `recordInfo rejected (${payload.code})` };
    }
    return payload;
  } catch {
    return { state: 'fail', failCode: 'parse', failMsg: 'recordInfo returned non-JSON' };
  }
}

/** Poll até estado terminal ou esgotar o orçamento de tentativas. */
export async function pollTtsTaskRecord(io: TtsIo, taskId: string): Promise<{ record: VoiceoverRecord; done: boolean }> {
  const interval = io.pollIntervalMs ?? 5000;
  const maxAttempts = io.pollMaxAttempts ?? 60;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (io.deadlineMs != null && (io.now ?? Date.now)() >= io.deadlineMs) break;
    const record = parseVoiceoverRecord(await queryRecordInfo(io, taskId));
    if (record.state === 'success' || record.state === 'fail') return { record, done: true };
    await sleepMs(io, interval);
  }
  return { record: parseVoiceoverRecord({ state: 'waiting' }), done: false };
}

/**
 * F0.3 (emenda E, plano v2): um fail transiente (ex.: 524 "generate task
 * timeout") pode ser seguido de conclusão tardia da MESMA task no provider.
 * Antes de recriar (nova síntese paga + órfão), re-poll a taskId original com
 * backoff linear limitado. Nunca lança: falha de rede/parse ou deadline →
 * não recuperado (o chamador decide recriar). Códigos permanentes nunca
 * chegam aqui — o gate é o `shouldRetry` do chamador.
 */
export async function repollFailedTtsTask(
  io: TtsIo,
  taskId: string,
): Promise<{ record: VoiceoverRecord; recovered: boolean }> {
  const polls = Math.max(0, Math.floor(io.failGracePolls ?? TTS_FAIL_GRACE_POLLS));
  const delay = Math.max(0, io.failGraceDelayMs ?? TTS_FAIL_GRACE_DELAY_MS);
  let record = parseVoiceoverRecord({ state: 'fail' });
  for (let i = 0; i < polls; i++) {
    const waitMs = delay * (i + 1);
    // A janela de graça nunca pode consumir o orçamento do segmento.
    if (io.deadlineMs != null && (io.now ?? Date.now)() + waitMs > io.deadlineMs) break;
    await sleepMs(io, waitMs);
    try {
      record = parseVoiceoverRecord(await queryRecordInfo(io, taskId));
    } catch {
      break;
    }
    if (record.state === 'success') return { record, recovered: true };
    // state 'waiting'/'running': a task voltou a progredir — continuar a janela.
  }
  return { record, recovered: false };
}

async function downloadTtsResult(
  io: TtsIo,
  url: string,
): Promise<{ ok: true; bytes: Uint8Array; contentType: string } | { ok: false; error: string }> {
  try {
    const res = await boundedFetch(io, url);
    if (!res.ok) return { ok: false, error: `download failed (HTTP ${res.status})` };
    const buf = new Uint8Array(await res.arrayBuffer());
    return { ok: true, bytes: buf, contentType: normalizeAudioContentType(res.headers.get('content-type') ?? '') };
  } catch (err) {
    return { ok: false, error: capError(`download error: ${(err as Error)?.message ?? err}`) };
  }
}

/**
 * Sintetiza UM segmento: pipeline completo com status honesto. Nunca lança.
 */
export async function synthesizeSegment(
  io: TtsIo,
  args: { ordinal: number; frameNumber: number; text: string; windowStart?: number; windowEnd?: number },
): Promise<VoiceFileEntry> {
  const { ordinal, frameNumber, text } = args;
  const entry: VoiceFileEntry = { segment: ordinal, frame_number: frameNumber, status: 'failed' };
  if (!text || !text.trim()) {
    return { ...entry, status: 'skipped', error: 'EMPTY_TEXT' };
  }
  if (!io.apiKey) return { ...entry, error: 'TTS_NOT_CONFIGURED' };
  try {
    const body = buildTtsRequestBody({
      texts: [{ id: `seg-${frameNumber}`, text }],
      lang: io.lang,
      voiceName: io.voiceName,
    }) as unknown as Record<string, unknown>;

    // createTask → poll, com exatamente 1 retry de pipeline quando a tarefa
    // falha com failCode transiente (429/5xx — política shouldRetry do V3).
    // F0.3 (emenda E): antes de recriar, janela de graça sobre a MESMA taskId
    // (conclusão tardia do provider) — evita síntese duplicada e órfãos.
    let record: VoiceoverRecord | null = null;
    let done = false;
    for (let attempt = 0; attempt <= TTS_MAX_RETRIES; attempt++) {
      const created = await createTtsTask(io, body);
      if (!created.taskId) {
        return {
          ...entry,
          ...(created.code ? { code: created.code } : {}),
          error: created.error ?? 'CREATE_TASK_FAILED',
        };
      }
      const polled = await pollTtsTaskRecord(io, created.taskId);
      record = polled.record;
      done = polled.done;
      if (done && record.state === 'fail' && shouldRetry(record.failCode, attempt)) {
        const failedCode = record.failCode;
        const grace = await repollFailedTtsTask(io, created.taskId);
        if (grace.recovered) {
          record = grace.record;
          io.log?.(`[tts] segment ${ordinal} late completion of task ${created.taskId} after failCode ${failedCode} — no resynthesis`);
          break;
        }
        continue;
      }
      break;
    }
    if (!record) return { ...entry, error: 'TTS_INTERNAL' };
    if (!done || record.state !== 'success' || record.resultUrls.length === 0) {
      const reason = !done
        ? 'POLL_EXHAUSTED'
        : (record.failMsg ?? record.failCode ?? 'TTS_TASK_FAILED');
      return {
        ...entry,
        ...(String(record.failCode) === '402' ? { code: TTS_PROVIDER_CREDITS_INSUFFICIENT } : {}),
        error: capError(reason),
      };
    }

    const downloaded = await downloadTtsResult(io, record.resultUrls[0]);
    if (downloaded.ok === false) return { ...entry, error: downloaded.error };

    const ext = detectAudioExtFromBytes(downloaded.bytes);
    if (!ext) return { ...entry, error: 'UNKNOWN_AUDIO_CONTAINER' };

    // E07: a voz medida pode exceder a janela APENAS por silêncio final do
    // provider (caso real: 3,24 s para 3,0 s com fala até 2,86 s). Corta-se a
    // cauda silenciosa até à janela — nunca fala — e a medida é refeita sobre
    // os bytes efetivamente escritos. Sem janela/medida completa, nada muda e
    // o gate de fit continua a recusar como antes.
    let bytes = downloaded.bytes;
    let measured = measureAudioDuration(bytes, ext);
    let tailTrim: VoiceFileEntry['tail_trim'];
    const winStart = typeof args.windowStart === 'number' ? args.windowStart : undefined;
    const winEnd = typeof args.windowEnd === 'number' ? args.windowEnd : undefined;
    if (ext === 'wav' && winStart !== undefined && winEnd !== undefined && winEnd > winStart
      && measured.decodeComplete === true && typeof measured.sampleCount === 'number'
      && typeof measured.sampleRate === 'number') {
      const maxSamples = Math.floor((winEnd - winStart) * measured.sampleRate);
      if (measured.sampleCount > maxSamples) {
        const fit = fitWavTailToWindow(bytes, { maxSamples });
        if (fit.applied) {
          bytes = fit.bytes;
          measured = measureAudioDuration(bytes, 'wav');
        }
        tailTrim = {
          applied: fit.applied, reason: fit.reason,
          original_sample_count: fit.originalSampleCount, kept_sample_count: fit.keptSampleCount,
          speech_end_sample: fit.speechEndSample, trimmed_ms: fit.trimmedMs, max_samples: maxSamples,
        };
        io.log?.(`[tts] segment ${ordinal} tail-fit ${fit.reason} ${fit.originalSampleCount}→${fit.keptSampleCount} samples (max ${maxSamples})`);
      }
    }

    const path = `${io.basePathFor(ordinal, frameNumber)}.${ext}`;
    await io.writeBinary(path, bytes, downloaded.contentType || defaultMimeForExt(ext));
    io.log?.(`[tts] segment ${ordinal} (frame ${frameNumber}) → ${path} (${bytes.length}B)`);
    io.log?.(`[tts] segment ${ordinal} measured ${measured.durationSec ?? "?"}s (${measured.source})`);
    return { ...entry, status: 'ok', path, duration_est_sec: estimateSpeechSeconds(text), measured_duration_sec: measured.durationSec, duration_source: measured.source, measured_sample_count: measured.sampleCount ?? null, measured_sample_rate: measured.sampleRate ?? null, decode_complete: measured.decodeComplete === true, ...(tailTrim ? { tail_trim: tailTrim } : {}), ...(winStart !== undefined ? { window_start: winStart } : {}), ...(winEnd !== undefined ? { window_end: winEnd } : {}) };
  } catch (err) {
    return { ...entry, error: capError((err as Error)?.message ?? err) };
  }
}

// ─── Materialização do projeto inteiro ─────────────────────────────────────

/**
 * Um ficheiro por segmento (ordem por frame_number), concorrência limitada e
 * orçamento temporal total. Segmentos fora do orçamento ficam `skipped`
 * (regeneráveis via retry parcial); tarefas em curso quando o prazo passa
 * continuam e o resultado é aceite.
 */
export async function materializeVoiceFiles(
  io: TtsIo,
  segments: NarrationSegmentLite[],
): Promise<{ files: VoiceFileEntry[]; okCount: number }> {
  const sorted = [...(segments ?? [])]
    .filter((s) => s && typeof s.frame_number === 'number')
    .sort((a, b) => a.frame_number - b.frame_number);

  const results: Array<VoiceFileEntry | undefined> = new Array(sorted.length);
  const startedAt = (io.now ?? (() => Date.now()))();
  const budgetMs = io.budgetMs ?? DEFAULT_TTS_BUDGET_MS;
  const concurrency = Math.max(1, Math.min(8, io.concurrency ?? DEFAULT_TTS_CONCURRENCY));

  let cursor = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const idx = cursor++;
      if (idx >= sorted.length) return;
      const seg = sorted[idx];
      const ordinal = idx + 1;
      const elapsed = (io.now ?? (() => Date.now()))() - startedAt;
      if (elapsed >= budgetMs) {
        results[idx] = { segment: ordinal, frame_number: seg.frame_number, status: 'skipped', error: 'TTS_BUDGET_EXHAUSTED' };
        continue;
      }
      results[idx] = await synthesizeSegment({ ...io, deadlineMs: startedAt + budgetMs }, { ordinal, frameNumber: seg.frame_number, text: seg.text });
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, sorted.length) }, () => worker());
  await Promise.all(workers);

  const files = results.map((f) => f ?? { segment: 0, frame_number: -1, status: 'failed' as const, error: 'INTERNAL' });
  return { files, okCount: files.filter((f) => f.status === 'ok').length };
}

/**
 * Converte somente a falha total causada por falta de saldo do provider em
 * erro terminal. Qualquer sucesso preserva a semântica parcial histórica.
 */
export function voiceMaterializationFailure(result: {
  files: VoiceFileEntry[];
  okCount: number;
}): { code: string; detail: string } | null {
  if (result.okCount > 0 || result.files.length === 0) return null;
  const creditsFailure = result.files.some((file) => file.code === TTS_PROVIDER_CREDITS_INSUFFICIENT);
  if (!creditsFailure) return { code: 'TTS_MATERIALIZATION_FAILED', detail: `No voice files produced: 0/${result.files.length} segments ok` };
  return {
    code: TTS_PROVIDER_CREDITS_INSUFFICIENT,
    detail: `TTS provider credits insufficient: 0/${result.files.length} segments ok`,
  };
}

// ─── Retry parcial (§10.1.3) ───────────────────────────────────────────────

/**
 * Merge imutável de uma entrada nova/actualizada em meta.files[], ordenado
 * por `segment`. Restantes campos da meta ficam intactos.
 */
export function mergeSegmentEntry<M extends { files?: unknown }>(meta: M, entry: VoiceFileEntry): M {
  const rawFiles = (meta as { files?: unknown }).files;
  const files: VoiceFileEntry[] = Array.isArray(rawFiles)
    ? (rawFiles as unknown[]).map((f) => f as VoiceFileEntry)
    : [];
  const idx = files.findIndex((f) => f.frame_number === entry.frame_number);
  if (idx >= 0) files[idx] = { ...entry };
  else files.push({ ...entry });
  files.sort((a, b) => a.segment - b.segment);
  return { ...(meta as Record<string, unknown>), files } as unknown as M;
}
